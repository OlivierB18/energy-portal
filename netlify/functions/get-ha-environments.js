import { createRemoteJWKSet, jwtVerify } from 'jose'
import { getMergedEnvironments } from './_environment-storage.js'

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

const normalizeConfigValue = (value) => (value ? String(value) : '')

const parseHaConfig = (rawValue) => {
  if (!rawValue) {
    return {}
  }

  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {}
}

const getEnvironmentNames = (metadata = {}) => {
  const haConfig = parseHaConfig(metadata.ha_config)
  const rawMap = haConfig.environment_names

  if (!rawMap) {
    return {}
  }

  const map = typeof rawMap === 'string'
    ? (() => {
        try {
          const parsed = JSON.parse(rawMap)
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        } catch {
          return {}
        }
      })()
    : (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap) ? rawMap : {})

  return Object.entries(map).reduce((acc, [id, name]) => {
    const normalizedId = String(id || '').trim()
    const normalizedName = String(name || '').trim()
    if (!normalizedId || !normalizedName) {
      return acc
    }
    acc[normalizedId] = normalizedName
    return acc
  }, {})
}

const mapMetadataEnvironments = (metadata) => {
  const envMap = metadata?.environments || {}
  return Object.entries(envMap).map(([id, env]) => {
    const config = env?.config || {}
    return {
      id,
      name: env?.name || id,
      type: env?.type || 'home_assistant',
      config: {
        baseUrl: normalizeConfigValue(config.base_url || config.baseUrl || env?.base_url || env?.url),
        apiKey: normalizeConfigValue(config.api_key || config.apiKey || env?.token),
        siteId: normalizeConfigValue(config.site_id || config.siteId),
        notes: normalizeConfigValue(config.notes),
      },
    }
  })
}

const mapLegacyHaEnvironments = (metadata) => {
  const haEnvironments = metadata?.ha_environments || {}
  return Object.entries(haEnvironments).map(([id, env]) => ({
    id,
    name: env?.name || id,
    type: 'home_assistant',
    config: {
      baseUrl: normalizeConfigValue(env?.base_url || env?.url),
      apiKey: normalizeConfigValue(env?.token),
      siteId: '',
      notes: '',
    },
  }))
}

const managementTokenCache = { token: null, expiresAt: 0 }
const metadataCache = { value: null, expiresAt: 0 }

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

const getCachedClientMetadata = async (domain, token) => {
  const now = Date.now()
  if (metadataCache.value && now < metadataCache.expiresAt) {
    return metadataCache.value
  }

  const metadata = await getClientMetadata(domain, token)
  metadataCache.value = metadata
  metadataCache.expiresAt = now + 60_000
  return metadata
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
  const response = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(userId)}?fields=email&include_fields=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  )

  if (!response.ok) {
    return ''
  }

  const data = await response.json()
  return typeof data.email === 'string' ? data.email.toLowerCase() : ''
}

const isAdminFromClaims = (payload, rolesClaim, email = '') => {
  const rolesValue = payload[rolesClaim]
  const roles = Array.isArray(rolesValue)
    ? rolesValue
    : typeof rolesValue === 'string'
      ? [rolesValue]
      : []
  const allowlist = (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || 'olivier@inside-out.tech')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
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

  const debugMode = (process.env.DEBUG_ADMIN || '').toLowerCase() === 'true'
  const debug = []

  const emailFromPayload = getEmailFromPayload(payload)
  if (emailFromPayload) debug.push({ source: 'id_token', email: emailFromPayload })
  const emailFromUserInfo = emailFromPayload ? '' : await getUserInfoEmail(domain, token)
  if (emailFromUserInfo) debug.push({ source: 'userinfo', email: emailFromUserInfo })
  const initialEmail = emailFromPayload || emailFromUserInfo
  const initialAdmin = isAdminFromClaims(payload, rolesClaim, initialEmail)

  if (initialAdmin) {
    if (debugMode) debug.push({ result: 'allowed_by_roles_or_allowlist' })
    return { isAdmin: true, debug: debugMode ? debug : undefined }
  }

  try {
    const managementToken = await getManagementToken(domain)
    const emailFromManagement = await getUserEmailFromManagement(domain, managementToken, payload.sub)
    if (emailFromManagement) debug.push({ source: 'management', email: emailFromManagement })
    const isAdmin = isAdminFromClaims(payload, rolesClaim, emailFromManagement)
    if (isAdmin) {
      if (debugMode) debug.push({ result: 'allowed_by_management' })
      return { isAdmin: true, debug: debugMode ? debug : undefined }
    }
  } catch (error) {
    if (debugMode) debug.push({ result: 'management_failed', message: error?.message })
  }

  if ((process.env.ADMIN_FAIL_OPEN || '').toLowerCase() === 'true') {
    if (debugMode) debug.push({ result: 'fail_open' })
    return { isAdmin: true, debug: debugMode ? debug : undefined }
  }

  if (debugMode) debug.push({ result: 'denied', roles: payload[rolesClaim] })
  return { isAdmin: false, debug: debugMode ? debug : undefined }
}

export const handler = async (event) => {
  console.log('get-ha-environments handler - METADATA MODE')
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    await verifyAuth(event)

    const domain = getEnv('AUTH0_DOMAIN')

    let metadata = {}
    let metadataWarning = null

    try {
      const managementToken = await getManagementToken(domain)
      metadata = await getCachedClientMetadata(domain, managementToken)
    } catch (error) {
      metadataWarning = error instanceof Error ? error.message : 'Unable to load metadata'
      console.warn('get-ha-environments metadata warning:', metadataWarning)
    }

    const { environments, source } = await getMergedEnvironments({
      event,
      metadata,
      getOptionalEnv,
    })

    const environmentNames = getEnvironmentNames(metadata)
    const environmentsWithNames = environments.map((env) => ({
      ...env,
      name: env.name || environmentNames[env.id] || env.id,
    }))

    if (environmentsWithNames.length === 0) {
      throw new Error('No environments configured')
    }

    console.log('Returning environments:', environmentsWithNames.length)

    return {
      statusCode: 200,
      body: JSON.stringify({
        environments: environmentsWithNames,
        source,
        ...(metadataWarning ? { warning: metadataWarning } : {}),
      }),
    }
  } catch (error) {
    console.error('get-ha-environments error:', error)
    const message = error instanceof Error ? error.message : 'Server error'
    const statusCode = message === 'Missing token' ? 401 : 500
    return {
      statusCode,
      body: JSON.stringify({
        error: message,
        details: 'Check Auth0 metadata and HA_* environment variables',
      }),
    }
  }
}


