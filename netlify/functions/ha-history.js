import { createRemoteJWKSet, jwtVerify } from 'jose'
import { resolveEnvironmentConfig } from './_environment-storage.js'
import { checkEnvironmentAccess } from './_access-control.js'
import { createServiceSupabaseClient } from './_supabase.js'

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
  'Brouwer TEST': {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
  'brouwer': {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
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
      const body = await response.text()
      console.error('Failed to get management token:', response.status, body)
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

const normalizeValue = (value) => (value ? String(value).trim() : '')
const ENV_METADATA_PREFIX = 'ha_env_v1_'

const getOwnerEmail = () => (process.env.OWNER_EMAIL || '').trim().toLowerCase()

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

const getEmailFromPayload = (payload) => {
  const emailValue = payload.email || payload['https://brouwer-ems/email']
  return typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
}

const isAdminEmail = (email) => {
  if (!email) return false
  const ownerEmail = getOwnerEmail()
  if (ownerEmail && email === ownerEmail) return true
  const allowlist = getAdminAllowlist()
  return allowlist.includes(email)
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
    throw Object.assign(new Error('Missing authorization header'), { statusCode: 401 })
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })

  let resolvedEmail = getEmailFromPayload(payload)

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
  console.log('[HA History] Auth resolved: email=', resolvedEmail || '(empty)', 'isAdmin=', isAdmin)

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

const getHaConfig = (metadata, environmentId) => {
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

  let fallback = HA_ENVIRONMENTS[requestedId]
  if (!fallback) {
    const key = Object.keys(HA_ENVIRONMENTS).find((id) => id.toLowerCase() === lowerRequested)
    if (key) {
      fallback = HA_ENVIRONMENTS[key]
    }
  }

  if (!fallback) {
    throw new Error(`Unknown environment: ${environmentId}`)
  }

  return {
    baseUrl: getEnv(fallback.urlEnv),
    token: getEnv(fallback.tokenEnv),
  }
}

const parseNumericState = (rawValue) => {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : NaN
  }

  if (rawValue === null || rawValue === undefined) {
    return NaN
  }

  const source = String(rawValue).trim()
  if (!source) {
    return NaN
  }

  let normalized = source.replace(/\s/g, '')

  const hasComma = normalized.includes(',')
  const hasDot = normalized.includes('.')

  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(',')
    const lastDot = normalized.lastIndexOf('.')

    if (lastComma > lastDot) {
      // Example: 16.410,123 -> 16410.123
      normalized = normalized.replace(/\./g, '').replace(',', '.')
    } else {
      // Example: 16,410.123 -> 16410.123
      normalized = normalized.replace(/,/g, '')
    }
  } else if (hasComma && !hasDot) {
    // Example: 16410,123 -> 16410.123
    normalized = normalized.replace(',', '.')
  }

  // Keep only numeric characters and decimal/sign symbols after normalization.
  normalized = normalized.replace(/[^0-9+\-.]/g, '')

  const value = Number(normalized)
  return Number.isFinite(value) ? value : NaN
}

const formatHistoryPayload = (historyData) => {
  const safeHistory = Array.isArray(historyData) ? historyData : []

  console.log('[HA History] Raw HA response:', safeHistory.length, 'entities',
    safeHistory.map((h) => ({ entity_id: h?.[0]?.entity_id, states: Array.isArray(h) ? h.length : 0 })))

  return safeHistory.map((entityHistory) => {
    const validStates = (entityHistory || [])
      .map((state) => {
        const parsedValue = parseNumericState(state?.state)
        if (!Number.isFinite(parsedValue)) {
          return null
        }

        return {
          ...state,
          parsedValue,
        }
      })
      .filter(Boolean)

    console.log('[HA History] Entity', entityHistory?.[0]?.entity_id, 'has', validStates.length, 'valid states')

    return {
      entity_id: entityHistory?.[0]?.entity_id || 'unknown',
      history: validStates.map((state) => ({
        timestamp: new Date(state.last_changed || state.last_updated).getTime(),
        value: state.parsedValue,
        state: state.state,
      })),
    }
  })
}

const getResolutionMs = (resolution) => {
  const normalized = String(resolution || 'raw').toLowerCase()
  if (normalized === '5min') return 5 * 60_000
  if (normalized === 'hourly') return 60 * 60_000
  return 0
}

