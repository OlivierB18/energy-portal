import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
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

const updateClientMetadata = async (domain, token, metadata) => {
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_metadata: metadata }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || 'Unable to update app metadata')
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

const verifyAdmin = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing token')
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const rolesClaim = process.env.AUTH0_ROLES_CLAIM || 'https://brouwer-ems/roles'
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })

  if (!isAdminFromClaims(payload, rolesClaim)) {
    throw new Error('Admin only')
  }
}

const normalizeEnvironments = (environments) => {
  if (!Array.isArray(environments)) {
    return []
  }

  return environments
    .map((env) => ({
      id: String(env.id || '').trim(),
      name: String(env.name || '').trim(),
      url: String(env.url || '').trim(),
      token: String(env.token || '').trim(),
    }))
    .filter((env) => env.id && env.name && env.url && env.token)
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    await verifyAdmin(event)

    const body = JSON.parse(event.body || '{}')
    const environments = normalizeEnvironments(body.environments)

    if (environments.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No environments provided' }) }
    }

    const domain = getEnv('AUTH0_DOMAIN')
    const managementToken = await getManagementToken(domain)
    const metadata = await getClientMetadata(domain, managementToken)

    const nextMap = environments.reduce((acc, env) => {
      acc[env.id] = {
        name: env.name,
        base_url: env.url,
        token: env.token,
      }
      return acc
    }, {})

    await updateClientMetadata(domain, managementToken, {
      ...metadata,
      ha_environments: nextMap,
    })

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const statusCode = message === 'Admin only' ? 403 : 500
    return {
      statusCode,
      body: JSON.stringify({ error: message }),
    }
  }
}
