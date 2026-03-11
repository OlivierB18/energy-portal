import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const managementTokenCache = { token: null, expiresAt: 0 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const getManagementToken = async (domain) => {
  const now = Date.now()
  if (managementTokenCache.token && now < managementTokenCache.expiresAt - 60000) {
    return managementTokenCache.token
  }

  const fetchToken = async () => {
    const response = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: getEnv('AUTH0_M2M_CLIENT_ID'),
        client_secret: getEnv('AUTH0_M2M_CLIENT_SECRET'),
        audience: `https://${domain}/api/v2/`,
        grant_type: 'client_credentials',
      }),
    })

    if (!response.ok) {
      throw new Error('Unable to get management token')
    }

    return response.json()
  }

  try {
    const data = await fetchToken()
    const expiresIn = Number(data.expires_in) || 600
    managementTokenCache.token = data.access_token
    managementTokenCache.expiresAt = Date.now() + expiresIn * 1000
    return managementTokenCache.token
  } catch {
    await sleep(200)
    const data = await fetchToken()
    const expiresIn = Number(data.expires_in) || 600
    managementTokenCache.token = data.access_token
    managementTokenCache.expiresAt = Date.now() + expiresIn * 1000
    return managementTokenCache.token
  }
}

const getClientMetadata = async (domain, token) => {
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    throw new Error('Unable to fetch app metadata')
  }

  const client = await response.json()
  return client.client_metadata || {}
}

const updateClientMetadata = async (domain, token, metadata) => {
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_metadata: metadata }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || 'Unable to update app metadata')
  }
}

const verifyAuth = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing token')
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
}

const normalizePricingConfig = (input) => {
  if (!input || typeof input !== 'object') {
    return null
  }

  const type = input.type === 'dynamic' ? 'dynamic' : 'fixed'
  const parseNumber = (raw, fallback) => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  return {
    type,
    consumerPrice: parseNumber(input.consumerPrice, 0.30),
    producerPrice: parseNumber(input.producerPrice, 0.10),
    consumerMargin: parseNumber(input.consumerMargin, 0.05),
    producerMargin: parseNumber(input.producerMargin, 0.02),
    updatedAt: new Date().toISOString(),
  }
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    await verifyAuth(event)

    const body = JSON.parse(event.body || '{}')
    const environmentId = String(body.environmentId || '').trim()
    const config = normalizePricingConfig(body.config)

    if (!environmentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
    }

    if (!config) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid pricing config' }) }
    }

    const domain = getEnv('AUTH0_DOMAIN')
    const managementToken = await getManagementToken(domain)
    const metadata = await getClientMetadata(domain, managementToken)

    const nextPricingMap = {
      ...(metadata.energy_pricing || {}),
      [environmentId]: config,
    }

    await updateClientMetadata(domain, managementToken, {
      ...metadata,
      energy_pricing: nextPricingMap,
    })

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        environmentId,
        config,
      }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const statusCode = message === 'Missing token' ? 401 : 500
    return {
      statusCode,
      body: JSON.stringify({ error: message }),
    }
  }
}