const aggregateToResolution = (samples, resolutionMs) => {
  if (!Array.isArray(samples) || samples.length === 0 || !Number.isFinite(resolutionMs) || resolutionMs <= 0) {
    return samples || []
  }

  const buckets = new Map()
  for (const sample of samples) {
    const timestamp = Number(sample?.timestamp)
    const value = Number(sample?.value)
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) {
      continue
    }

    const bucketTs = Math.floor(timestamp / resolutionMs) * resolutionMs
    if (!buckets.has(bucketTs)) {
      buckets.set(bucketTs, {
        sum: value,
        count: 1,
        min: value,
        max: value,
      })
      continue
    }

    const bucket = buckets.get(bucketTs)
    bucket.sum += value
    bucket.count += 1
    bucket.min = Math.min(bucket.min, value)
    bucket.max = Math.max(bucket.max, value)
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, bucket]) => ({
      timestamp,
      value: Number((bucket.sum / Math.max(1, bucket.count)).toFixed(6)),
      min: Number(bucket.min.toFixed(6)),
      max: Number(bucket.max.toFixed(6)),
      state: String(bucket.sum / Math.max(1, bucket.count)),
    }))
}

const getMaxPointsForResolution = (resolution) => {
  const normalized = String(resolution || 'raw').toLowerCase()
  if (normalized === 'hourly') return 720
  if (normalized === '5min') return 2000
  return 0
}

const capPoints = (samples, maxPoints) => {
  if (!Array.isArray(samples) || samples.length <= maxPoints || !Number.isFinite(maxPoints) || maxPoints <= 0) {
    return samples || []
  }

  const step = (samples.length - 1) / (maxPoints - 1)
  const picked = []
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.min(samples.length - 1, Math.round(i * step))
    picked.push(samples[idx])
  }

  return picked
}

const formatStatisticsPayload = (statisticsData, entityIdsList, productionEntityIds = []) => {
  const safeData = statisticsData && typeof statisticsData === 'object' ? statisticsData : {}
  const productionSet = new Set(productionEntityIds.map((id) => String(id).toLowerCase()))

  return entityIdsList.map((entityId) => {
    const statsRows = Array.isArray(safeData[entityId]) ? safeData[entityId] : []
    const isProduction = productionSet.has(entityId.toLowerCase())
    const mappedRows = statsRows
      .map((row, idx) => {
        const timestampRaw = row?.start || row?.end || row?.last_reset
        const timestamp = timestampRaw ? new Date(timestampRaw).getTime() : NaN
        const parsedValue = parseNumericState(
          row?.state ?? row?.sum ?? row?.mean ?? row?.max ?? row?.min,
        )

        let changeValue = parseNumericState(row?.change)

        // If change is null/NaN but sum is available, derive it as delta from the previous row's sum
        if (!Number.isFinite(changeValue) && idx > 0) {
          const prevRow = statsRows[idx - 1]
          const currSum = parseNumericState(row?.sum)
          const prevSum = parseNumericState(prevRow?.sum)
          if (Number.isFinite(currSum) && Number.isFinite(prevSum)) {
            changeValue = currSum - prevSum
          }
        }

        if (!Number.isFinite(timestamp) || (!Number.isFinite(parsedValue) && !Number.isFinite(changeValue))) {
          return null
        }

        // Clamp negative change to 0 for consumption entities (meter resets or data anomalies)
        if (!isProduction && Number.isFinite(changeValue) && changeValue < 0) {
          changeValue = 0
        }

        return {
          timestamp,
          value: Number.isFinite(parsedValue) ? parsedValue : 0,
          change: Number.isFinite(changeValue) ? changeValue : 0,
          state: String(row?.state ?? row?.sum ?? row?.mean ?? ''),
        }
      })
      .filter(Boolean)

    const totalChange = mappedRows.reduce((sum, r) => sum + r.change, 0)
    console.log('[HA History] Statistics entity', entityId, 'rows:', mappedRows.length, 'total change:', Number.isFinite(totalChange) ? totalChange.toFixed(3) : String(totalChange))

    return {
      entity_id: entityId,
      history: mappedRows,
      is_production: isProduction,
    }
  })
}

