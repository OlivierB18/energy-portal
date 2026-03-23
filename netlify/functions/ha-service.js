import { createRemoteJWKSet, jwtVerify } from 'jose'
import { resolveEnvironmentConfig } from './_environment-storage.js'

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
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
}

const ENV_METADATA_PREFIX = 'ha_env_v1_'

const ALLOWED_ACTIONS = {
  switch: ['turn_on', 'turn_off', 'toggle'],
  light: ['turn_on', 'turn_off', 'toggle'],
  input_boolean: ['turn_on', 'turn_off', 'toggle'],
  button: ['press'],
  script: ['turn_on'],
  scene: ['turn_on'],
}

const parseEnvironmentMap = (rawValue) => {
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

const decodeEnvironmentId = (encodedId) => {
  try {
    return Buffer.from(String(encodedId || ''), 'base64url').toString('utf8').trim()
  } catch {
    return ''
  }
}

const parseShardedEnvironmentMap = (metadata = {}) => {
  const entries = Object.keys(metadata || {}).filter(
    (key) => key.startsWith(ENV_METADATA_PREFIX) && key.endsWith('_url'),
  )

  return entries.reduce((acc, urlKey) => {
    const encodedId = urlKey.slice(ENV_METADATA_PREFIX.length, -'_url'.length)
    const environmentId = decodeEnvironmentId(encodedId)
    if (!environmentId) {
      return acc
    }

    const baseUrl = String(metadata[urlKey] || '').trim()
    const apiKey = String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_token`] || '').trim()
    if (!baseUrl || !apiKey) {
      return acc
    }

    acc[environmentId] = {
      name: String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_name`] || environmentId).trim() || environmentId,
      type: String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_type`] || 'home_assistant').trim() || 'home_assistant',
      config: {
        base_url: baseUrl,
        api_key: apiKey,
        site_id: String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_site_id`] || '').trim(),
        notes: String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_notes`] || '').trim(),
      },
    }
    return acc
  }, {})
}

const getStoredEnvironmentMap = (metadata = {}) => {
  const haConfig = parseHaConfig(metadata.ha_config)

  return {
    ...parseEnvironmentMap(metadata.environments),
    ...parseEnvironmentMap(metadata.ha_environments),
    ...parseEnvironmentMap(haConfig.__environments),
    ...parseShardedEnvironmentMap(metadata),
  }
}

const getHaConfig = (metadata, environmentId) => {
  const envMap = getStoredEnvironmentMap(metadata)
  const envConfig = envMap[environmentId]

  if (envConfig) {
    if (envConfig.type && envConfig.type !== 'home_assistant') {
      throw new Error('Environment is not Home Assistant')
    }

    const config = envConfig.config || {}
    const baseUrl = config.base_url || config.baseUrl || envConfig.base_url || envConfig.url
    const token = config.api_key || config.apiKey || envConfig.token
    if (baseUrl && token) {
      return { baseUrl, token }
    }
  }

  const legacyMap = parseEnvironmentMap(metadata.ha_environments)
  const legacy = legacyMap[environmentId]
  if (legacy) {
    const baseUrl = legacy.base_url || legacy.url
    const token = legacy.token
    if (baseUrl && token) {
      return { baseUrl, token }
    }
  }

  const fallback = HA_ENVIRONMENTS[environmentId]
  if (!fallback) {
    throw new Error('Unknown environment')
  }

  return {
    baseUrl: getEnv(fallback.urlEnv),
    token: getEnv(fallback.tokenEnv),
  }
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

const getVisibleEntityIds = (metadata, environmentId) => {
  const haConfig = parseHaConfig(metadata.ha_config)
  const envConfig = haConfig[environmentId] || {}
  const visibleEntityIds = envConfig.visible_entity_ids
  return Array.isArray(visibleEntityIds) ? visibleEntityIds : []
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

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || 'olivier@inside-out.tech')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

const getForceEmail = () => (process.env.ADMIN_FORCE_EMAIL || '').trim().toLowerCase()

const isEmailAllowed = (email, allowlist, forceEmail) => {
  if (!email) return false
  if (forceEmail && email === forceEmail) return true
  return allowlist.includes(email)
}

const isAdminFromClaims = (payload, rolesClaim, email = '') => {
  const rolesValue = payload[rolesClaim]
  const roles = Array.isArray(rolesValue)
    ? rolesValue
    : typeof rolesValue === 'string'
      ? [rolesValue]
      : []
  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()
  const isAllowedEmail = email.length > 0 && (allowlist.includes(email) || (forceEmail && email === forceEmail))
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

  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()
  const debugMode = (process.env.DEBUG_ADMIN || '').toLowerCase() === 'true'
  const debug = []

  const emailFromPayload = getEmailFromPayload(payload)
  if (emailFromPayload) debug.push({ source: 'id_token', email: emailFromPayload })
  if (isEmailAllowed(emailFromPayload, allowlist, forceEmail)) {
    if (debugMode) debug.push({ result: 'allowed_by_id_token' })
    return { payload, isAdmin: true, debug: debugMode ? debug : undefined }
  }

  const emailFromUserInfo = emailFromPayload ? '' : await getUserInfoEmail(domain, token)
  if (emailFromUserInfo) debug.push({ source: 'userinfo', email: emailFromUserInfo })
  if (isEmailAllowed(emailFromUserInfo, allowlist, forceEmail)) {
    if (debugMode) debug.push({ result: 'allowed_by_userinfo' })
    return { payload, isAdmin: true, debug: debugMode ? debug : undefined }
  }

  const initialEmail = emailFromPayload || emailFromUserInfo
  const initialAdmin = isAdminFromClaims(payload, rolesClaim, initialEmail)
  if (initialAdmin) {
    if (debugMode) debug.push({ result: 'allowed_by_roles', roles: payload[rolesClaim] })
    return { payload, isAdmin: true, debug: debugMode ? debug : undefined }
  }

  try {
    const managementToken = await getManagementToken(domain)
    const emailFromManagement = await getUserEmailFromManagement(domain, managementToken, payload.sub)
    if (emailFromManagement) debug.push({ source: 'management', email: emailFromManagement })
    if (isEmailAllowed(emailFromManagement, allowlist, forceEmail)) {
      if (debugMode) debug.push({ result: 'allowed_by_management' })
      return { payload, isAdmin: true, debug: debugMode ? debug : undefined }
    }
    const isAdmin = isAdminFromClaims(payload, rolesClaim, emailFromManagement)
    if (isAdmin) {
      if (debugMode) debug.push({ result: 'allowed_by_management_roles', roles: payload[rolesClaim] })
      return { payload, isAdmin: true, debug: debugMode ? debug : undefined }
    }
  } catch (error) {
    if (debugMode) debug.push({ result: 'management_fetch_failed', message: error?.message })
  }

  if ((process.env.ADMIN_FAIL_OPEN || '').toLowerCase() === 'true') {
    if (debugMode) debug.push({ result: 'fail_open' })
    return { payload, isAdmin: true, debug: debugMode ? debug : undefined }
  }

  if (debugMode) debug.push({ result: 'denied', allowlist, forceEmail, roles: payload[rolesClaim] })
  return { payload, isAdmin: false, debug: debugMode ? debug : undefined }
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const { isAdmin, debug } = await verifyAuth(event)
    const body = JSON.parse(event.body || '{}')
    const environmentId = body.environmentId?.trim()
    const entityId = body.entityId?.trim()
    const action = body.action?.trim()

    if (!environmentId || !entityId || !action) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters' }) }
    }

    const entityDomain = String(entityId).split('.')[0]
    const allowedActions = ALLOWED_ACTIONS[entityDomain] || []

    if (!allowedActions.includes(action)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Action not allowed' }) }
    }

    const auth0Domain = getEnv('AUTH0_DOMAIN')
    let metadata = null

    try {
      const managementToken = await getManagementToken(auth0Domain)
      metadata = await getClientMetadata(auth0Domain, managementToken)
    } catch (error) {
      // Fallback to local env defaults even for admins if Auth0 metadata fetch fails
      metadata = {}
      if (!isAdmin) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Entity not permitted' }) }
      }
    }

    const resolvedMetadata = metadata || {}

    if (!isAdmin) {
      const visibleEntityIds = getVisibleEntityIds(resolvedMetadata, environmentId)
      if (!visibleEntityIds.includes(entityId)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Entity not permitted' }) }
      }
    }

    const { baseUrl, token } = await resolveEnvironmentConfig({
      event,
      metadata: resolvedMetadata,
      environmentId,
      getOptionalEnv,
    })

    const response = await fetch(`${baseUrl}/api/services/${entityDomain}/${action}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entity_id: entityId }),
    })

    if (!response.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Home Assistant action failed' }) }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const resp = { error: message }
    const debugMode = (process.env.DEBUG_ADMIN || '').toLowerCase() === 'true'
    if (debugMode) {
      if (error && error.debug) resp.debug = error.debug
      if (typeof debug !== 'undefined') resp.debug = resp.debug ? resp.debug.concat(debug) : debug
    }
    return {
      statusCode: 500,
      body: JSON.stringify(resp),
    }
  }
}
