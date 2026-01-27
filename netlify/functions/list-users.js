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

    const managementToken = await getManagementToken(domain)
    const users = await fetchUsers(domain, managementToken)

    return {
      statusCode: 200,
      body: JSON.stringify({ users }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
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

const fetchUsers = async (domain, token) => {
  const response = await fetch(
    `https://${domain}/api/v2/users?per_page=50&page=0&include_totals=false&sort=created_at:-1`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  )

  if (!response.ok) {
    throw new Error('Unable to fetch users')
  }

  const users = await response.json()
  return users.map((user) => ({
    user_id: user.user_id,
    email: user.email,
    name: user.name,
    last_login: user.last_login,
    created_at: user.created_at,
    environmentIds: Array.isArray(user.app_metadata?.environmentIds) ? user.app_metadata.environmentIds : [],
  }))
}
