/**
 * Get hourly gas consumption by reading meter every hour
 * Each hour: current_meter_value - previous_hour_meter_value = consumption
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import { resolveEnvironmentConfig } from './_environment-storage.js'
import { checkEnvironmentAccess, isStaticAdmin } from './_access-control.js'
import { createServiceSupabaseClient } from './_supabase.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

const getOptionalEnv = (key) => {
  const value = process.env[key]
  return value && value.trim().length > 0 ? value : null
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
  } catch {
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

const HA_ENVIRONMENTS = {
  vacation: { urlEnv: 'HA_BROUWER_TEST_URL', tokenEnv: 'HA_BROUWER_TEST_TOKEN' },
  'Brouwer TEST': { urlEnv: 'HA_BROUWER_TEST_URL', tokenEnv: 'HA_BROUWER_TEST_TOKEN' },
  brouwer: { urlEnv: 'HA_BROUWER_TEST_URL', tokenEnv: 'HA_BROUWER_TEST_TOKEN' },
}

const normalizeValue = (value) => (value ? String(value).trim() : '')
const ENV_METADATA_PREFIX = 'ha_env_v1_'

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

const getUserInfoEmail = async (domain, token) => {
  try {
    const response = await fetch(`https://${domain}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return ''
    const data = await response.json()
    return typeof data.email === 'string' ? data.email.toLowerCase() : ''
  } catch {
    return ''
  }
}

const getUserEmailFromManagement = async (domain, managementToken, userId) => {
  try {
    const response = await fetch(
      `https://${domain}/api/v2/users/${encodeURIComponent(userId)}?fields=email&include_fields=true`,
      { headers: { Authorization: `Bearer ${managementToken}` } },
    )
    if (!response.ok) return ''
    const data = await response.json()
    return typeof data.email === 'string' ? data.email.toLowerCase() : ''
  } catch {
    return ''
  }
}

const verifyAuthAndAdmin = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw Object.assign(new Error('Missing auth'), { statusCode: 401 })
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })

  let resolvedEmail = ''
  const emailValue = payload.email || payload['https://brouwer-ems/email']
  resolvedEmail = typeof emailValue === 'string' ? emailValue.toLowerCase() : ''

  if (!resolvedEmail) {
    resolvedEmail = await getUserInfoEmail(domain, token)
  }

  if (!resolvedEmail) {
    try {
      const mgmtToken = await getManagementToken(domain)
      resolvedEmail = await getUserEmailFromManagement(domain, mgmtToken, payload.sub)
    } catch {
      // ignore
    }
  }

  const isAdmin = isAdminEmail(resolvedEmail)
  console.log('[Gas Hourly] Auth resolved: email=', resolvedEmail || '(empty)', 'isAdmin=', isAdmin)

  return { payload, isAdmin, resolvedEmail, userId: payload.sub }
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

    const baseUrl = normalizeValue(metadata[urlKey])
    const apiKey = normalizeValue(metadata[`${ENV_METADATA_PREFIX}${encodedId}_token`])
    if (!baseUrl || !apiKey) {
      return acc
    }

    acc[environmentId] = {
      name: normalizeValue(metadata[`${ENV_METADATA_PREFIX}${encodedId}_name`]) || environmentId,
      type: normalizeValue(metadata[`${ENV_METADATA_PREFIX}${encodedId}_type`]) || 'home_assistant',
      config: {
        base_url: baseUrl,
        api_key: apiKey,
        site_id: normalizeValue(metadata[`${ENV_METADATA_PREFIX}${encodedId}_site_id`]),
        notes: normalizeValue(metadata[`${ENV_METADATA_PREFIX}${encodedId}_notes`]),
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

const resolveHaConfigFromMetadata = (metadata, environmentId) => {
  const requestedId = normalizeValue(environmentId)
  const lowerRequested = requestedId.toLowerCase()

  const envMap = getStoredEnvironmentMap(metadata)
  const environmentEntry = Object.entries(envMap).find(([id]) => (
    id === requestedId ||
    id.toLowerCase() === lowerRequested
  ))

  if (environmentEntry) {
    const [, env] = environmentEntry
    const config = env?.config || {}
    const baseUrl = normalizeValue(config.base_url || config.baseUrl || env?.base_url || env?.url)
    const token = normalizeValue(config.api_key || config.apiKey || env?.token)
    if (baseUrl && token) {
      return { baseUrl, token }
    }
  }

  const legacyMap = parseEnvironmentMap(metadata?.ha_environments)
  const legacyEntry = Object.entries(legacyMap).find(([id]) => (
    id === requestedId ||
    id.toLowerCase() === lowerRequested
  ))

  if (legacyEntry) {
    const [, env] = legacyEntry
    const baseUrl = normalizeValue(env?.base_url || env?.url)
    const token = normalizeValue(env?.token)
    if (baseUrl && token) {
      return { baseUrl, token }
    }
  }

  return null
}

const getHaConfig = async (event, environmentId) => {
  const domain = getEnv('AUTH0_DOMAIN')
  let metadata = {}

  try {
    const managementToken = await getManagementToken(domain)
    metadata = await getCachedClientMetadata(domain, managementToken)
  } catch (error) {
    console.warn('[Gas Hourly] Metadata unavailable, using fallback env vars:', error instanceof Error ? error.message : error)
  }

  return resolveEnvironmentConfig({
    event,
    metadata,
    environmentId,
    getOptionalEnv,
  })
}

const parseNumericState = (rawValue) => {
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : NaN
  if (rawValue === null || rawValue === undefined) return NaN
  const source = String(rawValue).trim()
  if (!source) return NaN
  let normalized = source.replace(/\s/g, '')
  const hasComma = normalized.includes(','), hasDot = normalized.includes('.')
  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(','), lastDot = normalized.lastIndexOf('.')
    normalized = lastComma > lastDot ? normalized.replace(/\./g, '').replace(',', '.') : normalized.replace(/,/g, '')
  } else if (hasComma && !hasDot) {
    normalized = normalized.replace(',', '.')
  }
  normalized = normalized.replace(/[^0-9+\-.]/g, '')
  const value = Number(normalized)
  return Number.isFinite(value) ? value : NaN
}

export const handler = async (event) => {
  try {
    let authResult
    try {
      authResult = await verifyAuthAndAdmin(event)
    } catch (authErr) {
      const statusCode = authErr.statusCode || 401
      return { statusCode, body: JSON.stringify({ error: authErr.message || 'Unauthorized' }) }
    }

    const { isAdmin, resolvedEmail } = authResult

    const environmentId = String(event.queryStringParameters?.environmentId || '').trim()
    const entityId = event.queryStringParameters?.entityId || 'sensor.gas_meter_gas_consumption'
    const hoursBack = parseInt(event.queryStringParameters?.hoursBack || '200', 10) // ~8 days back to March 3

    if (!environmentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing query parameter: environmentId' }),
      }
    }

    // Access control: super admin / ADMIN_EMAILS always allowed; others checked via Supabase
    if (!isAdmin) {
      try {
        const supabase = createServiceSupabaseClient()
        const access = await checkEnvironmentAccess({ userEmail: resolvedEmail, environmentId, supabase })
        if (!access.allowed) {
          return { statusCode: 403, body: JSON.stringify({ error: 'Access denied to this environment' }) }
        }
      } catch (accessErr) {
        console.error('[Gas Hourly] Failed to verify environment access:', accessErr?.message || accessErr)
        return { statusCode: 403, body: JSON.stringify({ error: 'Unable to verify environment access' }) }
      }
    }

    const { baseUrl, token } = await getHaConfig(event, environmentId)

    // Calculate time range: from N hours ago to now
    const now = new Date()
    const startDate = new Date(now.getTime() - hoursBack * 3600 * 1000)
    const startTimeISO = startDate.toISOString()
    const endTimeISO = now.toISOString()

    console.log(`[Gas Hourly] Fetching ${entityId} from ${startTimeISO} to ${endTimeISO}`)

    // Fetch history from HA
    const historyUrl = new URL(baseUrl)
    historyUrl.pathname = `/api/history/period/${startTimeISO}`
    historyUrl.searchParams.append('filter_entity_id', entityId)
    historyUrl.searchParams.append('end_time', endTimeISO)

    const historyResp = await fetch(historyUrl.toString(), {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })

    if (!historyResp.ok) {
      const errorBody = await historyResp.text()
      console.error(`[Gas Hourly] HA returned ${historyResp.status}:`, errorBody)
      return {
        statusCode: historyResp.status,
        body: JSON.stringify({
          error: `HA API error: ${historyResp.status}`,
          details: errorBody.substring(0, 500),
        }),
      }
    }

    const historyData = await historyResp.json()
    console.log(`[Gas Hourly] Got history response, entities: ${historyData.length}`)

    // Find entity in response (history API returns array of arrays)
    const entityHistory = historyData.find(arr => arr?.[0]?.entity_id === entityId) || []
    console.log(`[Gas Hourly] Found ${entityHistory.length} state changes for ${entityId}`)

    if (entityHistory.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          entity_id: entityId,
          hourly: [],
          message: 'No history found',
          timeRange: { start: startTimeISO, end: endTimeISO },
        }),
      }
    }

    // Parse all meter values
    let readings = entityHistory
      .map(state => ({
        timestamp: new Date(state.last_changed || state.last_updated).getTime(),
        value: parseNumericState(state.state),
      }))
      .filter(r => Number.isFinite(r.value))
      .sort((a, b) => a.timestamp - b.timestamp)

    // Remove initialization artifacts: if the first readings have value 0 (or near 0)
    // while later readings are 1000x+ larger, these are sensor initialization states.
    // Example: gas sensor added → state=0, then reads real meter value 77208 m³ on next update.
    if (readings.length >= 3) {
      const medianIdx = Math.floor(readings.length / 2)
      const medianValue = readings[medianIdx].value
      if (medianValue > 10) {
        const threshold = medianValue * 0.001
        const firstRealIdx = readings.findIndex((r) => r.value > threshold)
        if (firstRealIdx > 0) {
          console.log(`[Gas Hourly] Skipping ${firstRealIdx} initialization readings (values 0-${readings[firstRealIdx - 1].value}, median=${medianValue})`)
          readings = readings.slice(firstRealIdx)
        }
      }
    }

    console.log(`[Gas Hourly] Parsed ${readings.length} valid readings`)

    if (readings.length < 2) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          entity_id: entityId,
          hourly: [],
          message: `Only ${readings.length} valid reading(s), need at least 2`,
          timeRange: { start: startTimeISO, end: endTimeISO },
        }),
      }
    }

    // Bucket readings by hour and calculate delta
    const hourlyDeltas = []
    const startHour = Math.floor(startDate.getTime() / 3600000)
    const endHour = Math.floor(now.getTime() / 3600000)

    for (let h = startHour; h <= endHour; h++) {
      const hourStart = h * 3600000
      const hourEnd = (h + 1) * 3600000

      // Find readings at/before start and end of this hour
      // Use <= hourEnd (inclusive) so readings exactly on the hour boundary are included.
      // DSMR gas meters report on the hour; strict < would miss them and yield 0 deltas.
      const atStart = readings.filter(r => r.timestamp <= hourStart).pop()
      const atEnd = readings.filter(r => r.timestamp <= hourEnd).pop()

      if (atStart && atEnd && atEnd.timestamp > atStart.timestamp) {
        let delta = Math.max(0, atEnd.value - atStart.value)
        // Hard cap: no residential gas meter can consume 50 m³ in one hour.
        // Any larger delta is a sensor initialization artifact (first reading 0 → cumulative meter value).
        if (delta > 50) {
          console.log(`[Gas Hourly] Capping spike at ${new Date(hourStart).toISOString()}: ${delta} → 0`)
          delta = 0
        }
        hourlyDeltas.push({
          hour: new Date(hourStart).toISOString(),
          delta: parseFloat(delta.toFixed(3)),
          start_value: atStart.value,
          end_value: atEnd.value,
        })
      } else {
        hourlyDeltas.push({
          hour: new Date(hourStart).toISOString(),
          delta: 0,
          start_value: atStart?.value ?? null,
          end_value: atEnd?.value ?? null,
        })
      }
    }

    console.log(`[Gas Hourly] Calculated ${hourlyDeltas.length} hourly deltas`)

    return {
      statusCode: 200,
      body: JSON.stringify({
        entity_id: entityId,
        hourly: hourlyDeltas,
        totalReadings: readings.length,
        timeRange: { start: startTimeISO, end: endTimeISO },
      }),
    }
  } catch (error) {
    console.error('[Gas Hourly] Error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    }
  }
}
