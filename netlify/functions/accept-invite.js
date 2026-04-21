import { createServiceSupabaseClient } from './_supabase.js'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const token = String(body?.token || '').trim()
  const user_id = String(body?.user_id || '').trim()
  const user_email = String(body?.user_email || '').trim().toLowerCase()

  if (!token || !user_id || !user_email) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields: token, user_id, user_email' }),
    }
  }

  const supabase = createServiceSupabaseClient()

  const { data: invite, error: inviteError } = await supabase
    .from('invites')
    .select('*')
    .eq('token', token)
    .maybeSingle()

  if (inviteError) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to look up invite' }) }
  }
  if (!invite) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Invite not found or already used' }) }
  }
  if (invite.accepted_at) {
    return { statusCode: 409, body: JSON.stringify({ error: 'Invite has already been accepted' }) }
  }
  if (new Date(invite.expires_at) < new Date()) {
    return { statusCode: 410, body: JSON.stringify({ error: 'Invite has expired' }) }
  }

  // Verify the email matches (case-insensitive)
  if (invite.email.toLowerCase() !== user_email) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Email address does not match the invite' }),
    }
  }

  try {
    const { error: upsertError } = await supabase
      .from('environment_users')
      .upsert(
        {
          environment_id: invite.environment_id,
          user_id,
          user_email,
          role: invite.role,
          invited_by: invite.invited_by,
          accepted_at: new Date().toISOString(),
        },
        { onConflict: 'environment_id,user_id' },
      )

    if (upsertError) throw upsertError

    const { error: updateError } = await supabase
      .from('invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id)

    if (updateError) throw updateError

    return {
      statusCode: 200,
      body: JSON.stringify({
        environment_id: invite.environment_id,
        role: invite.role,
      }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to accept invite' }),
    }
  }
}
