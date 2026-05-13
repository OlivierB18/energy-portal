import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient, toNumberOrNull } from './_supabase.js'
import { detectEnergyEntities } from './shared/entity-detection.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const normalizeText = (value) => String(value || '').trim()

const parseNumericState = (value) => {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

const getEmailFromPayload = (payload) => {
  const emailValue = payload.email || payload['https://brouwer-ems/email']
  return typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
}

const isAdminEmail = (email) => {
  const allowlist = (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const owner = String(process.env.OWNER_EMAIL || '').trim().toLowerCase()
  return (owner && email === owner) || allowlist.includes(email)
}

const verifyAdmin = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    const error = new Error('Missing token')
    error.statusCode = 401
    throw error
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
  const email = getEmailFromPayload(payload)

  if (!isAdminEmail(email)) {
    const error = new Error('Admin only')
    error.statusCode = 403
    throw error
  }
}

const floorToUtcHour = (date) => {
  const d = new Date(date)
  d.setUTCMinutes(0, 0, 0)
  return d
}

const toIsoHour = (date) => floorToUtcHour(date).toISOString()

const chunkArray = (items, size) => {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

const fetchHaStates = async ({ baseUrl, token }) => {
  const response = await fetch(`${baseUrl}/api/states`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`HA states request failed: ${response.status}`)
  }

  const states = await response.json()
  return Array.isArray(states) ? states : []
}

const fetchHaHistoryRange = async ({ baseUrl, token, startIso, endIso, entityIds }) => {
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    return []
  }

  const url = new URL(`${baseUrl}/api/history/period/${encodeURIComponent(startIso)}`)
  url.searchParams.set('end_time', endIso)
  url.searchParams.set('filter_entity_id', entityIds.join(','))
  url.searchParams.set('minimal_response', '1')
  url.searchParams.set('no_attributes', '1')

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`HA history request failed: ${response.status}`)
  }

  const payload = await response.json()
  return Array.isArray(payload) ? payload : []
}

const buildHourlyEntityMaps = ({ historyPayload, targetEntityIds }) => {
  const mapByEntity = new Map()
  targetEntityIds.forEach((id) => mapByEntity.set(id, new Map()))

  const registerPoint = (entityId, point) => {
    if (!mapByEntity.has(entityId)) return
    const ts = Date.parse(point?.last_changed || point?.last_updated || '')
    if (!Number.isFinite(ts)) return
    const value = parseNumericState(point?.state)
    if (value === null) return
    mapByEntity.get(entityId).set(toIsoHour(new Date(ts)), value)
  }

  if (historyPayload.length > 0 && Array.isArray(historyPayload[0])) {
    for (const series of historyPayload) {
      if (!Array.isArray(series) || series.length === 0) continue
      const first = series[0]
      const entityId = normalizeText(first?.entity_id)
      if (!entityId) continue
      for (const point of series) {
        registerPoint(entityId, point)
      }
    }
  } else {
    for (const point of historyPayload) {
      const entityId = normalizeText(point?.entity_id)
      if (!entityId) continue
      registerPoint(entityId, point)
    }
  }

  return mapByEntity
}

