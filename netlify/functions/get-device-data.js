import { createClient } from '@supabase/supabase-js'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    // Verify JWT authentication
    const authHeader = event.headers.authorization || event.headers.Authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
    }

    const token = authHeader.replace('Bearer ', '')
    const domain = getEnv('AUTH0_DOMAIN')

    try {
      const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
      await jwtVerify(token, jwks, {
        issuer: `https://${domain}/`,
      })
    } catch (error) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) }
    }

    // Get query parameters
    const params = event.queryStringParameters || {}
    const environmentId = params.environment_id
    const startTime = params.start_time // ISO timestamp
    const endTime = params.end_time // ISO timestamp

    if (!environmentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environment_id' }) }
    }

    const supabaseUrl = getEnv('SUPABASE_URL')
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // Build query
    let query = supabase
      .from('device_data')
      .select('timestamp, current_power, energy_import_t1_kwh, energy_import_t2_kwh, gas_total_m3')
      .eq('environment_id', environmentId)
      .order('timestamp', { ascending: true })

    if (startTime) {
      query = query.gte('timestamp', startTime)
    }
    if (endTime) {
      query = query.lte('timestamp', endTime)
    }

    const { data, error } = await query.limit(10000)

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ data: data || [] }),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  } catch (error) {
    console.error('[get-device-data] error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
    }
  }
}
