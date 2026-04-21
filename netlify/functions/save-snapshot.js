import { createRemoteJWKSet, jwtVerify } from 'jose'
import { connectLambda, getStore } from '@netlify/blobs'
import { resolveEnvironmentReference } from './_environment-storage.js'

const SNAPSHOT_STORE_NAME = 'ha-snapshots'
const managementTokenCache = { token: null, expiresAt: 0 }

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

const resolveReferenceSafe = async (event, environmentId) => {
  const requestedId = String(environmentId || '').trim()
  if (!requestedId) {
    throw new Error('Missing environmentId')
  }

  try {
    const domain = getEnv('AUTH0_DOMAIN')
    const managementToken = await getManagementToken(domain)
    const metadata = await getClientMetadata(domain, managementToken)
    const resolvedReference = await resolveEnvironmentReference({
      event,
      metadata,
      environmentId: requestedId,
      getOptionalEnv,
    })

    return {
      canonicalEnvironmentId: resolvedReference.environmentId,
      aliases: Array.isArray(resolvedReference.aliases) && resolvedReference.aliases.length > 0
        ? resolvedReference.aliases
        : [resolvedReference.environmentId],
    }
  } catch (error) {
    console.warn('[save-snapshot] Falling back to requested environmentId, metadata resolution failed:', error instanceof Error ? error.message : String(error))
    return {
      canonicalEnvironmentId: requestedId,
      aliases: [requestedId],
    }
  }
}

const getSnapshotStore = (event) => {
  connectLambda(event)
  return getStore(SNAPSHOT_STORE_NAME)
}

const getOwnerEmail = () => (process.env.OWNER_EMAIL || '').trim().toLowerCase()

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

const getForceEmail = () => (process.env.ADMIN_FORCE_EMAIL || '').trim().toLowerCase()

const getEmailFromPayload = (payload) => {
  const emailValue = payload.email || payload['https://brouwer-ems/email'] || payload['email']
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

  return { payload, isAdmin, resolvedEmail }
}

export const handler = async (event) => {
  try {
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

    if (event.httpMethod === 'POST') {
      let body
      try {
        body = JSON.parse(event.body || '{}')
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
      }

      const { environmentId, snapshot } = body
      if (!environmentId || typeof environmentId !== 'string') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
      }
      if (!snapshot || typeof snapshot !== 'object') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing snapshot' }) }
      }

      const { canonicalEnvironmentId, aliases } = await resolveReferenceSafe(event, environmentId)

      const store = getSnapshotStore(event)
      await store.setJSON(`snapshot_${canonicalEnvironmentId}`, {
        ...snapshot,
        savedAt: snapshot.savedAt || Date.now(),
      })

      for (const alias of aliases) {
        if (alias && alias !== canonicalEnvironmentId) {
          await store.delete(`snapshot_${alias}`).catch(() => undefined)
        }
      }

      console.log('[save-snapshot] Saved snapshot for environment:', canonicalEnvironmentId)
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true }),
      }
    }

    if (event.httpMethod === 'GET') {
      const environmentId = event.queryStringParameters?.environmentId
      if (!environmentId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
      }

      const store = getSnapshotStore(event)
      const { canonicalEnvironmentId, aliases } = await resolveReferenceSafe(event, environmentId)
      let snapshot = null

      for (const alias of aliases) {
        try {
          snapshot = await store.get(`snapshot_${alias}`, { type: 'json' })
          if (snapshot) {
            break
          }
        } catch {
          // continue alias lookup
        }
      }

      if (!snapshot) {
        try {
          snapshot = await store.get(`snapshot_${canonicalEnvironmentId}`, { type: 'json' })
        } catch {
          snapshot = null
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ snapshot: snapshot || null, environmentId: canonicalEnvironmentId }),
      }
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  } catch (error) {
    console.error('[save-snapshot] Error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
    }
  }
}
