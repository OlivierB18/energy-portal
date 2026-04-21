import { createClient } from '@supabase/supabase-js'

const requireEnv = (key) => {
  const value = process.env[key]
  if (!value || !String(value).trim()) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

export const createServiceSupabaseClient = () => {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  )
}

export const toNumberOrNull = (value) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

export const clampNonNegative = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return num < 0 ? 0 : num
}

export const getViewRange = ({ view = 'day', date }) => {
  const normalizedView = String(view || 'day').toLowerCase()
  const baseDate = date ? new Date(`${date}T00:00:00`) : new Date()
  const safeBase = Number.isFinite(baseDate.getTime()) ? baseDate : new Date()

  const start = new Date(safeBase)
  start.setHours(0, 0, 0, 0)

  const end = new Date(start)
  if (normalizedView === 'week') {
    end.setDate(end.getDate() + 7)
  } else if (normalizedView === 'month') {
    end.setMonth(end.getMonth() + 1)
  } else {
    end.setDate(end.getDate() + 1)
  }

  return {
    view: normalizedView,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    start,
    end,
  }
}

export const toDayString = (date = new Date()) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