export const handler = async (event) => {
  try {
    const MAX_RANGE_MS = 45 * 24 * 60 * 60 * 1000

    const environmentId = String(event.queryStringParameters?.environmentId || '').trim()
    const startTime = String(event.queryStringParameters?.startTime || '').trim()
    const endTime = String(event.queryStringParameters?.endTime || '').trim()
    const entityIds = event.queryStringParameters?.entityIds

    if (!environmentId || !startTime || !endTime || !entityIds) {
      console.error('[HA History] Missing query parameters:', { startTime, endTime, entityIds })
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing query parameters: environmentId, startTime, endTime, entityIds' }),
      }
    }

    const startMs = Date.parse(startTime)
    const endMs = Date.parse(endTime)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid date range for startTime/endTime' }),
      }
    }

    let effectiveStartTime = new Date(startMs).toISOString()
    const effectiveEndTime = new Date(endMs).toISOString()

    if (endMs - startMs > MAX_RANGE_MS) {
      effectiveStartTime = new Date(endMs - MAX_RANGE_MS).toISOString()
      console.log('[HA History] Clamped range to 45 days:', {
        requestedStartTime: startTime,
        requestedEndTime: endTime,
        effectiveStartTime,
        effectiveEndTime,
      })
    }

    let authResult
    try {
      authResult = await verifyAuthAndAdmin(event)
    } catch (authErr) {
      const statusCode = authErr.statusCode || 401
      return {
        statusCode,
        body: JSON.stringify({ error: authErr.message || 'Unauthorized' }),
      }
    }

    const { isAdmin, resolvedEmail } = authResult

    const mode = String(event.queryStringParameters?.mode || 'history').toLowerCase()
    const statisticsPeriod = String(event.queryStringParameters?.period || 'hour').toLowerCase()
    const resolution = String(event.queryStringParameters?.resolution || 'raw').toLowerCase()
    const productionEntityIds = event.queryStringParameters?.productionEntityIds
      ? event.queryStringParameters.productionEntityIds.split(',').map((id) => id.trim()).filter(Boolean)
      : []
    const tzOffsetMinutes = parseInt(event.queryStringParameters?.tzOffset || '0', 10) || 0

    // Access control: super admin / ADMIN_EMAILS always allowed; others checked via Supabase
    if (!isAdmin) {
      try {
        const supabase = createServiceSupabaseClient()
        const access = await checkEnvironmentAccess({ userEmail: resolvedEmail, environmentId, supabase })
        if (!access.allowed) {
          return { statusCode: 403, body: JSON.stringify({ error: 'Access denied to this environment' }) }
        }
      } catch (accessErr) {
        console.error('[HA History] Failed to verify environment access:', accessErr?.message || accessErr)
        return { statusCode: 403, body: JSON.stringify({ error: 'Unable to verify environment access' }) }
      }
    }

    console.log('[HA History] Request for environment:', environmentId, 'entities:', entityIds)

    // Prefer metadata-backed config and fall back to environment variables
    let haConfig
    try {
      const domain = getEnv('AUTH0_DOMAIN')
      let metadata = {}
      try {
        const managementToken = await getManagementToken(domain)
        metadata = await getCachedClientMetadata(domain, managementToken)
      } catch (metadataError) {
        console.warn('[HA History] Metadata unavailable, using fallback env vars:', metadataError?.message || metadataError)
      }

      haConfig = await resolveEnvironmentConfig({
        event,
        metadata,
        environmentId,
        getOptionalEnv,
      })
      console.log('[HA History] Got HA config, URL host:', new URL(haConfig.baseUrl).hostname)
    } catch (err) {
      console.error('[HA History] Failed to get HA config:', err.message || err)
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Failed to retrieve Home Assistant config',
          details: err instanceof Error ? err.message : String(err),
        }),
      }
    }

    const { baseUrl, token: haToken } = haConfig

    // Parse entity IDs
    const entityIdsList = Array.from(new Set(entityIds.split(',').map((id) => id.trim()).filter(Boolean)))

    if (mode === 'statistics') {
      // HA does NOT expose statistics_during_period as a REST endpoint (WebSocket only).
      // Instead, fetch raw history via /api/history/period/ and compute hourly/daily deltas
      // from the cumulative (total_increasing) meter readings — same approach HA Energy uses.
      const histUrl = new URL(baseUrl)
      histUrl.pathname = `/api/history/period/${effectiveStartTime}`
      // HA expects a comma-separated list in a single filter_entity_id parameter.
      // Repeating filter_entity_id can lead to partial results depending on backend parsing.
      histUrl.searchParams.set('filter_entity_id', entityIdsList.join(','))
      if (effectiveEndTime) {
        histUrl.searchParams.append('end_time', effectiveEndTime)
      }
      histUrl.searchParams.append('significant_changes_only', 'false')
      histUrl.searchParams.append('no_attributes', 'true')

      console.log('[HA History] Statistics via history API, period:', statisticsPeriod, 'entities:', entityIdsList.length)

      let histResponse
      try {
        histResponse = await fetch(histUrl.toString(), {
          headers: {
            Authorization: `Bearer ${haToken}`,
            'Content-Type': 'application/json',
          },
        })
      } catch (fetchErr) {
        console.error('[HA History] Statistics history fetch failed:', fetchErr.message)
        return {
          statusCode: 503,
          body: JSON.stringify({
            error: 'Failed to connect to Home Assistant',
            details: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          }),
        }
      }

      if (!histResponse.ok) {
        const errorBody = await histResponse.text()
        console.error('[HA History] Statistics history API error', histResponse.status, errorBody)
        return {
          statusCode: histResponse.status,
          body: JSON.stringify({
            error: `Home Assistant API error: ${histResponse.status}`,
            details: errorBody,
          }),
        }
      }

      const rawHistory = await histResponse.json()

      // HA returns array of arrays: [[{entity_id, state, last_changed}, ...], ...]
      const entityArrays = Array.isArray(rawHistory) ? rawHistory : []
      const productionSet = new Set(productionEntityIds.map((id) => String(id).toLowerCase()))

      // Bucket size in ms
      const bucketMs = statisticsPeriod === 'day' ? 86_400_000 : 3_600_000

      // Helper: floor timestamp to bucket start
      // For daily buckets, use client timezone offset so day boundaries align with local midnight.
      const offsetMs = tzOffsetMinutes * 60_000
      const floorToBucket = (ms) => {
        if (statisticsPeriod === 'day') {
          // Shift into client's local clock, floor to midnight, shift back to UTC
          const localMs = ms + offsetMs
          const d = new Date(localMs)
          const dayStartLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
          return dayStartLocal - offsetMs
        }
        return Math.floor(ms / bucketMs) * bucketMs
      }

      const formatted = entityIdsList.map((entityId) => {
        // Find this entity's history array
        const entityHistory = entityArrays.find(
          (arr) => Array.isArray(arr) && arr.length > 0 && arr[0]?.entity_id === entityId,
        ) || []

        // Parse to sorted {timestamp, value} pairs
        let points = entityHistory
          .map((row) => {
            const ts = row?.last_changed || row?.last_updated
            const timestamp = ts ? new Date(ts).getTime() : NaN
            const value = parseNumericState(row?.state)
            if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return null
            return { timestamp, value }
          })
          .filter(Boolean)
          .sort((a, b) => a.timestamp - b.timestamp)

        // Remove initialization artifacts: if the first readings have value 0 (or near 0)
        // while later readings are 1000x+ larger, these are sensor initialization states — not real meter values.
        // Example: sensor added → state=0, then reads real meter value 100155 kWh on next update.
        if (points.length >= 3) {
          const medianIdx = Math.floor(points.length / 2)
          const medianValue = points[medianIdx].value
          if (medianValue > 100) {
            const threshold = medianValue * 0.001
            const firstRealIdx = points.findIndex((p) => p.value > threshold)
            if (firstRealIdx > 0) {
              console.log('[HA History] Skipping', firstRealIdx, 'initialization points for', entityId,
                '(values 0-' + points[firstRealIdx - 1].value + ', median=' + medianValue + ')')
              points = points.slice(firstRealIdx)
            }
          }
        }

        if (points.length === 0) {
          console.log('[HA History] Statistics entity', entityId, '0 raw points')
          return { entity_id: entityId, history: [], is_production: productionSet.has(entityId.toLowerCase()) }
        }

        // Compute delta per bucket from cumulative readings
        // For each bucket, find the first and last readings and compute (last - first)
        const bucketMap = new Map()
        for (const point of points) {
          const bucketStart = floorToBucket(point.timestamp)
          if (!bucketMap.has(bucketStart)) {
            bucketMap.set(bucketStart, { first: point.value, last: point.value })
          } else {
            const bucket = bucketMap.get(bucketStart)
            bucket.last = point.value
          }
        }

        const isProduction = productionSet.has(entityId.toLowerCase())
        const history = []
        for (const [bucketStart, bucket] of bucketMap) {
          let change = bucket.last - bucket.first
          // Clamp negative changes to 0 for consumption (meter resets)
          if (!isProduction && change < 0) change = 0
          // Clamp absurdly large intra-bucket deltas (initialization artifacts)
          if (change > 2000) change = 0
          history.push({
            timestamp: bucketStart,
            value: bucket.last,
            change: Number(change.toFixed(4)),
            state: String(bucket.last),
          })
        }

        history.sort((a, b) => a.timestamp - b.timestamp)

        // For better accuracy: ALWAYS use inter-bucket deltas for cumulative meters.
        // Intra-bucket delta (last-first within an hour) misses consumption that happened
        // between the last reading of hour N-1 and first reading of hour N.
        // HA Energy dashboard uses the same approach: delta = value_at_end - value_at_start_of_period.
        if (history.length > 1) {
          for (let i = 1; i < history.length; i++) {
            const prevLast = bucketMap.get(history[i - 1].timestamp)?.last
            if (prevLast !== undefined && Number.isFinite(prevLast)) {
              const interBucketDelta = history[i].value - prevLast
              if (interBucketDelta >= 0) {
                history[i].change = Number(interBucketDelta.toFixed(4))
              } else if (!isProduction) {
                // Negative = meter reset, clamp to 0
                history[i].change = 0
              }
            }
          }
        }

        // Hard cap: no residential meter can consume 500 kWh or m³ per hour, or 2000 per day.
        // Any larger delta is a sensor initialization artifact (e.g. first reading 0 → cumulative meter value).
        const maxChangePerBucket = statisticsPeriod === 'day' ? 2000 : 500
        for (const h of history) {
          if (h.change > maxChangePerBucket) {
            console.log('[HA History] Capping spike for', entityId, 'bucket', new Date(h.timestamp).toISOString(), 'change', h.change, '→ 0')
            h.change = 0
          }
        }

        const totalChange = history.reduce((sum, r) => sum + r.change, 0)
        console.log('[HA History] Statistics entity', entityId, 'raw points:', points.length,
          'buckets:', history.length, 'total change:', totalChange.toFixed(3))

        return {
          entity_id: entityId,
          history,
          is_production: isProduction,
        }
      })

      return {
        statusCode: 200,
        body: JSON.stringify({
          entities: formatted,
          timestamp: new Date().toISOString(),
          mode: 'statistics',
          _debug: {
            method: 'history-derived',
            requestedEntityIds: entityIdsList,
            period: statisticsPeriod,
            rowCountPerEntity: formatted.map((e) => ({
              entityId: e.entity_id,
              buckets: e.history.length,
              totalChange: e.history.reduce((s, r) => s + r.change, 0).toFixed(3),
            })),
          },
        }),
      }
    }

    // Fetch history from Home Assistant
    // Format: /api/history/period/<start_time>?filter_entity_id=sensor.x&filter_entity_id=sensor.y&end_time=...
    const historyUrl = new URL(baseUrl)
    historyUrl.pathname = `/api/history/period/${effectiveStartTime}`
    
    // Add each entity ID as a separate filter_entity_id parameter
    // HA expects a comma-separated list in a single filter_entity_id parameter.
    historyUrl.searchParams.set('filter_entity_id', entityIdsList.join(','))
    
    if (effectiveEndTime) {
      historyUrl.searchParams.append('end_time', effectiveEndTime)
    }
    // Return all state changes (not just "significant" ones) so the power chart is complete
    historyUrl.searchParams.append('significant_changes_only', 'false')
    // Skip attributes to reduce payload size
    historyUrl.searchParams.append('no_attributes', 'true')
    console.log('[HA History] Entity IDs:', entityIdsList)

    let historyResponse
    try {
      historyResponse = await fetch(historyUrl.toString(), {
        headers: {
          Authorization: `Bearer ${haToken}`,
          'Content-Type': 'application/json',
        },
      })
    } catch (fetchErr) {
      console.error('[HA History] Network fetch failed:', fetchErr.message)
      return {
        statusCode: 503,
        body: JSON.stringify({
          error: 'Failed to connect to Home Assistant',
          details: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        }),
      }
    }

    if (!historyResponse.ok) {
      const errorBody = await historyResponse.text()
      console.error('[HA History] HA returned status', historyResponse.status, ':', errorBody)
      return {
        statusCode: historyResponse.status,
        body: JSON.stringify({
          error: `Home Assistant API error: ${historyResponse.status}`,
          details: errorBody,
        }),
      }
    }

    const historyData = await historyResponse.json()
    const formatted = formatHistoryPayload(historyData)
    const resolutionMs = getResolutionMs(resolution)
    const maxPoints = getMaxPointsForResolution(resolution)
    const processed = resolutionMs > 0
      ? formatted.map((entity) => ({
          ...entity,
          history: capPoints(aggregateToResolution(entity.history, resolutionMs), maxPoints),
        }))
      : formatted

    console.log('[HA History] Loaded', processed.length, 'entity histories', 'resolution=', resolution)

    return {
      statusCode: 200,
      body: JSON.stringify({
        entities: processed,
        timestamp: new Date().toISOString(),
        resolution,
      }),
    }
  } catch (error) {
    console.error('[HA History] Unexpected error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Server error',
      }),
    }
  }
}
