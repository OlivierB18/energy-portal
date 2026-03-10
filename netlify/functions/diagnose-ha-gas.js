/**
 * Diagnostic function: tests ALL possible HA API endpoints for gas data
 * Visit: /.netlify/functions/diagnose-ha-gas?environmentId=vacation
 * This will show exactly which HA APIs return data and which fail.
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

const getHaConfig = (envId) => {
  const env = HA_ENVIRONMENTS[envId] ||
    HA_ENVIRONMENTS[Object.keys(HA_ENVIRONMENTS).find(k => k.toLowerCase() === envId?.toLowerCase())]
  if (!env) throw new Error(`Unknown env: ${envId}`)
  return { baseUrl: getEnv(env.urlEnv), token: getEnv(env.tokenEnv) }
}

const tryFetch = async (url, token, label) => {
  const result = { label, url, status: null, ok: false, body: null, error: null, dataCount: 0 }
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    result.status = resp.status
    result.ok = resp.ok
    const text = await resp.text()
    try {
      const json = JSON.parse(text)
      // Truncate large responses
      if (Array.isArray(json)) {
        result.dataCount = json.length
        result.body = json.length > 0
          ? { totalEntities: json.length, firstEntity: Array.isArray(json[0]) ? { stateCount: json[0].length, firstState: json[0][0], lastState: json[0][json[0].length - 1] } : json[0] }
          : []
      } else if (typeof json === 'object' && json !== null) {
        const keys = Object.keys(json)
        result.dataCount = keys.length
        const preview = {}
        for (const key of keys.slice(0, 5)) {
          const val = json[key]
          if (Array.isArray(val)) {
            preview[key] = { rowCount: val.length, first: val[0], last: val[val.length - 1] }
          } else {
            preview[key] = val
          }
        }
        result.body = preview
      } else {
        result.body = json
      }
    } catch {
      result.body = text.substring(0, 500)
    }
  } catch (err) {
    result.error = err.message
  }
  return result
}

export const handler = async (event) => {
  try {
    const envId = event.queryStringParameters?.environmentId || 'vacation'
    const entityId = event.queryStringParameters?.entityId || 'sensor.gas_meter_gas_consumption'
    const { baseUrl, token } = getHaConfig(envId)

    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
    const startTimeISO = todayStart.toISOString()
    const endTimeISO = now.toISOString()
    const yesterdayStart = new Date(todayStart.getTime() - 86400000).toISOString()

    const results = []

    // ============================================
    // TEST 1: Check if entity exists via /api/states
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/states/${entityId}`,
      token,
      '1. Entity state (/api/states/<entity_id>)',
    ))

    // ============================================
    // TEST 2: Regular history API
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/history/period/${startTimeISO}?filter_entity_id=${entityId}&end_time=${endTimeISO}`,
      token,
      '2. Regular history (/api/history/period/ with filter_entity_id)',
    ))

    // ============================================
    // TEST 3: Regular history since yesterday (longer range = more data)
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/history/period/${yesterdayStart}?filter_entity_id=${entityId}&end_time=${endTimeISO}`,
      token,
      '3. Regular history (yesterday to now)',
    ))

    // ============================================
    // TEST 4: Statistics API (hourly)
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/history/statistics_during_period/${startTimeISO}?statistic_ids=${entityId}&period=hour&end_time=${endTimeISO}`,
      token,
      '4. Statistics API hourly (/api/history/statistics_during_period/)',
    ))

    // ============================================
    // TEST 5: Statistics API (5 minute)
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/history/statistics_during_period/${startTimeISO}?statistic_ids=${entityId}&period=5minute&end_time=${endTimeISO}`,
      token,
      '5. Statistics API 5-minute period',
    ))

    // ============================================
    // TEST 6: Maybe the entity needs :total suffix for statistics
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/history/statistics_during_period/${startTimeISO}?statistic_ids=${entityId}&period=hour&end_time=${endTimeISO}&types=change,sum,state`,
      token,
      '6. Statistics API with types=change,sum,state',
    ))

    // ============================================
    // TEST 7: Check ALL statistics (no filter) - see what stat IDs exist
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/history/statistics_during_period/${startTimeISO}?period=hour&end_time=${endTimeISO}`,
      token,
      '7. Statistics API - ALL stat IDs (no filter)',
    ))

    // ============================================
    // TEST 8: Try /api/states to list ALL gas-related entities
    // ============================================
    const allStatesResult = await tryFetch(
      `${baseUrl}/api/states`,
      token,
      '8. All states - looking for gas entities',
    )
    // Filter for gas-related entities
    try {
      const resp = await fetch(`${baseUrl}/api/states`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (resp.ok) {
        const states = await resp.json()
        const gasEntities = states.filter(s => {
          const id = (s.entity_id || '').toLowerCase()
          const name = (s.attributes?.friendly_name || '').toLowerCase()
          return id.includes('gas') || name.includes('gas')
        }).map(s => ({
          entity_id: s.entity_id,
          state: s.state,
          unit: s.attributes?.unit_of_measurement,
          friendly_name: s.attributes?.friendly_name,
          device_class: s.attributes?.device_class,
          state_class: s.attributes?.state_class,
        }))
        allStatesResult.body = { gasEntitiesFound: gasEntities.length, gasEntities }
        allStatesResult.dataCount = gasEntities.length
      }
    } catch { /* already captured in tryFetch */ }
    results.push(allStatesResult)

    // ============================================
    // TEST 9: Check HA config/version
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/config`,
      token,
      '9. HA Config (version info)',
    ))

    // ============================================
    // TEST 10: Try history with minimal_response
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/history/period/${startTimeISO}?filter_entity_id=${entityId}&end_time=${endTimeISO}&minimal_response&no_attributes`,
      token,
      '10. History with minimal_response & no_attributes',
    ))

    // ============================================
    // TEST 11: Try the recorder/statistics endpoint (if REST available)
    // ============================================
    results.push(await tryFetch(
      `${baseUrl}/api/statistics/${entityId}?start_time=${startTimeISO}&end_time=${endTimeISO}&period=hour`,
      token,
      '11. Alternative statistics endpoint (/api/statistics/)',
    ))

    // Summary
    const summary = {
      environment: envId,
      targetEntity: entityId,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      timeRange: { start: startTimeISO, end: endTimeISO },
      testResults: results.map(r => ({
        test: r.label,
        status: r.status,
        ok: r.ok,
        error: r.error,
        dataCount: r.dataCount,
      })),
      fullResults: results,
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary, null, 2),
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    }
  }
}
