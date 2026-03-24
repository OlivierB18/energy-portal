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

const managementTokenCache = { token: null, expiresAt: 0 }
const metadataCache = { value: null, expiresAt: 0 }

const getManagementToken = async (domain) => {
  const now = Date.now()
  if (managementTokenCache.token && now < managementTokenCache.expiresAt - 60000) {
    return managementTokenCache.token
  }

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
    const body = await response.text()
    console.error('[StatisticIds] Failed to get management token:', response.status, body)
    throw new Error('Unable to get management token')
  }

  const data = await response.json()
  const expiresIn = Number(data.expires_in) || 600
  managementTokenCache.token = data.access_token
  managementTokenCache.expiresAt = Date.now() + expiresIn * 1000
  return managementTokenCache.token
}

const getCachedClientMetadata = async (domain, token) => {
  const now = Date.now()
  if (metadataCache.value && now < metadataCache.expiresAt) {
    return metadataCache.value
  }

  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error('Unable to fetch app metadata')
  }
  const client = await response.json()
  const metadata = client.client_metadata || {}
  metadataCache.value = metadata
  metadataCache.expiresAt = now + 60_000
  return metadata
}

const getOwnerEmail = () => (process.env.OWNER_EMAIL || '').trim().toLowerCase()

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

const isAdminEmail = (email) => {
  if (!email) return false
  const ownerEmail = getOwnerEmail()
  if (ownerEmail && email === ownerEmail) return true
  return getAdminAllowlist().includes(email)
}

const verifyAuthAndAdmin = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw Object.assign(new Error('Missing authorization header'), { statusCode: 401 })
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })

  const emailValue = payload.email || payload['https://brouwer-ems/email']
  const email = typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
  const isAdmin = isAdminEmail(email)

  return { payload, isAdmin, userId: payload.sub }
}

const getUserAppMetadata = async (domain, userId) => {
  const managementToken = await getManagementToken(domain)
  const response = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(userId)}?fields=app_metadata&include_fields=true`,
    { headers: { Authorization: `Bearer ${managementToken}` } },
  )
  if (!response.ok) {
    throw new Error('Unable to fetch user metadata')
  }
  const user = await response.json()
  return user.app_metadata || {}
}

export const handler = async (event) => {
  try {
    let authResult
    try {
      authResult = await verifyAuthAndAdmin(event)
    } catch (authErr) {
      const statusCode = authErr.statusCode || 401
      console.error('[StatisticIds] Auth failed:', authErr.message)
      return {
        statusCode,
        body: JSON.stringify({ error: authErr.message || 'Unauthorized' }),
      }
    }

    const { isAdmin, userId } = authResult

    const environmentId = event.queryStringParameters?.environmentId
    if (!environmentId) {
      console.error('[StatisticIds] Missing environmentId parameter')
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing environmentId parameter' }),
      }
    }

    // Non-admin users may only access environments they are assigned to
    if (!isAdmin) {
      try {
        const domain = getEnv('AUTH0_DOMAIN')
        const appMetadata = await getUserAppMetadata(domain, userId)
        const allowedEnvIds = Array.isArray(appMetadata.environmentIds) ? appMetadata.environmentIds : []
        if (!allowedEnvIds.includes(environmentId)) {
          return { statusCode: 403, body: JSON.stringify({ error: 'Access denied to this environment' }) }
        }
      } catch (metaErr) {
        console.error('[StatisticIds] Failed to verify environment access:', metaErr?.message || metaErr)
        return { statusCode: 403, body: JSON.stringify({ error: 'Unable to verify environment access' }) }
      }
    }

    console.log('[StatisticIds] Request for environment:', environmentId)

    let haConfig
    try {
      const domain = getEnv('AUTH0_DOMAIN')
      let metadata = {}
      try {
        const managementToken = await getManagementToken(domain)
        metadata = await getCachedClientMetadata(domain, managementToken)
      } catch (metadataError) {
        console.warn('[StatisticIds] Metadata unavailable, using fallback:', metadataError?.message || metadataError)
      }

      haConfig = await resolveEnvironmentConfig({
        event,
        metadata,
        environmentId,
        getOptionalEnv,
      })
      console.log('[StatisticIds] Got HA config, URL host:', new URL(haConfig.baseUrl).hostname)
    } catch (err) {
      console.error('[StatisticIds] Failed to get HA config:', err.message || err)
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Failed to retrieve Home Assistant config',
          details: err instanceof Error ? err.message : String(err),
        }),
      }
    }

    const { baseUrl, token: haToken } = haConfig

    const statisticIdsUrl = new URL(baseUrl)
    statisticIdsUrl.pathname = '/api/recorder/list_statistic_ids'
    statisticIdsUrl.searchParams.set('statistic_type', 'sum')

    console.log('[StatisticIds] Fetching from HA:', statisticIdsUrl.toString())

    let haResponse
    try {
      haResponse = await fetch(statisticIdsUrl.toString(), {
        headers: {
          Authorization: `Bearer ${haToken}`,
          'Content-Type': 'application/json',
        },
      })
    } catch (fetchErr) {
      console.error('[StatisticIds] Network fetch failed:', fetchErr.message)
      return {
        statusCode: 503,
        body: JSON.stringify({
          error: 'Failed to connect to Home Assistant',
          details: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        }),
      }
    }

    if (!haResponse.ok) {
      const errorBody = await haResponse.text()
      console.error('[StatisticIds] HA API error', haResponse.status, errorBody)
      return {
        statusCode: haResponse.status,
        body: JSON.stringify({
          error: `Home Assistant API error: ${haResponse.status}`,
          details: errorBody,
        }),
      }
    }

    const allStatistics = await haResponse.json()
    const rawList = Array.isArray(allStatistics) ? allStatistics : []

    console.log('[StatisticIds] HA returned', rawList.length, 'total statistic IDs')

    const energyStatistics = rawList.filter(
      (item) => item?.unit_class === 'energy' && item?.has_sum === true,
    )

    const statisticIds = energyStatistics.map((item) => item.statistic_id).filter(Boolean)

    console.log('[StatisticIds] Filtered to', statisticIds.length, 'energy statistic IDs:', statisticIds.join(', '))

    return {
      statusCode: 200,
      body: JSON.stringify({ statistic_ids: statisticIds }),
    }
  } catch (error) {
    console.error('[StatisticIds] Unexpected error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Server error',
      }),
    }
  }
}
