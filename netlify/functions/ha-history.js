import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const HA_ENVIRONMENTS = {
  vacation: {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
  'Brouwer TEST': {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
  'brouwer': {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
}

const getHaConfigDirect = (environmentId) => {
  // Try exact match first
  let fallback = HA_ENVIRONMENTS[environmentId]
  
  // Try case-insensitive match
  if (!fallback) {
    const key = Object.keys(HA_ENVIRONMENTS).find(k => k.toLowerCase() === environmentId.toLowerCase())
    if (key) {
      fallback = HA_ENVIRONMENTS[key]
    }
  }
  
  if (!fallback) {
    throw new Error(`Unknown environment: ${environmentId}. Available: ${Object.keys(HA_ENVIRONMENTS).join(', ')}`)
  }

  try {
    const baseUrl = getEnv(fallback.urlEnv)
    const token = getEnv(fallback.tokenEnv)
    return { baseUrl, token }
  } catch (err) {
    throw new Error(`Missing environment variables for ${fallback.urlEnv} or ${fallback.tokenEnv}: ${err.message}`)
  }
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
      const body = await response.text()
      console.error('Failed to get management token:', response.status, body)
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
  } catch (error) {
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

const verifyAuth0Token = async (token) => {
  const domain = getEnv('AUTH0_DOMAIN')
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const issuer = `https://${domain}/`

  const JWKS = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`))

  const verified = await jwtVerify(token, JWKS, {
    audience: clientId,
    issuer,
  })

  return verified.payload
}

export const handler = async (event) => {
  try {
    const authHeader = event.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      console.error('[HA History] Missing authorization header')
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Missing authorization header' }),
      }
    }

    const token = authHeader.slice(7)
    let payload

    try {
      payload = await verifyAuth0Token(token)
    } catch (err) {
      console.error('[HA History] Token verification failed:', err)
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid token' }),
      }
    }

    const environmentId = event.queryStringParameters?.environmentId || 'vacation'
    const startTime = event.queryStringParameters?.startTime
    const endTime = event.queryStringParameters?.endTime
    const entityIds = event.queryStringParameters?.entityIds

    if (!startTime || !endTime || !entityIds) {
      console.error('[HA History] Missing query parameters:', { startTime, endTime, entityIds })
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing query parameters: startTime, endTime, entityIds' }),
      }
    }

    console.log('[HA History] Request for environment:', environmentId, 'entities:', entityIds)

    // Get HA config directly from environment variables
    let haConfig
    try {
      haConfig = getHaConfigDirect(environmentId)
      console.log('[HA History] Got HA config, URL host:', new URL(haConfig.baseUrl).hostname)
    } catch (err) {
      console.error('[HA History] Failed to get HA config:', err.message || err)
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Failed to retrieve Home Assistant config',
          details: err instanceof Error ? err.message : String(err),
        }),
      }
    }

    const { baseUrl, token: haToken } = haConfig

    // Parse entity IDs
    const entityIdsList = entityIds.split(',').map((id) => id.trim())

    // Fetch history from Home Assistant
    const historyUrl = new URL(baseUrl)
    historyUrl.pathname = '/api/history/period'
    historyUrl.searchParams.append('entity_ids', entityIdsList.join(','))
    historyUrl.searchParams.append('start_time', startTime)
    historyUrl.searchParams.append('end_time', endTime)

    console.log('[HA History] Fetching from:', historyUrl.toString())

    let historyResponse
    try {
      historyResponse = await fetch(historyUrl.toString(), {
        headers: {
          Authorization: `Bearer ${haToken}`,
          'Content-Type': 'application/json',
        },
      })
    } catch (fetchErr) {
      console.error('[HA History] Network fetch failed:', fetchErr.message)
      return {
        statusCode: 503,
        body: JSON.stringify({
          error: 'Failed to connect to Home Assistant',
          details: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        }),
      }
    }

    if (!historyResponse.ok) {
      const errorBody = await historyResponse.text()
      console.error('[HA History] HA returned status', historyResponse.status, ':', errorBody)
      return {
        statusCode: historyResponse.status,
        body: JSON.stringify({
          error: `Home Assistant API error: ${historyResponse.status}`,
          details: errorBody,
        }),
      }
    }

    const historyData = await historyResponse.json()

    console.log('[HA History] Raw HA response:', historyData.length, 'entities', 
      historyData.map((h) => ({ entity_id: h[0]?.entity_id, states: h.length })))

    // Convert HA history to our format: array of { entity_id, history: [...] }
    const formatted = historyData.map((entityHistory) => {
      const validStates = (entityHistory || [])
        .filter((state) => state.state && !Number.isNaN(parseFloat(state.state)))
      
      console.log('[HA History] Entity', entityHistory[0]?.entity_id, 'has', validStates.length, 'valid states')
      
      return {
        entity_id: entityHistory[0]?.entity_id || 'unknown',
        history: validStates.map((state) => ({
          timestamp: new Date(state.last_changed).getTime(),
          value: parseFloat(state.state),
          state: state.state,
        })),
      }
    })

    console.log('[HA History] Loaded', formatted.length, 'entity histories')

    return {
      statusCode: 200,
      body: JSON.stringify({
        entities: formatted,
        timestamp: new Date().toISOString(),
      }),
    }
  } catch (error) {
    console.error('[HA History] Unexpected error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Server error',
        stack: error instanceof Error ? error.stack : String(error),
      }),
    }
  }
}
