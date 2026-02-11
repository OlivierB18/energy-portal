import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const getOptionalEnv = (key) => {
  const value = process.env[key]
  return value && value.trim().length > 0 ? value : null
}

const HA_ENVIRONMENTS = {
  vacation: {
    name: 'Brouwer TEST',
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
}

const getFallbackEnvironments = () =>
  Object.entries(HA_ENVIRONMENTS)
    .map(([id, env]) => {
      const url = getOptionalEnv(env.urlEnv)
      const token = getOptionalEnv(env.tokenEnv)
      if (!url || !token) {
        return null
      }
      return {
        id,
        name: env.name || id,
        url,
        token,
      }
    })
    .filter(Boolean)

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

const getClientMetadata = async (domain, token) => {
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    throw new Error('Unable to fetch app metadata')
  }

  const client = await response.json()
  return client.client_metadata || {}
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

const verifyAuth = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing token')
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const rolesClaim = process.env.AUTH0_ROLES_CLAIM || 'https://brouwer-ems/roles'

  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
  const isAdmin = isAdminFromClaims(payload, rolesClaim)
  return { isAdmin }
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const { isAdmin } = await verifyAuth(event)
    const fallbackEnvironments = getFallbackEnvironments()
    let environments = []

    try {
      const domain = getEnv('AUTH0_DOMAIN')
      const managementToken = await getManagementToken(domain)
      const metadata = await getClientMetadata(domain, managementToken)
      const haEnvironments = metadata.ha_environments || {}

      environments = Object.entries(haEnvironments).map(([id, env]) => ({
        id,
        name: env?.name || id,
        url: env?.base_url || env?.url || '',
        token: env?.token,
      }))
    } catch (error) {
      if (fallbackEnvironments.length === 0) {
        throw error
      }
    }

    const resolved = environments.length > 0 ? environments : fallbackEnvironments

    const payload = isAdmin
      ? resolved
      : resolved.map((env) => ({ id: env.id, name: env.name }))

    return {
      statusCode: 200,
      body: JSON.stringify({ environments: payload }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
    }
  }
}
