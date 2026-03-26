import { createRemoteJWKSet, jwtVerify } from 'jose'
import { connectLambda, getStore } from '@netlify/blobs'

const SNAPSHOT_STORE_NAME = 'ha-snapshots'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
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

      const store = getSnapshotStore(event)
      await store.setJSON(`snapshot_${environmentId}`, {
        ...snapshot,
        savedAt: snapshot.savedAt || Date.now(),
      })

      console.log('[save-snapshot] Saved snapshot for environment:', environmentId)
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
      let snapshot = null
      try {
        snapshot = await store.get(`snapshot_${environmentId}`, { type: 'json' })
      } catch {
        // Snapshot not found or unreadable — return null gracefully
        snapshot = null
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ snapshot: snapshot || null }),
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
