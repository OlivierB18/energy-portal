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
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

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

    const isAdmin = await verifyAdmin(domain, token, payload, rolesClaim)
    if (!isAdmin) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Admin only' }) }
    }

    const body = JSON.parse(event.body || '{}')
    const userId = body.userId?.trim()
    const environmentIds = Array.isArray(body.environmentIds)
      ? body.environmentIds.map((env) => String(env))
      : []
    const environmentId = body.environmentId?.trim()
    const visibleSensorIds = Array.isArray(body.visibleSensorIds)
      ? body.visibleSensorIds.map((id) => String(id))
      : []

    if (!userId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'User ID is required' }) }
    }

    const managementToken = await getManagementToken(domain)
    let userMetadataUpdate = {}

    // If environmentId and visibleSensorIds are provided, update sensor visibility
    if (environmentId && visibleSensorIds.length >= 0) {
        console.log('[UPDATE-USER] Updating sensor visibility for user:', userId, 'env:', environmentId, 'sensors:', visibleSensorIds.length)
      try {
        const currentUser = await getUserMetadata(domain, managementToken, userId)
        const currentUserMetadata = currentUser.user_metadata || {}
        const haConfig = currentUserMetadata.ha_config || {}

        userMetadataUpdate = {
          user_metadata: {
            ...currentUserMetadata,
            ha_config: {
              ...haConfig,
              [environmentId]: {
                visible_entity_ids: visibleSensorIds,
                updated_at: new Date().toISOString(),
              },
            },
          },
        }
        console.log('[UPDATE-USER] Prepared userMetadataUpdate')
      } catch (metadataError) {
        console.error('Failed to update user metadata:', metadataError)
        throw new Error('Unable to get user metadata for sensor config')
      }
    }

    const appMetadataUpdate = environmentIds.length > 0 ? { environmentIds } : {}
      console.log('[UPDATE-USER] appMetadata keys:', Object.keys(appMetadataUpdate), 'userMetadata keys:', Object.keys(userMetadataUpdate))

    const user = await updateUserMetadata(
      domain,
      managementToken,
      userId,
      appMetadataUpdate,
      userMetadataUpdate,
    )

    return {
      statusCode: 200,
      body: JSON.stringify({
        user: {
          user_id: user.user_id,
          environmentIds: Array.isArray(user.app_metadata?.environmentIds)
            ? user.app_metadata.environmentIds
            : [],
        },
      }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
    }
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

const isAdminFromClaims = (payload, rolesClaim) => {
  const rolesValue = payload[rolesClaim]
  const roles = Array.isArray(rolesValue)
    ? rolesValue
    : typeof rolesValue === 'string'
      ? [rolesValue]
      : []
  return roles.includes('admin')
}

const verifyAdmin = async (domain, token, payload, rolesClaim) => {
  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()

  const emailFromPayload = getEmailFromPayload(payload)
  if (isEmailAllowed(emailFromPayload, allowlist, forceEmail)) {
    return true
  }

  const emailFromUserInfo = emailFromPayload ? '' : await getUserInfoEmail(domain, token)
  if (isEmailAllowed(emailFromUserInfo, allowlist, forceEmail)) {
    return true
  }

  if (isAdminFromClaims(payload, rolesClaim)) {
    return true
  }

  try {
    const managementToken = await getManagementToken(domain)
    const emailFromManagement = await getUserEmailFromManagement(domain, managementToken, payload.sub)
    if (isEmailAllowed(emailFromManagement, allowlist, forceEmail)) {
      return true
    }
  } catch {
    // Ignore management fallback errors and continue normal deny path.
  }

  if ((process.env.ADMIN_FAIL_OPEN || '').toLowerCase() === 'true') {
    return true
  }

  return false
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

const updateUserMetadata = async (domain, token, userId, appMetadata = {}, userMetadata = {}) => {
  const body = {}
  if (Object.keys(appMetadata).length > 0) {
    body.app_metadata = appMetadata
  }
  if (Object.keys(userMetadata).length > 0) {
    body.user_metadata = userMetadata.user_metadata
  }

  if (Object.keys(body).length === 0) {
    console.log('[UPDATE-USER] Empty body, skipping PATCH')
    // Nothing to update
    return { user_id: userId }
  }

  console.log('[UPDATE-USER] Patching user with body keys:', Object.keys(body))
  const response = await fetch(`https://${domain}/api/v2/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    console.log('[UPDATE-USER] PATCH failed with status:', response.status)
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || 'Unable to update user')
  }

  console.log('[UPDATE-USER] Successfully patched user')
  return response.json()
}

const getUserMetadata = async (domain, token, userId) => {
  const response = await fetch(`https://${domain}/api/v2/users/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || 'Unable to fetch user')
  }

  return response.json()
}
