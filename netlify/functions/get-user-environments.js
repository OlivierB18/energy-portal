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
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const authHeader = event.headers.authorization || event.headers.Authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing token' }) }
    }

    const token = authHeader.replace('Bearer ', '')
    const domain = getEnv('AUTH0_DOMAIN')

    const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${domain}/`,
    })

    const userId = payload.sub
    if (!userId || typeof userId !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing user id' }) }
    }

    const managementToken = await getManagementToken(domain)
    const environmentIds = await fetchUserEnvironmentIds(domain, managementToken, userId)

    return {
      statusCode: 200,
      body: JSON.stringify({ environmentIds }),
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

const fetchUserEnvironmentIds = async (domain, token, userId) => {
  const response = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(userId)}?fields=app_metadata&include_fields=true`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  )

  if (!response.ok) {
    throw new Error('Unable to fetch user metadata')
  }

  const user = await response.json()
  return Array.isArray(user.app_metadata?.environmentIds)
    ? user.app_metadata.environmentIds
    : []
}
