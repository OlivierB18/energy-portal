import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient } from './_supabase.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
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

  const user_id = String(body?.user_id || '').trim()
  const user_email = String(body?.user_email || '').trim().toLowerCase()
  const environment_id = String(body?.environment_id || '').trim()
  const action = String(body?.action || '').trim()

  if (!user_id || !user_email || !environment_id || !['add', 'remove'].includes(action)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing or invalid fields: user_id, user_email, environment_id, action (add|remove)' }),
    }
  }

  const supabase = createServiceSupabaseClient()

  // Permission check: super admin OR admin of this specific environment
  const callerIsSuper = isSuperAdmin(auth.email)
  if (!callerIsSuper) {
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

  try {
    if (action === 'add') {
      const { error } = await supabase
        .from('environment_users')
        .upsert(
          {
            environment_id,
            user_id,
            user_email,
            role: String(body?.role || 'viewer'),
            invited_by: auth.email,
            accepted_at: new Date().toISOString(),
          },
          { onConflict: 'environment_id,user_id' },
        )
      if (error) throw error
    } else {
      // action === 'remove'
      const { error } = await supabase
        .from('environment_users')
        .delete()
        .eq('environment_id', environment_id)
        .eq('user_id', user_id)
      if (error) throw error
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to update user environment' }),
    }
  }
}
