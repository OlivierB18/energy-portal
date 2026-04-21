import { createServiceSupabaseClient, toNumberOrNull } from './_supabase.js'
import { detectEnergyEntities } from './shared/entity-detection.js'

export const config = { schedule: '* * * * *' }

const handleDevicePush = async (event, deviceToken) => {
  const supabase = createServiceSupabaseClient()

  // Validate device token and resolve environment_id
  const { data: device, error: deviceError } = await supabase
    .from('devices')
    .select('environment_id')
    .eq('token', deviceToken)
    .maybeSingle()

  if (deviceError) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Device lookup failed' }) }
  }
  if (!device) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid device token' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const environment_id = device.environment_id
  const device_id = String(body?.device_id || 'default').trim()
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ':00.000Z') // minute precision

  const { error: upsertError } = await supabase
    .from('energy_readings')
    .upsert(
      {
        environment_id,
        device_id,
        timestamp,
        power_consumption_w: toNumberOrNull(body?.current_power),
        energy_import_kwh: toNumberOrNull(
          (body?.energy_import_t1_kwh ?? 0) + (body?.energy_import_t2_kwh ?? 0) || null,
        ),
        energy_export_kwh: toNumberOrNull(
          (body?.energy_export_t1_kwh ?? 0) + (body?.energy_export_t2_kwh ?? 0) || null,
        ),
        gas_total_m3: toNumberOrNull(body?.gas_total_m3),
      },
      { onConflict: 'environment_id,timestamp' },
    )

  if (upsertError) {
    return { statusCode: 500, body: JSON.stringify({ error: upsertError.message }) }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, environment_id, device_id }) }
}

const parseNumericState = (value) => {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

const getStateValue = (statesById, entityId) => {
  if (!entityId) return null
  const state = statesById.get(entityId)
  if (!state) return null
  return parseNumericState(state.state)
}

const sumEntityValues = (statesById, entityIds = []) => {
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    return null
  }

  let hasAny = false
  let sum = 0
  for (const entityId of entityIds) {
    const value = getStateValue(statesById, entityId)
    if (value !== null) {
      hasAny = true
      sum += value
    }
  }

  return hasAny ? sum : null
}

const normalizeMinuteTimestamp = (date = new Date()) => {
  const normalized = new Date(date)
  normalized.setSeconds(0, 0)
  return normalized.toISOString()
}

export const handler = async (event) => {
  // HTTP POST: device-pushed reading from agent — validate x-device-token header first
  if (event?.httpMethod === 'POST') {
    const deviceToken = (
      event.headers?.['x-device-token'] ||
      event.headers?.['X-Device-Token'] ||
      ''
    ).trim()
    if (!deviceToken) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing x-device-token' }) }
    }
    return handleDevicePush(event, deviceToken)
  }

  // Scheduled invocation: fetch from HA and ingest directly
  try {
    const supabase = createServiceSupabaseClient()

    const { data: environments, error: envError } = await supabase
      .from('environments')
      .select('*')
      .eq('is_active', true)

    if (envError) {
      throw envError
    }

    const nowMinuteIso = normalizeMinuteTimestamp(new Date())

    for (const env of environments || []) {
      const baseUrl = String(env.ha_base_url || '').replace(/\/+$/, '')
      const token = String(env.ha_api_token || '')
      if (!baseUrl || !token) {
        console.warn(`[Ingest] Skipping ${env.id} because HA config is incomplete`)
        continue
      }

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)

        let states = []
        try {
          const response = await fetch(`${baseUrl}/api/states`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            signal: controller.signal,
          })

          if (!response.ok) {
            throw new Error(`HA states request failed: ${response.status}`)
          }

          states = await response.json()
        } finally {
          clearTimeout(timeout)
        }

        const entities = Array.isArray(states) ? states : []
        const statesById = new Map(entities.map((item) => [String(item?.entity_id || ''), item]))
        const sensors = detectEnergyEntities(entities)

        const hasSolar = Boolean(sensors.solarEntity)
        const hasGas = Boolean(sensors.gasEntity)

        if (env.has_solar !== hasSolar || env.has_gas !== hasGas) {
          await supabase
            .from('environments')
            .update({
              has_solar: hasSolar,
              has_gas: hasGas,
              updated_at: new Date().toISOString(),
            })
            .eq('id', env.id)
        }

        const mappings = []
        if (sensors.currentPower) mappings.push({ environment_id: env.id, sensor_type: 'power_consumption', entity_id: sensors.currentPower, is_primary: true })
        if (sensors.currentProduction) mappings.push({ environment_id: env.id, sensor_type: 'power_production', entity_id: sensors.currentProduction, is_primary: true })
        sensors.consumptionEntities.forEach((entityId, index) => mappings.push({ environment_id: env.id, sensor_type: 'energy_import', entity_id: entityId, is_primary: index === 0 }))
        sensors.exportEntities.forEach((entityId, index) => mappings.push({ environment_id: env.id, sensor_type: 'energy_export', entity_id: entityId, is_primary: index === 0 }))
        if (sensors.solarEntity) mappings.push({ environment_id: env.id, sensor_type: 'solar_energy', entity_id: sensors.solarEntity, is_primary: true })
        if (sensors.gasEntity) mappings.push({ environment_id: env.id, sensor_type: 'gas_total', entity_id: sensors.gasEntity, is_primary: true })

        if (mappings.length > 0) {
          await supabase
            .from('environment_sensors')
            .upsert(mappings, { onConflict: 'environment_id,sensor_type,entity_id' })
        }

        const powerConsumptionW = getStateValue(statesById, sensors.currentPower)
        const powerProductionW = getStateValue(statesById, sensors.currentProduction)
        const energyImportKwh = sumEntityValues(statesById, sensors.consumptionEntities)
        const energyExportKwh = sumEntityValues(statesById, sensors.exportEntities)
        const solarEnergyKwh = getStateValue(statesById, sensors.solarEntity)
        const gasTotalM3 = getStateValue(statesById, sensors.gasEntity)

        const netPowerW =
          powerConsumptionW !== null && powerProductionW !== null
            ? powerConsumptionW - powerProductionW
            : powerConsumptionW

        const { error: upsertError } = await supabase
          .from('energy_readings')
          .upsert({
            environment_id: env.id,
            timestamp: nowMinuteIso,
            power_consumption_w: toNumberOrNull(powerConsumptionW),
            power_production_w: toNumberOrNull(powerProductionW),
            energy_import_kwh: toNumberOrNull(energyImportKwh),
            energy_export_kwh: toNumberOrNull(energyExportKwh),
            solar_energy_kwh: toNumberOrNull(solarEnergyKwh),
            gas_total_m3: toNumberOrNull(gasTotalM3),
            net_power_w: toNumberOrNull(netPowerW),
          }, { onConflict: 'environment_id,timestamp' })

        if (upsertError) {
          throw upsertError
        }

        console.log(`[Ingest] OK ${env.id}: P=${powerConsumptionW ?? 'null'}W Prod=${powerProductionW ?? 'null'}W`) 
      } catch (error) {
        console.error(`[Ingest] FAIL ${env.id}:`, error instanceof Error ? error.message : String(error))
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Ingest failed' }),
    }
  }
}
