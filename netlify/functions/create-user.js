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

    const roles = Array.isArray(payload[rolesClaim]) ? payload[rolesClaim] : []
    if (!roles.includes('admin')) {
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

    const inviteLink = await createInviteLink(domain, managementToken, user.user_id)

    return {
      statusCode: 200,
      body: JSON.stringify({
        user,
        inviteLink,
      }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' })
    }
  }
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