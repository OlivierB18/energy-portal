import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const authHeader = event.headers.authorization || event.headers.Authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing token' }) }
    }

    const token = authHeader.replace('Bearer ', '')
    const domain = getEnv('AUTH0_DOMAIN')
    const rolesClaim = process.env.AUTH0_ROLES_CLAIM || 'https://brouwer-ems/roles'

    const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${domain}/`,
    })

    if (!isAdminFromClaims(payload, rolesClaim)) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Admin only' }) }
    }

    const body = JSON.parse(event.body || '{}')
    const email = body.email?.trim()
    const connection = body.connection?.trim() || getEnv('AUTH0_DB_CONNECTION')

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Email is required' }) }
    }

    const clientId = process.env.AUTH0_APP_CLIENT_ID
    if (!clientId) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing AUTH0_APP_CLIENT_ID' }) }
    }

    const response = await fetch(`https://${domain}/dbconnections/change_password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        email,
        connection,
      }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => null)
      throw new Error(error?.description || error?.error || 'Unable to send reset email')
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
    }
  }
}

const isAdminFromClaims = (payload, rolesClaim) => {
  const rolesValue = payload[rolesClaim]
  const roles = Array.isArray(rolesValue)
    ? rolesValue
    : typeof rolesValue === 'string'
      ? [rolesValue]
      : []
  const allowlist = (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || 'olivier@inside-out.tech')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
  const emailValue = payload.email || payload['https://brouwer-ems/email'] || payload['email']
  const email = typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
  const isAllowedEmail = email.length > 0 && allowlist.includes(email)
  return roles.includes('admin') || isAllowedEmail
}
