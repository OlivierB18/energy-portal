/**
 * get-my-environments.js
 *
 * Returns the environment IDs that the current user has access to,
 * sourced from the Supabase environment_users table.
 *
 * Response:
 *   { environmentIds: string[] }  — list of allowed environment IDs
 *
 * Super admins (OWNER_EMAIL / ADMIN_EMAILS) receive ALL environment IDs
 * from the environments table so the frontend can load them without an
 * extra round trip.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient } from './_supabase.js'
import { isStaticAdmin } from './_access-control.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

const getEmailFromPayload = (payload) => {
  const value = payload.email || payload['https://brouwer-ems/email']
  return typeof value === 'string' ? value.toLowerCase() : ''
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
  const email = getEmailFromPayload(payload)
  return { email, payload }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let auth
  try {
    auth = await verifyAuth(event)
  } catch (err) {
    return { statusCode: err.statusCode || 401, body: JSON.stringify({ error: err.message }) }
  }

  const supabase = createServiceSupabaseClient()

  try {
    if (isStaticAdmin(auth.email)) {
      // Super admin / static admin: return all environment IDs from the environments table
      const { data, error } = await supabase
        .from('environments')
        .select('id')
        .order('id', { ascending: true })

      if (error) throw error

      const environmentIds = (data || []).map((row) => String(row.id))
      return {
        statusCode: 200,
        body: JSON.stringify({ environmentIds, isAdmin: true }),
      }
    }

    // Regular user: return only environments from environment_users
    // Uses the composite index idx_environment_users_email_env
    const { data, error } = await supabase
      .from('environment_users')
      .select('environment_id')
      .eq('user_email', auth.email)

    if (error) throw error

    const environmentIds = (data || []).map((row) => String(row.environment_id))
    return {
      statusCode: 200,
      body: JSON.stringify({ environmentIds, isAdmin: false }),
    }
  } catch (error) {
    console.error('[get-my-environments] Error:', error?.message || error)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
    }
  }
}
