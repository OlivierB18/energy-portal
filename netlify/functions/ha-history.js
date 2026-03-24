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

const formatStatisticsPayload = (statisticsData, entityIdsList) => {
  const safeData = statisticsData && typeof statisticsData === 'object' ? statisticsData : {}

  return entityIdsList.map((entityId) => {
    const statsRows = Array.isArray(safeData[entityId]) ? safeData[entityId] : []
    const mappedRows = statsRows
      .map((row, rowIndex) => {
        const timestampRaw = row?.start || row?.end || row?.last_reset
        const timestamp = timestampRaw ? new Date(timestampRaw).getTime() : NaN
        const parsedValue = parseNumericState(
          row?.state ?? row?.sum ?? row?.mean ?? row?.max ?? row?.min,
        )

        let changeValue = parseNumericState(row?.change)

        // HA versions before 2023.5 do not include the 'change' field in statistics_during_period.
        // Compute the per-period consumption from consecutive 'sum' (or 'state') differences so
        // the Electricity usage bar chart shows real data on all HA versions.
        if (!Number.isFinite(changeValue) || changeValue < 0) {
          const currentSum = parseNumericState(row?.sum)
          if (Number.isFinite(currentSum) && rowIndex > 0) {
            const prevSum = parseNumericState(statsRows[rowIndex - 1]?.sum)
            if (Number.isFinite(prevSum) && currentSum > prevSum) {
              changeValue = currentSum - prevSum
            }
          }

          // Fall back to state-field differences when sum is unavailable
          if ((!Number.isFinite(changeValue) || changeValue < 0) && Number.isFinite(parsedValue) && rowIndex > 0) {
            const prevParsed = parseNumericState(
              statsRows[rowIndex - 1]?.state ?? statsRows[rowIndex - 1]?.sum,
            )
            if (Number.isFinite(prevParsed) && parsedValue > prevParsed) {
              changeValue = parsedValue - prevParsed
            }
          }
        }

        if (!Number.isFinite(timestamp) || (!Number.isFinite(parsedValue) && !Number.isFinite(changeValue))) {
          return null
        }

        return {
          timestamp,
          value: Number.isFinite(parsedValue) ? parsedValue : 0,
          change: Number.isFinite(changeValue) && changeValue >= 0 ? changeValue : 0,
          state: String(row?.state ?? row?.sum ?? row?.mean ?? ''),
        }
      })
      .filter(Boolean)

    console.log('[HA History] Statistics entity', entityId, 'rows:', mappedRows.length)

    return {
      entity_id: entityId,
      history: mappedRows,
    }
  })
}

export const handler = async (event) => {
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization
    if (!authHeader?.startsWith('Bearer ')) {
      console.error('[HA History] Missing authorization header')
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Missing authorization header' }),
      }
    }

    // Keep auth behavior aligned with ha-entities: require bearer header presence.
    console.log('[HA History] Authorization header present')

    const environmentId = event.queryStringParameters?.environmentId || 'vacation'
    const startTime = event.queryStringParameters?.startTime
    const endTime = event.queryStringParameters?.endTime
    const entityIds = event.queryStringParameters?.entityIds
    const mode = String(event.queryStringParameters?.mode || 'history').toLowerCase()
    const statisticsPeriod = String(event.queryStringParameters?.period || 'hour').toLowerCase()

    if (!startTime || !endTime || !entityIds) {
      console.error('[HA History] Missing query parameters:', { startTime, endTime, entityIds })
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing query parameters: startTime, endTime, entityIds' }),
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
    const entityIdsList = entityIds.split(',').map((id) => id.trim())

    if (mode === 'statistics') {
      const statisticsUrl = new URL(baseUrl)
      statisticsUrl.pathname = `/api/history/statistics_during_period/${startTime}`
      entityIdsList.forEach((entityId) => {
        statisticsUrl.searchParams.append('statistic_ids', entityId)
      })
      statisticsUrl.searchParams.append('period', statisticsPeriod === 'day' ? 'day' : 'hour')
      if (endTime) {
        statisticsUrl.searchParams.append('end_time', endTime)
      }

      console.log('[HA History] Statistics fetch URL:', statisticsUrl.toString())

      let statisticsResponse
      try {
        statisticsResponse = await fetch(statisticsUrl.toString(), {
          headers: {
            Authorization: `Bearer ${haToken}`,
            'Content-Type': 'application/json',
          },
        })
      } catch (fetchErr) {
        console.error('[HA History] Statistics network fetch failed:', fetchErr.message)
        return {
          statusCode: 503,
          body: JSON.stringify({
            error: 'Failed to connect to Home Assistant statistics API',
            details: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          }),
        }
      }

      if (!statisticsResponse.ok) {
        const errorBody = await statisticsResponse.text()
        console.error('[HA History] Statistics API error', statisticsResponse.status, errorBody)
        return {
          statusCode: statisticsResponse.status,
          body: JSON.stringify({
            error: `Home Assistant statistics API error: ${statisticsResponse.status}`,
            details: errorBody,
          }),
        }
      }

      const statisticsData = await statisticsResponse.json()

      // Log raw HA statistics response for debugging
      entityIdsList.forEach((entityId) => {
        const rawRows = Array.isArray(statisticsData?.[entityId]) ? statisticsData[entityId] : []
        console.log('[HA History] Raw statistics for', entityId, ':', rawRows.length, 'rows')
        if (rawRows.length > 0) {
          console.log('[HA History] First raw row keys:', Object.keys(rawRows[0]))
          console.log('[HA History] First raw row:', JSON.stringify(rawRows[0]))
          if (rawRows.length > 1) {
            console.log('[HA History] Second raw row:', JSON.stringify(rawRows[1]))
          }
        }
      })

      const formatted = formatStatisticsPayload(statisticsData, entityIdsList)

      return {
        statusCode: 200,
        body: JSON.stringify({
          entities: formatted,
          timestamp: new Date().toISOString(),
          mode: 'statistics',
        }),
      }
    }

    // Fetch history from Home Assistant
    // Format: /api/history/period/<start_time>?filter_entity_id=sensor.x&filter_entity_id=sensor.y&end_time=...
    const historyUrl = new URL(baseUrl)
    historyUrl.pathname = `/api/history/period/${startTime}`
    
    // Add each entity ID as a separate filter_entity_id parameter
    entityIdsList.forEach((entityId) => {
      historyUrl.searchParams.append('filter_entity_id', entityId)
    })
    
    if (endTime) {
      historyUrl.searchParams.append('end_time', endTime)
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

    console.log('[HA History] Loaded', formatted.length, 'entity histories')

    return {
      statusCode: 200,
      body: JSON.stringify({
        entities: formatted,
        timestamp: new Date().toISOString(),
      }),
    }
  } catch (error) {
    console.error('[HA History] Unexpected error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Server error',
        stack: error instanceof Error ? error.stack : String(error),
      }),
    }
  }
}
