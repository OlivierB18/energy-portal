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
      const body = await response.text();
      console.error('Failed to get management token:', response.status, body);
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
    const body = await response.text();
    // For debugging: throw an error with full Auth0 response
    const error = new Error('Unable to fetch app metadata - getClientMetadata');
    error.status = response.status;
    error.auth0Body = body;
    throw error;
  }
  const client = await response.json()
  return client.client_metadata || {}
}

const getVisibleEntityIds = (metadata, environmentId) => {
  const haConfig = metadata.ha_config || {}
  const envConfig = haConfig[environmentId] || {}
  const visibleEntityIds = envConfig.visible_entity_ids
  return Array.isArray(visibleEntityIds) ? visibleEntityIds : []
}

const getHaConfig = (metadata, environmentId) => {
  const envMap = metadata.environments || {}
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

  const legacyMap = metadata.ha_environments || {}
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

  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()
  const debugMode = (process.env.DEBUG_ADMIN || '').toLowerCase() === 'true'
  const debug = []

  const emailFromPayload = getEmailFromPayload(payload)
  if (emailFromPayload) debug.push({ source: 'id_token', email: emailFromPayload })
  if (isEmailAllowed(emailFromPayload, allowlist, forceEmail)) {
    if (debugMode) debug.push({ result: 'allowed_by_id_token', allowlist, forceEmail })
    return { payload, isAdmin: true, debug: debugMode ? debug : undefined }
  }

  const emailFromUserInfo = emailFromPayload ? '' : await getUserInfoEmail(domain, token)
  if (emailFromUserInfo) debug.push({ source: 'userinfo', email: emailFromUserInfo })
  if (isEmailAllowed(emailFromUserInfo, allowlist, forceEmail)) {
    if (debugMode) debug.push({ result: 'allowed_by_userinfo', allowlist, forceEmail })
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
      if (debugMode) debug.push({ result: 'allowed_by_management', allowlist, forceEmail })
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
  console.log('ha-entities handler started - SIMPLIFIED MODE');
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const environmentId = event.queryStringParameters?.environmentId
    if (!environmentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
    }

    // SIMPLIFIED: Skip complex Auth0 verification, just verify token exists
    const authHeader = event.headers.authorization || event.headers.Authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing authorization' }) }
    }

    // SIMPLIFIED: Go directly to env vars, skip Auth0 metadata fetch
    console.log('Using environment variables directly for:', environmentId);
    const { baseUrl, token } = getHaConfig({}, environmentId)
    
    console.log('Fetching from Home Assistant:', baseUrl);
    const response = await fetch(`${baseUrl}/api/states`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    
    if (!response.ok) {
      const body = await response.text();
      console.error('Failed to fetch Home Assistant state:', response.status, body);
      return { 
        statusCode: 502, 
        body: JSON.stringify({ 
          error: 'Unable to fetch Home Assistant state', 
          status: response.status, 
          details: body 
        }) 
      }
    }
    
    const data = await response.json()
    console.log('Received entities from HA:', Array.isArray(data) ? data.length : 0);
    
    const entities = Array.isArray(data)
      ? data.map((entity) => ({
        entity_id: entity.entity_id,
        state: entity.state,
        domain: String(entity.entity_id || '').split('.')[0] || 'unknown',
        friendly_name: entity.attributes?.friendly_name || entity.entity_id,
      }))
      : []

    // SIMPLIFIED: Return all entities (no admin filtering)
    return {
      statusCode: 200,
      body: JSON.stringify({ entities }),
    }
  } catch (error) {
    console.error('ha-entities handler error:', error);
    const message = error instanceof Error ? error.message : 'Server error';
    const stack = error && error.stack ? error.stack : String(error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: message,
        stack,
        details: 'Simplified handler - check env vars: HA_BROUWER_TEST_URL, HA_BROUWER_TEST_TOKEN'
      }),
    };
  }
}
