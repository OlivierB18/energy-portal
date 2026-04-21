import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient } from './_supabase.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

const getOptionalEnv = (key) => {
  const value = process.env[key]
  return value && String(value).trim() ? String(value).trim() : null
}

const getEmailFromPayload = (payload) => {
  const value = payload.email || payload['https://brouwer-ems/email']
  return typeof value === 'string' ? value.toLowerCase() : ''
}

const isSuperAdmin = (email) => {
  const owner = String(process.env.OWNER_EMAIL || '').trim().toLowerCase()
  return Boolean(owner && email === owner)
}

const verifyAuth = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    const err = new Error('Missing token')
    err.statusCode = 401
    throw err
  }
  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
  const email = getEmailFromPayload(payload)
  return { email, payload }
}

const sendInviteEmail = async ({ to, inviteUrl, role, environmentName, invitedBy }) => {
  const apiKey = getOptionalEnv('RESEND_API_KEY')
  const appUrl = getOptionalEnv('APP_URL') || ''

  if (!apiKey) {
    console.warn('[invite-user] RESEND_API_KEY not set, skipping email')
    return false
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Energy Portal <noreply@${new URL(appUrl || 'https://example.com').hostname}>`,
      to: [to],
      subject: 'Je bent uitgenodigd voor Energy Portal',
      html: `
        <p>Hoi,</p>
        <p><strong>${invitedBy}</strong> heeft je uitgenodigd als <strong>${role}</strong> voor <strong>${environmentName}</strong> in Energy Portal.</p>
        <p>
          <a href="${inviteUrl}" style="background:#ea580c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:12px;">
            Uitnodiging accepteren
          </a>
        </p>
        <p style="color:#888;font-size:12px;margin-top:24px;">Deze link verloopt over 7 dagen.</p>
      `,
    }),
  })

  return response.ok
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let auth
  try {
    auth = await verifyAuth(event)
  } catch (err) {
    return { statusCode: err.statusCode || 401, body: JSON.stringify({ error: err.message }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const email = String(body?.email || '').trim().toLowerCase()
  const role = String(body?.role || 'viewer').trim()
  const environment_id = String(body?.environment_id || '').trim()

  if (!email || !environment_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: email, environment_id' }) }
  }
  if (!['admin', 'viewer'].includes(role)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid role. Must be admin or viewer' }) }
  }

  const supabase = createServiceSupabaseClient()

  // Permission check: super admin OR admin of that environment
  const callerIsSuperAdmin = isSuperAdmin(auth.email)
  if (!callerIsSuperAdmin) {
    const { data: callerAccess } = await supabase
      .from('environment_users')
      .select('role')
      .eq('environment_id', environment_id)
      .eq('user_email', auth.email)
      .maybeSingle()

    if (!callerAccess || callerAccess.role !== 'admin') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Insufficient permissions for this environment' }) }
    }
  }

  // Resolve environment name for the email
  const { data: environment, error: envError } = await supabase
    .from('environments')
    .select('id, name, display_name')
    .eq('id', environment_id)
    .maybeSingle()

  if (envError || !environment) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Environment not found' }) }
  }

  try {
    const { data: invite, error: insertError } = await supabase
      .from('invites')
      .insert({
        environment_id,
        email,
        role,
        invited_by: auth.email,
      })
      .select('token')
      .single()

    if (insertError) throw insertError

    const appUrl = getOptionalEnv('APP_URL') || ''
    const inviteUrl = `${appUrl}/accept-invite?token=${invite.token}`
    const environmentName = environment.display_name || environment.name

    await sendInviteEmail({
      to: email,
      inviteUrl,
      role,
      environmentName,
      invitedBy: auth.email,
    })

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        token: invite.token,
        invite_url: inviteUrl,
      }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to create invite' }),
    }
  }
}
