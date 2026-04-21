import { createRemoteJWKSet, jwtVerify } from 'jose'
import { resolveEnvironmentConfig } from './_environment-storage.js'

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

const getOwnerEmail = () => (process.env.OWNER_EMAIL || '').trim().toLowerCase()

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

const getForceEmail = () => (process.env.ADMIN_FORCE_EMAIL || '').trim().toLowerCase()

const getEmailFromPayload = (payload) => {
  const emailValue = payload.email || payload['https://brouwer-ems/email'] || payload.email
  return typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
}

const isEmailAllowed = (email, allowlist, forceEmail) => {
  if (!email) return false
  if (forceEmail && email === forceEmail) return true
  return allowlist.includes(email)
}

const verifyAuth = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    const err = new Error('Missing token')
    err.statusCode = 401
    throw err
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })

  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()
  const ownerEmail = getOwnerEmail()
  const resolvedEmail = getEmailFromPayload(payload)
  const isAdmin = (ownerEmail && resolvedEmail === ownerEmail) || isEmailAllowed(resolvedEmail, allowlist, forceEmail)

  return { payload, isAdmin }
}

const toBaseUrl = (input) => String(input || '').trim().replace(/\/+$/, '')

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { Allow: 'GET' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    }
  }

  let authResult
  try {
    authResult = await verifyAuth(event)
  } catch (authErr) {
    const statusCode = authErr.statusCode || 401
    return {
      statusCode,
      body: JSON.stringify({ error: authErr.message || 'Unauthorized' }),
    }
  }

  try {
    void authResult

    const environmentId = String(event.queryStringParameters?.environmentId || '').trim()
    if (!environmentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing environmentId' }),
      }
    }

    const domain = getEnv('AUTH0_DOMAIN')
    const managementToken = await getManagementToken(domain)
    const metadata = await getClientMetadata(domain, managementToken)
    const resolved = await resolveEnvironmentConfig({
      event,
      metadata,
      environmentId,
      getOptionalEnv,
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    try {
      const response = await fetch(`${toBaseUrl(resolved.baseUrl)}/api/`, {
        headers: { Authorization: `Bearer ${resolved.token}` },
        signal: controller.signal,
      })

      if (!response.ok) {
        return {
          statusCode: 502,
          body: JSON.stringify({
            error: 'Environment unreachable',
            environmentId: resolved.environment.id,
            status: response.status,
          }),
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          environmentId: resolved.environment.id,
          online: true,
          checkedAt: new Date().toISOString(),
        }),
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Environment unreachable',
      }),
    }
  }
}
