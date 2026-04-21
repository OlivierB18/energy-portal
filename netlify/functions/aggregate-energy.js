import { createServiceSupabaseClient } from './_supabase.js'

export const config = { schedule: '5 * * * *' }

export const handler = async () => {
  try {
    const supabase = createServiceSupabaseClient()

    const { error: hourlyError } = await supabase.rpc('aggregate_hourly', { hours_back: 3 })
    if (hourlyError) {
      throw hourlyError
    }

    const hourUtc = new Date().getUTCHours()
    if (hourUtc <= 2 || hourUtc >= 22) {
      const { error: dailyError } = await supabase.rpc('aggregate_daily', { days_back: 2 })
      if (dailyError) {
        throw dailyError
      }
    }

    console.log('[Aggregate] OK hourly/daily done')
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Aggregation failed' }),
    }
  }
}
