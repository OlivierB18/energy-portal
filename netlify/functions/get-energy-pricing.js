import { createRemoteJWKSet, jwtVerify } from 'jose'
import { getMergedPricingMap, resolvePricingConfig } from './_pricing-storage.js'
import { resolveEnvironmentReference } from './_environment-storage.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const getOptionalEnv = (key) => {
  const value = process.env[key]
  return value && value.trim().length > 0 ? value : null
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
    gasPrice: parseNumber(input.gasPrice, 1.35),
    gasMargin: parseNumber(input.gasMargin, 0),
    gasProxyKwhPerM3: parseNumber(input.gasProxyKwhPerM3, 10.55),
    updatedAt: String(input.updatedAt || input.updated_at || ''),
  }
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const environmentId = String(event.queryStringParameters?.environmentId || '').trim()
    if (!environmentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
    }

    await verifyAuth(event)

    let merged = await getMergedPricingMap({
      event,
      metadata: {},
    })

    // If blob is empty, fall back to legacy metadata and migrate on read.
    if (Object.keys(merged.pricingMap).length === 0) {
      try {
        const domain = getEnv('AUTH0_DOMAIN')
        const managementToken = await getManagementToken(domain)
        const metadata = await getClientMetadata(domain, managementToken)
        merged = await getMergedPricingMap({
          event,
          metadata,
        })
      } catch (metadataError) {
        console.warn('[GET-ENERGY-PRICING] Metadata fallback unavailable:', metadataError instanceof Error ? metadataError.message : metadataError)
      }
    }

    let canonicalEnvironmentId = environmentId
    let aliasIds = [environmentId]
    try {
      const domain = getEnv('AUTH0_DOMAIN')
      const managementToken = await getManagementToken(domain)
      const metadata = await getClientMetadata(domain, managementToken)
      const resolvedReference = await resolveEnvironmentReference({
        event,
        metadata,
        environmentId,
        getOptionalEnv,
      })
      canonicalEnvironmentId = resolvedReference.environmentId
      aliasIds = resolvedReference.aliases
    } catch {
      // Keep fallback to requested ID.
    }

    const resolvedConfig = aliasIds
      .map((id) => resolvePricingConfig({ pricingMap: merged.pricingMap, environmentId: id }))
      .find((config) => config !== null)
    const config = normalizePricingConfig(resolvedConfig)

    return {
      statusCode: 200,
      body: JSON.stringify({
        environmentId: canonicalEnvironmentId,
        config,
        source: merged.source,
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
