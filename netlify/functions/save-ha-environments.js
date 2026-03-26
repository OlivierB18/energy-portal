import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const managementTokenCache = { token: null, expiresAt: 0 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const getManagementToken = async (domain) => {
  const now = Date.now()
  if (managementTokenCache.token && now < managementTokenCache.expiresAt - 60000) {
    return managementTokenCache.token
  }

  const fetchToken = async () => {
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

    return response.json()
  }

  try {
    const data = await fetchToken()
    const expiresIn = Number(data.expires_in) || 600
    managementTokenCache.token = data.access_token
    managementTokenCache.expiresAt = Date.now() + expiresIn * 1000
    return managementTokenCache.token
  } catch (error) {
    await sleep(200)
    const data = await fetchToken()
    const expiresIn = Number(data.expires_in) || 600
    managementTokenCache.token = data.access_token
    managementTokenCache.expiresAt = Date.now() + expiresIn * 1000
    return managementTokenCache.token
  }
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

const getEmailFromPayload = (payload) => {
  const emailValue = payload.email || payload['https://brouwer-ems/email'] || payload['email']
  return typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
}

const getUserInfoEmail = async (domain, token) => {
  const response = await fetch(`https://${domain}/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    return ''
  }

  const data = await response.json()
  return typeof data.email === 'string' ? data.email.toLowerCase() : ''
}

const getUserEmailFromManagement = async (domain, token, userId) => {
  if (!userId) {
    return ''
  }

  const response = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(userId)}?fields=email&include_fields=true`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  )

  if (!response.ok) {
    return ''
  }

  const data = await response.json()
  return typeof data.email === 'string' ? data.email.toLowerCase() : ''
}

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || 'olivier@inside-out.tech')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

const getForceEmail = () => (process.env.ADMIN_FORCE_EMAIL || '').trim().toLowerCase()

const isEmailAllowed = (email, allowlist, forceEmail) => {
  if (!email) {
    return false
  }

  if (forceEmail && email === forceEmail) {
    return true
  }

  return allowlist.includes(email)
}

const hasAdminRoleClaim = (payload, rolesClaim) => {
  const rolesValue = payload[rolesClaim]
  const roles = Array.isArray(rolesValue)
    ? rolesValue
    : typeof rolesValue === 'string'
      ? [rolesValue]
      : []
  return roles.includes('admin')
}

const verifyAdmin = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing token')
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const rolesClaim = process.env.AUTH0_ROLES_CLAIM || 'https://brouwer-ems/roles'
  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })

  const emailFromPayload = getEmailFromPayload(payload)
  if (isEmailAllowed(emailFromPayload, allowlist, forceEmail)) {
    return
  }

  const emailFromUserInfo = emailFromPayload ? '' : await getUserInfoEmail(domain, token)
  if (isEmailAllowed(emailFromUserInfo, allowlist, forceEmail)) {
    return
  }

  if (hasAdminRoleClaim(payload, rolesClaim)) {
    return
  }

  try {
    const managementToken = await getManagementToken(domain)
    const emailFromManagement = await getUserEmailFromManagement(domain, managementToken, payload.sub)
    if (isEmailAllowed(emailFromManagement, allowlist, forceEmail)) {
      return
    }
  } catch {
    // Ignore management fallback errors and continue normal deny path.
  }

  if ((process.env.ADMIN_FAIL_OPEN || '').toLowerCase() === 'true') {
    return
  }

  throw new Error('Admin only')
}

const normalizeEnvironments = (environments) => {
  if (!Array.isArray(environments)) {
    return []
  }

  return environments
    .map((env) => ({
      id: String(env.id || '').trim(),
      name: String(env.name || '').trim(),
      type: String(env.type || 'home_assistant').trim(),
      config: {
        baseUrl: String(env.config?.baseUrl || env.baseUrl || env.url || '').trim(),
        apiKey: String(env.config?.apiKey || env.apiKey || env.token || '').trim(),
        siteId: String(env.config?.siteId || env.siteId || '').trim(),
        notes: String(env.config?.notes || env.notes || '').trim(),
      },
    }))
    .filter((env) => env.id && env.name)
}

const parseEnvironmentMap = (rawValue) => {
  if (!rawValue) {
    return {}
  }

  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  return rawValue && typeof rawValue === 'object' ? rawValue : {}
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
    const currentEnvironmentMap = {
      ...parseEnvironmentMap(metadata.environments),
      ...parseEnvironmentMap(metadata.ha_environments),
    }

    const nextMap = environments.reduce((acc, env) => {
      acc[env.id] = {
        name: env.name,
        type: env.type,
        config: {
          base_url: env.config.baseUrl,
          api_key: env.config.apiKey,
          site_id: env.config.siteId,
          notes: env.config.notes,
        },
      }
      return acc
    }, {})

    const mergedEnvironments = {
      ...currentEnvironmentMap,
      ...nextMap,
    }

    await updateClientMetadata(domain, managementToken, {
      ...metadata,
      // Auth0 can enforce strict schemas on `environments` (string<=255 or null).
      environments: null,
      ha_environments: mergedEnvironments,
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
