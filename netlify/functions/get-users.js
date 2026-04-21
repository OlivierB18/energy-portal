import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient } from './_supabase.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

const getEmailFromPayload = (payload) => {
  const value = payload.email || payload['https://brouwer-ems/email']
  return typeof value === 'string' ? value.toLowerCase() : ''
}

const isSuperAdmin = (email) => {
  const owner = String(process.env.OWNER_EMAIL || '').trim().toLowerCase()
  return Boolean(owner && email === owner)
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
    let usersQuery

    if (isSuperAdmin(auth.email)) {
      // Super admin: all users from all environments
      const { data, error } = await supabase
        .from('environment_users')
        .select('user_id, user_email, role, environment_id, accepted_at, invited_by, environments(id, name, display_name)')
        .order('user_email', { ascending: true })

      if (error) throw error
      usersQuery = data || []
    } else {
      // Regular admin: only users from environments where caller is admin
      const { data: adminEnvs, error: adminError } = await supabase
        .from('environment_users')
        .select('environment_id')
        .eq('user_email', auth.email)
        .eq('role', 'admin')

      if (adminError) throw adminError
      const adminEnvIds = (adminEnvs || []).map((row) => row.environment_id)

      if (adminEnvIds.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ users: [] }) }
      }

      const { data, error } = await supabase
        .from('environment_users')
        .select('user_id, user_email, role, environment_id, accepted_at, invited_by, environments(id, name, display_name)')
        .in('environment_id', adminEnvIds)
        .order('user_email', { ascending: true })

      if (error) throw error
      usersQuery = data || []
    }

    // Group by user_id: build list of users with their environments
    const userMap = new Map()
    for (const row of usersQuery) {
      if (!userMap.has(row.user_id)) {
        userMap.set(row.user_id, {
          user_id: row.user_id,
          email: row.user_email,
          role: row.role,
          environments: [],
        })
      }
      const user = userMap.get(row.user_id)
      // Upgrade role if user has admin in any environment
      if (row.role === 'admin' && user.role !== 'admin') {
        user.role = 'admin'
      }
      const env = row.environments
      user.environments.push({
        id: String(row.environment_id),
        name: (env?.display_name || env?.name || row.environment_id),
        role: row.role,
      })
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ users: Array.from(userMap.values()) }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to load users' }),
    }
  }
}
