/**
 * Get hourly gas consumption by reading meter every hour
 * Each hour: current_meter_value - previous_hour_meter_value = consumption
 */

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

const HA_ENVIRONMENTS = {
  vacation: { urlEnv: 'HA_BROUWER_TEST_URL', tokenEnv: 'HA_BROUWER_TEST_TOKEN' },
  'Brouwer TEST': { urlEnv: 'HA_BROUWER_TEST_URL', tokenEnv: 'HA_BROUWER_TEST_TOKEN' },
  brouwer: { urlEnv: 'HA_BROUWER_TEST_URL', tokenEnv: 'HA_BROUWER_TEST_TOKEN' },
}

const getHaConfigDirect = (environmentId) => {
  let fallback = HA_ENVIRONMENTS[environmentId]
  if (!fallback) {
    const key = Object.keys(HA_ENVIRONMENTS).find(k => k.toLowerCase() === environmentId.toLowerCase())
    if (key) fallback = HA_ENVIRONMENTS[key]
  }
  if (!fallback) throw new Error(`Unknown environment: ${environmentId}`)
  return { baseUrl: getEnv(fallback.urlEnv), token: getEnv(fallback.tokenEnv) }
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
    const authHeader = event.headers.authorization || event.headers.Authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing auth' }) }
    }

    const environmentId = event.queryStringParameters?.environmentId || 'vacation'
    const entityId = event.queryStringParameters?.entityId || 'sensor.gas_meter_gas_consumption'
    const hoursBack = parseInt(event.queryStringParameters?.hoursBack || '200', 10) // ~8 days back to March 3

    const { baseUrl, token } = getHaConfigDirect(environmentId)

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
    const readings = entityHistory
      .map(state => ({
        timestamp: new Date(state.last_changed || state.last_updated).getTime(),
        value: parseNumericState(state.state),
      }))
      .filter(r => Number.isFinite(r.value))
      .sort((a, b) => a.timestamp - b.timestamp)

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
      const atStart = readings.filter(r => r.timestamp <= hourStart).pop()
      const atEnd = readings.filter(r => r.timestamp < hourEnd).pop()

      if (atStart && atEnd && atEnd.timestamp > atStart.timestamp) {
        const delta = Math.max(0, atEnd.value - atStart.value)
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
