import { createRemoteJWKSet, jwtVerify } from 'jose'
import crypto from 'crypto'

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
    const name = body.name?.trim()
    const environmentIds = Array.isArray(body.environmentIds)
      ? body.environmentIds.map((env) => String(env))
      : []

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Email is required' }) }
    }

    const connection = getEnv('AUTH0_DB_CONNECTION')
    const managementToken = await getManagementToken(domain)
    const user = await createUser(domain, managementToken, {
      email,
      name,
      connection,
      environmentIds,
    })

    const passwordEmailSent = await sendPasswordResetEmail(domain, email, connection)
    const inviteLink = await createInviteLink(domain, managementToken, user.user_id)

    return {
      statusCode: 200,
      body: JSON.stringify({
        user,
        inviteLink,
        passwordEmailSent,
      }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' })
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
  const ownerEmail = (process.env.OWNER_EMAIL || '').trim().toLowerCase()
  const allowlist = (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
  const emailValue = payload.email || payload['https://brouwer-ems/email'] || payload['email']
  const email = typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
  const isOwner = ownerEmail.length > 0 && email === ownerEmail
  const isAllowedEmail = email.length > 0 && allowlist.includes(email)
  return roles.includes('admin') || isOwner || isAllowedEmail
}

const getManagementToken = async (domain) => {
  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: getEnv('AUTH0_M2M_CLIENT_ID'),
      client_secret: getEnv('AUTH0_M2M_CLIENT_SECRET'),
      audience: `https://${domain}/api/v2/`,
      grant_type: 'client_credentials',
    }),
  })

  if (!response.ok) {
    throw new Error('Unable to get management token')
  }

  const data = await response.json()
  return data.access_token
}

const createUser = async (domain, token, { email, name, connection, environmentIds }) => {
  const password = generatePassword()
  const response = await fetch(`https://${domain}/api/v2/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      name: name || undefined,
      connection,
      password,
      email_verified: false,
      verify_email: true,
      app_metadata: {
        environmentIds,
      },
    }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || 'Unable to create user')
  }

  return response.json()
}

const generatePassword = () => {
  return crypto.randomBytes(24).toString('base64url')
}

const sendPasswordResetEmail = async (domain, email, connection) => {
  const clientId = process.env.AUTH0_APP_CLIENT_ID

  if (!clientId) {
    return false
  }

  try {
    const response = await fetch(`https://${domain}/dbconnections/change_password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        email,
        connection,
      }),
    })

    return response.ok
  } catch {
    return false
  }
}

const createInviteLink = async (domain, token, userId) => {
  try {
    const response = await fetch(`https://${domain}/api/v2/tickets/password-change`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        result_url: process.env.AUTH0_INVITE_REDIRECT_URL || undefined,
        mark_email_as_verified: false,
        ttl_sec: 60 * 60 * 24 * 7,
      }),
    })

    if (!response.ok) {
      return null
    }

    const data = await response.json()
    return data.ticket || null
  } catch {
    return null
  }
}