/**
 * _access-control.js
 *
 * Shared helper for environment-level access control.
 *
 * Priority order:
 *   1. OWNER_EMAIL env var           → super admin, always allowed
 *   2. ADMIN_EMAILS / VITE_ADMIN_EMAILS env var  → static admin allowlist, always allowed
 *   3. environment_users table in Supabase       → row-level access for regular users
 *
 * Usage:
 *   import { checkEnvironmentAccess } from './_access-control.js'
 *
 *   const { allowed, isSuperAdmin } = await checkEnvironmentAccess({
 *     userEmail,       // string — caller's email (lower-cased)
 *     environmentId,   // string — the environment being requested
 *     supabase,        // Supabase service client from createServiceSupabaseClient()
 *   })
 *
 *   if (!allowed) return { statusCode: 403, body: JSON.stringify({ error: 'Access denied to this environment' }) }
 */

import { createServiceSupabaseClient } from './_supabase.js'

const getOwnerEmail = () =>
  String(process.env.OWNER_EMAIL || '').trim().toLowerCase()

const getAdminAllowlist = () =>
  String(process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

/**
 * Returns true when the email belongs to a static admin
 * (OWNER_EMAIL or ADMIN_EMAILS), i.e. no DB lookup needed.
 */
export const isStaticAdmin = (email) => {
  if (!email) return false
  const owner = getOwnerEmail()
  if (owner && email === owner) return true
  return getAdminAllowlist().includes(email)
}

/**
 * Check whether `userEmail` is allowed to access `environmentId`.
 *
 * @param {{ userEmail: string, environmentId: string, supabase?: import('@supabase/supabase-js').SupabaseClient }} opts
 * @returns {Promise<{ allowed: boolean, isSuperAdmin: boolean, isAdmin: boolean }>}
 */
export const checkEnvironmentAccess = async ({ userEmail, environmentId, supabase }) => {
  const email = String(userEmail || '').trim().toLowerCase()
  const envId = String(environmentId || '').trim()

  if (!email) {
    return { allowed: false, isSuperAdmin: false, isAdmin: false }
  }

  // Static super admin / admin allowlist → always allowed
  if (isStaticAdmin(email)) {
    const isOwner = email === getOwnerEmail()
    return { allowed: true, isSuperAdmin: isOwner, isAdmin: true }
  }

  if (!envId) {
    return { allowed: false, isSuperAdmin: false, isAdmin: false }
  }

  // Supabase lookup — uses the composite index (user_email, environment_id) for O(log n)
  const client = supabase || createServiceSupabaseClient()

  const { data, error } = await client
    .from('environment_users')
    .select('role')
    .eq('user_email', email)
    .eq('environment_id', envId)
    .maybeSingle()

  if (error) {
    // Surface the error so callers can log it; deny access on any DB error
    const dbErr = new Error(`Access-control DB lookup failed: ${error.message}`)
    dbErr.cause = error
    throw dbErr
  }

  const allowed = data !== null
  return {
    allowed,
    isSuperAdmin: false,
    isAdmin: allowed && data.role === 'admin',
  }
}

/**
 * Returns the list of environment IDs a user has access to.
 * Super admins / static admins return null (meaning "all environments").
 *
 * @param {{ userEmail: string, supabase?: import('@supabase/supabase-js').SupabaseClient }} opts
 * @returns {Promise<string[] | null>}  null = unrestricted, string[] = allowed IDs
 */
export const getUserAllowedEnvironments = async ({ userEmail, supabase }) => {
  const email = String(userEmail || '').trim().toLowerCase()

  if (!email) return []
  if (isStaticAdmin(email)) return null // unrestricted

  const client = supabase || createServiceSupabaseClient()

  const { data, error } = await client
    .from('environment_users')
    .select('environment_id')
    .eq('user_email', email)

  if (error) {
    const dbErr = new Error(`Access-control DB lookup failed: ${error.message}`)
    dbErr.cause = error
    throw dbErr
  }

  return (data || []).map((row) => String(row.environment_id))
}
