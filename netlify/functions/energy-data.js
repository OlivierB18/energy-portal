import { createRemoteJWKSet, jwtVerify } from 'jose'
import { clampNonNegative, createServiceSupabaseClient, getViewRange, toDayString } from './_supabase.js'
import { resolveEnvironmentConfig } from './_environment-storage.js'

const _getOptionalEnvFallback = (key) => {
  const value = process.env[key]
  return value && value.trim().length > 0 ? value : null
}

async function getHaFallback(event, environmentId) {
  try {
    const config = await resolveEnvironmentConfig({ event, environmentId, getOptionalEnv: _getOptionalEnvFallback })
    return {
      haUrl: config?.baseUrl || null,
      haToken: config?.token || null,
    }
  } catch {
    return null
  }
}

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const verifyAuth = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    const error = new Error('Missing token')
    error.statusCode = 401
    throw error
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
}

const summarizeRows = (rows) => {
  const safe = Array.isArray(rows) ? rows : []
  return {
    kwh_imported: Number(safe.reduce((sum, row) => sum + (Number(row?.kwh_imported) || 0), 0).toFixed(3)),
    kwh_exported: Number(safe.reduce((sum, row) => sum + (Number(row?.kwh_exported) || 0), 0).toFixed(3)),
    solar_kwh: Number(safe.reduce((sum, row) => sum + (Number(row?.solar_kwh) || 0), 0).toFixed(3)),
    gas_m3: Number(safe.reduce((sum, row) => sum + (Number(row?.gas_m3) || 0), 0).toFixed(3)),
    avg_power_w: safe.length > 0
      ? Number((safe.reduce((sum, row) => sum + (Number(row?.avg_power_w) || 0), 0) / safe.length).toFixed(2))
      : 0,
    max_power_w: Number(safe.reduce((max, row) => Math.max(max, Number(row?.max_power_w) || 0), 0).toFixed(2)),
  }
}

const resolveRangeFromQuery = (query) => {
  const now = new Date()
  const hoursBack = Number(query?.hoursBack)
  if (Number.isFinite(hoursBack) && hoursBack > 0) {
    const end = now
    const start = new Date(now.getTime() - hoursBack * 60 * 60 * 1000)
    return {
      view: 'hours',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      start,
      end,
    }
  }

  const explicitStart = String(query?.startTime || '').trim()
  const explicitEnd = String(query?.endTime || '').trim()
  const startMs = Date.parse(explicitStart)
  const endMs = Date.parse(explicitEnd)
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    const start = new Date(startMs)
    const end = new Date(endMs)
    return {
      view: 'custom',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      start,
      end,
    }
  }

  return getViewRange({ view: query?.view || 'day', date: query?.date })
}

