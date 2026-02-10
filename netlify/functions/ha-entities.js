import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const HA_ENVIRONMENTS = {
  vacation: {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
}

const getHaConfig = (environmentId) => {
  const config = HA_ENVIRONMENTS[environmentId]
  if (!config) {
    throw new Error('Unknown environment')
  }
  return {
    baseUrl: getEnv(config.urlEnv),
    token: getEnv(config.tokenEnv),
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

const getVisibleEntityIds = async (domain, environmentId) => {
  const managementToken = await getManagementToken(domain)
  const metadata = await getClientMetadata(domain, managementToken)
  const haConfig = metadata.ha_config || {}
  const envConfig = haConfig[environmentId] || {}
  const visibleEntityIds = envConfig.visible_entity_ids
  return Array.isArray(visibleEntityIds) ? visibleEntityIds : []
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
  return { payload, isAdmin }
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const environmentId = event.queryStringParameters?.environmentId
    if (!environmentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
    }

    const { isAdmin } = await verifyAuth(event)
    const { baseUrl, token } = getHaConfig(environmentId)
    const domain = getEnv('AUTH0_DOMAIN')
    const visibleEntityIds = isAdmin ? null : await getVisibleEntityIds(domain, environmentId)

    if (!isAdmin && visibleEntityIds.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ entities: [] }) }
    }

    const response = await fetch(`${baseUrl}/api/states`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Unable to fetch Home Assistant state' }) }
    }

    const data = await response.json()
    const entities = Array.isArray(data)
      ? data.map((entity) => ({
        entity_id: entity.entity_id,
        state: entity.state,
        domain: String(entity.entity_id || '').split('.')[0] || 'unknown',
        friendly_name: entity.attributes?.friendly_name || entity.entity_id,
      }))
      : []

    const filteredEntities = isAdmin
      ? entities
      : entities.filter((entity) => visibleEntityIds.includes(entity.entity_id))

    return {
      statusCode: 200,
      body: JSON.stringify({ entities: filteredEntities }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
    }
  }
}
