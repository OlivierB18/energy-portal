import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient } from './_supabase.js'
import { detectEnergyEntities } from './shared/entity-detection.js'

const ENV_METADATA_PREFIX = 'ha_env_v1_'

const getAuth0ManagementToken = async () => {
  const domain = process.env.AUTH0_DOMAIN
  const clientId = process.env.AUTH0_M2M_CLIENT_ID
  const clientSecret = process.env.AUTH0_M2M_CLIENT_SECRET
  if (!domain || !clientId || !clientSecret) return null
  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`,
      grant_type: 'client_credentials',
    }),
  })
  if (!response.ok) return null
  const data = await response.json()
  return data.access_token || null
}

const getAuth0ClientMetadata = async () => {
  const domain = process.env.AUTH0_DOMAIN
  const appClientId = process.env.AUTH0_APP_CLIENT_ID
  if (!domain || !appClientId) return {}
  const token = await getAuth0ManagementToken()
  if (!token) return {}
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(appClientId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) return {}
  const client = await response.json()
  return client.client_metadata || {}
}

const parseCredentialsFromAuth0Metadata = (metadata) => {
  const urlKeys = Object.keys(metadata || {}).filter(
    (key) => key.startsWith(ENV_METADATA_PREFIX) && key.endsWith('_url'),
  )
  return urlKeys.reduce((acc, urlKey) => {
    const encodedId = urlKey.slice(ENV_METADATA_PREFIX.length, -'_url'.length)
    let environmentId
    try {
      environmentId = Buffer.from(encodedId, 'base64url').toString('utf8').trim()
    } catch {
      return acc
    }
    if (!environmentId) return acc
    const tokenKey = `${ENV_METADATA_PREFIX}${encodedId}_token`
    const nameKey = `${ENV_METADATA_PREFIX}${encodedId}_name`
    const baseUrl = String(metadata[urlKey] || '').trim()
    const apiKey = String(metadata[tokenKey] || '').trim()
    if (!baseUrl || !apiKey) return acc
    acc.push({ id: environmentId, name: String(metadata[nameKey] || '').trim(), baseUrl, apiKey })
    return acc
  }, [])
}

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
      const environments = data || []

      // Auto-migrate HA credentials from Auth0 client metadata if any environment is missing them
      const needsMigration = environments.filter((env) => !env.ha_base_url || !env.ha_api_token)
      if (needsMigration.length > 0) {
        try {
          const auth0Metadata = await getAuth0ClientMetadata()
          const credSources = parseCredentialsFromAuth0Metadata(auth0Metadata)
          console.log(`[ENV MIGRATE] Found ${credSources.length} credential entries in Auth0 metadata`)

          for (const env of needsMigration) {
            const match = credSources.find(
              (b) =>
                b.id === env.id ||
                b.id.toLowerCase() === env.id.toLowerCase() ||
                (b.name && b.name.toLowerCase() === (env.name || '').toLowerCase()),
            )
            if (match?.baseUrl && match?.apiKey) {
              const patch = {
                ha_base_url: match.baseUrl,
                ha_api_token: match.apiKey,
                updated_at: new Date().toISOString(),
              }
              await supabase.from('environments').update(patch).eq('id', env.id)
              Object.assign(env, patch)
              console.log(`[ENV MIGRATE] Auto-migrated credentials for ${env.id} from Auth0 → Supabase`)
            } else {
              console.warn(`[ENV MIGRATE] No Auth0 credentials found for ${env.id}. Available IDs: ${credSources.map(c => c.id).join(', ')}`)
            }
          }
        } catch (migrateError) {
          console.warn('[ENV MIGRATE] Migration skipped:', migrateError?.message)
        }
      }

      return { statusCode: 200, body: JSON.stringify({ environments }) }
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
