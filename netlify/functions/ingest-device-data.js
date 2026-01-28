import { createClient } from '@supabase/supabase-js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const parseFloatOrNull = (value) => {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const ingestKey = getEnv('INGEST_API_KEY')
    const providedKey = event.headers['x-ingest-key'] || event.headers['X-Ingest-Key']

    if (!providedKey || providedKey !== ingestKey) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
    }

    const body = JSON.parse(event.body || '{}')

    const payload = {
      environment_id: body.environment_id,
      device_id: body.device_id,
      timestamp: new Date().toISOString(),
      current_power: parseFloatOrNull(body.current_power),
      energy_import_t1_kwh: parseFloatOrNull(body.energy_import_t1_kwh),
      energy_import_t2_kwh: parseFloatOrNull(body.energy_import_t2_kwh),
      energy_export_t1_kwh: parseFloatOrNull(body.energy_export_t1_kwh),
      energy_export_t2_kwh: parseFloatOrNull(body.energy_export_t2_kwh),
      gas_total_m3: parseFloatOrNull(body.gas_total_m3),
    }

    if (!payload.environment_id || !payload.device_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environment_id or device_id' }) }
    }

    const supabaseUrl = getEnv('SUPABASE_URL')
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const { error } = await supabase.from('device_data').insert(payload)
    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
    }
  }
}