const buildLegacyStatisticsEntityRows = ({ hourlyRows, entityIds, productionEntityIds }) => {
  const ids = String(entityIds || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (ids.length === 0) {
    return []
  }

  const productionSet = new Set(
    String(productionEntityIds || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )

  const consumptionId = ids.find((id) => !productionSet.has(id)) || ids[0]
  const exportId = ids.find((id) => productionSet.has(id)) || null

  const rows = []

  if (consumptionId) {
    rows.push({
      entity_id: consumptionId,
      is_production: false,
      history: hourlyRows.map((row) => ({
        timestamp: new Date(row.hour).getTime(),
        change: clampNonNegative(row.kwh_imported) || 0,
        value: clampNonNegative(row.kwh_imported) || 0,
      })),
    })
  }

  if (exportId) {
    rows.push({
      entity_id: exportId,
      is_production: true,
      history: hourlyRows.map((row) => ({
        timestamp: new Date(row.hour).getTime(),
        change: clampNonNegative(row.kwh_exported) || 0,
        value: clampNonNegative(row.kwh_exported) || 0,
      })),
    })
  }

  return rows
}

const buildLegacyHistoryEntityRows = ({ readings, entityIds }) => {
  const ids = String(entityIds || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (ids.length === 0) {
    return []
  }

  const firstId = ids[0]
  const secondId = ids[1] || null

  const primary = {
    entity_id: firstId,
    history: readings.map((row) => ({
      timestamp: new Date(row.timestamp).getTime(),
      value: Number(row.power_consumption_w) || 0,
      state: String(Number(row.power_consumption_w) || 0),
    })),
  }

  if (!secondId) {
    return [primary]
  }

  return [
    primary,
    {
      entity_id: secondId,
      history: readings.map((row) => ({
        timestamp: new Date(row.timestamp).getTime(),
        value: Number(row.power_production_w) || 0,
        state: String(Number(row.power_production_w) || 0),
      })),
    },
  ]
}

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    }
  }

  try {
    await verifyAuth(event)

    const supabase = createServiceSupabaseClient()
    const query = event.queryStringParameters || {}
    const view = String(query.view || 'day').toLowerCase()

    if (view === 'overview') {
      const { data: environments, error: envError } = await supabase
        .from('environments')
        .select('id,name,display_name,has_solar,has_gas,timezone,is_active')
        .eq('is_active', true)

      if (envError) throw envError

      const today = toDayString(new Date())
      const envIds = (environments || []).map((env) => env.id)

      const { data: dailyRows, error: dailyError } = await supabase
        .from('energy_daily')
        .select('*')
        .in('environment_id', envIds.length > 0 ? envIds : [''])
        .eq('day', today)

      if (dailyError) throw dailyError

      const { data: recentRows, error: recentError } = await supabase
        .from('energy_readings')
        .select('environment_id,timestamp,power_consumption_w,power_production_w,net_power_w')
        .gte('timestamp', new Date(Date.now() - 12 * 60 * 60_000).toISOString())
        .order('timestamp', { ascending: false })

      if (recentError) throw recentError

      const latestByEnvironment = new Map()
      for (const row of recentRows || []) {
        if (!latestByEnvironment.has(row.environment_id)) {
          latestByEnvironment.set(row.environment_id, row)
        }
      }

      const dailyByEnvironment = new Map((dailyRows || []).map((row) => [row.environment_id, row]))

      const overview = (environments || []).map((env) => {
        const daily = dailyByEnvironment.get(env.id)
        const latest = latestByEnvironment.get(env.id)
        return {
          environmentId: env.id,
          name: env.display_name || env.name,
          has_solar: Boolean(env.has_solar),
          has_gas: Boolean(env.has_gas),
          current_power_w: Number(latest?.net_power_w ?? latest?.power_consumption_w ?? 0) || 0,
          kwh_imported: clampNonNegative(daily?.kwh_imported) || 0,
          kwh_exported: clampNonNegative(daily?.kwh_exported) || 0,
          gas_m3: clampNonNegative(daily?.gas_m3) || 0,
          avg_power_w: Number(daily?.avg_power_w || 0),
          max_power_w: Number(daily?.max_power_w || 0),
          updated_at: latest?.timestamp || null,
        }
      })

      return {
        statusCode: 200,
        body: JSON.stringify({
          overview,
          day: today,
        }),
      }
    }

    const environmentId = String(query.environmentId || '').trim()
    if (!environmentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing environmentId' }),
      }
    }

    const { data: environment, error: environmentError } = await supabase
      .from('environments')
      .select('*')
      .eq('id', environmentId)
      .eq('is_active', true)
      .maybeSingle()

    if (environmentError) throw environmentError
    if (!environment) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Environment not found' }),
      }
    }

    const range = resolveRangeFromQuery(query)

    const { data: readings, error: readingsError } = await supabase
      .from('energy_readings')
      .select('*')
      .eq('environment_id', environmentId)
      .gte('timestamp', range.startIso)
      .lt('timestamp', range.endIso)
      .order('timestamp', { ascending: true })

    if (readingsError) throw readingsError

    const { data: hourlyRows, error: hourlyError } = await supabase
      .from('energy_hourly')
      .select('*')
      .eq('environment_id', environmentId)
      .gte('hour', range.startIso)
      .lt('hour', range.endIso)
      .order('hour', { ascending: true })

    if (hourlyError) throw hourlyError

    const startDay = toDayString(range.start)
    const endDay = toDayString(new Date(range.end.getTime() - 1))

    const { data: dailyRows, error: dailyError } = await supabase
      .from('energy_daily')
      .select('*')
      .eq('environment_id', environmentId)
      .gte('day', startDay)
      .lte('day', endDay)
      .order('day', { ascending: true })

    if (dailyError) throw dailyError

    const summarySource = range.view === 'month' ? dailyRows : hourlyRows
    const summary = summarizeRows(summarySource || [])

    const responsePayload = {
      environment: {
        id: environment.id,
        name: environment.display_name || environment.name,
        has_solar: Boolean(environment.has_solar),
        has_gas: Boolean(environment.has_gas),
      },
      period: {
        start: range.startIso,
        end: range.endIso,
      },
      summary,
      hourly: (hourlyRows || []).map((row) => ({
        hour: row.hour,
        kwh_imported: clampNonNegative(row.kwh_imported) || 0,
        kwh_exported: clampNonNegative(row.kwh_exported) || 0,
        solar_kwh: clampNonNegative(row.solar_kwh) || 0,
        gas_m3: clampNonNegative(row.gas_m3) || 0,
        avg_power_w: Number(row.avg_power_w || 0),
      })),
      daily: (dailyRows || []).map((row) => ({
        day: row.day,
        kwh_imported: clampNonNegative(row.kwh_imported) || 0,
        kwh_exported: clampNonNegative(row.kwh_exported) || 0,
        solar_kwh: clampNonNegative(row.solar_kwh) || 0,
        gas_m3: clampNonNegative(row.gas_m3) || 0,
        avg_power_w: Number(row.avg_power_w || 0),
      })),
      power_samples: (readings || []).map((row) => ({
        timestamp: row.timestamp,
        power_w: Number(row.power_consumption_w || 0),
        production_w: Number(row.power_production_w || 0),
      })),
    }

    // Compatibility mode for existing Dashboard fetches while migrating frontend calls.
    if (query.mode === 'statistics') {
      if (!hourlyRows || hourlyRows.length === 0) {
        const creds = await getHaFallback(event, environmentId)
        if (creds?.haUrl && creds?.haToken) {
          const { handler } = await import('./ha-history.js')
          return handler(event)
        }
      }
      const entities = buildLegacyStatisticsEntityRows({
        hourlyRows: hourlyRows || [],
        entityIds: query.entityIds,
        productionEntityIds: query.productionEntityIds,
      })
      return {
        statusCode: 200,
        body: JSON.stringify({
          entities,
          timestamp: new Date().toISOString(),
          mode: 'statistics',
          source: 'supabase',
          summary,
        }),
      }
    }

    if (query.mode === 'history' || query.entityIds) {
      if (!readings || readings.length === 0) {
        const creds = await getHaFallback(event, environmentId)
        if (creds?.haUrl && creds?.haToken) {
          const { handler } = await import('./ha-history.js')
          return handler(event)
        }
      }
      const entities = buildLegacyHistoryEntityRows({
        readings: readings || [],
        entityIds: query.entityIds,
      })
      return {
        statusCode: 200,
        body: JSON.stringify({
          entities,
          timestamp: new Date().toISOString(),
          source: 'supabase',
          summary,
        }),
      }
    }

    // Compatibility for old gas endpoint style
    if (query.hoursBack) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          environmentId,
          hourly: (hourlyRows || []).map((row) => ({
            hour: row.hour,
            delta: clampNonNegative(row.gas_m3) || 0,
          })),
          source: 'supabase',
        }),
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify(responsePayload),
    }
  } catch (error) {
    const statusCode = error?.statusCode || 500
    return {
      statusCode,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to load energy data' }),
    }
  }
}
