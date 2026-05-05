import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient } from './_supabase.js'
import { detectEnergyEntities } from './shared/entity-detection.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
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
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
  const email = getEmailFromPayload(payload)
  return {
    email,
    isAdmin: isAdminEmail(email),
  }
}

const parseJsonBody = (body) => {
  try {
    return JSON.parse(body || '{}')
  } catch {
    return null
  }
}

const normalizeEnvironmentInput = (payload) => ({
  id: String(payload?.id || '').trim(),
  name: String(payload?.name || '').trim(),
  display_name: String(payload?.display_name || '').trim() || null,
  ha_base_url: String(payload?.ha_base_url || '').trim().replace(/\/+$/, ''),
  ha_api_token: String(payload?.ha_api_token || '').trim(),
  installed_on: payload?.installed_on ? new Date(payload.installed_on).toISOString() : null,
  timezone: String(payload?.timezone || 'Europe/Amsterdam').trim() || 'Europe/Amsterdam',
  is_active: payload?.is_active !== false,
  has_solar: Boolean(payload?.has_solar),
  has_gas: Boolean(payload?.has_gas),
})

const assertAdmin = (auth) => {
  if (!auth.isAdmin) {
    const error = new Error('Admin only')
    error.statusCode = 403
    throw error
  }
}

const testHaConnection = async (ha_base_url, ha_api_token) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${ha_base_url}/api/states`, {
      headers: {
        Authorization: `Bearer ${ha_api_token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Home Assistant request failed: ${response.status}`,
      }
    }

    const states = await response.json()
    const sensors = detectEnergyEntities(Array.isArray(states) ? states : [])
    return {
      ok: true,
      detected: sensors,
      has_solar: Boolean(sensors.solarEntity),
      has_gas: Boolean(sensors.gasEntity),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export const handler = async (event) => {
  try {
    const auth = await verifyAuth(event)
    const supabase = createServiceSupabaseClient()

    if (event.httpMethod === 'GET') {
      const { data, error } = await supabase
        .from('environments')
        .select('*')
        .eq('is_active', true)
        .order('name', { ascending: true })

      if (error) throw error
      return { statusCode: 200, body: JSON.stringify({ environments: data || [] }) }
    }

    if (event.httpMethod === 'POST') {
      const body = parseJsonBody(event.body)
      if (!body) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
      }

      if (event.path?.endsWith('/test-connection') || body?.action === 'test-connection') {
        const ha_base_url = String(body?.ha_base_url || '').trim().replace(/\/+$/, '')
        const ha_api_token = String(body?.ha_api_token || '').trim()

        if (!ha_base_url || !ha_api_token) {
          return { statusCode: 400, body: JSON.stringify({ error: 'Missing ha_base_url or ha_api_token' }) }
        }

        const result = await testHaConnection(ha_base_url, ha_api_token)
        return { statusCode: result.ok ? 200 : 502, body: JSON.stringify(result) }
      }

      assertAdmin(auth)
      const environment = normalizeEnvironmentInput(body)
      if (!environment.id || !environment.name || !environment.ha_base_url || !environment.ha_api_token) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required environment fields' }) }
      }

      const { data, error } = await supabase
        .from('environments')
        .upsert({
          ...environment,
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single()

      if (error) throw error
      return { statusCode: 200, body: JSON.stringify({ environment: data }) }
    }

    if (event.httpMethod === 'PUT') {
      assertAdmin(auth)
      const body = parseJsonBody(event.body)
      if (!body) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
      }

      const id = String(event.queryStringParameters?.id || body?.id || '').trim()
      if (!id) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing environment id' }) }
      }

      const updatePayload = normalizeEnvironmentInput({ ...body, id })
      // Don't overwrite ha_api_token if not provided (e.g. name-only update)
      if (!updatePayload.ha_api_token) {
        delete updatePayload.ha_api_token
      }
      const { data, error } = await supabase
        .from('environments')
        .update({ ...updatePayload, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single()

      if (error) throw error
      return { statusCode: 200, body: JSON.stringify({ environment: data }) }
    }

    if (event.httpMethod === 'DELETE') {
      assertAdmin(auth)
      const id = String(event.queryStringParameters?.id || '').trim()
      if (!id) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing environment id' }) }
      }

      const { error } = await supabase
        .from('environments')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id)

      if (error) throw error
      return { statusCode: 200, body: JSON.stringify({ success: true }) }
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  } catch (error) {
    const statusCode = error?.statusCode || 500
    return {
      statusCode,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Environment API error' }),
    }
  }
}
