import { createServiceSupabaseClient } from './_supabase.js'

// Runs daily at 06:00 UTC to keep the Supabase Free tier project active.
// Supabase pauses projects after 7 days of inactivity on the free plan.
export const config = { schedule: '0 6 * * *' }

export const handler = async () => {
  try {
    const supabase = createServiceSupabaseClient()

    const { error } = await supabase
      .from('environments')
      .select('id')
      .limit(1)

    if (error) {
      console.error('[keep-alive] Supabase ping failed:', error.message)
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) }
    }

    console.log('[keep-alive] Supabase ping OK at', new Date().toISOString())
    return { statusCode: 200, body: JSON.stringify({ ok: true }) }
  } catch (err) {
    console.error('[keep-alive] Unexpected error:', err?.message || err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected error' }) }
  }
}
