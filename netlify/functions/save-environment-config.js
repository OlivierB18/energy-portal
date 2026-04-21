import { createRemoteJWKSet, jwtVerify } from 'jose'
import { resolveEnvironmentReference, stripShardedEnvironmentMetadata } from './_environment-storage.js'

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

const getOwnerEmail = () => (process.env.OWNER_EMAIL || '').trim().toLowerCase()

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
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
  const ownerEmail = getOwnerEmail()
  const isOwner = ownerEmail.length > 0 && email === ownerEmail
  const isAllowedEmail = email.length > 0 && (allowlist.includes(email) || (forceEmail && email === forceEmail))
  return roles.includes('admin') || isOwner || isAllowedEmail
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

  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()
  const ownerEmail = getOwnerEmail()
  const debugMode = (process.env.DEBUG_ADMIN || '').toLowerCase() === 'true'
  const debug = []

  const emailFromPayload = getEmailFromPayload(payload)
  if (emailFromPayload) debug.push({ source: 'id_token', email: emailFromPayload })
  if ((ownerEmail && emailFromPayload === ownerEmail) || isEmailAllowed(emailFromPayload, allowlist, forceEmail)) {
    if (debugMode) debug.push({ result: 'allowed_by_id_token' })
    return
  }

  const emailFromUserInfo = emailFromPayload ? '' : await getUserInfoEmail(domain, token)
  if (emailFromUserInfo) debug.push({ source: 'userinfo', email: emailFromUserInfo })
  if ((ownerEmail && emailFromUserInfo === ownerEmail) || isEmailAllowed(emailFromUserInfo, allowlist, forceEmail)) {
    if (debugMode) debug.push({ result: 'allowed_by_userinfo' })
    return
  }

  const initialEmail = emailFromPayload || emailFromUserInfo
  const initialAdmin = isAdminFromClaims(payload, rolesClaim, initialEmail)
  if (initialAdmin) {
    if (debugMode) debug.push({ result: 'allowed_by_roles' })
    return
  }

  try {
    const managementToken = await getManagementToken(domain)
    const emailFromManagement = await getUserEmailFromManagement(domain, managementToken, payload.sub)
    if (emailFromManagement) debug.push({ source: 'management', email: emailFromManagement })
    if (isAdminFromClaims(payload, rolesClaim, emailFromManagement)) {
      if (debugMode) debug.push({ result: 'allowed_by_management' })
      return
    }
  } catch (error) {
    if (debugMode) debug.push({ result: 'management_failed', message: error?.message })
  }

  const err = new Error('Admin only')
  if (debugMode) err.debug = debug
  throw err
}

const parseEnvironmentMap = (input) => {
  if (!input) {
    return {}
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

const parseHaConfig = (input) => {
  if (!input) {
    return {}
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

const sanitizeClientMetadata = (metadata) => {
  const haConfig = parseHaConfig(metadata?.ha_config)

  return {
    ...stripShardedEnvironmentMetadata(metadata),
    environments: null,
    ha_environments: null,
    ha_config: JSON.stringify(haConfig),
  }
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    await verifyAdmin(event)

    const body = JSON.parse(event.body || '{}')
    const requestedEnvironmentId = body.environmentId?.trim()
    const visibleEntityIds = Array.isArray(body.visibleEntityIds)
      ? body.visibleEntityIds.map((entityId) => String(entityId))
      : []

    if (!requestedEnvironmentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
    }

    const domain = getEnv('AUTH0_DOMAIN')
    const managementToken = await getManagementToken(domain)
    const metadata = await getClientMetadata(domain, managementToken)
    const haConfig = parseHaConfig(metadata.ha_config)

    const resolvedReference = await resolveEnvironmentReference({
      event,
      metadata,
      environmentId: requestedEnvironmentId,
      getOptionalEnv,
    })
    const environmentId = resolvedReference.environmentId
    const aliases = resolvedReference.aliases

    const nextConfig = {
      ...haConfig,
      [environmentId]: {
        visible_entity_ids: visibleEntityIds,
        updated_at: new Date().toISOString(),
      },
    }

    aliases
      .filter((alias) => alias && alias !== environmentId)
      .forEach((alias) => {
        delete nextConfig[alias]
      })

    await updateClientMetadata(domain, managementToken, {
      ...sanitizeClientMetadata(metadata),
      ha_config: JSON.stringify(nextConfig),
    })

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const statusCode = message === 'Admin only' ? 403 : 500
    const resp = { error: message }
    const debugMode = (process.env.DEBUG_ADMIN || '').toLowerCase() === 'true'
    if (debugMode && error && error.debug) {
      resp.debug = error.debug
    }
    return {
      statusCode,
      body: JSON.stringify(resp),
    }
  }
}