const buildHourlyReadings = ({ environmentId, startIso, endIso, importIds, exportIds, gasId, entityHourMaps }) => {
  const readings = []
  const startHour = floorToUtcHour(startIso)
  const endHour = floorToUtcHour(endIso)

  const lastValues = new Map()

  const getForwardFilledSum = (entityIds) => {
    let hasAny = false
    let sum = 0
    for (const entityId of entityIds) {
      const map = entityHourMaps.get(entityId)
      if (!map) continue
      const next = map.get(currentHourIso)
      if (next !== undefined) {
        lastValues.set(entityId, next)
      }
      const value = lastValues.get(entityId)
      if (Number.isFinite(value)) {
        hasAny = true
        sum += value
      }
    }
    return hasAny ? sum : null
  }

  const getForwardFilledValue = (entityId) => {
    if (!entityId) return null
    const map = entityHourMaps.get(entityId)
    if (!map) return null
    const next = map.get(currentHourIso)
    if (next !== undefined) {
      lastValues.set(entityId, next)
    }
    const value = lastValues.get(entityId)
    return Number.isFinite(value) ? value : null
  }

  let cursor = new Date(startHour)
  while (cursor <= endHour) {
    const currentHourIso = cursor.toISOString()

    const energyImport = getForwardFilledSum(importIds)
    const energyExport = getForwardFilledSum(exportIds)
    const gasTotal = getForwardFilledValue(gasId)

    if (energyImport !== null || energyExport !== null || gasTotal !== null) {
      readings.push({
        environment_id: environmentId,
        timestamp: currentHourIso,
        energy_import_kwh: toNumberOrNull(energyImport),
        energy_export_kwh: toNumberOrNull(energyExport),
        gas_total_m3: toNumberOrNull(gasTotal),
      })
    }

    cursor = new Date(cursor.getTime() + 60 * 60 * 1000)
  }

  return readings
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed, use POST' }) }
    }

    await verifyAdmin(event)

    const body = JSON.parse(event.body || '{}')
    const environmentId = normalizeText(body.environmentId)
    if (!environmentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
    }

    const chunkDays = Math.max(1, Math.min(31, Number(body.chunkDays) || 7))
    const dryRun = Boolean(body.dryRun)

    const supabase = createServiceSupabaseClient()
    const { data: env, error: envError } = await supabase
      .from('environments')
      .select('id,name,installed_on,ha_base_url,ha_api_token,is_active')
      .eq('id', environmentId)
      .maybeSingle()

    if (envError) throw envError
    if (!env) {
      return { statusCode: 404, body: JSON.stringify({ error: `Unknown environment: ${environmentId}` }) }
    }

    const baseUrl = normalizeText(env.ha_base_url).replace(/\/+$/, '')
    const token = normalizeText(env.ha_api_token)
    if (!baseUrl || !token) {
      return { statusCode: 400, body: JSON.stringify({ error: `Environment ${environmentId} missing ha_base_url or ha_api_token` }) }
    }

    const startIso = normalizeText(body.startDate)
      || (env.installed_on ? new Date(env.installed_on).toISOString() : '')
    if (!startIso) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No startDate and no installed_on on environment' }) }
    }

    const endIso = normalizeText(body.endDate) || new Date().toISOString()
    const startMs = Date.parse(startIso)
    const endMs = Date.parse(endIso)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid startDate/endDate' }) }
    }

    const states = await fetchHaStates({ baseUrl, token })
    const detected = detectEnergyEntities(states)

    const importIds = detected.consumptionEntities || []
    const exportIds = detected.exportEntities || []
    const gasId = detected.gasEntity || null
    const trackedIds = Array.from(new Set([...importIds, ...exportIds, ...(gasId ? [gasId] : [])]))

    if (trackedIds.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No meter entities detected for backfill', detected }),
      }
    }

    const allEntityHourMaps = new Map()
    trackedIds.forEach((id) => allEntityHourMaps.set(id, new Map()))

    let cursor = new Date(startMs)
    while (cursor.getTime() < endMs) {
      const chunkStart = new Date(cursor)
      const chunkEnd = new Date(Math.min(endMs, chunkStart.getTime() + chunkDays * 24 * 60 * 60 * 1000))

      const historyPayload = await fetchHaHistoryRange({
        baseUrl,
        token,
        startIso: chunkStart.toISOString(),
        endIso: chunkEnd.toISOString(),
        entityIds: trackedIds,
      })

      const chunkMaps = buildHourlyEntityMaps({ historyPayload, targetEntityIds: trackedIds })
      for (const [entityId, hourMap] of chunkMaps.entries()) {
        const aggregateMap = allEntityHourMaps.get(entityId)
        if (!aggregateMap) continue
        for (const [hourIso, value] of hourMap.entries()) {
          aggregateMap.set(hourIso, value)
        }
      }

      cursor = chunkEnd
    }

    const readings = buildHourlyReadings({
      environmentId,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      importIds,
      exportIds,
      gasId,
      entityHourMaps: allEntityHourMaps,
    })

    if (!dryRun && readings.length > 0) {
      for (const chunk of chunkArray(readings, 500)) {
        const { error: upsertError } = await supabase
          .from('energy_readings')
          .upsert(chunk, { onConflict: 'environment_id,timestamp' })
        if (upsertError) throw upsertError
      }

      const hoursBack = Math.max(3, Math.ceil((endMs - startMs) / (60 * 60 * 1000)) + 1)
      const daysBack = Math.max(2, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1)

      await supabase.rpc('aggregate_hourly', { hours_back: hoursBack })
      await supabase.rpc('aggregate_daily', { days_back: daysBack })
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        dryRun,
        environmentId,
        range: { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() },
        detected,
        trackedEntities: trackedIds,
        generatedReadings: readings.length,
      }),
    }
  } catch (error) {
    return {
      statusCode: error?.statusCode || 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    }
  }
}
