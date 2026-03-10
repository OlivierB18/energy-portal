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
  'Brouwer TEST': {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
  'brouwer': {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
}

const getHaConfigDirect = (environmentId) => {
  // Try exact match first
  let fallback = HA_ENVIRONMENTS[environmentId]
  
  // Try case-insensitive match
  if (!fallback) {
    const key = Object.keys(HA_ENVIRONMENTS).find(k => k.toLowerCase() === environmentId.toLowerCase())
    if (key) {
      fallback = HA_ENVIRONMENTS[key]
    }
  }
  
  if (!fallback) {
    throw new Error(`Unknown environment: ${environmentId}. Available: ${Object.keys(HA_ENVIRONMENTS).join(', ')}`)
  }

  try {
    const baseUrl = getEnv(fallback.urlEnv)
    const token = getEnv(fallback.tokenEnv)
    return { baseUrl, token }
  } catch (err) {
    throw new Error(`Missing environment variables for ${fallback.urlEnv} or ${fallback.tokenEnv}: ${err.message}`)
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
      .map((row) => {
        const timestampRaw = row?.start || row?.end || row?.last_reset
        const timestamp = timestampRaw ? new Date(timestampRaw).getTime() : NaN
        const parsedValue = parseNumericState(
          row?.state ?? row?.sum ?? row?.mean ?? row?.max ?? row?.min,
        )

        const changeValue = parseNumericState(row?.change)

        if (!Number.isFinite(timestamp) || (!Number.isFinite(parsedValue) && !Number.isFinite(changeValue))) {
          return null
        }

        return {
          timestamp,
          value: Number.isFinite(parsedValue) ? parsedValue : 0,
          change: Number.isFinite(changeValue) ? changeValue : 0,
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

    // Get HA config directly from environment variables
    let haConfig
    try {
      haConfig = getHaConfigDirect(environmentId)
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

    console.log('[HA History] Fetching from:', historyUrl.toString())
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
