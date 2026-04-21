import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient } from './_supabase.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
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

const toEnvironmentSlug = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63) || 'environment'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  try {
    await verifyAuth(event)
  } catch (err) {
    return {
      statusCode: err.statusCode || 401,
      body: JSON.stringify({ error: err.message || 'Unauthorized' }),
    }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const name = String(body?.name || '').trim()
  const ha_url = String(body?.ha_url || '').trim().replace(/\/+$/, '')
  const ha_token = String(body?.ha_token || '').trim()

  if (!name || !ha_url) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields: name, ha_url' }),
    }
  }

  const supabase = createServiceSupabaseClient()
  const environment_id = toEnvironmentSlug(name)

  try {
    // Step 1: INSERT into environments
    const { error: envError } = await supabase.from('environments').insert({
      id: environment_id,
      name,
      ha_base_url: ha_url,
      ha_api_token: ha_token || null,
      is_active: true,
      timezone: 'Europe/Amsterdam',
      updated_at: new Date().toISOString(),
    })

    if (envError) throw envError

    // Step 2: INSERT into devices with a randomly generated token
    const device_token = crypto.randomUUID()
    const { error: deviceError } = await supabase.from('devices').insert({
      environment_id,
      token: device_token,
    })

    if (deviceError) throw deviceError

    // Step 3: Return provisioning result
    return {
      statusCode: 201,
      body: JSON.stringify({
        environment_id,
        device_token,
        ingest_url: '/.netlify/functions/ingest-energy',
      }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Provisioning failed',
      }),
    }
  }
}
