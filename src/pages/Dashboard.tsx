import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import EnergyCard from '../components/EnergyCard'
import EnergyChart from '../components/EnergyChart'
import HomeAssistantConfig from '../components/HomeAssistantConfig'
import EnergyPriceModal from '../components/EnergyPriceModal'
import { Zap, Clock, Home, Settings, DollarSign, Flame, Users as UsersIcon, LogOut, ChevronDown } from 'lucide-react'
import { useAuth0 } from '@auth0/auth0-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { HaEntity, EnergyPricingConfig } from '../types'
import {
  getDashboardResponseCache,
  getOverviewLiveSnapshot,
  makeDashboardCacheKey,
  setOverviewLiveSnapshot,
  setDashboardResponseCache,
} from '../lib/dashboardRuntimeCache'

interface EnvironmentConfig {
  id: string
  name: string
  type?: string
}

interface HaEnvironmentPayload {
  id: string
  name?: string
  type?: string
  config?: {
    baseUrl?: string
  }
}

interface DashboardProps {
  isAdmin: boolean
  selectedEnvironmentId?: string
  onEnvironmentChange?: (environmentId: string) => void
  onOpenOverview?: () => void
  onManageUsers?: () => void
  onLogout?: () => void
}

interface PowerSample {
  timestamp: number
  power: number
}

interface HistoryArchivePayload {
  fetchTime: number
  powerSamples: PowerSample[]
  productionSamples: PowerSample[]
}

interface HaMetricSources {
  currentPowerEntityId: string | null
  currentProductionEntityId: string | null
  consumptionEntityIds: string[] | null
  exportEntityIds: string[] | null
  solarEntityId: string | null
  gasEntityId: string | null
  dailyElectricityEntityId: string | null
  monthlyElectricityEntityId: string | null
  dailyProductionEntityId: string | null
  monthlyProductionEntityId: string | null
  dailyGasEntityId: string | null
  monthlyGasEntityId: string | null
  electricityTotalEntityId: string | null
  electricityTotalEntityIds: string[] | null
  electricityConsumptionEntityIds: string[] | null
  electricityProductionEntityIds: string[] | null
  electricityProductionTotalEntityId: string | null
  electricityProductionTotalEntityIds: string[] | null
  gasTotalEntityId: string | null
}

interface HaMetricsSnapshot {
  currentPowerKw: number | null
  currentProductionKw: number | null
  dailyElectricityKwh: number | null
  monthlyElectricityKwh: number | null
  dailyProductionKwh: number | null
  monthlyProductionKwh: number | null
  dailyGasM3: number | null
  monthlyGasM3: number | null
  powerEntityId: string | null
  sources: HaMetricSources
}

interface DynamicPricePoint {
  time: string
  eurPerKwh: number
  isForecast: boolean
}

interface DynamicPriceChartPoint {
  time: string
  fullTime: string
  price: number
  currentPrice: number | null
  forecastPrice: number | null
  fixedConsumerPrice: number | null
  fixedProducerPrice: number | null
}

interface CachedOverviewStatusSnapshot {
  status?: 'online' | 'offline' | 'connecting'
  lastSeenAt?: number
}

const GAS_METER_ENTITY_ID = 'sensor.gas_meter_gas_consumption'
const DYNAMIC_PRICE_CHART_EVENT = 'energy-dynamic-chart-visibility-changed'
const HA_ENVIRONMENTS_UPDATED_EVENT = 'ha-environments-updated'
const OVERVIEW_STATUS_CACHE_KEY = 'overview_status_cache_v2'
const MAX_LIVE_SAMPLE_POINTS = 8000
const MAX_ARCHIVE_HOURLY_POINTS = 60000
const ARCHIVE_LOOKBACK_DAYS = 45
const ARCHIVE_REFRESH_TTL_MS = 12 * 60 * 60_000
const configuredDefaultGasPrice = Number(import.meta.env.VITE_DEFAULT_GAS_PRICE_EUR_PER_M3)
const DEFAULT_GAS_PRICE_PER_M3 = Number.isFinite(configuredDefaultGasPrice) && configuredDefaultGasPrice > 0
  ? configuredDefaultGasPrice
  : 1.35
const configuredDefaultGasMargin = Number(import.meta.env.VITE_DEFAULT_GAS_MARGIN_EUR_PER_M3)
const DEFAULT_GAS_MARGIN_PER_M3 = Number.isFinite(configuredDefaultGasMargin)
  ? configuredDefaultGasMargin
  : 0
const configuredDynamicGasProxy = Number(import.meta.env.VITE_DYNAMIC_GAS_KWH_PER_M3)
const DEFAULT_DYNAMIC_GAS_KWH_PER_M3 = Number.isFinite(configuredDynamicGasProxy) && configuredDynamicGasProxy > 0
  ? configuredDynamicGasProxy
  : 10.55

const pruneLocalStorageCache = () => {
  try {
    const removablePrefixes = [
      'ha_history_archive_',
      'ha_history_v5_',
      'ha_electricity_buckets_',
      'energy_live_power_samples_',
      'energy_live_production_samples_',
    ]

    const removableKeys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .filter((key): key is string => Boolean(key))
      .filter((key) => removablePrefixes.some((prefix) => key.startsWith(prefix)))

    // Remove a limited set first; avoid nuking all caches every write.
    removableKeys.slice(0, 8).forEach((key) => localStorage.removeItem(key))
  } catch {
    // Ignore cleanup failures.
  }
}

const storeLocalJson = (key: string, value: unknown) => {
  const serialized = JSON.stringify(value)

  try {
    localStorage.setItem(key, serialized)
  } catch {
    // Try targeted eviction first; fallback to clear only as last resort.
    try {
      pruneLocalStorageCache()
      localStorage.setItem(key, serialized)
      return
    } catch {
      try {
        localStorage.clear()
        localStorage.setItem(key, serialized)
      } catch {
        // Ignore storage failures.
      }
    }
  }
}

const storeLocalValue = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    try {
      pruneLocalStorageCache()
      localStorage.setItem(key, value)
    } catch {
      // Ignore storage failures.
    }
  }
}

const trimSamplesToRecentWindow = (
  samples: PowerSample[],
  windowMs: number = 24 * 60 * 60_000,
) => {
  const now = Date.now()
  const startMs = now - windowMs
  return samples.filter((sample) => sample.timestamp >= startMs && sample.timestamp <= now)
}

const mergePowerSamples = (
  seriesList: Array<PowerSample[]>,
  {
    resolutionMs = 10_000,
    maxPoints,
  }: { resolutionMs?: number; maxPoints?: number } = {},
): PowerSample[] => {
  const uniqueMap = new Map<number, PowerSample>()

  seriesList.forEach((series) => {
    series.forEach((sample) => {
      if (
        !sample ||
        typeof sample.timestamp !== 'number' ||
        typeof sample.power !== 'number' ||
        !Number.isFinite(sample.timestamp) ||
        !Number.isFinite(sample.power)
      ) {
        return
      }

      const key = Math.floor(sample.timestamp / resolutionMs) * resolutionMs
      const existing = uniqueMap.get(key)
      if (!existing || sample.timestamp > existing.timestamp) {
        uniqueMap.set(key, sample)
      }
    })
  })

  const merged = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp)
  if (typeof maxPoints === 'number' && maxPoints > 0 && merged.length > maxPoints) {
    return merged.slice(-maxPoints)
  }

  return merged
}

const sanitizePowerSampleArray = (input: unknown): PowerSample[] => {
  if (!Array.isArray(input)) {
    return []
  }

  return mergePowerSamples(
    [
      input.filter(
        (sample): sample is PowerSample =>
          typeof sample === 'object' &&
          sample !== null &&
          typeof (sample as PowerSample).timestamp === 'number' &&
          typeof (sample as PowerSample).power === 'number' &&
          Number.isFinite((sample as PowerSample).timestamp) &&
          Number.isFinite((sample as PowerSample).power),
      ) as PowerSample[],
    ],
    { resolutionMs: 10_000 },
  )
}

const getHistoryResolution = (range: 'today' | 'week' | 'month') => {
  if (range === 'today') return 'raw'
  if (range === 'week') return '5min'
  return 'hourly'
}

const getLttbTarget = (range: 'today' | 'week' | 'month') => {
  if (range === 'today') return 1000
  if (range === 'week') return 800
  return 500
}

const downsampleLTTB = (samples: PowerSample[], threshold: number): PowerSample[] => {
  if (!Array.isArray(samples) || samples.length <= threshold || threshold < 3) {
    return samples
  }

  const sampled: PowerSample[] = []
  const every = (samples.length - 2) / (threshold - 2)

  let a = 0
  sampled.push(samples[a])

  for (let i = 0; i < threshold - 2; i += 1) {
    const avgRangeStart = Math.floor((i + 1) * every) + 1
    const avgRangeEnd = Math.floor((i + 2) * every) + 1
    const avgRangeEndClamped = Math.min(avgRangeEnd, samples.length)

    let avgX = 0
    let avgY = 0
    let avgRangeLength = avgRangeEndClamped - avgRangeStart
    if (avgRangeLength <= 0) {
      avgRangeLength = 1
    }

    for (let j = avgRangeStart; j < avgRangeEndClamped; j += 1) {
      avgX += samples[j].timestamp
      avgY += samples[j].power
    }
    avgX /= avgRangeLength
    avgY /= avgRangeLength

    const rangeOffs = Math.floor(i * every) + 1
    const rangeTo = Math.floor((i + 1) * every) + 1
    const rangeToClamped = Math.min(rangeTo, samples.length - 1)

    const pointAX = samples[a].timestamp
    const pointAY = samples[a].power

    let maxArea = -1
    let nextA = rangeOffs

    for (let j = rangeOffs; j <= rangeToClamped; j += 1) {
      const area = Math.abs(
        (pointAX - avgX) * (samples[j].power - pointAY) -
        (pointAX - samples[j].timestamp) * (avgY - pointAY),
      )
      if (area > maxArea) {
        maxArea = area
        nextA = j
      }
    }

    sampled.push(samples[nextA])
    a = nextA
  }

  sampled.push(samples[samples.length - 1])
  return sampled
}

const runOnIdle = (callback: () => void) => {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const withIdle = window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (id: number) => void
  }

  if (typeof withIdle.requestIdleCallback === 'function') {
    const idleId = withIdle.requestIdleCallback(() => callback(), { timeout: 1200 })
    return () => withIdle.cancelIdleCallback?.(idleId)
  }

  const timer = window.setTimeout(callback, 350)
  return () => window.clearTimeout(timer)
}

const inflightRequests = new Map<string, Promise<Response>>()
const MAX_CONCURRENT_REQUESTS = 3
let activeRequestCount = 0
const requestQueue: Array<() => void> = []

const sleepMs = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const runWithRequestLimit = async <T,>(operation: () => Promise<T>): Promise<T> => {
  if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => {
      requestQueue.push(resolve)
    })
  }

  activeRequestCount += 1
  try {
    return await operation()
  } finally {
    activeRequestCount = Math.max(0, activeRequestCount - 1)
    const next = requestQueue.shift()
    if (next) {
      next()
    }
  }
}

const throttledAuthFetch = async (
  url: string,
  token: string,
  {
    retriesMs = [1000, 3000],
    signal,
  }: {
    retriesMs?: number[]
    signal?: AbortSignal
  } = {},
): Promise<Response> => {
  const execute = () => runWithRequestLimit(() => fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  }))

  let response = await execute()

  for (let i = 0; i < retriesMs.length && response.status === 403; i += 1) {
    await sleepMs(retriesMs[i])
    response = await execute()
  }

  return response
}

const deduplicatedAuthFetch = async (
  url: string,
  token: string,
  {
    retriesMs = [1000, 3000],
  }: {
    retriesMs?: number[]
  } = {},
): Promise<Response> => {
  const key = `GET::${url}`
  const existing = inflightRequests.get(key)
  if (existing) {
    return existing.then((response) => response.clone())
  }

  const requestPromise = (async () => {
    return throttledAuthFetch(url, token, { retriesMs })
  })().finally(() => {
    inflightRequests.delete(key)
  })

  inflightRequests.set(key, requestPromise)
  return requestPromise.then((response) => response.clone())
}

const normalizeEnvironmentConfigs = (input: unknown): EnvironmentConfig[] => {
  if (!Array.isArray(input)) {
    return []
  }

  return input
    .map((env) => {
      const payload = env as { id?: unknown; name?: unknown; type?: unknown }
      return {
        id: String(payload?.id || '').trim(),
        name: String(payload?.name || payload?.id || '').trim(),
        type: typeof payload?.type === 'string' ? payload.type : undefined,
      }
    })
    .filter((env) => Boolean(env.id))
}

const normalizeDynamicPricePoints = (input: unknown): DynamicPricePoint[] => {
  if (!input || typeof input !== 'object') {
    return []
  }

  const payload = input as {
    prices?: Array<{ time?: unknown; eurPerKwh?: unknown; price?: unknown }>
  }

  const rows = Array.isArray(payload?.prices) ? payload.prices : []
  if (rows.length === 0) {
    return []
  }

  const now = Date.now()
  const byTime = new Map<string, DynamicPricePoint>()

  for (const row of rows) {
    const rawTime = String(row?.time || '').trim()
    const parsedTime = Date.parse(rawTime)
    if (!rawTime || Number.isNaN(parsedTime)) {
      continue
    }

    const directPerKwh = Number(row?.eurPerKwh)
    const convertedPerKwh = Number(row?.price) / 1000
    const eurPerKwh = Number.isFinite(directPerKwh) ? directPerKwh : convertedPerKwh
    if (!Number.isFinite(eurPerKwh)) {
      continue
    }

    const normalizedTime = new Date(parsedTime).toISOString()
    byTime.set(normalizedTime, {
      time: normalizedTime,
      eurPerKwh,
      isForecast: parsedTime > now,
    })
  }

  return Array.from(byTime.values()).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
}

const parseEntsoeBasePrice = (input: unknown): number | null => {
  if (!input || typeof input !== 'object') {
    return null
  }

  const payload = input as {
    current?: { eurPerKwh?: unknown }
    prices?: Array<{ eurPerKwh?: unknown; price?: unknown }>
  }

  const currentPerKwh = Number(payload?.current?.eurPerKwh)
  if (Number.isFinite(currentPerKwh) && currentPerKwh >= 0) {
    return currentPerKwh
  }

  const points = Array.isArray(payload?.prices) ? payload.prices : []
  if (points.length === 0) {
    return null
  }

  const values = points
    .map((point) => {
      const direct = Number(point?.eurPerKwh)
      if (Number.isFinite(direct)) {
        return direct
      }

      const eurPerMWh = Number(point?.price)
      return Number.isFinite(eurPerMWh) ? eurPerMWh / 1000 : NaN
    })
    .filter((value) => Number.isFinite(value) && value >= 0)

  if (values.length === 0) {
    return null
  }

  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

const parseEntsoeGasProxyPrice = (
  input: unknown,
  proxyKwhPerM3: number = DEFAULT_DYNAMIC_GAS_KWH_PER_M3,
): number | null => {
  const basePerKwh = parseEntsoeBasePrice(input)
  if (basePerKwh === null || !Number.isFinite(basePerKwh) || basePerKwh < 0) {
    return null
  }

  const factor = Number.isFinite(proxyKwhPerM3) && proxyKwhPerM3 > 0
    ? proxyKwhPerM3
    : DEFAULT_DYNAMIC_GAS_KWH_PER_M3

  return basePerKwh * factor
}

const parseNumericValue = (value: unknown) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN
  }

  if (value === null || value === undefined) {
    return NaN
  }

  const source = String(value).trim()
  if (!source) {
    return NaN
  }

  let normalized = source.replace(/\s/g, '')
  const hasComma = normalized.includes(',')
  const hasDot = normalized.includes('.')

  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(',')
    const lastDot = normalized.lastIndexOf('.')
    normalized = lastComma > lastDot
      ? normalized.replace(/\./g, '').replace(',', '.')
      : normalized.replace(/,/g, '')
  } else if (hasComma && !hasDot) {
    normalized = normalized.replace(',', '.')
  }

  normalized = normalized.replace(/[^0-9+\-.]/g, '')
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : NaN
}

const convertEnergyToKwh = (value: number, unit: unknown) => {
  if (!Number.isFinite(value)) {
    return NaN
  }

  const normalized = String(unit || '').trim().toLowerCase()
  if (normalized === 'wh') {
    return value / 1000
  }
  if (normalized === 'mwh') {
    return value * 1000
  }
  return value
}

const convertGasToM3 = (value: number, unit: unknown) => {
  if (!Number.isFinite(value)) {
    return NaN
  }

  const normalized = String(unit || '').trim().toLowerCase()
  if (normalized === 'l' || normalized === 'liter' || normalized === 'liters') {
    return value / 1000
  }
  return value
}

const findGasConsumptionEntity = (entities: HaEntity[]) => {
  const exactEntity = entities.find(
    (entity) => entity.domain === 'sensor' && entity.entity_id.toLowerCase() === GAS_METER_ENTITY_ID,
  )

  if (exactEntity) {
    return exactEntity
  }

  const friendlyNameMatch = entities.find((entity) => (
    entity.domain === 'sensor' && (entity.friendly_name || '').toLowerCase() === 'gas meter gas consumption'
  ))

  if (friendlyNameMatch) {
    return friendlyNameMatch
  }

  return entities.find((entity) => {
    const entityId = entity.entity_id.toLowerCase()
    const friendlyName = (entity.friendly_name || '').toLowerCase()
    const searchable = `${entityId} ${friendlyName}`

    return entity.domain === 'sensor' && (
      searchable.includes('gas_meter_gas_consumption') ||
      (searchable.includes('gas meter') && searchable.includes('consumption')) ||
      (searchable.includes('gas') && searchable.includes('meter') && searchable.includes('m3')) ||
      searchable.includes('gas meter gas consumption')
    )
  })
}

// Format chart labels: time on top, date below (e.g. "14:00\n10-03")
const formatChartAxisLabel = (timestamp: number, range: 'today' | 'week' | 'month'): string => {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dayNum = String(date.getDate()).padStart(2, '0')
  const monthNum = String(date.getMonth() + 1).padStart(2, '0')
  const dateStr = `${dayNum}-${monthNum}`

  if (range === 'today') {
    return time
  }

  if (range === 'week') {
    const dayStr = date.toLocaleDateString('nl-NL', { weekday: 'short' })
    return `${time}\n${dayStr} ${dateStr}`
  }

  // month: daily buckets — show just date
  return dateStr
}

const parseInputDate = (value: string): Date | null => {
  const [year, month, day] = value.split('-').map(Number)
  const isValidDate = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
  if (!isValidDate) {
    return null
  }

  return new Date(year, month - 1, day)
}

const getBoundsFromInputDates = (
  startDateInput: string,
  endDateInput: string,
): { startMs: number; endMs: number } => {
  const fallbackDate = new Date()
  const parsedStart = parseInputDate(startDateInput) || fallbackDate
  const parsedEnd = parseInputDate(endDateInput) || fallbackDate

  const start = new Date(parsedStart)
  const end = new Date(parsedEnd)

  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)

  if (start.getTime() > end.getTime()) {
    return {
      startMs: end.getTime(),
      endMs: start.getTime(),
    }
  }

  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
  }
}

const normalizePricingConfig = (input: unknown): EnergyPricingConfig | null => {
  if (!input || typeof input !== 'object') {
    return null
  }

  const value = input as Record<string, unknown>
  const type = value.type === 'dynamic' ? 'dynamic' : 'fixed'
  const parseNumber = (raw: unknown, fallback: number) => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  return {
    type,
    consumerPrice: parseNumber(value.consumerPrice, 0.30),
    producerPrice: parseNumber(value.producerPrice, 0.10),
    consumerMargin: parseNumber(value.consumerMargin, 0.05),
    producerMargin: parseNumber(value.producerMargin, 0.02),
    gasPrice: parseNumber(value.gasPrice, DEFAULT_GAS_PRICE_PER_M3),
    gasMargin: parseNumber(value.gasMargin, DEFAULT_GAS_MARGIN_PER_M3),
    gasProxyKwhPerM3: parseNumber(value.gasProxyKwhPerM3, DEFAULT_DYNAMIC_GAS_KWH_PER_M3),
  }
}

const normalizeHaMetricsSnapshot = (input: unknown): HaMetricsSnapshot | null => {
  if (!input || typeof input !== 'object') {
    return null
  }

  const value = input as Record<string, unknown>
  const toNumberOrNull = (raw: unknown) => {
    if (raw === null || raw === undefined) {
      return null
    }

    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }

  const toStringOrNull = (raw: unknown) => {
    if (typeof raw !== 'string') {
      return null
    }

    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  const rawSources = typeof value?.sources === 'object' && value?.sources !== null
    ? (value.sources as Record<string, unknown>)
    : {}

  const toStringArrayOrNull = (raw: unknown): string[] | null => {
    if (!Array.isArray(raw)) return null
    const arr = raw.map((v) => toStringOrNull(v)).filter((v): v is string => v !== null)
    return arr.length > 0 ? arr : null
  }

  const sources: HaMetricSources = {
    currentPowerEntityId: toStringOrNull(rawSources.currentPowerEntityId),
    currentProductionEntityId: toStringOrNull(rawSources.currentProductionEntityId),
    consumptionEntityIds: toStringArrayOrNull(rawSources.consumptionEntityIds),
    exportEntityIds: toStringArrayOrNull(rawSources.exportEntityIds),
    solarEntityId: toStringOrNull(rawSources.solarEntityId),
    gasEntityId: toStringOrNull(rawSources.gasEntityId),
    dailyElectricityEntityId: toStringOrNull(rawSources.dailyElectricityEntityId),
    monthlyElectricityEntityId: toStringOrNull(rawSources.monthlyElectricityEntityId),
    dailyProductionEntityId: toStringOrNull(rawSources.dailyProductionEntityId),
    monthlyProductionEntityId: toStringOrNull(rawSources.monthlyProductionEntityId),
    dailyGasEntityId: toStringOrNull(rawSources.dailyGasEntityId),
    monthlyGasEntityId: toStringOrNull(rawSources.monthlyGasEntityId),
    electricityTotalEntityId: toStringOrNull(rawSources.electricityTotalEntityId),
    electricityTotalEntityIds: toStringArrayOrNull(rawSources.electricityTotalEntityIds),
    electricityConsumptionEntityIds: toStringArrayOrNull(rawSources.electricityConsumptionEntityIds),
    electricityProductionEntityIds: toStringArrayOrNull(rawSources.electricityProductionEntityIds),
    electricityProductionTotalEntityId: toStringOrNull(rawSources.electricityProductionTotalEntityId),
    electricityProductionTotalEntityIds: toStringArrayOrNull(rawSources.electricityProductionTotalEntityIds),
    gasTotalEntityId: toStringOrNull(rawSources.gasTotalEntityId),
  }

  return {
    currentPowerKw: toNumberOrNull(value.currentPowerKw),
    currentProductionKw: toNumberOrNull(value.currentProductionKw),
    dailyElectricityKwh: toNumberOrNull(value.dailyElectricityKwh),
    monthlyElectricityKwh: toNumberOrNull(value.monthlyElectricityKwh),
    dailyProductionKwh: toNumberOrNull(value.dailyProductionKwh),
    monthlyProductionKwh: toNumberOrNull(value.monthlyProductionKwh),
    dailyGasM3: toNumberOrNull(value.dailyGasM3),
    monthlyGasM3: toNumberOrNull(value.monthlyGasM3),
    powerEntityId: sources.currentPowerEntityId,
    sources,
  }
}

interface DetectedEnergyEntities {
  electricityTotalEntityIds: string[]
  electricityProductionTotalEntityIds: string[]
  gasTotalEntityId: string | null
  powerConsumptionEntityId: string | null
  powerProductionEntityId: string | null
}

const PRODUCTION_KEYWORDS = [
  'production', 'solar', 'pv', 'export', 'injection',
  'teruglever', 'opwek', 'opgewekt', 'yield', 'returned', 'teruggeleverd',
]

function detectEnergyEntities(entities: HaEntity[]): DetectedEnergyEntities {
  const sensors = entities.filter((e) => e.domain === 'sensor')

  const hasProductionKeyword = (e: HaEntity) => {
    const id = e.entity_id.toLowerCase()
    const name = (e.friendly_name ?? '').toLowerCase()
    return PRODUCTION_KEYWORDS.some((kw) => id.includes(kw) || name.includes(kw))
  }

  const hasGasKeyword = (e: HaEntity) => {
    const id = e.entity_id.toLowerCase()
    const name = (e.friendly_name ?? '').toLowerCase()
    return id.includes('gas') || name.includes('gas')
  }

  const isTotalClass = (e: HaEntity) =>
    e.state_class === 'total_increasing' || e.state_class === 'total'

  const isEnergyUnit = (e: HaEntity) => {
    const unit = (e.unit_of_measurement ?? '').toLowerCase()
    return unit === 'kwh' || unit === 'wh' || unit === 'mwh'
  }

  const isGasUnit = (e: HaEntity) => {
    const unit = (e.unit_of_measurement ?? '').toLowerCase()
    return unit === 'm³' || unit === 'm3' || unit === 'ft³'
  }

  const isPowerUnit = (e: HaEntity) => {
    const unit = (e.unit_of_measurement ?? '').toLowerCase()
    return unit === 'w' || unit === 'kw' || unit === 'va' || unit === 'kva'
  }

  // Electricity consumption totals (for Electricity usage bar chart)
  const electricityTotalEntityIds = sensors
    .filter((e) => {
      const isEnergy = e.device_class === 'energy' || isEnergyUnit(e)
      return isEnergy && isTotalClass(e) && !hasProductionKeyword(e) && !hasGasKeyword(e)
    })
    .map((e) => e.entity_id)

  // Electricity production totals
  const electricityProductionTotalEntityIds = sensors
    .filter((e) => {
      const isEnergy = e.device_class === 'energy' || isEnergyUnit(e)
      return isEnergy && isTotalClass(e) && hasProductionKeyword(e)
    })
    .map((e) => e.entity_id)

  // Gas total meter
  const gasEntity = sensors.find((e) => {
    const isGas = e.device_class === 'gas' || isGasUnit(e)
    return isGas && isTotalClass(e)
  })

  // Power consumption entity (for Power sources chart — instantaneous, not total)
  const powerConsumptionEntity = sensors.find((e) => {
    const isPower = e.device_class === 'power' || isPowerUnit(e)
    return isPower && !isTotalClass(e) && !hasProductionKeyword(e)
  })

  // Power production entity (for Power sources chart)
  const powerProductionEntity = sensors.find((e) => {
    const isPower = e.device_class === 'power' || isPowerUnit(e)
    return isPower && !isTotalClass(e) && hasProductionKeyword(e)
  })

  return {
    electricityTotalEntityIds,
    electricityProductionTotalEntityIds,
    gasTotalEntityId: gasEntity?.entity_id ?? null,
    powerConsumptionEntityId: powerConsumptionEntity?.entity_id ?? null,
    powerProductionEntityId: powerProductionEntity?.entity_id ?? null,
  }
}

// Module-level throttle map for snapshot saves — one per environment, max once per 5 minutes
const snapshotSaveLastSentMs = new Map<string, number>()
const SNAPSHOT_SAVE_THROTTLE_MS = 5 * 60 * 1000 // 5 minutes

export default function Dashboard({
  isAdmin,
  selectedEnvironmentId,
  onEnvironmentChange,
  onOpenOverview,
  onManageUsers,
  onLogout,
}: DashboardProps) {
  const formatDateForInput = (date: Date) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const [selectedEnvironment, setSelectedEnvironment] = useState<string>(selectedEnvironmentId ?? '')
  const [stableSelectedEnvironment, setStableSelectedEnvironment] = useState<string>(selectedEnvironmentId ?? '')
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today')
  const todayInput = formatDateForInput(new Date())
  const [selectedStartDate, setSelectedStartDate] = useState<string>(todayInput)
  const [selectedEndDate, setSelectedEndDate] = useState<string>(todayInput)
  const [allowedEnvironmentIds, setAllowedEnvironmentIds] = useState<string[] | null>(null)
  const [isCheckingPermissions, setIsCheckingPermissions] = useState(true)
  const [environments, setEnvironments] = useState<EnvironmentConfig[]>([])
  const [envLoading, setEnvLoading] = useState(false)
  const [_envError, setEnvError] = useState<string | null>(null)
  const [haEntities, setHaEntities] = useState<HaEntity[]>([])
  const [entitiesLoaded, setEntitiesLoaded] = useState(false)
  const [isEnvironmentOffline, setIsEnvironmentOffline] = useState(false)
  const [offlineLastSeenAt, setOfflineLastSeenAt] = useState<number | null>(null)
  // Laatst bekende sensoren (blijven altijd staan bij error)
  const [lastKnownHaEntities, setLastKnownHaEntities] = useState<HaEntity[]>([])
  const [haMetricsSnapshot, setHaMetricsSnapshot] = useState<HaMetricsSnapshot | null>(null)
  const [haLoading, setHaLoading] = useState(false)
  const [haError, setHaError] = useState<string | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [haActionId, setHaActionId] = useState<string | null>(null)
  const [showHaConfig, setShowHaConfig] = useState(false)
  const [haRefreshKey, setHaRefreshKey] = useState(0)
  const [powerSamples, setPowerSamples] = useState<PowerSample[]>([])
  const [productionSamples, setProductionSamples] = useState<PowerSample[]>([])
  const [historicalRangeSamples, setHistoricalRangeSamples] = useState<PowerSample[]>([])
  const [historicalProductionRangeSamples, setHistoricalProductionRangeSamples] = useState<PowerSample[]>([])
  const [archivedPowerSamples, setArchivedPowerSamples] = useState<PowerSample[]>([])
  const [archivedProductionSamples, setArchivedProductionSamples] = useState<PowerSample[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [electricityUsageBuckets, setElectricityUsageBuckets] = useState<Array<{ timestamp: number; importKwh: number; exportKwh: number }>>([])
  const [isLoadingUsage, setIsLoadingUsage] = useState(false)
  const [gasMeterReadings, setGasMeterReadings] = useState<Array<{ timestamp: number; value: number }>>([])
  const [showPriceModal, setShowPriceModal] = useState(false)
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [pricingConfig, setPricingConfig] = useState<EnergyPricingConfig | null>(null)
  const [dynamicConsumerPriceKwh, setDynamicConsumerPriceKwh] = useState<number | null>(null)
  const [dynamicGasPricePerM3, setDynamicGasPricePerM3] = useState<number | null>(null)
  const [showDynamicPriceChart, setShowDynamicPriceChart] = useState(false)
  const [dynamicPricePoints, setDynamicPricePoints] = useState<DynamicPricePoint[]>([])
  const [dynamicPriceUpdatedAt, setDynamicPriceUpdatedAt] = useState<string | null>(null)
  const [dynamicPriceChartLoading, setDynamicPriceChartLoading] = useState(false)
  const [dynamicPriceChartError, setDynamicPriceChartError] = useState<string | null>(null)
  const [showFixedPriceLinesOnChart, setShowFixedPriceLinesOnChart] = useState(true)
  const [environmentInstalledOnMs, setEnvironmentInstalledOnMs] = useState<number | null>(null)
  // Sensor connection status: 'connecting' | 'connected' | 'error'
  const [haConnectionStatus, setHaConnectionStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently, user } = useAuth0()
  const perfDashboardTimerStartedRef = useRef(false)
  const perfViewSwitchTimerStartedRef = useRef(false)
  const perfHaEntitiesTimerStartedRef = useRef(false)
  const perfPowerSourcesDataTimerStartedRef = useRef(false)
  const initialHaLoadKeyRef = useRef('')
  const silentHaRefreshInProgressRef = useRef(false)
  const lastHaEntitiesFetchAtRef = useRef(0)
  const lastGasFetchKeyRef = useRef('')

  const getAuthToken = useCallback(async () => {
    const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
    return getAccessTokenSilently({
      authorizationParams: { audience },
    })
  }, [getAccessTokenSilently])

  const haEnvironmentsCacheKey = 'ha_environments_cache_v1'
  const userCacheScope = useMemo(() => {
    const source = user?.sub || user?.email || 'anonymous'
    return String(source).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  }, [user?.email, user?.sub])
  const selectedEnvironmentRequestId = useMemo(() => {
    const selected = environments.find((env) => env.id === selectedEnvironment)
    if (!selected) {
      return selectedEnvironment
    }

    const rawId = String(selected.id || '').trim()
    const rawName = String(selected.name || '').trim()
    const legacyIds = new Set(['vacation', 'brouwer', 'brouwer test'])

    if (legacyIds.has(rawId.toLowerCase()) && rawName && rawName.toLowerCase() !== rawId.toLowerCase()) {
      return rawName
    }

    return rawId
  }, [environments, selectedEnvironment])

  const stableSelectedEnvironmentRequestId = useMemo(() => {
    const selected = environments.find((env) => env.id === stableSelectedEnvironment)
    if (!selected) {
      return stableSelectedEnvironment
    }

    const rawId = String(selected.id || '').trim()
    const rawName = String(selected.name || '').trim()
    const legacyIds = new Set(['vacation', 'brouwer', 'brouwer test'])

    if (legacyIds.has(rawId.toLowerCase()) && rawName && rawName.toLowerCase() !== rawId.toLowerCase()) {
      return rawName
    }

    return rawId
  }, [environments, stableSelectedEnvironment])
  const environmentScope = selectedEnvironmentRequestId || 'default'
  const isEnvironmentSelectionSettled = !selectedEnvironmentId || selectedEnvironmentId === selectedEnvironment

  const haEntitiesCacheKey = `ha_entities_cache_v4_${environmentScope}_${userCacheScope}`
  const userEnvironmentIdsCacheKey = `user_environment_ids_cache_v1_${userCacheScope}`
  const dynamicPriceCacheKey = `energy_dynamic_price_${environmentScope}`
  const dynamicPriceChartPreferenceKey = `energy_dynamic_chart_visible_${environmentScope}`
  const dynamicPriceFixedLinesPreferenceKey = `energy_dynamic_chart_show_fixed_lines_${environmentScope}`

  const readCachedOverviewStatus = useCallback((environmentId: string) => {
    try {
      const raw = localStorage.getItem(OVERVIEW_STATUS_CACHE_KEY)
      if (!raw) {
        return null
      }

      const parsed = JSON.parse(raw) as Record<string, CachedOverviewStatusSnapshot>
      const snapshot = parsed?.[environmentId]
      if (!snapshot || typeof snapshot !== 'object') {
        return null
      }

      return {
        status: snapshot.status,
        lastSeenAt: typeof snapshot.lastSeenAt === 'number' ? snapshot.lastSeenAt : null,
      }
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    if (!selectedEnvironment) {
      return
    }

    const snapshot = getOverviewLiveSnapshot(selectedEnvironment)
    if (!snapshot) {
      return
    }

    if (snapshot.status === 'online') {
      setHaConnectionStatus('connected')
      setIsInitialLoading(false)
      setIsEnvironmentOffline(false)
      setEntitiesLoaded(true)
    }

    if (Number.isFinite(snapshot.currentPower) || Number.isFinite(snapshot.dailyUsage)) {
      setHaMetricsSnapshot((prev) => ({
        currentPowerKw: Number.isFinite(snapshot.currentPower) ? Number(snapshot.currentPower) : prev?.currentPowerKw ?? null,
        currentProductionKw: prev?.currentProductionKw ?? null,
        dailyElectricityKwh: Number.isFinite(snapshot.dailyUsage) ? Number(snapshot.dailyUsage) : prev?.dailyElectricityKwh ?? null,
        monthlyElectricityKwh: prev?.monthlyElectricityKwh ?? null,
        dailyProductionKwh: prev?.dailyProductionKwh ?? null,
        monthlyProductionKwh: prev?.monthlyProductionKwh ?? null,
        dailyGasM3: prev?.dailyGasM3 ?? null,
        monthlyGasM3: prev?.monthlyGasM3 ?? null,
        powerEntityId: prev?.powerEntityId ?? null,
        sources: prev?.sources ?? {
          currentPowerEntityId: null,
          currentProductionEntityId: null,
          consumptionEntityIds: null,
          exportEntityIds: null,
          solarEntityId: null,
          gasEntityId: null,
          dailyElectricityEntityId: null,
          monthlyElectricityEntityId: null,
          dailyProductionEntityId: null,
          monthlyProductionEntityId: null,
          dailyGasEntityId: null,
          monthlyGasEntityId: null,
          electricityTotalEntityId: null,
          electricityTotalEntityIds: null,
          electricityConsumptionEntityIds: null,
          electricityProductionEntityIds: null,
          electricityProductionTotalEntityId: null,
          electricityProductionTotalEntityIds: null,
          gasTotalEntityId: null,
        },
      }))
    }
  }, [selectedEnvironment])

  useEffect(() => {
    if (!selectedEnvironment) {
      return
    }

    if (!perfDashboardTimerStartedRef.current) {
      console.time('[PERF] Dashboard total load')
      perfDashboardTimerStartedRef.current = true
    }

    return () => {
      if (perfDashboardTimerStartedRef.current) {
        console.timeEnd('[PERF] Dashboard total load')
        perfDashboardTimerStartedRef.current = false
      }
    }
  }, [selectedEnvironment])

  useEffect(() => {
    if (!selectedEnvironment) {
      return
    }

    if (!perfViewSwitchTimerStartedRef.current) {
      console.time('[PERF] View switch')
      perfViewSwitchTimerStartedRef.current = true
    }

    return () => {
      if (perfViewSwitchTimerStartedRef.current) {
        console.timeEnd('[PERF] View switch')
        perfViewSwitchTimerStartedRef.current = false
      }
    }
  }, [selectedEnvironment, timeRange, selectedStartDate, selectedEndDate])

  useEffect(() => {
    let isDisposed = false

    const loadEnvironments = async ({ useCache = false, silent = false } = {}) => {
      if (!isAuthenticated) {
        setEnvironments([])
        return
      }

      if (useCache) {
        try {
          const cached = localStorage.getItem(haEnvironmentsCacheKey)
          if (cached) {
            const parsed = JSON.parse(cached)
            const cachedEnvironments = normalizeEnvironmentConfigs(parsed)

            if (cachedEnvironments.length > 0 && !isDisposed) {
              setEnvironments(cachedEnvironments)
            }
          }
        } catch {
          // Ignore cache parse errors and continue with network fetch.
        }
      }

      if (!silent) {
        setEnvLoading(true)
      }
      setEnvError(null)

      try {
        const token = await getAuthToken()
        const response = await fetch('/.netlify/functions/environments', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new Error('Unable to load environments')
        }

        const data = await response.json()
        const loaded: HaEnvironmentPayload[] = Array.isArray(data?.environments)
          ? data.environments
          : []
        const next = loaded.map((env: HaEnvironmentPayload & { display_name?: string }) => ({
          id: String(env.id),
          name: String(env.display_name || env.name || env.id),
          type: env.type || 'home_assistant',
        }))
        if (!isDisposed) {
          setEnvironments(next)
        }
        storeLocalJson(haEnvironmentsCacheKey, next)
      } catch (error) {
        if (!isDisposed) {
          setEnvError(error instanceof Error ? error.message : 'Unable to load environments')
        }
      } finally {
        if (!silent && !isDisposed) {
          setEnvLoading(false)
        }
      }
    }

    void loadEnvironments({ useCache: true, silent: false })

    const interval = setInterval(() => {
      void loadEnvironments({ useCache: false, silent: true })
    }, 15000)

    const handleFocusRefresh = () => {
      void loadEnvironments({ useCache: false, silent: true })
    }

    window.addEventListener('focus', handleFocusRefresh)

    return () => {
      isDisposed = true
      clearInterval(interval)
      window.removeEventListener('focus', handleFocusRefresh)
    }
  }, [haEnvironmentsCacheKey, isAuthenticated, getAuthToken])

  useEffect(() => {
    const applyCachedEnvironments = (source: unknown) => {
      const next = normalizeEnvironmentConfigs(source)
      if (next.length > 0) {
        setEnvironments(next)
      }
    }

    const handleUpdatedEvent = (event: Event) => {
      const customEvent = event as CustomEvent<unknown>
      applyCachedEnvironments(customEvent.detail)
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== haEnvironmentsCacheKey || !event.newValue) {
        return
      }

      try {
        applyCachedEnvironments(JSON.parse(event.newValue))
      } catch {
        // Ignore malformed storage payloads.
      }
    }

    window.addEventListener(HA_ENVIRONMENTS_UPDATED_EVENT, handleUpdatedEvent as EventListener)
    window.addEventListener('storage', handleStorage)

    return () => {
      window.removeEventListener(HA_ENVIRONMENTS_UPDATED_EVENT, handleUpdatedEvent as EventListener)
      window.removeEventListener('storage', handleStorage)
    }
  }, [haEnvironmentsCacheKey])

  useEffect(() => {
    const loadAssignments = async () => {
      if (!isAuthenticated) {
        setAllowedEnvironmentIds(null)
        setIsCheckingPermissions(false)
        return
      }

      if (isAdmin) {
        setAllowedEnvironmentIds(null)
        setIsCheckingPermissions(false)
        return
      }

      let hasCachedAssignments = false
      try {
        const cached = localStorage.getItem(userEnvironmentIdsCacheKey)
        if (cached) {
          const parsed = JSON.parse(cached)
          if (Array.isArray(parsed)) {
            const cachedIds = parsed.filter((id) => typeof id === 'string')
            if (cachedIds.length > 0) {
              setAllowedEnvironmentIds(cachedIds)
              hasCachedAssignments = true
            }
          }
        }
      } catch {
        // Ignore malformed permission cache.
      }

      setIsCheckingPermissions(!hasCachedAssignments)

      try {
        const claims = await getIdTokenClaims()
        const envClaim = 'https://brouwer-ems/environments'
        const envs = (claims?.[envClaim] as string[] | undefined) ?? null

        if (envs && envs.length > 0) {
          setAllowedEnvironmentIds(envs)
          storeLocalJson(userEnvironmentIdsCacheKey, envs)
          setIsCheckingPermissions(false)
          return
        }

        const token = await getAuthToken()
        const response = await fetch('/.netlify/functions/get-user-environments', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new Error('Unable to load user environments')
        }

        const data = await response.json()
        const ids = Array.isArray(data?.environmentIds) ? data.environmentIds : []
        setAllowedEnvironmentIds(ids)
        storeLocalJson(userEnvironmentIdsCacheKey, ids)
      } catch {
        if (!hasCachedAssignments) {
          setAllowedEnvironmentIds([])
        }
      } finally {
        setIsCheckingPermissions(false)
      }
    }

    void loadAssignments()
  }, [getAuthToken, getIdTokenClaims, isAuthenticated, isAdmin, userEnvironmentIdsCacheKey])

  const visibleEnvironments = allowedEnvironmentIds
    ? environments.filter((env) => allowedEnvironmentIds.includes(env.id))
    : environments

  useEffect(() => {
    if (visibleEnvironments.length === 0) {
      return
    }

    if (!visibleEnvironments.find((env) => env.id === selectedEnvironment)) {
      setSelectedEnvironment(visibleEnvironments[0].id)
    }
  }, [selectedEnvironment, visibleEnvironments])

  useEffect(() => {
    if (selectedEnvironmentId && selectedEnvironmentId !== selectedEnvironment) {
      setSelectedEnvironment(selectedEnvironmentId)
    }
  }, [selectedEnvironment, selectedEnvironmentId])

  useEffect(() => {
    if (!selectedEnvironment) {
      return
    }

    const timer = window.setTimeout(() => {
      setStableSelectedEnvironment(selectedEnvironment)
    }, 100)

    return () => {
      window.clearTimeout(timer)
    }
  }, [selectedEnvironment])

  useEffect(() => {
    let isMounted = true

    const loadPricing = async () => {
      if (!selectedEnvironment) {
        setPricingConfig(null)
        return
      }

      const key = `energy_pricing_${environmentScope}`
      const runtimePricingKey = makeDashboardCacheKey(['pricing', environmentScope])

      const runtimePricing = getDashboardResponseCache<EnergyPricingConfig>(runtimePricingKey)
      if (runtimePricing) {
        setPricingConfig(runtimePricing)
      }

      try {
        const cached = localStorage.getItem(key)
        if (cached && isMounted) {
          const normalized = normalizePricingConfig(JSON.parse(cached))
          if (normalized) {
            setPricingConfig(normalized)
          }
        }
      } catch {
        // Ignore local parse errors and continue with server fetch.
      }

      if (!isAuthenticated) {
        return
      }

      try {
        const token = await getAuthToken()
        const response = await fetch(`/.netlify/functions/get-energy-pricing?environmentId=${encodeURIComponent(selectedEnvironmentRequestId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new Error('Unable to load pricing config')
        }

        const data = await response.json()
        const normalized = normalizePricingConfig(data?.config)

        if (!isMounted) {
          return
        }

        if (normalized) {
          setPricingConfig(normalized)
          storeLocalJson(key, normalized)
          setDashboardResponseCache(runtimePricingKey, normalized, 30 * 60_000)
        } else {
          setPricingConfig(null)
        }
      } catch {
        // Keep cached pricing when server fetch fails.
      }
    }

    void loadPricing()

    return () => {
      isMounted = false
    }
  }, [environmentScope, getAuthToken, isAuthenticated, selectedEnvironment, selectedEnvironmentRequestId])

  useEffect(() => {
    if (!selectedEnvironment) {
      setShowDynamicPriceChart(false)
      setDynamicPriceChartError(null)
      return
    }

    try {
      const chartStored = localStorage.getItem(dynamicPriceChartPreferenceKey)
      if (chartStored) {
        const parsed = JSON.parse(chartStored)
        setShowDynamicPriceChart(Boolean(parsed?.visible))
      } else {
        setShowDynamicPriceChart(false)
      }

      const fixedLinesStored = localStorage.getItem(dynamicPriceFixedLinesPreferenceKey)
      if (fixedLinesStored) {
        const parsed = JSON.parse(fixedLinesStored)
        setShowFixedPriceLinesOnChart(typeof parsed?.visible === 'boolean' ? parsed.visible : true)
      } else {
        setShowFixedPriceLinesOnChart(true)
      }
    } catch {
      setShowDynamicPriceChart(false)
      setShowFixedPriceLinesOnChart(true)
    }
  }, [
    dynamicPriceChartPreferenceKey,
    dynamicPriceFixedLinesPreferenceKey,
    selectedEnvironment,
  ])

  useEffect(() => {
    if (!selectedEnvironment) {
      return
    }

    const handleDynamicChartVisibilityChange = (event: Event) => {
      const detail = (event as CustomEvent<{ environmentId?: string; visible?: boolean; showFixedLines?: boolean }>)?.detail
      if (!detail || detail.environmentId !== selectedEnvironment) {
        return
      }

      const visible = Boolean(detail.visible)
      setShowDynamicPriceChart(visible)
      if (typeof detail.showFixedLines === 'boolean') {
        setShowFixedPriceLinesOnChart(detail.showFixedLines)
      }
      if (!visible) {
        setDynamicPriceChartError(null)
      }
    }

    window.addEventListener(DYNAMIC_PRICE_CHART_EVENT, handleDynamicChartVisibilityChange as EventListener)
    return () => {
      window.removeEventListener(DYNAMIC_PRICE_CHART_EVENT, handleDynamicChartVisibilityChange as EventListener)
    }
  }, [selectedEnvironment])

  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated || !showDynamicPriceChart) {
      setDynamicPriceChartLoading(false)
      return
    }

    let isMounted = true

    const fetchDynamicPriceChart = async () => {
      if (isMounted) {
        setDynamicPriceChartLoading(true)
        setDynamicPriceChartError(null)
      }

      try {
        const token = await getAuthToken()
        const response = await fetch('/.netlify/functions/get-entsoe-prices?hoursAhead=120', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          const payload = await response.json().catch(() => null)
          throw new Error(payload?.message || payload?.error || 'Unable to load dynamic price chart')
        }

        const data = await response.json()
        const points = normalizeDynamicPricePoints(data)

        if (!isMounted) {
          return
        }

        if (points.length === 0) {
          throw new Error('No dynamic price points available yet')
        }

        setDynamicPricePoints(points)
        setDynamicPriceUpdatedAt(typeof data?.timestamp === 'string' ? data.timestamp : new Date().toISOString())

        const resolvedPrice = parseEntsoeBasePrice(data)
        const proxyFactor = Number.isFinite(pricingConfig?.gasProxyKwhPerM3) && Number(pricingConfig?.gasProxyKwhPerM3) > 0
          ? Number(pricingConfig?.gasProxyKwhPerM3)
          : DEFAULT_DYNAMIC_GAS_KWH_PER_M3
        const resolvedGasPrice = parseEntsoeGasProxyPrice(data, proxyFactor)

        if (resolvedPrice !== null && Number.isFinite(resolvedPrice) && resolvedPrice >= 0) {
          setDynamicConsumerPriceKwh(resolvedPrice)
          if (resolvedGasPrice !== null && Number.isFinite(resolvedGasPrice) && resolvedGasPrice >= 0) {
            setDynamicGasPricePerM3(resolvedGasPrice)
          }

          storeLocalJson(dynamicPriceCacheKey, {
            value: resolvedPrice,
            electricityValue: resolvedPrice,
            gasValue: resolvedGasPrice,
            updatedAt: new Date().toISOString(),
          })
        }
      } catch (error) {
        if (!isMounted) {
          return
        }

        setDynamicPriceChartError(error instanceof Error ? error.message : 'Unable to load dynamic price chart')
      } finally {
        if (isMounted) {
          setDynamicPriceChartLoading(false)
        }
      }
    }

    void fetchDynamicPriceChart()
    const intervalId = window.setInterval(() => {
      void fetchDynamicPriceChart()
    }, 15 * 60 * 1000)

    return () => {
      isMounted = false
      window.clearInterval(intervalId)
    }
  }, [
    dynamicPriceCacheKey,
    pricingConfig?.gasProxyKwhPerM3,
    getAuthToken,
    isAuthenticated,
    selectedEnvironment,
    showDynamicPriceChart,
  ])

  useEffect(() => {
    if (!selectedEnvironment || pricingConfig?.type !== 'dynamic') {
      setDynamicConsumerPriceKwh(null)
      setDynamicGasPricePerM3(null)
      return
    }

    try {
      const cached = localStorage.getItem(dynamicPriceCacheKey)
      if (!cached) {
        return
      }

      const parsed = JSON.parse(cached)
      const electricityValue = Number(parsed?.electricityValue ?? parsed?.value)
      if (Number.isFinite(electricityValue) && electricityValue >= 0) {
        setDynamicConsumerPriceKwh(electricityValue)
      }

      const gasValue = Number(parsed?.gasValue)
      if (Number.isFinite(gasValue) && gasValue >= 0) {
        setDynamicGasPricePerM3(gasValue)
      }
    } catch {
      // Ignore parse errors and refresh from API.
    }
  }, [dynamicPriceCacheKey, pricingConfig?.type, selectedEnvironment])

  useEffect(() => {
    if (!selectedEnvironment) {
      setIsEnvironmentOffline(false)
      setOfflineLastSeenAt(null)
      return
    }

    const cached = readCachedOverviewStatus(selectedEnvironment)
    if (cached?.status === 'offline') {
      setIsEnvironmentOffline(true)
      setOfflineLastSeenAt(cached.lastSeenAt ?? null)
      return
    }

    setIsEnvironmentOffline(false)
    setOfflineLastSeenAt(cached?.lastSeenAt ?? null)
  }, [readCachedOverviewStatus, selectedEnvironment])

  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated || !isEnvironmentOffline) {
      return
    }

    let isDisposed = false

    const checkEnvironmentHealth = async () => {
      try {
        const token = await getAuthToken()
        if (isDisposed) {
          return
        }

        const response = await fetch(`/.netlify/functions/ha-health?environmentId=${encodeURIComponent(selectedEnvironmentRequestId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (isDisposed) {
          return
        }

        if (response.ok) {
          setIsEnvironmentOffline(false)
          setHaConnectionStatus('connecting')
          return
        }

        if (response.status === 502) {
          console.warn(`[HA] Environment ${selectedEnvironmentRequestId} is unreachable`)
        }
      } catch {
        // Keep offline state and retry on next interval.
      }
    }

    void checkEnvironmentHealth()
    const interval = window.setInterval(() => {
      void checkEnvironmentHealth()
    }, 5 * 60 * 1000)

    return () => {
      isDisposed = true
      window.clearInterval(interval)
    }
  }, [getAuthToken, isAuthenticated, isEnvironmentOffline, selectedEnvironment, selectedEnvironmentRequestId])

  useEffect(() => {
    // Keep current data visible while switching environment.
    // Fresh data is loaded in the background to avoid visible flashes.
    if (!selectedEnvironment) {
      setIsInitialLoading(false)
      return
    }

    try {
      const cached = localStorage.getItem(haEntitiesCacheKey)
      if (!cached) {
        return
      }

      const parsed = JSON.parse(cached)
      const cachedEntities = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.entities)
          ? parsed.entities
          : []
      const cachedMetrics = Array.isArray(parsed)
        ? null
        : normalizeHaMetricsSnapshot(parsed?.metrics)

      if (cachedMetrics) {
        setHaMetricsSnapshot(cachedMetrics)
        setIsInitialLoading(false)
        setEntitiesLoaded(true)
      }

      if (!Array.isArray(cachedEntities) || cachedEntities.length === 0) {
        return
      }

      const normalized = cachedEntities
        .filter((entity: HaEntity) => typeof entity?.entity_id === 'string')
        .map((entity: HaEntity) => ({
          entity_id: entity.entity_id,
          state: entity.state,
          domain: entity.domain,
          friendly_name: entity.friendly_name,
          unit_of_measurement: entity.unit_of_measurement,
          device_class: entity.device_class,
          state_class: entity.state_class,
        }))

      if (normalized.length > 0) {
        setHaEntities(normalized)
        setLastKnownHaEntities(normalized)
        setIsInitialLoading(false)
        setEntitiesLoaded(true)
      }
    } catch {
      // Ignore entity cache parse errors.
    }
  }, [haEntitiesCacheKey, selectedEnvironment])

  // Load last known good values from Blobs — shown before live data arrives
  useEffect(() => {
    if (!stableSelectedEnvironment || stableSelectedEnvironment !== selectedEnvironment || !isAuthenticated) {
      return
    }

    let isCancelled = false

    const loadSnapshot = async () => {
      try {
        const token = await getAuthToken()
        if (isCancelled) return
        const response = await fetch(
          `/.netlify/functions/save-snapshot?environmentId=${encodeURIComponent(selectedEnvironmentRequestId)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (isCancelled || !response.ok) return
        const result = await response.json()
        const snapshot = result?.snapshot
        if (!snapshot || typeof snapshot !== 'object') return

        // Only populate from snapshot if we don't have live data yet
        if (!haMetricsSnapshot) {
          const snapMetrics = normalizeHaMetricsSnapshot(snapshot)
          if (snapMetrics) {
            setHaMetricsSnapshot(snapMetrics)
          }
        }
      } catch {
        // Silently ignore network errors — snapshot load is best-effort
      }
    }

    void loadSnapshot()
    return () => { isCancelled = true }
  }, [selectedEnvironment, isAuthenticated, getAuthToken, haMetricsSnapshot])

  // Close settings dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showSettingsDropdown && !target.closest('.settings-dropdown-container')) {
        setShowSettingsDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSettingsDropdown])

  useEffect(() => {
    let isDisposed = false
    let latestRequestId = 0
    let activeController: AbortController | null = null

    const loadHaEntities = async (silent = false) => {
      const requestId = ++latestRequestId

      if (silent) {
        if (silentHaRefreshInProgressRef.current) {
          return
        }

        // Entity list changes infrequently; avoid hammering ha-entities in silent mode.
        if (Date.now() - lastHaEntitiesFetchAtRef.current < 5 * 60_000) {
          return
        }
      }

      if (!isAuthenticated) {
        if (!silent) {
          setHaConnectionStatus('error')
        }
        return
      }
      if (!isEnvironmentSelectionSettled) {
        return
      }
      if (!stableSelectedEnvironment || stableSelectedEnvironment !== selectedEnvironment) {
        if (!silent) {
          setHaConnectionStatus('error')
        }
        return
      }

      if (isEnvironmentOffline) {
        if (!silent) {
          setHaLoading(false)
          setHaConnectionStatus('error')
          setHaError(null)
          setIsInitialLoading(false)
        }
        return
      }
      
      if (!silent) {
        setHaLoading(true)
        setHaError(null)
        if (!perfHaEntitiesTimerStartedRef.current) {
          console.time('[PERF] ha-entities')
          perfHaEntitiesTimerStartedRef.current = true
        }
        const overviewSnapshot = getOverviewLiveSnapshot(selectedEnvironment)
        if (overviewSnapshot?.status === 'online') {
          setHaConnectionStatus('connected')
        } else {
          setHaConnectionStatus('connecting')
        }
      }
      
      try {
        if (silent) {
          silentHaRefreshInProgressRef.current = true
        }

        const token = await getAuthToken()
        if (isDisposed || requestId !== latestRequestId) {
          return
        }

        // eslint-disable-next-line no-console
        console.log(`[HA] ${silent ? '🔄 SILENT' : '📥 INITIAL'} refresh starting...`)

        activeController?.abort()
        activeController = new AbortController()
        
        const response = await throttledAuthFetch(
          `/.netlify/functions/ha-entities?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&tzOffset=${new Date().getTimezoneOffset() * -1}`,
          token,
          {
            signal: activeController.signal,
          },
        )

        if (isDisposed || requestId !== latestRequestId) {
          return
        }
        
        // eslint-disable-next-line no-console
        console.log(`[HA] Response status: ${response.status}`)
        
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          if (response.status === 502) {
            console.warn(`[HA] Environment ${selectedEnvironmentRequestId} is unreachable`)
            setIsEnvironmentOffline(true)
            setOfflineLastSeenAt(Date.now())
            setOverviewLiveSnapshot({
              environmentId: selectedEnvironment,
              status: 'offline',
              lastSeenAt: Date.now(),
            })
          } else {
            // eslint-disable-next-line no-console
            console.error(`[HA] Error: ${data?.error || 'Unknown error'}`)
          }
          if (!silent) {
            setHaConnectionStatus('error')
            setHaError(data?.error || 'Unable to load sensor data')
            setIsInitialLoading(false)
          }
          // NEVER clear entities on error - keep showing last known data
          return
        }
        
        let data = await response.json()
        if (isDisposed || requestId !== latestRequestId) {
          return
        }

        let entities = Array.isArray(data?.entities) ? data.entities : []
        let metrics = normalizeHaMetricsSnapshot(data?.metrics)

        if (entities.length === 0 && stableSelectedEnvironmentRequestId !== selectedEnvironment) {
          const retryResponse = await throttledAuthFetch(
            `/.netlify/functions/ha-entities?environmentId=${encodeURIComponent(selectedEnvironment)}&tzOffset=${new Date().getTimezoneOffset() * -1}`,
            token,
            {
              signal: activeController.signal,
              retriesMs: [],
            },
          )

          if (retryResponse.ok) {
            data = await retryResponse.json()
            entities = Array.isArray(data?.entities) ? data.entities : []
            metrics = normalizeHaMetricsSnapshot(data?.metrics)
          }
        }
        // eslint-disable-next-line no-console
        console.log(`[HA] ✅ Loaded ${entities.length} entities`)
        
        // Update entities AND keep them as last known
        setHaEntities(entities)
        setLastKnownHaEntities(entities)
        setEntitiesLoaded(true)
        setIsEnvironmentOffline(false)
        setHaMetricsSnapshot(metrics)
        storeLocalJson(haEntitiesCacheKey, { entities, metrics })
        setHaConnectionStatus('connected')
        setHaError(null)
        setOverviewLiveSnapshot({
          environmentId: selectedEnvironment,
          status: 'online',
          currentPower: metrics?.currentPowerKw ?? undefined,
          dailyUsage: metrics?.dailyElectricityKwh ?? undefined,
          lastUpdate: new Date().toLocaleTimeString(),
          lastSeenAt: Date.now(),
        })
        lastHaEntitiesFetchAtRef.current = Date.now()
        if (perfHaEntitiesTimerStartedRef.current) {
          console.timeEnd('[PERF] ha-entities')
          perfHaEntitiesTimerStartedRef.current = false
        }

        // Persist latest known values to Netlify Blobs for offline fallback
        // Fire-and-forget: do NOT await, do NOT block rendering, do NOT show errors
        if (metrics && selectedEnvironment) {
          const lastSent = snapshotSaveLastSentMs.get(selectedEnvironment) ?? 0
          if (Date.now() - lastSent > SNAPSHOT_SAVE_THROTTLE_MS) {
            snapshotSaveLastSentMs.set(selectedEnvironment, Date.now())
            getAuthToken().then((authToken: string) => {
              return fetch('/.netlify/functions/save-snapshot', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${authToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  environmentId: selectedEnvironment,
                  snapshot: {
                    dailyElectricityKwh: metrics.dailyElectricityKwh,
                    monthlyElectricityKwh: metrics.monthlyElectricityKwh,
                    dailyGasM3: metrics.dailyGasM3,
                    monthlyGasM3: metrics.monthlyGasM3,
                    savedAt: Date.now(),
                  },
                }),
              })
            }).catch(() => { /* ignore errors — offline fallback is best-effort */ })
          }
        }
        
        if (!silent) {
          setIsInitialLoading(false) // Only set false on successful initial load
        }
      } catch (error) {
        if (isDisposed || requestId !== latestRequestId) {
          return
        }

        if (error instanceof Error && error.name === 'AbortError') {
          return
        }

        // eslint-disable-next-line no-console
        console.error('[HA] Fetch error:', error);
        if (!silent) {
          setHaError(error instanceof Error ? error.message : 'Unable to load sensor data')
          setHaConnectionStatus('error')
          setIsInitialLoading(false) // Set false on error too so we show last known data
          if (perfHaEntitiesTimerStartedRef.current) {
            console.timeEnd('[PERF] ha-entities')
            perfHaEntitiesTimerStartedRef.current = false
          }
        }
        // NEVER clear entities on error - keep showing last known data
      } finally {
        if (silent) {
          silentHaRefreshInProgressRef.current = false
        }
        if (!silent) {
          setHaLoading(false)
        }
      }
    }
    
    if (stableSelectedEnvironment && stableSelectedEnvironment === selectedEnvironment && isEnvironmentSelectionSettled) {
      const nextLoadKey = `${stableSelectedEnvironmentRequestId}::${haRefreshKey}`
      if (initialHaLoadKeyRef.current !== nextLoadKey) {
        initialHaLoadKeyRef.current = nextLoadKey
        // Initial load
        // eslint-disable-next-line no-console
        console.log('[HA] Starting initial load...')
        void loadHaEntities(false)
      }
    }
    
    // Auto-refresh every 30 seconds - ALWAYS silent, NEVER affects UI on error
    const interval = setInterval(() => {
      void loadHaEntities(true)
    }, 30000)
    
    return () => {
      isDisposed = true
      latestRequestId += 1
      activeController?.abort()
      clearInterval(interval)
    }
  }, [getAuthToken, haEntitiesCacheKey, isAuthenticated, selectedEnvironment, haRefreshKey, isEnvironmentOffline, stableSelectedEnvironment, stableSelectedEnvironmentRequestId, isEnvironmentSelectionSettled])

  const getControlActions = (domain: string) => {
    switch (domain) {
      case 'switch':
      case 'light':
      case 'input_boolean':
        return [
          { label: 'On', action: 'turn_on' },
          { label: 'Off', action: 'turn_off' },
        ]
      case 'button':
        return [{ label: 'Press', action: 'press' }]
      case 'script':
        return [{ label: 'Run', action: 'turn_on' }]
      case 'scene':
        return [{ label: 'Activate', action: 'turn_on' }]
      default:
        return []
    }
  }

  const runHaAction = async (entityId: string, action: string) => {
    try {
      setHaActionId(entityId)
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/ha-service', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environmentId: selectedEnvironment,
          entityId,
          action,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Unable to run action')
      }

      const refresh = await throttledAuthFetch(
        `/.netlify/functions/ha-entities?environmentId=${encodeURIComponent(selectedEnvironmentRequestId)}&tzOffset=${new Date().getTimezoneOffset() * -1}`,
        token,
        { retriesMs: [] },
      )

      if (refresh.ok) {
        const data = await refresh.json()
        const refreshedEntities = Array.isArray(data?.entities) ? data.entities : []
        const refreshedMetrics = normalizeHaMetricsSnapshot(data?.metrics)
        setHaEntities(refreshedEntities)
        setLastKnownHaEntities(refreshedEntities)
        setHaMetricsSnapshot(refreshedMetrics)
        storeLocalJson(haEntitiesCacheKey, { entities: refreshedEntities, metrics: refreshedMetrics })
      }
    } catch (error) {
      setHaError(error instanceof Error ? error.message : 'Unable to run action')
    } finally {
      setHaActionId(null)
    }
  }

  const configuredGasPrice = Number(pricingConfig?.gasPrice)
  const configuredGasMargin = Number(pricingConfig?.gasMargin)
  const fallbackGasPrice = DEFAULT_GAS_PRICE_PER_M3
  const savedGasRatePerM3 = Number.isFinite(configuredGasPrice) && configuredGasPrice > 0
    ? configuredGasPrice
    : fallbackGasPrice
  const gasBaseRatePerM3 = pricingConfig?.type === 'dynamic' && Number.isFinite(dynamicGasPricePerM3) && Number(dynamicGasPricePerM3) > 0
    ? Number(dynamicGasPricePerM3)
    : savedGasRatePerM3
  const gasMarginPerM3 = Number.isFinite(configuredGasMargin)
    ? configuredGasMargin
    : DEFAULT_GAS_MARGIN_PER_M3
  const gasRatePerM3 = Math.max(0, gasBaseRatePerM3 + gasMarginPerM3)

  // Extract real-time energy data from Home Assistant entities
  const realTimeData = useMemo(() => {
    const entities = haEntities.length > 0 ? haEntities : lastKnownHaEntities
    const serverMetrics = haMetricsSnapshot
    const overviewSnapshot = selectedEnvironment ? getOverviewLiveSnapshot(selectedEnvironment) : null
    
    // Helper function to parse numeric values from entity state
    const parseValue = (state: string): number => {
      const parsed = parseNumericValue(state)
      return Number.isFinite(parsed) ? parsed : 0
    }

    const environmentKey = environmentScope

    const toSearchable = (entity: HaEntity) =>
      `${entity.entity_id} ${entity.friendly_name || ''}`.toLowerCase()

    const productionKeywords = [
      'production',
      'producer',
      'solar',
      'pv',
      'generation',
      'yield',
      'opwek',
      'opgewekt',
      'export',
      'injection',
      'teruglever',
    ]

    // Helper function to find entity by keywords in entity_id/friendly_name
    const findEntity = (keywords: string[], excludedKeywords: string[] = []): HaEntity | undefined => {
      return entities.find((entity) => {
        if (entity.domain !== 'sensor') {
          return false
        }

        const searchable = toSearchable(entity)
        return keywords.some((keyword) => searchable.includes(keyword.toLowerCase())) &&
          !excludedKeywords.some((keyword) => searchable.includes(keyword.toLowerCase()))
      })
    }

    const isPowerUnit = (unit: string | undefined) => {
      const normalizedUnit = String(unit || '').trim().toLowerCase()
      return (
        normalizedUnit === 'w' ||
        normalizedUnit === 'kw' ||
        normalizedUnit === 'watt' ||
        normalizedUnit === 'kilowatt' ||
        normalizedUnit === 'va' ||
        normalizedUnit === 'kva'
      )
    }

    const findPowerEntity = (): HaEntity | undefined => {
      const powerKeywords = [
        'current_power',
        'active_power',
        'power',
        'watt',
        'vermogen',
        'actueel vermogen',
        'actueel_vermogen',
        'huidig verbruik',
        'verbruik nu',
        'current usage',
        'current consumption',
        'load',
      ]
      const excludedKeywords = [
        'today',
        'daily',
        'month',
        'monthly',
        'total',
        'kwh',
        'energy',
        'gas',
        'price',
        'cost',
        'tariff',
        ...productionKeywords,
      ]

      const candidates = entities.filter((entity) => {
        if (entity.domain !== 'sensor') {
          return false
        }

        const searchable = toSearchable(entity)
        return !excludedKeywords.some((keyword) => searchable.includes(keyword))
      })

      const deviceClassMatch = candidates.find((entity) => {
        const deviceClass = String(entity.device_class || '').toLowerCase()
        return deviceClass === 'power' && Number.isFinite(parseNumericValue(entity.state))
      })
      if (deviceClassMatch) {
        return deviceClassMatch
      }

      const keywordMatch = candidates.find((entity) => {
        const searchable = toSearchable(entity)
        return (
          powerKeywords.some((keyword) => searchable.includes(keyword)) &&
          Number.isFinite(parseNumericValue(entity.state))
        )
      })
      if (keywordMatch) {
        return keywordMatch
      }

      return entities.find((entity) => {
        if (entity.domain !== 'sensor') {
          return false
        }

        const searchable = toSearchable(entity)
        if (productionKeywords.some((keyword) => searchable.includes(keyword))) {
          return false
        }

        return isPowerUnit(entity.unit_of_measurement) && Number.isFinite(parseNumericValue(entity.state))
      })
    }

    const findProductionPowerEntity = (): HaEntity | undefined => {
      const excludedKeywords = [
        'today',
        'daily',
        'month',
        'monthly',
        'total',
        'kwh',
        'energy',
        'gas',
        'price',
        'cost',
        'tariff',
      ]

      const candidates = entities.filter((entity) => {
        if (entity.domain !== 'sensor') {
          return false
        }

        const searchable = toSearchable(entity)
        return (
          productionKeywords.some((keyword) => searchable.includes(keyword)) &&
          !excludedKeywords.some((keyword) => searchable.includes(keyword))
        )
      })

      const deviceClassMatch = candidates.find((entity) => {
        const deviceClass = String(entity.device_class || '').toLowerCase()
        return deviceClass === 'power' && Number.isFinite(parseNumericValue(entity.state))
      })
      if (deviceClassMatch) {
        return deviceClassMatch
      }

      const powerUnitMatch = candidates.find((entity) => (
        isPowerUnit(entity.unit_of_measurement) && Number.isFinite(parseNumericValue(entity.state))
      ))
      if (powerUnitMatch) {
        return powerUnitMatch
      }

      return entities.find((entity) => {
        if (entity.domain !== 'sensor') {
          return false
        }

        const searchable = toSearchable(entity)
        return (
          productionKeywords.some((keyword) => searchable.includes(keyword)) &&
          isPowerUnit(entity.unit_of_measurement) &&
          Number.isFinite(parseNumericValue(entity.state))
        )
      })
    }

    const convertPowerToKw = (rawValue: number, unit: string | undefined) => {
      const normalizedUnit = String(unit || '').trim().toLowerCase()
      if (normalizedUnit === 'w' || normalizedUnit === 'watt' || normalizedUnit === 'va') {
        return rawValue / 1000
      }
      if (normalizedUnit === 'kw' || normalizedUnit === 'kilowatt') {
        return rawValue
      }
      // Backward-compatible fallback for sensors without units.
      return rawValue > 100 ? rawValue / 1000 : rawValue
    }

    const derivePowerFromEnergyMeter = (meterTotalKwh: number): number => {
      if (!Number.isFinite(meterTotalKwh)) {
        return 0
      }

      const keys = {
        total: `energy_meter_last_total_${environmentKey}`,
        ts: `energy_meter_last_ts_${environmentKey}`,
      }

      const now = Date.now()
      const previousTotal = parseFloat(localStorage.getItem(keys.total) || '')
      const previousTs = parseInt(localStorage.getItem(keys.ts) || '', 10)

      storeLocalValue(keys.total, meterTotalKwh.toString())
      storeLocalValue(keys.ts, now.toString())

      if (!Number.isFinite(previousTotal) || !Number.isFinite(previousTs)) {
        return 0
      }

      const deltaKwh = meterTotalKwh - previousTotal
      const deltaMs = now - previousTs

      if (deltaKwh <= 0 || deltaMs <= 0 || deltaMs > 30 * 60 * 1000) {
        return 0
      }

      const hours = deltaMs / (1000 * 60 * 60)
      const derivedKw = deltaKwh / hours
      return Number.isFinite(derivedKw) && derivedKw > 0 ? derivedKw : 0
    }

    const calculateUsageFromPowerSamples = (samples: PowerSample[], startMs: number, endMs: number) => {
      if (samples.length < 2) {
        return 0
      }

      const sorted = [...samples]
        .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.power))
        .sort((a, b) => a.timestamp - b.timestamp)

      let kwh = 0
      for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1]
        const current = sorted[index]

        if (current.timestamp <= startMs || previous.timestamp >= endMs) {
          continue
        }

        const segmentStart = Math.max(previous.timestamp, startMs)
        const segmentEnd = Math.min(current.timestamp, endMs)

        if (segmentEnd <= segmentStart) {
          continue
        }

        const hours = (segmentEnd - segmentStart) / (1000 * 60 * 60)
        const averagePowerKw = (previous.power + current.power) / 2
        kwh += averagePowerKw * hours
      }

      return kwh
    }

    // Helper function to derive gas daily/monthly from cumulative meter when dedicated sensors are missing
    const trackGasFromMeter = (gasMeterTotal: number): { daily: number; monthly: number } => {
      const now = new Date()
      const today = now.toDateString()
      const thisMonth = `${now.getFullYear()}-${now.getMonth() + 1}`
      const keys = {
        dailyDate: `gas_daily_date_${environmentKey}`,
        dailyBase: `gas_daily_base_${environmentKey}`,
        monthValue: `gas_month_${environmentKey}`,
        monthBase: `gas_month_base_${environmentKey}`,
      }

      const storedDailyDate = localStorage.getItem(keys.dailyDate)
      const storedDailyBase = parseFloat(localStorage.getItem(keys.dailyBase) || '0')
      const storedMonthValue = localStorage.getItem(keys.monthValue)
      const storedMonthBase = parseFloat(localStorage.getItem(keys.monthBase) || '0')

      let dailyBase = storedDailyBase
      let monthBase = storedMonthBase

      if (storedDailyDate !== today || !Number.isFinite(storedDailyBase)) {
        dailyBase = gasMeterTotal
        storeLocalValue(keys.dailyDate, today)
        storeLocalValue(keys.dailyBase, gasMeterTotal.toString())
      }

      if (storedMonthValue !== thisMonth || !Number.isFinite(storedMonthBase)) {
        monthBase = gasMeterTotal
        storeLocalValue(keys.monthValue, thisMonth)
        storeLocalValue(keys.monthBase, gasMeterTotal.toString())
      }

      return {
        daily: Math.max(0, gasMeterTotal - dailyBase),
        monthly: Math.max(0, gasMeterTotal - monthBase),
      }
    }

    // Find power sensor (current usage in W or kW)
    const powerEntity = findPowerEntity()
    const productionPowerEntity = findProductionPowerEntity()
    const rawCurrentPower = powerEntity ? parseNumericValue(powerEntity.state) : NaN
    const rawCurrentProduction = productionPowerEntity ? parseNumericValue(productionPowerEntity.state) : NaN
    let currentPower = Number.isFinite(rawCurrentPower) ? rawCurrentPower : NaN
    let currentProduction = Number.isFinite(rawCurrentProduction) ? rawCurrentProduction : 0
    
    // eslint-disable-next-line no-console
    console.log('[Energy] Power entity:', powerEntity?.entity_id, '=', powerEntity?.state)
    
    currentPower = convertPowerToKw(currentPower, powerEntity?.unit_of_measurement)
    currentProduction = convertPowerToKw(currentProduction, productionPowerEntity?.unit_of_measurement)

    // Find daily/monthly/total electricity sensors (in kWh)
    const dailyEntity = findEntity(
      ['energy_today', 'daily_energy', 'today_energy', 'day_energy', 'daily', 'today'],
      ['gas', 'price', 'cost', 'tariff', ...productionKeywords],
    )
    const monthlyEntity = findEntity(
      ['energy_month', 'monthly_energy', 'month_energy', 'monthly', 'this_month', 'month'],
      ['gas', 'price', 'cost', 'tariff', ...productionKeywords],
    )
    const totalEnergyEntity = findEntity(
      ['energy_total', 'total_energy', 'total_consumption', 'kwh_total', 'consumption_total', 'p1_meter_energy_import', 'energy_import'],
      ['gas', 'price', 'cost', 'tariff', ...productionKeywords],
    )
    const dailyProductionEntity = findEntity(
      ['production_today', 'today_production', 'daily_production', 'opwek_vandaag', 'opgewekt_vandaag', 'solar_today', 'pv_today'],
      ['gas', 'price', 'cost', 'tariff'],
    )
    const monthlyProductionEntity = findEntity(
      ['production_month', 'month_production', 'monthly_production', 'opwek_maand', 'opgewekt_maand', 'solar_month', 'pv_month'],
      ['gas', 'price', 'cost', 'tariff'],
    )

    if (serverMetrics?.currentPowerKw !== null && serverMetrics?.currentPowerKw !== undefined) {
      currentPower = serverMetrics.currentPowerKw
    } else if (!Number.isFinite(currentPower) && Number.isFinite(overviewSnapshot?.currentPower)) {
      currentPower = Number(overviewSnapshot?.currentPower)
    } else if (!Number.isFinite(currentPower) && totalEnergyEntity) {
      currentPower = derivePowerFromEnergyMeter(parseValue(totalEnergyEntity.state))
    }

    if (serverMetrics?.currentProductionKw !== null && serverMetrics?.currentProductionKw !== undefined) {
      currentProduction = serverMetrics.currentProductionKw
    }

    if (!Number.isFinite(currentPower)) {
      currentPower = 0
    }

    if (!Number.isFinite(currentProduction)) {
      currentProduction = 0
    }

    // eslint-disable-next-line no-console
    console.log(
      '[Energy] Detected sensors - Daily:',
      dailyEntity?.entity_id,
      'Monthly:',
      monthlyEntity?.entity_id,
      'Total:',
      totalEnergyEntity?.entity_id,
      'Production daily:',
      dailyProductionEntity?.entity_id,
      'Production monthly:',
      monthlyProductionEntity?.entity_id,
    )

    const gasDailyEntity = findEntity([
      'gas_today',
      'daily_gas',
      'today_gas',
      'gas_day',
      'gas_verbruik_dag',
      'gas_consumption_today',
    ])
    const gasMonthlyEntity = findEntity([
      'gas_month',
      'monthly_gas',
      'month_gas',
      'gas_verbruik_maand',
      'gas_consumption_month',
    ])
    const gasFlowEntity = findEntity(
      ['gas_flow', 'gas_rate', 'current_gas', 'gas_current', 'gas_usage', 'gas_consumption'],
      ['today', 'day', 'month', 'total', 'cost', 'price', 'tariff'],
    )
    const gasMeterEntity = findGasConsumptionEntity(entities)
    
    // Use sensor data if available, otherwise track locally
    let dailyUsage: number
    let monthlyUsage: number
    let dailyProduction: number
    let monthlyProduction: number

    const nowTime = Date.now()
    const nowDate = new Date(nowTime)
    const startOfToday = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate(),
      0,
      0,
      0,
      0,
    ).getTime()
    const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1, 0, 0, 0, 0).getTime()

    const sampledDailyUsage = calculateUsageFromPowerSamples(powerSamples, startOfToday, nowTime)
    const sampledMonthlyUsage = calculateUsageFromPowerSamples(powerSamples, startOfMonth, nowTime)
    const sampledDailyProduction = calculateUsageFromPowerSamples(productionSamples, startOfToday, nowTime)
    const sampledMonthlyProduction = calculateUsageFromPowerSamples(productionSamples, startOfMonth, nowTime)
    
    const hasServerDailyMetric = Number.isFinite(serverMetrics?.dailyElectricityKwh)
    const hasServerMonthlyMetric = Number.isFinite(serverMetrics?.monthlyElectricityKwh)
    const hasServerDailyProductionMetric = Number.isFinite(serverMetrics?.dailyProductionKwh)
    const hasServerMonthlyProductionMetric = Number.isFinite(serverMetrics?.monthlyProductionKwh)

    if (hasServerDailyMetric || hasServerMonthlyMetric) {
      dailyUsage = hasServerDailyMetric
        ? Number(serverMetrics?.dailyElectricityKwh)
        : dailyEntity
          ? parseValue(dailyEntity.state)
          : sampledDailyUsage

      monthlyUsage = hasServerMonthlyMetric
        ? Number(serverMetrics?.monthlyElectricityKwh)
        : monthlyEntity
          ? parseValue(monthlyEntity.state)
          : sampledMonthlyUsage

      // eslint-disable-next-line no-console
      console.log('[Energy] Using server metrics as source of truth - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else if (dailyEntity || monthlyEntity) {
      dailyUsage = dailyEntity ? parseValue(dailyEntity.state) : sampledDailyUsage
      monthlyUsage = monthlyEntity ? parseValue(monthlyEntity.state) : sampledMonthlyUsage

      // eslint-disable-next-line no-console
      console.log('[Energy] Using direct HA sensors - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else if (sampledDailyUsage > 0 || sampledMonthlyUsage > 0) {
      dailyUsage = sampledDailyUsage
      monthlyUsage = sampledMonthlyUsage

      // eslint-disable-next-line no-console
      console.warn('[Energy] Falling back to sampled usage (no reliable daily/monthly meter source found)')
    } else {
      dailyUsage = 0
      monthlyUsage = 0

      // eslint-disable-next-line no-console
      console.warn('[Energy] No reliable electricity day/month data source available')
    }

    dailyUsage = Math.max(0, dailyUsage)
    monthlyUsage = Math.max(dailyUsage, monthlyUsage)

    if (hasServerDailyProductionMetric || hasServerMonthlyProductionMetric) {
      dailyProduction = hasServerDailyProductionMetric
        ? Number(serverMetrics?.dailyProductionKwh)
        : dailyProductionEntity
          ? parseValue(dailyProductionEntity.state)
          : sampledDailyProduction

      monthlyProduction = hasServerMonthlyProductionMetric
        ? Number(serverMetrics?.monthlyProductionKwh)
        : monthlyProductionEntity
          ? parseValue(monthlyProductionEntity.state)
          : sampledMonthlyProduction
    } else if (dailyProductionEntity || monthlyProductionEntity) {
      dailyProduction = dailyProductionEntity ? parseValue(dailyProductionEntity.state) : sampledDailyProduction
      monthlyProduction = monthlyProductionEntity ? parseValue(monthlyProductionEntity.state) : sampledMonthlyProduction
    } else if (sampledDailyProduction > 0 || sampledMonthlyProduction > 0) {
      dailyProduction = sampledDailyProduction
      monthlyProduction = sampledMonthlyProduction
    } else {
      dailyProduction = 0
      monthlyProduction = 0
    }

    dailyProduction = Math.max(0, dailyProduction)
    monthlyProduction = Math.max(dailyProduction, monthlyProduction)

    let gasDailyUsage = 0
    let gasMonthlyUsage = 0

    if (gasDailyEntity || gasMonthlyEntity) {
      gasDailyUsage = gasDailyEntity ? parseValue(gasDailyEntity.state) : 0
      
      if (gasMonthlyEntity) {
        gasMonthlyUsage = parseValue(gasMonthlyEntity.state)
      } else if (gasDailyEntity) {
        // Accumulate when no monthly sensor
        const trackedGas = trackGasFromMeter(0)
        gasMonthlyUsage = trackedGas.monthly + gasDailyUsage
      }
    } else if (gasMeterEntity) {
      const trackedGas = trackGasFromMeter(parseValue(gasMeterEntity.state))
      gasDailyUsage = trackedGas.daily
      gasMonthlyUsage = trackedGas.monthly
    }

    if (serverMetrics?.dailyGasM3 !== null && serverMetrics?.dailyGasM3 !== undefined) {
      gasDailyUsage = serverMetrics.dailyGasM3
    }
    if (serverMetrics?.monthlyGasM3 !== null && serverMetrics?.monthlyGasM3 !== undefined) {
      gasMonthlyUsage = serverMetrics.monthlyGasM3
    }

    const gasChartValue = gasFlowEntity
      ? parseValue(gasFlowEntity.state)
      : gasDailyUsage

    // Calculate energy costs using pricing config.
    // Dynamic mode uses live ENTSOE base price with supplier margin added on top.
    const configuredConsumerBase = pricingConfig?.consumerPrice || 0.30
    const consumerBaseRate = pricingConfig?.type === 'dynamic'
      ? (dynamicConsumerPriceKwh ?? configuredConsumerBase)
      : configuredConsumerBase
    const consumerRate = consumerBaseRate + (pricingConfig?.consumerMargin || 0)
    const configuredProducerBase = pricingConfig?.producerPrice || 0.10
    const producerBaseRate = pricingConfig?.type === 'dynamic'
      ? (dynamicConsumerPriceKwh ?? configuredProducerBase)
      : configuredProducerBase
    const producerRate = Math.max(0, producerBaseRate - (pricingConfig?.producerMargin || 0))
    const electricityCostToday = dailyUsage * consumerRate
    const electricityCostMonth = monthlyUsage * consumerRate
    const electricityRevenueToday = dailyProduction * producerRate
    const electricityRevenueMonth = monthlyProduction * producerRate
    const netDailyUsage = dailyUsage - dailyProduction
    const netMonthlyUsage = monthlyUsage - monthlyProduction
    const netElectricityCostToday = electricityCostToday - electricityRevenueToday
    const netElectricityCostMonth = electricityCostMonth - electricityRevenueMonth
    const gasCostToday = gasDailyUsage * gasRatePerM3
    const gasCostMonth = gasMonthlyUsage * gasRatePerM3
    const totalCostToday = electricityCostToday + gasCostToday - electricityRevenueToday
    const totalCostMonth = electricityCostMonth + gasCostMonth - electricityRevenueMonth

    return {
      currentPower: parseFloat(currentPower.toFixed(2)),
      currentProduction: parseFloat(currentProduction.toFixed(2)),
      dailyUsage: parseFloat(dailyUsage.toFixed(2)),
      monthlyUsage: parseFloat(monthlyUsage.toFixed(2)),
      dailyProduction: parseFloat(dailyProduction.toFixed(2)),
      monthlyProduction: parseFloat(monthlyProduction.toFixed(2)),
      netDailyUsage: parseFloat(netDailyUsage.toFixed(2)),
      netMonthlyUsage: parseFloat(netMonthlyUsage.toFixed(2)),
      gasDailyUsage: parseFloat(gasDailyUsage.toFixed(2)),
      gasMonthlyUsage: parseFloat(gasMonthlyUsage.toFixed(2)),
      gasChartValue: parseFloat(gasChartValue.toFixed(3)),
      electricityCostToday: parseFloat(electricityCostToday.toFixed(2)),
      electricityCostMonth: parseFloat(electricityCostMonth.toFixed(2)),
      electricityRevenueToday: parseFloat(electricityRevenueToday.toFixed(2)),
      electricityRevenueMonth: parseFloat(electricityRevenueMonth.toFixed(2)),
      netElectricityCostToday: parseFloat(netElectricityCostToday.toFixed(2)),
      netElectricityCostMonth: parseFloat(netElectricityCostMonth.toFixed(2)),
      gasCostToday: parseFloat(gasCostToday.toFixed(2)),
      gasCostMonth: parseFloat(gasCostMonth.toFixed(2)),
      costToday: parseFloat(totalCostToday.toFixed(2)),
      costMonth: parseFloat(totalCostMonth.toFixed(2)),
    }
  }, [
    haEntities,
    lastKnownHaEntities,
    haMetricsSnapshot,
    pricingConfig,
    dynamicConsumerPriceKwh,
    dynamicGasPricePerM3,
    selectedEnvironment,
    gasRatePerM3,
    powerSamples,
    productionSamples,
  ])

  const powerHistoryScope = useMemo(() => {
    const source = haMetricsSnapshot?.powerEntityId || 'fallback'
    return String(source).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120)
  }, [haMetricsSnapshot?.powerEntityId])

  const productionHistoryScope = useMemo(() => {
    const source = haMetricsSnapshot?.sources?.currentProductionEntityId || 'fallback'
    return String(source).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120)
  }, [haMetricsSnapshot?.sources?.currentProductionEntityId])

  const livePowerStorageKey = `energy_live_power_samples_v3_${environmentScope}_${powerHistoryScope}`
  const liveProductionStorageKey = `energy_live_production_samples_v2_${environmentScope}_${productionHistoryScope}`
  const liveGasStorageKey = `energy_gas_hourly_data_${environmentScope}`
  const historyArchiveStorageKey = `energy_history_archive_hourly_v2_${environmentScope}`
  const legacyHistoryArchiveStorageKeys = useMemo(
    () => [
      `energy_history_archive_hourly_v1_${environmentScope}_${powerHistoryScope}_${productionHistoryScope}`,
      `energy_history_archive_hourly_v1_${environmentScope}_fallback_fallback`,
    ],
    [environmentScope, powerHistoryScope, productionHistoryScope],
  )
  const environmentInstalledOnStorageKey = `energy_environment_installed_on_v3_${environmentScope}`
  const latestPowerRef = useRef(realTimeData.currentPower)
  const latestProductionRef = useRef(realTimeData.currentProduction)
  const haEntitiesRef = useRef(haEntities)
  const haMetricsSnapshotRef = useRef(haMetricsSnapshot)

  useEffect(() => {
    latestPowerRef.current = realTimeData.currentPower
  }, [realTimeData.currentPower])

  useEffect(() => {
    latestProductionRef.current = realTimeData.currentProduction
  }, [realTimeData.currentProduction])

  useEffect(() => {
    haEntitiesRef.current = haEntities
  }, [haEntities])

  useEffect(() => {
    haMetricsSnapshotRef.current = haMetricsSnapshot
  }, [haMetricsSnapshot])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(livePowerStorageKey)
      if (!stored) {
        // Keep current in-memory samples while new key is still warming up.
        return
      }

      const parsed = JSON.parse(stored)
      const cleaned = sanitizePowerSampleArray(parsed).slice(-MAX_LIVE_SAMPLE_POINTS)
      setPowerSamples(cleaned)
    } catch {
      // Keep existing samples on parse errors.
    }
  }, [livePowerStorageKey])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(liveProductionStorageKey)
      if (!stored) {
        // Keep current in-memory samples while new key is still warming up.
        return
      }

      const parsed = JSON.parse(stored)
      const cleaned = sanitizePowerSampleArray(parsed).slice(-MAX_LIVE_SAMPLE_POINTS)
      setProductionSamples(cleaned)
    } catch {
      // Keep existing samples on parse errors.
    }
  }, [liveProductionStorageKey])

  useEffect(() => {
    try {
      const keysToLoad = [historyArchiveStorageKey, ...legacyHistoryArchiveStorageKeys]
      let mergedPowerSamples: PowerSample[] = []
      let mergedProductionSamples: PowerSample[] = []
      let latestFetchTime = 0
      let hasSamples = false

      keysToLoad.forEach((storageKey) => {
        if (!storageKey) {
          return
        }

        const stored = localStorage.getItem(storageKey)
        if (!stored) {
          return
        }

        const parsed = JSON.parse(stored) as Partial<HistoryArchivePayload>
        const power = sanitizePowerSampleArray(parsed?.powerSamples)
        const production = sanitizePowerSampleArray(parsed?.productionSamples)

        if (power.length === 0 && production.length === 0) {
          return
        }

        hasSamples = true
        mergedPowerSamples = mergePowerSamples(
          [mergedPowerSamples, power],
          { resolutionMs: 60 * 60_000, maxPoints: MAX_ARCHIVE_HOURLY_POINTS },
        )
        mergedProductionSamples = mergePowerSamples(
          [mergedProductionSamples, production],
          { resolutionMs: 60 * 60_000, maxPoints: MAX_ARCHIVE_HOURLY_POINTS },
        )

        const fetchTime = Number(parsed?.fetchTime)
        if (Number.isFinite(fetchTime) && fetchTime > latestFetchTime) {
          latestFetchTime = fetchTime
        }
      })

      if (!hasSamples) {
        setArchivedPowerSamples([])
        setArchivedProductionSamples([])
        return
      }

      setArchivedPowerSamples(mergedPowerSamples)
      setArchivedProductionSamples(mergedProductionSamples)

      storeLocalJson(historyArchiveStorageKey, {
        fetchTime: latestFetchTime > 0 ? latestFetchTime : Date.now(),
        powerSamples: mergedPowerSamples,
        productionSamples: mergedProductionSamples,
      })
    } catch {
      setArchivedPowerSamples([])
      setArchivedProductionSamples([])
    }
  }, [historyArchiveStorageKey, legacyHistoryArchiveStorageKeys])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(environmentInstalledOnStorageKey)
      if (!stored) {
        setEnvironmentInstalledOnMs(null)
        return
      }

      const parsed = Number(stored)
      setEnvironmentInstalledOnMs(Number.isFinite(parsed) && parsed > 0 ? parsed : null)
    } catch {
      setEnvironmentInstalledOnMs(null)
    }
  }, [environmentInstalledOnStorageKey])

  useEffect(() => {
    if (!stableSelectedEnvironment || stableSelectedEnvironment !== selectedEnvironment || !isAuthenticated) {
      return
    }

    let isDisposed = false

    const refreshInstalledOnFromHistory = async () => {
      try {
        const metricSources = haMetricsSnapshotRef.current?.sources
        const prioritizedIds: string[] = []
        const seenIds = new Set<string>()

        const pushEntityId = (entityId: string | null | undefined) => {
          if (!entityId || typeof entityId !== 'string') {
            return
          }

          const normalized = entityId.trim()
          if (!normalized || seenIds.has(normalized)) {
            return
          }

          seenIds.add(normalized)
          prioritizedIds.push(normalized)
        }

        pushEntityId(metricSources?.electricityTotalEntityId)
        pushEntityId(metricSources?.electricityProductionTotalEntityId)
        pushEntityId(metricSources?.gasEntityId || metricSources?.gasTotalEntityId)
        pushEntityId(metricSources?.dailyElectricityEntityId)
        pushEntityId(metricSources?.monthlyElectricityEntityId)
        pushEntityId(metricSources?.dailyProductionEntityId)
        pushEntityId(metricSources?.monthlyProductionEntityId)
        pushEntityId(metricSources?.dailyGasEntityId)
        pushEntityId(metricSources?.monthlyGasEntityId)
        pushEntityId(metricSources?.currentPowerEntityId)
        pushEntityId(metricSources?.currentProductionEntityId)

        const entities = haEntitiesRef.current
        entities.forEach((entity) => {
          if (entity.domain !== 'sensor') {
            return
          }

          const entityId = String(entity.entity_id || '')
          const searchable = `${entityId} ${entity.friendly_name || ''}`.toLowerCase()
          if (!entityId || searchable.includes('price') || searchable.includes('cost')) {
            return
          }

          const unit = String(entity.unit_of_measurement || '').trim().toLowerCase()
          const stateClass = String(entity.state_class || '').toLowerCase()
          const deviceClass = String(entity.device_class || '').toLowerCase()

          const hasEnergyUnit = unit === 'wh' || unit === 'kwh' || unit === 'mwh'
          const hasGasUnit = unit.includes('m3') || unit.includes('m³') || unit === 'l' || unit === 'liter'
          const isCumulative = stateClass === 'total_increasing' || stateClass === 'total'
          const hasRelevantKeyword = (
            searchable.includes('electricity') ||
            searchable.includes('energy') ||
            searchable.includes('consumption') ||
            searchable.includes('production') ||
            searchable.includes('gas') ||
            searchable.includes('meter') ||
            searchable.includes('opwek') ||
            searchable.includes('teruglever') ||
            searchable.includes('solar') ||
            searchable.includes('pv')
          )

          if (hasRelevantKeyword && (hasEnergyUnit || hasGasUnit || isCumulative || deviceClass === 'energy' || deviceClass === 'gas')) {
            pushEntityId(entityId)
          }
        })

        if (prioritizedIds.length === 0) {
          return
        }

        const token = await getAuthToken()
        if (isDisposed) {
          return
        }

        const now = Date.now()
        const startTimeIso = new Date(now - ARCHIVE_LOOKBACK_DAYS * 24 * 60 * 60_000).toISOString()
        const endTimeIso = new Date(now).toISOString()
        const selectedIds = prioritizedIds.slice(0, 8)

        const url = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(startTimeIso)}&endTime=${encodeURIComponent(endTimeIso)}&entityIds=${encodeURIComponent(selectedIds.join(','))}&mode=history&resolution=hourly`
        const response = await deduplicatedAuthFetch(url, token)

        if (!response.ok || isDisposed) {
          return
        }

        const payload = await response.json()
        if (isDisposed) {
          return
        }

        const earliestCandidates = (Array.isArray(payload?.entities) ? payload.entities : [])
          .flatMap((entry: any) => (Array.isArray(entry?.history) ? entry.history : []))
          .map((row: any) => Number(row?.timestamp))
          .filter((value: number) => Number.isFinite(value) && value > 0)

        if (earliestCandidates.length === 0) {
          return
        }

        const detectedInstalledOnMs = Math.min(...earliestCandidates)
        setEnvironmentInstalledOnMs((previous) => {
          const mergedWithPrevious = previous === null
            ? detectedInstalledOnMs
            : Math.min(previous, detectedInstalledOnMs)

          try {
            const persistedInstalledOnMs = Number(localStorage.getItem(environmentInstalledOnStorageKey))
            const canonicalInstalledOnMs = Number.isFinite(persistedInstalledOnMs) && persistedInstalledOnMs > 0
              ? Math.min(persistedInstalledOnMs, mergedWithPrevious)
              : mergedWithPrevious
            storeLocalValue(environmentInstalledOnStorageKey, String(canonicalInstalledOnMs))
            return canonicalInstalledOnMs
          } catch {
            return mergedWithPrevious
          }
        })
      } catch (error) {
        console.warn('[Installed On] Failed to refresh from HA history:', error)
      }
    }

    void refreshInstalledOnFromHistory()
    return () => {
      isDisposed = true
    }
  }, [
    selectedEnvironment,
    isAuthenticated,
    getAuthToken,
    environmentInstalledOnStorageKey,
    haEntities.length,
    haMetricsSnapshot?.sources?.electricityTotalEntityId,
    haMetricsSnapshot?.sources?.electricityProductionTotalEntityId,
    haMetricsSnapshot?.sources?.gasTotalEntityId,
    haMetricsSnapshot?.sources?.dailyElectricityEntityId,
    haMetricsSnapshot?.sources?.monthlyElectricityEntityId,
    haMetricsSnapshot?.sources?.dailyProductionEntityId,
    haMetricsSnapshot?.sources?.monthlyProductionEntityId,
    haMetricsSnapshot?.sources?.dailyGasEntityId,
    haMetricsSnapshot?.sources?.monthlyGasEntityId,
    haMetricsSnapshot?.sources?.currentPowerEntityId,
    haMetricsSnapshot?.sources?.currentProductionEntityId,
    entitiesLoaded,
    isEnvironmentOffline,
  ])

  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated || !entitiesLoaded || isEnvironmentOffline) {
      return
    }

    let cancelled = false

    const warmupParallel = async () => {
      try {
        const token = await getAuthToken()
        if (cancelled) return

        const bounds = getBoundsFromInputDates(selectedStartDate, selectedEndDate)
        const startIso = new Date(Math.max(0, bounds.startMs - 60 * 60_000)).toISOString()
        const endIso = new Date(Math.min(bounds.endMs, Date.now())).toISOString()
        const preferredPowerEntityId = haMetricsSnapshotRef.current?.powerEntityId
        const historyResolution = getHistoryResolution(timeRange)

        const historyUrl = preferredPowerEntityId
          ? `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(startIso)}&endTime=${encodeURIComponent(endIso)}&entityIds=${encodeURIComponent(preferredPowerEntityId)}&resolution=${encodeURIComponent(historyResolution)}`
          : null

        const gasEntityId = haMetricsSnapshotRef.current?.sources?.gasEntityId || haMetricsSnapshotRef.current?.sources?.gasTotalEntityId
        const gasHoursBack = Math.max(200, Math.ceil((Date.now() - bounds.startMs) / 3_600_000) + 24)
        const gasUrl = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&hoursBack=${gasHoursBack}${gasEntityId ? `&entityId=${encodeURIComponent(gasEntityId)}` : ''}`

        const pricingUrl = `/.netlify/functions/get-energy-pricing?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}`

        const sources = haMetricsSnapshotRef.current?.sources
        const usageEntityIds = [
          ...(sources?.consumptionEntityIds ?? []),
          ...(sources?.exportEntityIds ?? []),
        ]
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
          .filter((id, index, all) => all.indexOf(id) === index)
          .join(',')
        const usagePeriod = timeRange === 'month' ? 'day' : 'hour'
        const usageUrl = usageEntityIds
          ? `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(new Date(bounds.startMs).toISOString())}&endTime=${encodeURIComponent(new Date(Math.min(bounds.endMs, Date.now())).toISOString())}&entityIds=${encodeURIComponent(usageEntityIds)}&mode=statistics&period=${usagePeriod}&resolution=${encodeURIComponent(historyResolution)}&tzOffset=${new Date().getTimezoneOffset() * -1}`
          : null

        const tasks: Promise<Response>[] = [
          deduplicatedAuthFetch(pricingUrl, token),
          deduplicatedAuthFetch(gasUrl, token),
        ]

        if (historyUrl) tasks.push(deduplicatedAuthFetch(historyUrl, token))
        if (usageUrl) tasks.push(deduplicatedAuthFetch(usageUrl, token))

        await Promise.all(tasks.map((task) => task.catch(() => null)))
      } catch {
        // Ignore warmup failures.
      }
    }

    void warmupParallel()
    return () => {
      cancelled = true
    }
  }, [entitiesLoaded, getAuthToken, isAuthenticated, isEnvironmentOffline, selectedEndDate, selectedEnvironment, selectedStartDate, stableSelectedEnvironmentRequestId, timeRange])

  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated || !entitiesLoaded || isEnvironmentOffline) {
      return
    }

    const nextRange = timeRange === 'today' ? 'week' : timeRange === 'week' ? 'month' : null
    if (!nextRange) {
      return
    }

    const cancelIdle = runOnIdle(() => {
      void (async () => {
        try {
          const preferredPowerEntityId = haMetricsSnapshotRef.current?.powerEntityId
          if (!preferredPowerEntityId) {
            return
          }

          const now = new Date()
          const endDate = formatDateForInput(now)
          const startDate = (() => {
            if (nextRange === 'week') {
              const dayOfWeek = now.getDay()
              const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
              const monday = new Date(now)
              monday.setDate(now.getDate() - diffToMonday)
              return formatDateForInput(monday)
            }
            const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
            return formatDateForInput(firstOfMonth)
          })()

          const bounds = getBoundsFromInputDates(startDate, endDate)
          const startMs = bounds.startMs
          const endMs = Math.min(bounds.endMs, Date.now())
          const resolution = getHistoryResolution(nextRange)

          const cacheKey = makeDashboardCacheKey([
            'history',
            environmentScope,
            startMs,
            endMs,
            resolution,
            preferredPowerEntityId,
          ])

          if (getDashboardResponseCache(cacheKey)) {
            return
          }

          const token = await getAuthToken()
          const startIso = new Date(startMs - 60 * 60_000).toISOString()
          const endIso = new Date(endMs).toISOString()
          const url = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(startIso)}&endTime=${encodeURIComponent(endIso)}&entityIds=${encodeURIComponent(preferredPowerEntityId)}&resolution=${encodeURIComponent(resolution)}`
          const response = await deduplicatedAuthFetch(url, token)
          if (!response.ok) {
            return
          }

          const result = await response.json()
          const historyData = Array.isArray(result?.entities) ? result.entities : []
          const raw = historyData[0]?.history || []
          const parsed = raw
            .map((state: any) => ({
              timestamp: Number(state?.timestamp),
              power: Number(state?.value),
            }))
            .filter((sample: PowerSample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.power))
          const downsampled = downsampleLTTB(parsed, getLttbTarget(nextRange))
          setDashboardResponseCache(cacheKey, {
            powerSamples: downsampled,
            productionSamples: [],
          }, nextRange === 'week' ? 15 * 60_000 : 30 * 60_000)
        } catch {
          // Ignore prefetch failures.
        }
      })()
    })

    return () => {
      cancelIdle()
    }
  }, [entitiesLoaded, environmentScope, getAuthToken, isAuthenticated, isEnvironmentOffline, selectedEnvironment, stableSelectedEnvironmentRequestId, timeRange])

  // Load stored gas data from localStorage immediately (before async fetch)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(liveGasStorageKey)
      if (!stored) {
        setGasMeterReadings([])
        return
      }

      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) {
        setGasMeterReadings([])
        return
      }

      const cleaned = parsed
        .filter((r: { timestamp?: number; value?: number }) =>
          typeof r?.timestamp === 'number' && typeof r?.value === 'number' &&
          Number.isFinite(r.timestamp) && Number.isFinite(r.value))
        .sort((a: { timestamp: number }, b: { timestamp: number }) => a.timestamp - b.timestamp)
      setGasMeterReadings(cleaned)
    } catch {
      setGasMeterReadings([])
    }
  }, [liveGasStorageKey])

  // Fetch hourly gas consumption
  useEffect(() => {
    if (!stableSelectedEnvironment || stableSelectedEnvironment !== selectedEnvironment || !isAuthenticated) {
      return
    }
    if (!entitiesLoaded || isEnvironmentOffline) {
      return
    }

    const fetchGasHourly = async () => {
      try {
        const token = await getAuthToken()
        // Read entity ID from reactive state (not ref) so it's available when the dependency triggers this effect
        const gasEntityId =
          haMetricsSnapshot?.sources?.gasEntityId ||
          haMetricsSnapshot?.sources?.gasTotalEntityId ||
          haMetricsSnapshotRef.current?.sources?.gasEntityId ||
          haMetricsSnapshotRef.current?.sources?.gasTotalEntityId
        // Compute hoursBack to cover the full selected date range (week/month)
        const gasBounds = getBoundsFromInputDates(selectedStartDate, selectedEndDate)
        // For month view, expand start to installation date so gas chart matches electricity range
        const gasStartMs = timeRange === 'month' && environmentInstalledOnMs
          ? Math.min(gasBounds.startMs, environmentInstalledOnMs)
          : gasBounds.startMs
        const hoursBack = Math.max(200, Math.ceil((Date.now() - gasStartMs) / 3_600_000) + 24)
        const isTodayRange = selectedStartDate === selectedEndDate && selectedEndDate === formatDateForInput(new Date())
        const gasTtlMs = timeRange === 'today'
          ? (isTodayRange ? 2 * 60_000 : 60 * 60_000)
          : timeRange === 'week'
            ? 15 * 60_000
            : 30 * 60_000
        const runtimeGasCacheKey = makeDashboardCacheKey([
          'gas-hourly',
          environmentScope,
          gasEntityId || 'default',
          hoursBack,
          timeRange,
          selectedStartDate,
          selectedEndDate,
        ])

        const fetchKey = `${stableSelectedEnvironmentRequestId}::${hoursBack}::${gasEntityId || 'default'}::${timeRange}::${selectedStartDate}::${selectedEndDate}`
        if (fetchKey === lastGasFetchKeyRef.current) {
          return
        }
        lastGasFetchKeyRef.current = fetchKey

        const runtimeGasHit = getDashboardResponseCache<Array<{ timestamp: number; value: number }>>(runtimeGasCacheKey)
        if (runtimeGasHit && runtimeGasHit.length > 0) {
          setGasMeterReadings(runtimeGasHit)
        }

        const url = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&hoursBack=${hoursBack}${gasEntityId ? `&entityId=${encodeURIComponent(gasEntityId)}` : ''}`
        console.log('[Gas Hourly DEBUG] === fetchGasHourly START ===')
        console.log('[Gas Hourly DEBUG] gasEntityId:', gasEntityId || '(default → sensor.gas_meter_gas_consumption)')
        console.log('[Gas Hourly DEBUG] haMetricsSnapshot?.sources?.gasTotalEntityId:', haMetricsSnapshot?.sources?.gasTotalEntityId)
        console.log('[Gas Hourly DEBUG] haMetricsSnapshotRef.current?.sources?.gasTotalEntityId:', haMetricsSnapshotRef.current?.sources?.gasTotalEntityId)
        console.log('[Gas Hourly DEBUG] selectedStartDate:', selectedStartDate, 'selectedEndDate:', selectedEndDate)
        console.log('[Gas Hourly DEBUG] hoursBack:', hoursBack, 'gasBounds.startMs:', new Date(gasBounds.startMs).toISOString())
        console.log('[Gas Hourly DEBUG] Full URL:', url)
        
        const response = await deduplicatedAuthFetch(url, token)

        if (!response.ok) {
          lastGasFetchKeyRef.current = ''
          if (response.status === 502) {
            console.warn(`[HA] Environment ${selectedEnvironmentRequestId} is unreachable`)
            setIsEnvironmentOffline(true)
            setOfflineLastSeenAt(Date.now())
          } else {
            console.error('[Gas Hourly] Fetch failed:', response.status)
          }
          return
        }

        const data = await response.json()
        console.log('[Gas Hourly DEBUG] Response entity_id:', data.entity_id)
        console.log('[Gas Hourly DEBUG] hourly array length:', data.hourly?.length)
        console.log('[Gas Hourly DEBUG] totalReadings:', data.totalReadings)
        console.log('[Gas Hourly DEBUG] timeRange:', JSON.stringify(data.timeRange))
        if (data.message) console.log('[Gas Hourly DEBUG] message:', data.message)
        if (Array.isArray(data.hourly) && data.hourly.length > 0) {
          const nonZero = data.hourly.filter((h: any) => h.delta > 0)
          console.log('[Gas Hourly DEBUG] Non-zero hourly deltas:', nonZero.length, 'total delta:', nonZero.reduce((s: number, h: any) => s + h.delta, 0).toFixed(3))
          console.log('[Gas Hourly DEBUG] First hourly:', JSON.stringify(data.hourly[0]))
          console.log('[Gas Hourly DEBUG] Last hourly:', JSON.stringify(data.hourly[data.hourly.length - 1]))
        }
        console.log('[Gas Hourly] Got', data.hourly?.length, 'hourly readings')

        // Convert hourly deltas to meter readings (cumulative)
        if (Array.isArray(data.hourly) && data.hourly.length > 0) {
          const readings = []
          let cumulativeValue = 0

          for (const hour of data.hourly) {
            const timestamp = new Date(hour.hour).getTime()
            cumulativeValue += hour.delta
            readings.push({ timestamp, value: cumulativeValue })
          }

          setGasMeterReadings(readings)
          setDashboardResponseCache(runtimeGasCacheKey, readings, gasTtlMs)
          console.log('[Gas Hourly DEBUG] Set gasMeterReadings:', readings.length, 'cumulative readings')
          console.log('[Gas Hourly DEBUG] First reading:', JSON.stringify(readings[0]), 'Last reading:', JSON.stringify(readings[readings.length - 1]))
          // Cache in localStorage for instant display on next load
          storeLocalJson(liveGasStorageKey, readings)
        } else {
          console.log('[Gas Hourly] No hourly data')
          setGasMeterReadings([])
        }
      } catch (error) {
        lastGasFetchKeyRef.current = ''
        console.error('[Gas Hourly] Error:', error)
      }
    }

    fetchGasHourly()
    const interval = window.setInterval(fetchGasHourly, 5 * 60 * 1000) // Refresh every 5 min
    return () => window.clearInterval(interval)
  }, [environmentInstalledOnMs, entitiesLoaded, getAuthToken, haMetricsSnapshot?.sources?.gasEntityId, haMetricsSnapshot?.sources?.gasTotalEntityId, isAuthenticated, isEnvironmentOffline, liveGasStorageKey, selectedEndDate, selectedEnvironment, selectedStartDate, stableSelectedEnvironment, stableSelectedEnvironmentRequestId, timeRange])

  // Pre-warm cache for week and month ranges so switching is instant
  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated || haEntities.length === 0) {
      return
    }
    if (!entitiesLoaded || isEnvironmentOffline) {
      return
    }

    let isDisposed = false

    const prefetchRange = async (startMs: number, endMs: number) => {
      const now = Date.now()
      const clampedEnd = Math.min(endMs, now)
      if (clampedEnd <= startMs) return

      // Warm the same cache key that fetchHistoricalData reads (history mode, 15-min buckets, 5-min TTL)
      const cacheStartKey = Math.floor(startMs / (15 * 60_000))
      const cacheEndKey = Math.floor(clampedEnd / (15 * 60_000))
      const cacheKey = `ha_history_v5_${environmentScope}_${cacheStartKey}_${cacheEndKey}`

      try {
        const cached = localStorage.getItem(cacheKey)
        if (cached) {
          const parsed = JSON.parse(cached)
          // Already fresh enough — skip (5-min TTL)
          if (parsed?.fetchTime && (now - parsed.fetchTime) < 5 * 60_000) return
        }
      } catch { /* ignore */ }

      const currentEntities = haEntitiesRef.current
      if (currentEntities.length === 0) return

      const preferredPowerEntityId = haMetricsSnapshotRef.current?.powerEntityId || null
      const powerEntity = preferredPowerEntityId
        ? currentEntities.find((e) => e.entity_id === preferredPowerEntityId)
        : currentEntities.find((e) => {
            const id = e.entity_id.toLowerCase()
            return !id.startsWith('binary_sensor') && (
              id.includes('electricity_meter_power_consumption') ||
              (id.includes('electricity_meter') && id.includes('power')) ||
              id.includes('current_power')
            )
          })

      if (!powerEntity) return

      const productionEntityId = haMetricsSnapshotRef.current?.sources?.currentProductionEntityId || null
      const entityIds = Array.from(new Set([
        powerEntity.entity_id,
        productionEntityId,
      ].filter((id): id is string => typeof id === 'string' && id.length > 0)))

      try {
        const token = await getAuthToken()
        if (isDisposed) return

        // Use history mode (power/kW entities are not in HA long-term statistics)
        const spanMs = Math.max(0, clampedEnd - startMs)
        const inferredResolution = spanMs > 14 * 24 * 60 * 60_000 ? 'hourly' : '5min'
        const url = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(new Date(startMs).toISOString())}&endTime=${encodeURIComponent(new Date(clampedEnd).toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}&resolution=${encodeURIComponent(inferredResolution)}`
        const response = await deduplicatedAuthFetch(url, token)
        if (!response.ok || isDisposed) return

        const result = await response.json()
        if (isDisposed) return

        const historyData: any[] = Array.isArray(result?.entities) ? result.entities : []
        const powerData = historyData.find((e: any) => e.entity_id === powerEntity.entity_id)
        const prodData = historyData.find((e: any) => e.entity_id === productionEntityId)

        const toSamples = (history: any[], unit?: string): PowerSample[] =>
          (Array.isArray(history) ? history : [])
            .map((s) => {
              const ts = Number(s?.timestamp)
              const raw = Number(s?.value)
              if (!Number.isFinite(ts) || !Number.isFinite(raw)) return null
              const u = String(unit || '').trim().toLowerCase()
              const kw = (u === 'w' || u === 'watt' || u === 'va') ? raw / 1000 : raw
              return { timestamp: ts, power: kw }
            })
            .filter((s): s is PowerSample => s !== null)

        const powerSamples = toSamples(powerData?.history, powerEntity.unit_of_measurement)
        const productionSamples = toSamples(prodData?.history)

        if (powerSamples.length > 0) {
          storeLocalJson(cacheKey, { fetchTime: Date.now(), powerSamples, productionSamples })
          console.log('[Prefetch] Cached', powerSamples.length, 'samples for range', new Date(startMs).toLocaleDateString())
        }
      } catch { /* ignore prefetch errors */ }
    }

    // Prefetch in background — fire sooner so week/month is ready by the time user clicks
    const now = Date.now()
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 6); weekStart.setHours(0, 0, 0, 0)
    const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    const installedOnMs = environmentInstalledOnMs
    const monthStartMs = installedOnMs ? Math.min(monthStart.getTime(), installedOnMs) : monthStart.getTime()

    const t1 = window.setTimeout(() => { void prefetchRange(weekStart.getTime(), now) }, 2000)
    const t2 = window.setTimeout(() => { void prefetchRange(monthStartMs, now) }, 5000)

    return () => {
      isDisposed = true
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [selectedEnvironment, isAuthenticated, haEntities.length, environmentInstalledOnMs, getAuthToken, entitiesLoaded, isEnvironmentOffline, stableSelectedEnvironmentRequestId])

  // Clear stale bucket/statistic-ID caches when the selected environment changes
  const prevSelectedEnvironmentRef = useRef<string>('')
  useEffect(() => {
    const prev = prevSelectedEnvironmentRef.current
    if (prev && prev !== selectedEnvironment) {
      // Privacy: immediately clear all environment-specific in-memory state
      // so data from the previous environment is never visible during loading.
      setHaEntities([])
      setEntitiesLoaded(false)
      setIsEnvironmentOffline(false)
      setOfflineLastSeenAt(null)
      setLastKnownHaEntities([])
      setHaMetricsSnapshot(null)
      setPowerSamples([])
      setProductionSamples([])
      setHistoricalRangeSamples([])
      setHistoricalProductionRangeSamples([])
      setArchivedPowerSamples([])
      setArchivedProductionSamples([])
      setElectricityUsageBuckets([])
      setGasMeterReadings([])
      setHaError(null)
      setHaConnectionStatus('connecting')
      setIsInitialLoading(true)
      setEnvironmentInstalledOnMs(null)
      setPricingConfig(null)
      setDynamicPricePoints([])
      setDynamicPriceUpdatedAt(null)
      setDynamicConsumerPriceKwh(null)
      setDynamicGasPricePerM3(null)

      // Clear only localStorage keys belonging to the previous environment
      const keysToRemove = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
        (key): key is string =>
          key !== null && (
            key.startsWith(`ha_electricity_buckets_v3_${prev}_`) ||
            key.startsWith(`ha_electricity_buckets_v4_${prev}_`) ||
            key === `ha_statistic_ids_v1_${prev}`
          ),
      )
      keysToRemove.forEach((k) => localStorage.removeItem(k))
    }
    prevSelectedEnvironmentRef.current = selectedEnvironment
  }, [selectedEnvironment])

  // Derive a stable entity-ID key for the statistics effect.
  // This prevents re-fires when the snapshot object churns (null → cached → blob → ha-entities)
  // but the actual entity IDs to fetch haven't changed.
  const statisticsEntityIdsKey = useMemo(() => {
    const s = haMetricsSnapshot?.sources
    if (!s) return ''
    const consumption = [
      ...(s.consumptionEntityIds ?? []),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0)
    const production = [
      ...(s.exportEntityIds ?? []),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0)
    const all = [...new Set([...consumption, ...production])].sort()
    return all.join(',')
  }, [haMetricsSnapshot?.sources])

  // Fetch electricity usage statistics (kWh per hour/day) — matches HA "Electricity usage" bar chart
  useEffect(() => {
    if (!stableSelectedEnvironment || stableSelectedEnvironment !== selectedEnvironment || !isAuthenticated) {
      return
    }
    if (!entitiesLoaded || isEnvironmentOffline) {
      return
    }
    // Wait until we have usable entity IDs from the server snapshot.
    // An empty key means sources are absent or all null (e.g. blob fallback without sources).
    if (!statisticsEntityIdsKey) {
      return
    }

    let isDisposed = false

    const fetchUsageStatistics = async () => {
      const bounds = getBoundsFromInputDates(selectedStartDate, selectedEndDate)
      const now = Date.now()
      const clampedEnd = Math.min(bounds.endMs, now)

      // For month range, clamp start to installed-on date (use the LATER of month-start and install date)
      const startMs = timeRange === 'month' && environmentInstalledOnMs
        ? Math.min(bounds.startMs, environmentInstalledOnMs)
        : bounds.startMs

      console.log('[Usage Stats DEBUG] === fetchUsageStatistics START ===')
      console.log('[Usage Stats DEBUG] timeRange:', timeRange, 'selectedStartDate:', selectedStartDate, 'selectedEndDate:', selectedEndDate)
      console.log('[Usage Stats DEBUG] bounds:', { startMs: new Date(bounds.startMs).toISOString(), endMs: new Date(bounds.endMs).toISOString() })
      console.log('[Usage Stats DEBUG] clampedEnd:', new Date(clampedEnd).toISOString(), 'startMs:', new Date(startMs).toISOString())
      console.log('[Usage Stats DEBUG] environmentInstalledOnMs:', environmentInstalledOnMs ? new Date(environmentInstalledOnMs).toISOString() : 'null')
      console.log('[Usage Stats DEBUG] haMetricsSnapshot exists:', !!haMetricsSnapshot)
      console.log('[Usage Stats DEBUG] haMetricsSnapshotRef.current exists:', !!haMetricsSnapshotRef.current)
      console.log('[Usage Stats DEBUG] haMetricsSnapshotRef.current?.sources:', JSON.stringify(haMetricsSnapshotRef.current?.sources ?? null))

      if (environmentInstalledOnMs && startMs === environmentInstalledOnMs) {
        console.log('[Usage Stats] startMs:', new Date(startMs).toISOString(), '(from installedOn)')
      } else {
        console.log('[Usage Stats] startMs:', new Date(startMs).toISOString())
      }

      if (clampedEnd <= startMs) return

      // statistics period: hour for today/week, day for month
      const period = timeRange === 'month' ? 'day' : 'hour'
      const isTodayRange = selectedStartDate === selectedEndDate && selectedEndDate === formatDateForInput(new Date())
      const usageTtlMs = timeRange === 'today'
        ? (isTodayRange ? 2 * 60_000 : 60 * 60_000)
        : timeRange === 'week'
          ? 15 * 60_000
          : 30 * 60_000

      // --- Step A: get confirmed statistic IDs from HA ---
      // Priority 1: use electricityConsumptionEntityIds + electricityProductionEntityIds from sources
      // (set by ha-entities.js enrichMetricsWithHistoryFallback from stored detection in Fix A)
      const sources = haMetricsSnapshotRef.current?.sources
      const storedConsumptionIds: string[] = Array.from(new Set([
        ...(sources?.consumptionEntityIds ?? []),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0)))
      const storedProductionIds: string[] = Array.from(new Set([
        ...(sources?.exportEntityIds ?? []),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0)))

      // All entity IDs to fetch statistics for (consumption + production together)
      let entityIds: string[] = []
      // Track which IDs are production so we can build the net map
      let productionEntityIdsForFetch: string[] = []

      if (storedConsumptionIds.length > 0) {
        // Priority 1: use stored detection results
        entityIds = Array.from(new Set([...storedConsumptionIds, ...storedProductionIds]))
        productionEntityIdsForFetch = storedProductionIds
        console.log('[Usage Stats] Using stored consumption IDs:', storedConsumptionIds.join(', '))
        if (storedProductionIds.length > 0) {
          console.log('[Usage Stats] Using stored production IDs:', storedProductionIds.join(', '))
        }
      } else {
        // Priority 2: try get-ha-statistic-ids then fall back to detectEnergyEntities
        const statisticIdCacheKey = `ha_statistic_ids_v1_${environmentScope}`
        const statisticIdCacheTtlMs = 3600_000 // 1 hour

        try {
          const cachedIds = localStorage.getItem(statisticIdCacheKey)
          if (cachedIds) {
            const parsed = JSON.parse(cachedIds)
            if (
              parsed?.fetchTime &&
              now - parsed.fetchTime < statisticIdCacheTtlMs &&
              Array.isArray(parsed.ids) &&
              parsed.ids.length > 0
            ) {
              entityIds = parsed.ids
            }
          }
        } catch { /* ignore */ }

        if (entityIds.length === 0) {
          try {
            const token = await getAuthToken()
            if (isDisposed) return
            const idsResponse = await fetch(
              `/.netlify/functions/get-ha-statistic-ids?environmentId=${encodeURIComponent(selectedEnvironmentRequestId)}`,
              { headers: { Authorization: `Bearer ${token}` } },
            )
            if (!isDisposed && idsResponse.ok) {
              const idsResult = await idsResponse.json()
              if (Array.isArray(idsResult?.statistic_ids) && idsResult.statistic_ids.length > 0) {
                entityIds = idsResult.statistic_ids
                try {
                  storeLocalJson(statisticIdCacheKey, { fetchTime: Date.now(), ids: entityIds })
                } catch { /* ignore quota errors */ }
              }
            }
          } catch (err) {
            console.warn('[Usage Stats] get-ha-statistic-ids failed, falling back:', err)
          }
        }

        if (entityIds.length === 0) {
          entityIds = []
        }
      }

      if (entityIds.length === 0) {
        console.log('[Usage Stats DEBUG] No energy total entities found — RETURNING EARLY')
        console.log('[Usage Stats DEBUG] storedConsumptionIds was:', storedConsumptionIds)
        console.log('[Usage Stats DEBUG] haEntitiesRef.current.length:', haEntitiesRef.current.length)
        return
      }

      entityIds = Array.from(new Set(entityIds.filter((id): id is string => typeof id === 'string' && id.length > 0)))
      productionEntityIdsForFetch = Array.from(new Set(productionEntityIdsForFetch.filter((id): id is string => typeof id === 'string' && id.length > 0)))

      console.log('[Usage Stats] Using statistic IDs from HA:', entityIds.join(', '))

      // --- Step C: load persistent incremental cache ---
      // Cache key includes a hash of entity IDs so stale data is automatically discarded when sensors change
      const entityHash = [...entityIds].sort().join(',').split('').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)
      const runtimeUsageCacheKey = makeDashboardCacheKey([
        'usage',
        environmentScope,
        period,
        startMs,
        clampedEnd,
        entityHash,
      ])

      const runtimeUsageHit = getDashboardResponseCache<Array<{ timestamp: number; importKwh: number; exportKwh: number }>>(runtimeUsageCacheKey)
      if (runtimeUsageHit && runtimeUsageHit.length > 0) {
        setElectricityUsageBuckets(runtimeUsageHit)
      }

      let cachedBuckets: Array<{ timestamp: number; importKwh: number; exportKwh: number }> = []

      // Determine incremental fetch range
      let fetchStartMs = startMs
      if (cachedBuckets.length > 0) {
        const firstTs = cachedBuckets[0].timestamp
        const lastTs = cachedBuckets[cachedBuckets.length - 1].timestamp
        // Only use incremental fetch if the cache already covers the START of the range.
        // When switching from day→week, the cache only has today's data so firstTs >> startMs.
        // In that case we must do a full fetch for the entire week/month.
        const bucketSizeMs = period === 'day' ? 86_400_000 : 3_600_000
        if (firstTs <= startMs + bucketSizeMs) {
          const overlapMs = period === 'day' ? 26 * 3600_000 : 3 * 3600_000
          const incrementalStart = lastTs - overlapMs
          if (incrementalStart > startMs) {
            fetchStartMs = incrementalStart
          }
        }
      }

      setIsLoadingUsage(true)

      try {
        const token = await getAuthToken()
        if (isDisposed) return

        let url = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(new Date(fetchStartMs).toISOString())}&endTime=${encodeURIComponent(new Date(clampedEnd).toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}&mode=statistics&period=${period}&resolution=raw&tzOffset=${new Date().getTimezoneOffset() * -1}`

        if (productionEntityIdsForFetch.length > 0) {
          url += `&productionEntityIds=${encodeURIComponent(productionEntityIdsForFetch.join(','))}`
        }

        console.log('[Usage Stats DEBUG] Fetching energy-data URL:', url)
        console.log('[Usage Stats DEBUG] fetchStartMs:', new Date(fetchStartMs).toISOString(), 'clampedEnd:', new Date(clampedEnd).toISOString())

        // Use AbortController with timeout to prevent hanging forever
        const controller = new AbortController()
        const timeoutId = setTimeout(() => {
          console.error('[Usage Stats DEBUG] \u26a0\ufe0f FETCH TIMED OUT after 30s')
          controller.abort()
        }, 30_000)

        let response: Response
        try {
          response = await deduplicatedAuthFetch(url, token)
        } catch (fetchErr) {
          clearTimeout(timeoutId)
          console.error('[Usage Stats DEBUG] \u274c Fetch threw:', fetchErr)
          if (!isDisposed) setIsLoadingUsage(false)
          return
        }
        clearTimeout(timeoutId)
        console.log('[Usage Stats DEBUG] Fetch completed, status:', response.status)
        if (!response.ok || isDisposed) {
          if (!isDisposed) {
            console.error('[Usage Stats] API returned', response.status, await response.text().catch(() => ''))
            setIsLoadingUsage(false)
          }
          return
        }

        const result = await response.json()
        if (isDisposed) return

        // Log debug info from statistics API
        if (result?._debug) {
          console.log('[Usage Stats] Debug:', JSON.stringify(result._debug, null, 2))
        }

        const historyData: Array<{ entity_id: string; is_production: boolean; history: Array<{ timestamp: number; change: number; value: number }> }> =
          Array.isArray(result?.entities) ? result.entities : []

        console.log('[Usage Stats DEBUG] Raw API result keys:', Object.keys(result ?? {}))
        console.log('[Usage Stats DEBUG] result.entities is array:', Array.isArray(result?.entities), 'length:', result?.entities?.length)
        console.log('[Usage Stats] Entities in response:', historyData.map(e => `${e.entity_id} (${e.history?.length || 0} rows, prod=${e.is_production})`).join(', ') || 'NONE')

        // Build separate consumption and production bucket maps, then compute net
        const consumptionMap = new Map<number, number>()
        const productionMap = new Map<number, number>()

        for (const entry of historyData) {
          if (!entityIds.includes(entry.entity_id)) continue
          for (const row of entry.history) {
            const ts = row.timestamp
            const delta = row.change
            if (!Number.isFinite(ts) || !Number.isFinite(delta) || delta < 0) continue
            if (entry.is_production) {
              productionMap.set(ts, (productionMap.get(ts) ?? 0) + delta)
            } else {
              consumptionMap.set(ts, (consumptionMap.get(ts) ?? 0) + delta)
            }
          }
        }

        // Electricity usage chart shows GROSS consumption (same as HA Energy dashboard).
        // Production (return to grid) is NOT subtracted — it's a separate concept.
        const allTimestamps = new Set<number>([
          ...consumptionMap.keys(),
          ...productionMap.keys(),
        ])
        const newBuckets = Array.from(allTimestamps.values())
          .sort((a, b) => a - b)
          .map((timestamp) => ({
            timestamp,
            importKwh: Number((consumptionMap.get(timestamp) ?? 0).toFixed(3)),
            exportKwh: Number((productionMap.get(timestamp) ?? 0).toFixed(3)),
          }))

        console.log('[Usage Stats DEBUG] consumptionMap size:', consumptionMap.size, 'productionMap size:', productionMap.size)
        console.log(
          '[Usage Stats DEBUG] newBuckets count:',
          newBuckets.length,
          'total import kWh:',
          newBuckets.reduce((s, b) => s + b.importKwh, 0).toFixed(3),
          'total export kWh:',
          newBuckets.reduce((s, b) => s + b.exportKwh, 0).toFixed(3),
        )
        if (newBuckets.length > 0) {
          console.log('[Usage Stats DEBUG] first bucket:', JSON.stringify(newBuckets[0]), 'last bucket:', JSON.stringify(newBuckets[newBuckets.length - 1]))
        }

        // Merge with strict overwrite: cached first, fetched buckets win on same timestamp.
        const mergedMap = new Map<number, { importKwh: number; exportKwh: number }>(
          cachedBuckets.map((bucket) => [
            bucket.timestamp,
            {
              importKwh: bucket.importKwh,
              exportKwh: bucket.exportKwh,
            },
          ]),
        )
        for (const b of newBuckets) {
          mergedMap.set(b.timestamp, {
            importKwh: b.importKwh,
            exportKwh: b.exportKwh,
          })
        }
        // Only keep buckets within the current range
        const mergedBuckets = Array.from(mergedMap.entries())
          .filter(([ts]) => ts >= startMs && ts <= clampedEnd)
          .sort((a, b) => a[0] - b[0])
          .map(([timestamp, values]) => ({
            timestamp,
            importKwh: values.importKwh,
            exportKwh: values.exportKwh,
          }))

        console.log('[Usage Stats DEBUG] mergedMap size (before filter):', mergedMap.size)
        console.log('[Usage Stats DEBUG] mergedBuckets count (after filter):', mergedBuckets.length)
        console.log('[Usage Stats DEBUG] filter range: startMs=', new Date(startMs).toISOString(), 'clampedEnd=', new Date(clampedEnd).toISOString())
        if (mergedMap.size > 0 && mergedBuckets.length === 0) {
          const allTs = Array.from(mergedMap.keys()).sort((a, b) => a - b)
          console.log('[Usage Stats DEBUG] ⚠️ ALL BUCKETS FILTERED OUT! Bucket timestamp range:', new Date(allTs[0]).toISOString(), '→', new Date(allTs[allTs.length - 1]).toISOString())
        }

        if (!isDisposed) setElectricityUsageBuckets(mergedBuckets)

        if (mergedBuckets.length > 0) {
          const firstDate = new Date(mergedBuckets[0].timestamp).toISOString().slice(0, 10)
          const lastDate = new Date(mergedBuckets[mergedBuckets.length - 1].timestamp).toISOString().slice(0, 10)
          console.log(`[Usage Stats] Fetched ${mergedBuckets.length} buckets, range: ${firstDate} → ${lastDate}`)
        }

        setDashboardResponseCache(runtimeUsageCacheKey, mergedBuckets, usageTtlMs)
        console.log(`[Usage Stats] Cached ${mergedBuckets.length} buckets in runtime cache`)
      } catch (err) {
        console.error('[Usage Stats] Error:', err)
      } finally {
        if (!isDisposed) setIsLoadingUsage(false)
      }
    }

    void fetchUsageStatistics()
    return () => { isDisposed = true }
  }, [
    selectedEnvironment,
    isAuthenticated,
    selectedStartDate,
    selectedEndDate,
    timeRange,
    environmentInstalledOnMs,
    getAuthToken,
    statisticsEntityIdsKey,
    entitiesLoaded,
    isEnvironmentOffline,
  ])

  // Fetch electricity history
  useEffect(() => {
    if (!stableSelectedEnvironment || stableSelectedEnvironment !== selectedEnvironment || !isAuthenticated) {
      return
    }
    if (!entitiesLoaded || isEnvironmentOffline) {
      return
    }

    let isDisposed = false

    const normalizeHistoryPowerToKw = (rawValue: number, unit?: string) => {
      if (!Number.isFinite(rawValue)) {
        return NaN
      }

      const normalizedUnit = String(unit || '').trim().toLowerCase()
      if (normalizedUnit === 'w' || normalizedUnit === 'watt' || normalizedUnit === 'watts' || normalizedUnit === 'va') {
        return rawValue / 1000
      }
      if (normalizedUnit === 'kw' || normalizedUnit === 'kilowatt' || normalizedUnit === 'kilowatts' || normalizedUnit === 'kva') {
        return rawValue
      }
      if (normalizedUnit === 'mw') {
        return rawValue * 1000
      }

      // Unknown unit: choose the scale that is closest to current live power.
      const livePower = latestPowerRef.current
      const asKw = rawValue
      const asWToKw = rawValue / 1000

      if (Number.isFinite(livePower) && livePower > 0) {
        const diffKw = Math.abs(asKw - livePower)
        const diffWToKw = Math.abs(asWToKw - livePower)
        return diffWToKw < diffKw ? asWToKw : asKw
      }

      return rawValue > 50 ? rawValue / 1000 : rawValue
    }

    const fetchHistoricalData = async () => {
      try {
        console.time('[PERF] Power Sources render')
        if (!perfPowerSourcesDataTimerStartedRef.current) {
          console.time('[PERF] Power Sources data')
          perfPowerSourcesDataTimerStartedRef.current = true
        }
        console.log('[HA History] Starting fetch for environment:', selectedEnvironment)

        const preferredPowerEntityId = haMetricsSnapshotRef.current?.powerEntityId || null
        const preferredProductionEntityId = haMetricsSnapshotRef.current?.sources?.currentProductionEntityId || null
        const bounds = getBoundsFromInputDates(selectedStartDate, selectedEndDate)
        const requestedStartMs = timeRange === 'month'
          ? Math.min(bounds.startMs, environmentInstalledOnMs ?? Number.POSITIVE_INFINITY)
          : bounds.startMs

        const now = Date.now()
        const clampedEndMs = Math.min(bounds.endMs, now)
        if (clampedEndMs <= requestedStartMs) {
          console.warn('[HA History] Skipping fetch because selected range ends in the future')
          return
        }

        // today = history mode (per-minute precision); week/month also uses history mode.
        // NOTE: statistics mode only works for energy (kWh/m³) entities — power (kW) entities are NOT in HA statistics.
        // Power sources chart always uses history mode. Electricity usage uses statistics separately.

        // Check localStorage cache first — avoid unnecessary network requests.
        // Round start/end to 15-minute buckets so switching between day/week/month
        // hits the same cache entry as long as the selected window hasn't changed.
        const cacheStartKey = Math.floor(requestedStartMs / (15 * 60_000))
        const cacheEndKey = Math.floor(clampedEndMs / (15 * 60_000))
        const cacheKey = `ha_history_v5_${environmentScope}_${cacheStartKey}_${cacheEndKey}`
        const resolution = getHistoryResolution(timeRange)
        const runtimeCacheKey = makeDashboardCacheKey([
          'history',
          environmentScope,
          requestedStartMs,
          clampedEndMs,
          resolution,
          haMetricsSnapshotRef.current?.powerEntityId || 'auto',
        ])
        // History data for power (kW) entities — cache for 5 min.
        const cacheTtlMs = 5 * 60_000
        let staleCachedSamples: PowerSample[] | null = null
        let staleCachedProductionSamples: PowerSample[] | null = null

        const runtimeHit = getDashboardResponseCache<{ powerSamples: PowerSample[]; productionSamples: PowerSample[] }>(runtimeCacheKey)
        if (runtimeHit?.powerSamples?.length) {
          setHistoricalRangeSamples(runtimeHit.powerSamples)
          setHistoricalProductionRangeSamples(runtimeHit.productionSamples || [])
          console.log('[HA History] Runtime cache hit:', runtimeHit.powerSamples.length, 'power samples')
          if (perfPowerSourcesDataTimerStartedRef.current) {
            console.timeEnd('[PERF] Power Sources data')
            perfPowerSourcesDataTimerStartedRef.current = false
          }
          console.timeEnd('[PERF] Power Sources render')
          return
        }
        try {
          const cached = localStorage.getItem(cacheKey)
          if (cached) {
            const parsed = JSON.parse(cached)
            if (parsed?.fetchTime) {
              const cachedPower = sanitizePowerSampleArray(parsed.powerSamples)
              const cachedProduction = sanitizePowerSampleArray(parsed.productionSamples)
              if ((now - parsed.fetchTime) < cacheTtlMs) {
                // Fresh cache — use immediately and skip network fetch
                console.log('[HA History] Loaded from cache:', cachedPower.length, 'power samples')
                setHistoricalRangeSamples(cachedPower)
                setHistoricalProductionRangeSamples(cachedProduction)
                if (perfPowerSourcesDataTimerStartedRef.current) {
                  console.timeEnd('[PERF] Power Sources data')
                  perfPowerSourcesDataTimerStartedRef.current = false
                }
                console.timeEnd('[PERF] Power Sources render')
                return
              }
              // Stale cache — show immediately while we re-fetch in background
              if (cachedPower.length > 0) {
                setHistoricalRangeSamples(cachedPower)
                setHistoricalProductionRangeSamples(cachedProduction)
                staleCachedSamples = cachedPower
                staleCachedProductionSamples = cachedProduction
              }
            }
          }
        } catch {
          // Ignore cache parse errors
        }

        const startTime = new Date(requestedStartMs - 60 * 60_000)
        const endTime = new Date(clampedEndMs)

        console.log('[HA History] Fetching selected range from', startTime.toISOString(), 'to', endTime.toISOString())

        // Find power entity - prefer server-selected metrics source for admin/non-admin parity.
        const currentHaEntities = haEntitiesRef.current
        const preferredPowerEntity = preferredPowerEntityId
          ? currentHaEntities.find((entity) => entity.entity_id === preferredPowerEntityId)
          : null
        const preferredProductionEntity = preferredProductionEntityId
          ? currentHaEntities.find((entity) => entity.entity_id === preferredProductionEntityId)
          : null

        // Auto-detect entities using HA's own classification as reliable fallback
        const detectedEntities = detectEnergyEntities(currentHaEntities)
        const detectedPowerEntity = detectedEntities.powerConsumptionEntityId
          ? currentHaEntities.find((e) => e.entity_id === detectedEntities.powerConsumptionEntityId)
          : undefined
        const detectedProductionEntity = detectedEntities.powerProductionEntityId
          ? currentHaEntities.find((e) => e.entity_id === detectedEntities.powerProductionEntityId)
          : undefined

        const powerEntity = preferredPowerEntity || detectedPowerEntity || currentHaEntities.find(
            (e) => {
              const id = e.entity_id.toLowerCase()
              // Prioritize electricity meter, exclude binary sensors
              return !id.startsWith('binary_sensor') && (
                id.includes('electricity_meter_power_consumption') ||
                id.includes('electricity_meter') && id.includes('power') ||
                id.includes('meter') && id.includes('power') && id.includes('consumption')
              )
            }
          ) || currentHaEntities.find(
            (e) => {
              const id = e.entity_id.toLowerCase()
              // Fallback to any power/watt sensor that's not binary
              return !id.startsWith('binary_sensor') && id.startsWith('sensor.') && (
                id.includes('current_power') ||
                (id.includes('power') && (id.includes('consumption') || id.includes('watt')))
              )
            }
          )

        // Only use production entity if explicitly detected by server or by detectEnergyEntities.
        // Do NOT do broad keyword fallback — it picks up grid export sensors in environments without solar.
        const productionEntity = preferredProductionEntity || detectedProductionEntity || null

        console.log('[HA History] Available entities:', currentHaEntities.map((e) => e.entity_id).join(', '))
        console.log('[HA History] Preferred power entity from metrics:', preferredPowerEntityId)
        console.log('[HA History] Preferred production entity from metrics:', preferredProductionEntityId)
        console.log('[HA History] Found power entity:', powerEntity?.entity_id)
        console.log('[HA History] Found production entity:', productionEntity?.entity_id)

        if (!powerEntity) {
          console.error('[HA History] No power entity found from', haEntities.length, 'entities')
          return
        }

        // Only use the primary power entity — extra entities cause doubled/spiked values.
        const entityIds = Array.from(new Set([
          powerEntity.entity_id,
          productionEntity?.entity_id || null,
        ].filter((entityId): entityId is string => typeof entityId === 'string' && entityId.length > 0)))

        console.log('[HA History] Fetching entities:', entityIds.join(', '))
        console.log('[HA History] From', startTime.toISOString(), 'to', endTime.toISOString())

        setIsLoadingHistory(true)
        const token = await getAuthToken()
        const url = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(startTime.toISOString())}&endTime=${encodeURIComponent(endTime.toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}&resolution=${encodeURIComponent(resolution)}`
        
        console.log('[HA History] Request URL:', url)

        const response = await deduplicatedAuthFetch(url, token)

        if (!response.ok) {
          const errorText = await response.text()
          console.error('[HA History] Failed to fetch:', response.status, errorText)
          if (!isDisposed) setIsLoadingHistory(false)
          return
        }

        const result = await response.json()
        if (isDisposed) {
          return
        }
        const historyData = result.entities || []

        const detectedInstalledOnMs = historyData
          .flatMap((entry: any) => Array.isArray(entry?.history) ? entry.history : [])
          .map((row: any) => Number(row?.timestamp))
          .filter((ts: number) => Number.isFinite(ts) && ts > 0)
          .reduce((min: number, ts: number) => (ts < min ? ts : min), Number.POSITIVE_INFINITY)

        if (Number.isFinite(detectedInstalledOnMs)) {
          setEnvironmentInstalledOnMs((prev) => {
            const next = Number.isFinite(prev) && (prev as number) > 0
              ? Math.min(prev as number, detectedInstalledOnMs)
              : detectedInstalledOnMs
            storeLocalValue(environmentInstalledOnStorageKey, String(next))
            return next
          })
        }

        console.log('[HA History] Retrieved data for', historyData.length, 'entities:', JSON.stringify(historyData.map((e: any) => ({ entity_id: e.entity_id, samples: e.history?.length || 0 }))))

        // Process power data (only the primary entity to avoid doubled/spiked values)
        const powerEntityIdSet = new Set([powerEntity.entity_id])
        let newPowerSamples: PowerSample[] = []
        const powerSeriesByEntity = historyData
          .filter((entry: any) => powerEntityIdSet.has(String(entry?.entity_id || '')))
          .map((entry: any) => {
            const matchedEntity = currentHaEntities.find((entity) => entity.entity_id === entry?.entity_id)
            const normalized = (Array.isArray(entry?.history) ? entry.history : [])
              .map((state: any) => {
                const timestamp = Number(state?.timestamp)
                const rawValue = Number(state?.value)
                const normalizedPower = normalizeHistoryPowerToKw(rawValue, matchedEntity?.unit_of_measurement)

                if (!Number.isFinite(timestamp) || !Number.isFinite(normalizedPower)) {
                  return null
                }

                return {
                  timestamp,
                  power: normalizedPower,
                }
              })
              .filter((sample: PowerSample | null): sample is PowerSample => sample !== null)

            return normalized
          })
          .filter((series: PowerSample[]) => series.length > 0)

        if (powerSeriesByEntity.length > 0) {
          newPowerSamples = mergePowerSamples(powerSeriesByEntity)

          newPowerSamples = downsampleLTTB(newPowerSamples, getLttbTarget(timeRange))

          // Store fetched range samples directly so they are always visible for the selected date regardless of live-samples trim
          setHistoricalRangeSamples(newPowerSamples)

          setPowerSamples((prev) => {
            const trimmed = mergePowerSamples([prev, newPowerSamples], { maxPoints: MAX_LIVE_SAMPLE_POINTS })
            storeLocalJson(livePowerStorageKey, trimSamplesToRecentWindow(trimmed))
            return trimmed
          })

          console.log('[HA History] Loaded', newPowerSamples.length, 'power samples from', powerSeriesByEntity.length, 'entities')
        } else if (staleCachedSamples === null) {
          // Only clear if we had nothing to show — don't erase stale data on empty HA response
          setHistoricalRangeSamples([])
        }

        // Process production data
        const productionData = historyData.find((h: any) => h.entity_id === productionEntity?.entity_id)
        let newProductionSamples: PowerSample[] = []
        if (productionData?.history && productionData.history.length > 0) {
          newProductionSamples = productionData.history
            .map((state: any) => {
              const timestamp = Number(state?.timestamp)
              const rawValue = Number(state?.value)
              const normalizedPower = normalizeHistoryPowerToKw(rawValue, productionEntity?.unit_of_measurement)

              if (!Number.isFinite(timestamp) || !Number.isFinite(normalizedPower)) {
                return null
              }

              return {
                timestamp,
                power: normalizedPower,
              }
            })
            .filter((sample: PowerSample | null): sample is PowerSample => sample !== null)

          newProductionSamples = downsampleLTTB(newProductionSamples, getLttbTarget(timeRange))

          setHistoricalProductionRangeSamples(newProductionSamples)

          setProductionSamples((prev) => {
            const trimmed = mergePowerSamples([prev, newProductionSamples], { maxPoints: MAX_LIVE_SAMPLE_POINTS })
            storeLocalJson(liveProductionStorageKey, trimSamplesToRecentWindow(trimmed))
            return trimmed
          })

          console.log('[HA History] Loaded', newProductionSamples.length, 'production samples')
        } else if (staleCachedProductionSamples === null) {
          // Only clear if we had nothing to show from stale cache
          setHistoricalProductionRangeSamples([])
        }

        try {
          storeLocalJson(cacheKey, {
            fetchTime: Date.now(),
            powerSamples: newPowerSamples,
            productionSamples: newProductionSamples,
          })
          setDashboardResponseCache(runtimeCacheKey, {
            powerSamples: newPowerSamples,
            productionSamples: newProductionSamples,
          }, cacheTtlMs)
        } catch {
          // Ignore storage quota errors
        }

        try {
          const existingArchiveRaw = localStorage.getItem(historyArchiveStorageKey)
          const existingArchive = existingArchiveRaw
            ? (JSON.parse(existingArchiveRaw) as Partial<HistoryArchivePayload>)
            : null

          const mergedPowerArchive = mergePowerSamples(
            [sanitizePowerSampleArray(existingArchive?.powerSamples), newPowerSamples],
            { resolutionMs: 60 * 60_000, maxPoints: MAX_ARCHIVE_HOURLY_POINTS },
          )
          const mergedProductionArchive = mergePowerSamples(
            [sanitizePowerSampleArray(existingArchive?.productionSamples), newProductionSamples],
            { resolutionMs: 60 * 60_000, maxPoints: MAX_ARCHIVE_HOURLY_POINTS },
          )

          if (mergedPowerArchive.length > 0 || mergedProductionArchive.length > 0) {
            setArchivedPowerSamples(mergedPowerArchive)
            setArchivedProductionSamples(mergedProductionArchive)
            storeLocalJson(historyArchiveStorageKey, {
              fetchTime: Date.now(),
              powerSamples: mergedPowerArchive,
              productionSamples: mergedProductionArchive,
            })
          }
        } catch {
          // Ignore archive merge/write failures.
        }

        if (!isDisposed) setIsLoadingHistory(false)
        if (perfPowerSourcesDataTimerStartedRef.current) {
          console.timeEnd('[PERF] Power Sources data')
          perfPowerSourcesDataTimerStartedRef.current = false
        }
        console.timeEnd('[PERF] Power Sources render')
      } catch (error) {
        console.error('[HA History] Error fetching historical data:', error)
        if (!isDisposed) setIsLoadingHistory(false)
        if (perfPowerSourcesDataTimerStartedRef.current) {
          console.timeEnd('[PERF] Power Sources data')
          perfPowerSourcesDataTimerStartedRef.current = false
        }
        console.timeEnd('[PERF] Power Sources render')
      }
    }

    void fetchHistoricalData()
    return () => {
      isDisposed = true
    }
  }, [
    selectedEnvironment,
    isAuthenticated,
    selectedStartDate,
    selectedEndDate,
    timeRange,
    environmentInstalledOnMs,
    getAuthToken,
    environmentInstalledOnStorageKey,
    historyArchiveStorageKey,
    livePowerStorageKey,
    liveProductionStorageKey,
    entitiesLoaded,
    isEnvironmentOffline,
  ])

  useEffect(() => {
    if (!stableSelectedEnvironment || stableSelectedEnvironment !== selectedEnvironment || !isAuthenticated) {
      return
    }
    if (!entitiesLoaded || isEnvironmentOffline) {
      return
    }

    let isDisposed = false

    const normalizeHistoryPowerToKw = (rawValue: number, unit?: string) => {
      if (!Number.isFinite(rawValue)) {
        return NaN
      }

      const normalizedUnit = String(unit || '').trim().toLowerCase()
      if (normalizedUnit === 'w' || normalizedUnit === 'watt' || normalizedUnit === 'watts' || normalizedUnit === 'va') {
        return rawValue / 1000
      }
      if (normalizedUnit === 'kw' || normalizedUnit === 'kilowatt' || normalizedUnit === 'kilowatts' || normalizedUnit === 'kva') {
        return rawValue
      }
      if (normalizedUnit === 'mw') {
        return rawValue * 1000
      }

      return rawValue > 50 ? rawValue / 1000 : rawValue
    }

    const fetchArchiveStatistics = async () => {
      try {
        const now = Date.now()
        let existingPowerArchive: PowerSample[] = []
        let existingProductionArchive: PowerSample[] = []

        try {
          const cached = localStorage.getItem(historyArchiveStorageKey)
          if (cached) {
            const parsed = JSON.parse(cached) as Partial<HistoryArchivePayload>
            existingPowerArchive = sanitizePowerSampleArray(parsed?.powerSamples)
            existingProductionArchive = sanitizePowerSampleArray(parsed?.productionSamples)
            if (existingPowerArchive.length > 0 || existingProductionArchive.length > 0) {
              setArchivedPowerSamples(existingPowerArchive)
              setArchivedProductionSamples(existingProductionArchive)

              const cachedArchiveTimestamps = [
                existingPowerArchive[0]?.timestamp,
                existingProductionArchive[0]?.timestamp,
              ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)

              if (cachedArchiveTimestamps.length > 0) {
                const cachedInstalledOnMs = Math.min(...cachedArchiveTimestamps)
                setEnvironmentInstalledOnMs((previous) => previous === null
                  ? cachedInstalledOnMs
                  : Math.min(previous, cachedInstalledOnMs))

                try {
                  const persistedInstalledOnMs = Number(localStorage.getItem(environmentInstalledOnStorageKey))
                  const nextInstalledOnMs = Number.isFinite(persistedInstalledOnMs) && persistedInstalledOnMs > 0
                    ? Math.min(persistedInstalledOnMs, cachedInstalledOnMs)
                    : cachedInstalledOnMs
                  storeLocalValue(environmentInstalledOnStorageKey, String(nextInstalledOnMs))
                } catch {
                  // Ignore localStorage errors.
                }
              }
            }

            const fetchTime = Number(parsed?.fetchTime)
            const knownInstalledOnMs = Number(localStorage.getItem(environmentInstalledOnStorageKey))
            const hasKnownInstalledOn = Number.isFinite(knownInstalledOnMs) && knownInstalledOnMs > 0
            if (Number.isFinite(fetchTime) && now - fetchTime < ARCHIVE_REFRESH_TTL_MS && hasKnownInstalledOn) {
              return
            }
          }
        } catch {
          // Ignore cache parse errors and continue with refresh.
        }

        const preferredPowerEntityId = haMetricsSnapshotRef.current?.powerEntityId || null
        const preferredProductionEntityId = haMetricsSnapshotRef.current?.sources?.currentProductionEntityId || null
        const currentHaEntities = haEntitiesRef.current

        const preferredPowerEntity = preferredPowerEntityId
          ? currentHaEntities.find((entity) => entity.entity_id === preferredPowerEntityId)
          : null
        const preferredProductionEntity = preferredProductionEntityId
          ? currentHaEntities.find((entity) => entity.entity_id === preferredProductionEntityId)
          : null

        const powerEntity = preferredPowerEntity || currentHaEntities.find(
            (entity) => {
              const id = entity.entity_id.toLowerCase()
              return !id.startsWith('binary_sensor') && (
                id.includes('electricity_meter_power_consumption') ||
                id.includes('electricity_meter') && id.includes('power') ||
                id.includes('meter') && id.includes('power') && id.includes('consumption')
              )
            }
          ) || currentHaEntities.find(
            (entity) => {
              const id = entity.entity_id.toLowerCase()
              return !id.startsWith('binary_sensor') && id.startsWith('sensor.') && (
                id.includes('current_power') ||
                (id.includes('power') && (id.includes('consumption') || id.includes('watt')))
              )
            }
          )

        if (!powerEntity) {
          return
        }

        // Only use production entity if server explicitly detected one.
        // Do NOT do broad keyword fallback — it picks up grid export sensors in environments without solar.
        const productionEntity = preferredProductionEntity || null

        const metricSources = haMetricsSnapshotRef.current?.sources
        const entityIds = Array.from(new Set([
          powerEntity.entity_id,
          productionEntity?.entity_id || null,
          metricSources?.electricityTotalEntityId || null,
          metricSources?.electricityProductionTotalEntityId || null,
          metricSources?.gasTotalEntityId || null,
          metricSources?.dailyElectricityEntityId || null,
          metricSources?.monthlyElectricityEntityId || null,
          metricSources?.dailyProductionEntityId || null,
          metricSources?.monthlyProductionEntityId || null,
        ].filter((entityId): entityId is string => typeof entityId === 'string' && entityId.trim().length > 0)))

        const token = await getAuthToken()
        const archiveStartTime = new Date(now - ARCHIVE_LOOKBACK_DAYS * 24 * 60 * 60_000)
        const archiveEndTime = new Date(now)

        const archiveUrl = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(archiveStartTime.toISOString())}&endTime=${encodeURIComponent(archiveEndTime.toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}&mode=statistics&period=hour&resolution=hourly&tzOffset=${new Date().getTimezoneOffset() * -1}`

        const response = await deduplicatedAuthFetch(archiveUrl, token)

        let historyData: any[] = []
        if (response.ok) {
          const result = await response.json()
          if (isDisposed) {
            return
          }

          historyData = Array.isArray(result?.entities) ? result.entities : []
        } else {
          const errorBody = await response.text().catch(() => '')
          console.warn(
            '[HA History] Statistics bootstrap failed, trying history fallback for month window:',
            response.status,
            errorBody,
          )
        }

        const hasStatisticsRows = historyData.some(
          (entry) => Array.isArray(entry?.history) && entry.history.length > 0,
        )

        if (!hasStatisticsRows) {
          const selectedBounds = getBoundsFromInputDates(selectedStartDate, selectedEndDate)
          const fallbackStartMs = Math.max(0, selectedBounds.startMs - 24 * 60 * 60_000)
          const fallbackHistoryUrl = `/.netlify/functions/energy-data?environmentId=${encodeURIComponent(stableSelectedEnvironmentRequestId)}&startTime=${encodeURIComponent(new Date(fallbackStartMs).toISOString())}&endTime=${encodeURIComponent(archiveEndTime.toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}&mode=history&resolution=hourly`

          const historyFallbackResponse = await deduplicatedAuthFetch(fallbackHistoryUrl, token)

          if (historyFallbackResponse.ok) {
            const fallbackResult = await historyFallbackResponse.json()
            if (isDisposed) {
              return
            }

            historyData = Array.isArray(fallbackResult?.entities) ? fallbackResult.entities : []
          }
        }

        const installedOnCandidates = historyData.flatMap((entry: any) => {
          const rows = Array.isArray(entry?.history) ? entry.history : []
          return rows
            .map((row: any) => Number(row?.timestamp))
            .filter((timestamp: number) => Number.isFinite(timestamp) && timestamp > 0)
        })

        if (installedOnCandidates.length > 0) {
          const detectedInstalledOnMs = Math.min(...installedOnCandidates)
          setEnvironmentInstalledOnMs((previous) => previous === null
            ? detectedInstalledOnMs
            : Math.min(previous, detectedInstalledOnMs))

          try {
            const persistedInstalledOnMs = Number(localStorage.getItem(environmentInstalledOnStorageKey))
            const nextInstalledOnMs = Number.isFinite(persistedInstalledOnMs) && persistedInstalledOnMs > 0
              ? Math.min(persistedInstalledOnMs, detectedInstalledOnMs)
              : detectedInstalledOnMs
            storeLocalValue(environmentInstalledOnStorageKey, String(nextInstalledOnMs))
          } catch {
            // Ignore localStorage errors.
          }
        }

        const archivePowerSamples = sanitizePowerSampleArray(
          historyData
            .find((entry: any) => entry?.entity_id === powerEntity.entity_id)
            ?.history
            ?.map((state: any) => {
              const timestamp = Number(state?.timestamp)
              const rawValue = Number(state?.value)
              const normalizedPower = normalizeHistoryPowerToKw(rawValue, powerEntity?.unit_of_measurement)

              if (!Number.isFinite(timestamp) || !Number.isFinite(normalizedPower)) {
                return null
              }

              return {
                timestamp,
                power: normalizedPower,
              }
            })
            ?.filter((sample: PowerSample | null): sample is PowerSample => sample !== null),
        )

        const archiveProductionSamples = sanitizePowerSampleArray(
          historyData
            .find((entry: any) => entry?.entity_id === productionEntity?.entity_id)
            ?.history
            ?.map((state: any) => {
              const timestamp = Number(state?.timestamp)
              const rawValue = Number(state?.value)
              const normalizedPower = normalizeHistoryPowerToKw(rawValue, productionEntity?.unit_of_measurement)

              if (!Number.isFinite(timestamp) || !Number.isFinite(normalizedPower)) {
                return null
              }

              return {
                timestamp,
                power: normalizedPower,
              }
            })
            ?.filter((sample: PowerSample | null): sample is PowerSample => sample !== null),
        )

        const nextPowerArchive = mergePowerSamples(
          [existingPowerArchive, archivePowerSamples],
          { resolutionMs: 60 * 60_000, maxPoints: MAX_ARCHIVE_HOURLY_POINTS },
        )
        const nextProductionArchive = mergePowerSamples(
          [existingProductionArchive, archiveProductionSamples],
          { resolutionMs: 60 * 60_000, maxPoints: MAX_ARCHIVE_HOURLY_POINTS },
        )

        if (nextPowerArchive.length === 0 && nextProductionArchive.length === 0) {
          return
        }

        setArchivedPowerSamples(nextPowerArchive)
        setArchivedProductionSamples(nextProductionArchive)

        const payload: HistoryArchivePayload = {
          fetchTime: now,
          powerSamples: nextPowerArchive,
          productionSamples: nextProductionArchive,
        }
        storeLocalJson(historyArchiveStorageKey, payload)
      } catch (error) {
        console.error('[HA History] Error refreshing archive statistics:', error)
      }
    }

    void fetchArchiveStatistics()
    return () => {
      isDisposed = true
    }
  }, [
    selectedEnvironment,
    isAuthenticated,
    getAuthToken,
    historyArchiveStorageKey,
    environmentInstalledOnStorageKey,
    haEntities.length,
    haMetricsSnapshot?.powerEntityId,
    haMetricsSnapshot?.sources?.currentProductionEntityId,
    haMetricsSnapshot?.sources?.electricityTotalEntityId,
    haMetricsSnapshot?.sources?.electricityProductionTotalEntityId,
    haMetricsSnapshot?.sources?.gasTotalEntityId,
    haMetricsSnapshot?.sources?.dailyElectricityEntityId,
    haMetricsSnapshot?.sources?.monthlyElectricityEntityId,
    haMetricsSnapshot?.sources?.dailyProductionEntityId,
    haMetricsSnapshot?.sources?.monthlyProductionEntityId,
    entitiesLoaded,
    isEnvironmentOffline,
  ])

  useEffect(() => {
    if (!selectedEnvironment || visibleEnvironments.length === 0) {
      return
    }

    const captureSamples = () => {
      const now = Date.now()

      setPowerSamples((prev) => {
        const lastSample = prev[prev.length - 1]
        if (lastSample && now - lastSample.timestamp < 8000) {
          return prev
        }

        const next = [...prev, { timestamp: now, power: latestPowerRef.current }]
        const trimmed = next.slice(-MAX_LIVE_SAMPLE_POINTS)
        storeLocalJson(livePowerStorageKey, trimSamplesToRecentWindow(trimmed))
        return trimmed
      })

      setProductionSamples((prev) => {
        const lastSample = prev[prev.length - 1]
        if (lastSample && now - lastSample.timestamp < 8000) {
          return prev
        }

        const next = [...prev, { timestamp: now, power: latestProductionRef.current }]
        const trimmed = next.slice(-MAX_LIVE_SAMPLE_POINTS)
        storeLocalJson(liveProductionStorageKey, trimSamplesToRecentWindow(trimmed))
        return trimmed
      })
    }

    captureSamples()
    const interval = window.setInterval(captureSamples, 10000)
    return () => window.clearInterval(interval)
  }, [livePowerStorageKey, liveProductionStorageKey, selectedEnvironment, visibleEnvironments.length])

  const earliestArchiveStartMs = useMemo(() => {
    const candidateTimestamps = [
      archivedPowerSamples[0]?.timestamp,
      archivedProductionSamples[0]?.timestamp,
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

    if (candidateTimestamps.length === 0) {
      return null
    }

    return Math.min(...candidateTimestamps)
  }, [archivedPowerSamples, archivedProductionSamples])

  const selectedEnvironmentName = useMemo(() => {
    const matched = visibleEnvironments.find((environment) => environment.id === selectedEnvironment)
    if (matched?.name) {
      return matched.name
    }

    return selectedEnvironment || 'No environment selected'
  }, [selectedEnvironment, visibleEnvironments])

  const environmentInstalledOnLabel = useMemo(() => {
    if (environmentInstalledOnMs === null) {
      return 'unknown'
    }

    return new Date(environmentInstalledOnMs).toLocaleString('nl-NL', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }, [environmentInstalledOnMs])


  const selectedRange = useMemo(() => {
    const bounds = getBoundsFromInputDates(selectedStartDate, selectedEndDate)
    const startLabel = new Date(bounds.startMs).toLocaleDateString()
    const endLabel = new Date(bounds.endMs).toLocaleDateString()

    return {
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      label: startLabel === endLabel ? endLabel : `${startLabel} - ${endLabel}`,
    }
  }, [selectedStartDate, selectedEndDate])

  const handleTimeRangeChange = (nextRange: 'today' | 'week' | 'month') => {
    setTimeRange(nextRange)

    const now = new Date()
    const today = formatDateForInput(now)

    if (nextRange === 'today') {
      setSelectedStartDate(today)
      setSelectedEndDate(today)
    } else if (nextRange === 'week') {
      const sevenDaysAgo = new Date(now)
      sevenDaysAgo.setDate(now.getDate() - 6)
      sevenDaysAgo.setHours(0, 0, 0, 0)
      setSelectedStartDate(formatDateForInput(sevenDaysAgo))
      setSelectedEndDate(today)
    } else if (nextRange === 'month') {
      // From the 1st of the month, capped to today
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      setSelectedStartDate(formatDateForInput(firstOfMonth))
      setSelectedEndDate(today)
    }
  }

  const electricityRange = useMemo(() => {
    const installedOnStartMs = environmentInstalledOnMs
    const expandedStartMs = timeRange === 'month'
      ? Math.min(
          selectedRange.startMs,
          earliestArchiveStartMs ?? Number.POSITIVE_INFINITY,
          installedOnStartMs ?? Number.POSITIVE_INFINITY,
        )
      : selectedRange.startMs
    const label = expandedStartMs < selectedRange.startMs
      ? `${new Date(expandedStartMs).toLocaleDateString()} - ${new Date(selectedRange.endMs).toLocaleDateString()}`
      : selectedRange.label

    return {
      startMs: expandedStartMs,
      endMs: selectedRange.endMs,
      label,
    }
  }, [earliestArchiveStartMs, environmentInstalledOnMs, selectedRange.endMs, selectedRange.label, selectedRange.startMs, timeRange])
  // Build gas chart data from locally captured meter readings
  // HA does not provide history/statistics for this gas entity (returns 404),
  // so we capture the meter value every 10sec via entity polling and derive consumption.
  const bucketGasReadings = useCallback(
    (startMs: number, endMs: number, bucketMs: number) => {
      const readings = gasMeterReadings.filter(
        (r) => r.timestamp >= startMs - bucketMs && r.timestamp <= endMs,
      )

      console.log('[bucketGasReadings DEBUG] input: startMs=', new Date(startMs).toISOString(), 'endMs=', new Date(endMs).toISOString(), 'bucketMs=', bucketMs)
      console.log('[bucketGasReadings DEBUG] gasMeterReadings total:', gasMeterReadings.length, 'after filter:', readings.length)
      if (gasMeterReadings.length > 0 && readings.length < 2) {
        console.log('[bucketGasReadings DEBUG] \u26a0\ufe0f Filtered to <2 readings! Filter range:', new Date(startMs - bucketMs).toISOString(), '\u2192', new Date(endMs).toISOString())
        console.log('[bucketGasReadings DEBUG] gasMeterReadings actual range:', new Date(gasMeterReadings[0].timestamp).toISOString(), '\u2192', new Date(gasMeterReadings[gasMeterReadings.length - 1].timestamp).toISOString())
      }

      if (readings.length < 2) {
        return [] as Array<{ start: number; change: number }>
      }

      // For daily buckets, align to local midnight (same as server's tzOffset-aware bucketing)
      const tzOff = new Date().getTimezoneOffset() * -60_000
      const floorToLocalDay = (ms: number) => {
        const localMs = ms + tzOff
        const d = new Date(localMs)
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tzOff
      }
      const bucketStart = bucketMs === 86_400_000 ? floorToLocalDay(startMs) : Math.floor(startMs / bucketMs) * bucketMs
      const bucketEnd = bucketMs === 86_400_000 ? floorToLocalDay(endMs) + bucketMs : Math.ceil(endMs / bucketMs) * bucketMs
      const buckets: Array<{ start: number; change: number }> = []

      for (let t = bucketStart; t < bucketEnd; t += bucketMs) {
        const nextT = t + bucketMs
        // Find the reading closest to bucket start (at or before)
        const atStart = readings.filter((r) => r.timestamp <= t).pop()
          ?? readings.find((r) => r.timestamp >= t && r.timestamp < nextT)
        // Find the reading closest to bucket end (at or before bucket end)
        const atEnd = readings.filter((r) => r.timestamp <= nextT).pop()

        if (atStart && atEnd && atEnd.value > atStart.value) {
          buckets.push({
            start: t,
            change: parseFloat((atEnd.value - atStart.value).toFixed(3)),
          })
        } else {
          buckets.push({ start: t, change: 0 })
        }
      }

      return buckets
    },
    [gasMeterReadings],
  )

  const bucketPowerSeries = useCallback(
    (
      powerSeries: PowerSample[],
      productionSeries: PowerSample[],
      startMs: number,
      endMs: number,
      bucketMs: number,
      powerSeriesIsSigned: boolean,
    ) => {
      const sortedPower = [...powerSeries].sort((a, b) => a.timestamp - b.timestamp)
      const sortedProduction = [...productionSeries].sort((a, b) => a.timestamp - b.timestamp)

      const bucketStart = Math.floor(startMs / bucketMs) * bucketMs
      const bucketEnd = Math.ceil(endMs / bucketMs) * bucketMs
      const buckets: Array<{ start: number; value: number | null }> = []
      const staleThresholdMs = Math.max(bucketMs * 2, 30 * 60_000)

      const estimateMedianInterval = (samples: PowerSample[]) => {
        if (samples.length < 3) return 0
        const intervals: number[] = []
        for (let i = 1; i < samples.length; i += 1) {
          const delta = samples[i].timestamp - samples[i - 1].timestamp
          if (delta > 0) intervals.push(delta)
        }
        if (intervals.length === 0) return 0
        intervals.sort((a, b) => a - b)
        const middle = Math.floor(intervals.length / 2)
        return intervals.length % 2 === 0
          ? Math.round((intervals[middle - 1] + intervals[middle]) / 2)
          : intervals[middle]
      }

      const powerMedianIntervalMs = estimateMedianInterval(sortedPower)
      const productionMedianIntervalMs = estimateMedianInterval(sortedProduction)
      const effectivePowerStaleThresholdMs = Math.max(staleThresholdMs, powerMedianIntervalMs > 0 ? powerMedianIntervalMs * 2 : 0)
      const effectiveProductionStaleThresholdMs = Math.max(staleThresholdMs, productionMedianIntervalMs > 0 ? productionMedianIntervalMs * 2 : 0)

      let powerIndex = 0
      let productionIndex = 0
      let lastKnownPower: number | null = null
      let lastKnownProduction: number | null = null
      let lastPowerTimestamp: number | null = null
      let lastProductionTimestamp: number | null = null

      while (powerIndex < sortedPower.length && sortedPower[powerIndex].timestamp < bucketStart) {
        lastKnownPower = sortedPower[powerIndex].power
        lastPowerTimestamp = sortedPower[powerIndex].timestamp
        powerIndex += 1
      }

      while (productionIndex < sortedProduction.length && sortedProduction[productionIndex].timestamp < bucketStart) {
        lastKnownProduction = sortedProduction[productionIndex].power
        lastProductionTimestamp = sortedProduction[productionIndex].timestamp
        productionIndex += 1
      }

      const nowMs = Date.now()

      for (let t = bucketStart; t < bucketEnd; t += bucketMs) {
        const nextT = t + bucketMs

        let bucketPowerSum = 0
        let bucketPowerCount = 0
        let bucketProductionSum = 0
        let bucketProductionCount = 0

        while (powerIndex < sortedPower.length && sortedPower[powerIndex].timestamp < nextT) {
          const sample = sortedPower[powerIndex]
          if (sample.timestamp >= t) {
            bucketPowerSum += sample.power
            bucketPowerCount += 1
          }
          lastKnownPower = sample.power
          lastPowerTimestamp = sample.timestamp
          powerIndex += 1
        }

        while (productionIndex < sortedProduction.length && sortedProduction[productionIndex].timestamp < nextT) {
          const sample = sortedProduction[productionIndex]
          if (sample.timestamp >= t) {
            bucketProductionSum += sample.power
            bucketProductionCount += 1
          }
          lastKnownProduction = sample.power
          lastProductionTimestamp = sample.timestamp
          productionIndex += 1
        }

        const isFutureBucket = t > nowMs
        const hasCurrentPower = bucketPowerCount > 0
        const hasCurrentProduction = bucketProductionCount > 0
        const hasRecentPower = lastKnownPower !== null && lastPowerTimestamp !== null && (nextT - lastPowerTimestamp) <= effectivePowerStaleThresholdMs
        const hasRecentProduction = lastKnownProduction !== null && lastProductionTimestamp !== null && (nextT - lastProductionTimestamp) <= effectiveProductionStaleThresholdMs

        const avgPower = hasCurrentPower
          ? (bucketPowerSum / bucketPowerCount)
          : hasRecentPower
            ? Number(lastKnownPower)
            : null
        const avgProduction = hasCurrentProduction
          ? (bucketProductionSum / bucketProductionCount)
          : hasRecentProduction
            ? Number(lastKnownProduction)
            : null

        let bucketValue: number | null = null
        if (!isFutureBucket) {
          if (powerSeriesIsSigned) {
            bucketValue = avgPower
          } else if (avgPower !== null || avgProduction !== null) {
            const powerValue = avgPower ?? 0
            const productionValue = avgProduction ?? 0
            bucketValue = powerValue - productionValue
          }
        }

        buckets.push({
          start: t,
          value: bucketValue === null ? null : parseFloat(bucketValue.toFixed(3)),
        })
      }

      return buckets
    },
    [],
  )

  // Combine live samples with the last fetched historical range so past dates are always visible
  const chartSamples = useMemo(() => {
    const filteredHistorical = historicalRangeSamples.filter(
      (sample) => sample.timestamp >= electricityRange.startMs && sample.timestamp <= electricityRange.endMs,
    )
    const filteredLive = powerSamples.filter(
      (sample) => sample.timestamp >= electricityRange.startMs && sample.timestamp <= electricityRange.endMs,
    )

    if (filteredHistorical.length > 0) {
      return mergePowerSamples([filteredHistorical, filteredLive])
    }

    const filteredArchive = archivedPowerSamples.filter(
      (sample) => sample.timestamp >= electricityRange.startMs && sample.timestamp <= electricityRange.endMs,
    )
    return mergePowerSamples([filteredArchive, filteredLive])
  }, [archivedPowerSamples, electricityRange.endMs, electricityRange.startMs, historicalRangeSamples, powerSamples])

  const chartProductionSamples = useMemo(() => {
    const filteredHistorical = historicalProductionRangeSamples.filter(
      (sample) => sample.timestamp >= electricityRange.startMs && sample.timestamp <= electricityRange.endMs,
    )
    const filteredLive = productionSamples.filter(
      (sample) => sample.timestamp >= electricityRange.startMs && sample.timestamp <= electricityRange.endMs,
    )

    if (filteredHistorical.length > 0) {
      return mergePowerSamples([filteredHistorical, filteredLive])
    }

    const filteredArchive = archivedProductionSamples.filter(
      (sample) => sample.timestamp >= electricityRange.startMs && sample.timestamp <= electricityRange.endMs,
    )
    return mergePowerSamples([filteredArchive, filteredLive])
  }, [archivedProductionSamples, electricityRange.endMs, electricityRange.startMs, historicalProductionRangeSamples, productionSamples])

  const chartData = useMemo(() => {
    const bucketMs = timeRange === 'today'
      ? 60_000
      : timeRange === 'week'
        ? 5 * 60_000
        : 60 * 60_000

    const powerSeriesIsSigned = chartSamples.some(
      (sample) =>
        sample.timestamp >= electricityRange.startMs &&
        sample.timestamp <= electricityRange.endMs &&
        sample.power < -0.05,
    )
    const buckets = bucketPowerSeries(
      chartSamples,
      chartProductionSamples,
      electricityRange.startMs,
      electricityRange.endMs,
      bucketMs,
      powerSeriesIsSigned,
    )

    if (buckets.length === 0) {
      return [] as Array<{ time: string; power: number | null }>
    }

    return buckets.map((bucket) => ({
      time: formatChartAxisLabel(bucket.start, timeRange),
      power: bucket.value,
    }))
  }, [
    bucketPowerSeries,
    chartSamples,
    chartProductionSamples,
    electricityRange.startMs,
    electricityRange.endMs,
    timeRange,
  ])

  // "Electricity usage" bar chart data — from HA statistics (kWh per bucket)
  // Padded to cover the full selected range so x-axis aligns with the gas chart.
  const electricityUsageChartData = useMemo(() => {
    console.log('[Chart DEBUG] electricityUsageChartData recalc: electricityUsageBuckets.length=', electricityUsageBuckets.length)
    console.log('[Chart DEBUG] electricityRange:', { startMs: new Date(electricityRange.startMs).toISOString(), endMs: new Date(electricityRange.endMs).toISOString() })
    if (electricityUsageBuckets.length === 0) {
      console.log('[Chart DEBUG] electricityUsageBuckets is EMPTY -> returning []')
      return [] as Array<{ time: string; power: number | null; exportPower: number | null }>
    }
    const filtered = electricityUsageBuckets
      .filter((b) => b.timestamp >= electricityRange.startMs && b.timestamp <= electricityRange.endMs)
    console.log('[Chart DEBUG] After range filter:', filtered.length, 'buckets of', electricityUsageBuckets.length)
    if (filtered.length === 0 && electricityUsageBuckets.length > 0) {
      console.log('[Chart DEBUG] \u26a0\ufe0f ALL FILTERED OUT! Bucket range:', new Date(electricityUsageBuckets[0].timestamp).toISOString(), '\u2192', new Date(electricityUsageBuckets[electricityUsageBuckets.length - 1].timestamp).toISOString())
    }

    // Build maps from timestamp -> import/export kWh for quick lookup
    const importKwhMap = new Map(filtered.map((b) => [b.timestamp, b.importKwh]))
    const exportKwhMap = new Map(filtered.map((b) => [b.timestamp, b.exportKwh]))

    // Generate consistent hourly/daily slots from range start to now (not end-of-day)
    // For daily buckets the server uses local-midnight timestamps (e.g. 22:00 UTC for CET),
    // so we must align slot generation to the same local-midnight boundary.
    const bucketMs = timeRange === 'month' ? 86_400_000 : 3_600_000
    const tzOffsetMs = new Date().getTimezoneOffset() * -60_000
    const floorToSlot = (ms: number) => {
      if (bucketMs === 86_400_000) {
        // Floor to local midnight, then convert back to UTC
        const localMs = ms + tzOffsetMs
        const d = new Date(localMs)
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tzOffsetMs
      }
      return Math.floor(ms / bucketMs) * bucketMs
    }
    const slotStart = floorToSlot(electricityRange.startMs)
    const slotEnd = floorToSlot(Math.min(electricityRange.endMs, Date.now()))
    const padded: Array<{ time: string; power: number | null; exportPower: number | null }> = []
    for (let t = slotStart; t <= slotEnd; t += bucketMs) {
      padded.push({
        time: formatChartAxisLabel(t, timeRange),
        power: importKwhMap.get(t) ?? 0,
        exportPower: exportKwhMap.get(t) ?? 0,
      })
    }

    return padded
  }, [electricityUsageBuckets, electricityRange.startMs, electricityRange.endMs, timeRange])

  const gasChartData = useMemo(() => {
    const bucketMs = timeRange === 'month' ? 86_400_000 : 3_600_000
    // For month view, use the same expanded range as electricity chart
    const gasStartMs = timeRange === 'month' ? electricityRange.startMs : selectedRange.startMs
    // Cap end to now so future empty buckets don't stretch the x-axis beyond electricity chart
    const rawGasEndMs = timeRange === 'month' ? electricityRange.endMs : selectedRange.endMs
    const gasEndMs = Math.min(rawGasEndMs, Date.now())
    console.log('[Chart DEBUG] gasChartData recalc: gasMeterReadings.length=', gasMeterReadings.length)
    console.log('[Chart DEBUG] selectedRange:', { startMs: new Date(gasStartMs).toISOString(), endMs: new Date(gasEndMs).toISOString() })
    console.log('[Chart DEBUG] bucketMs:', bucketMs, '(' + (bucketMs === 3_600_000 ? 'hourly' : 'daily') + ')')
    if (gasMeterReadings.length > 0) {
      console.log('[Chart DEBUG] gasMeterReadings range:', new Date(gasMeterReadings[0].timestamp).toISOString(), '\u2192', new Date(gasMeterReadings[gasMeterReadings.length - 1].timestamp).toISOString())
      console.log('[Chart DEBUG] gasMeterReadings first value:', gasMeterReadings[0].value, 'last value:', gasMeterReadings[gasMeterReadings.length - 1].value)
    }
    const buckets = bucketGasReadings(gasStartMs, gasEndMs, bucketMs)
    console.log('[Chart DEBUG] bucketGasReadings returned:', buckets.length, 'buckets')
    if (buckets.length > 0) {
      const nonZero = buckets.filter(b => b.change > 0)
      console.log('[Chart DEBUG] Non-zero gas buckets:', nonZero.length, 'total change:', nonZero.reduce((s, b) => s + b.change, 0).toFixed(3))
    }

    if (buckets.length === 0) {
      console.log('[Chart DEBUG] \u26a0\ufe0f Gas buckets EMPTY -> returning placeholder')
      // No local readings yet — show empty chart
      return [{ time: '', power: 0 }]
    }

    return buckets.map((b) => {
      const time = formatChartAxisLabel(b.start, timeRange)
      return { time, power: Math.max(0, b.change) }
    })
  }, [bucketGasReadings, selectedRange.startMs, selectedRange.endMs, electricityRange.startMs, electricityRange.endMs, timeRange])

  useEffect(() => {
    if (!selectedEnvironment) {
      return
    }

    const hasAnyChartData = chartData.length > 0 || electricityUsageChartData.length > 0 || gasChartData.length > 0
    if (
      entitiesLoaded &&
      !haLoading &&
      !isLoadingHistory &&
      !isLoadingUsage &&
      hasAnyChartData
    ) {
      if (perfViewSwitchTimerStartedRef.current) {
        console.timeEnd('[PERF] View switch')
        perfViewSwitchTimerStartedRef.current = false
      }

      if (perfDashboardTimerStartedRef.current) {
        console.timeEnd('[PERF] Dashboard total load')
        perfDashboardTimerStartedRef.current = false
      }
    }
  }, [
    chartData.length,
    electricityUsageChartData.length,
    entitiesLoaded,
    gasChartData.length,
    haLoading,
    isLoadingHistory,
    isLoadingUsage,
    selectedEnvironment,
  ])

  const dynamicPriceChartData = useMemo<DynamicPriceChartPoint[]>(() => {
    const fixedConsumerLine = showFixedPriceLinesOnChart && pricingConfig?.type === 'fixed'
      ? Number(((pricingConfig?.consumerPrice || 0.30) + (pricingConfig?.consumerMargin || 0)).toFixed(4))
      : null
    const fixedProducerLine = showFixedPriceLinesOnChart && pricingConfig?.type === 'fixed'
      ? Number(Math.max(0, (pricingConfig?.producerPrice || 0.10) - (pricingConfig?.producerMargin || 0)).toFixed(4))
      : null

    return dynamicPricePoints.map((point) => {
      const date = new Date(point.time)
      const time = date.toLocaleString([], {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      const fullTime = date.toLocaleString([], {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
      const roundedPrice = Number(point.eurPerKwh.toFixed(4))

      return {
        time,
        fullTime,
        price: roundedPrice,
        currentPrice: point.isForecast ? null : roundedPrice,
        forecastPrice: point.isForecast ? roundedPrice : null,
        fixedConsumerPrice: fixedConsumerLine,
        fixedProducerPrice: fixedProducerLine,
      }
    })
  }, [dynamicPricePoints, pricingConfig, showFixedPriceLinesOnChart])

  const gasSelectedPeriodTotal = useMemo(() => {
    return parseFloat(
      gasChartData.reduce((sum, item) => sum + Math.max(0, item.power), 0).toFixed(2),
    )
  }, [gasChartData])

  const electricityUsageTotal = useMemo(() => {
    return parseFloat(
      electricityUsageBuckets
        .filter((b) => b.timestamp >= electricityRange.startMs && b.timestamp <= electricityRange.endMs)
        .reduce((sum, b) => sum + b.importKwh, 0)
        .toFixed(2),
    )
  }, [electricityUsageBuckets, electricityRange.startMs, electricityRange.endMs])

  const electricityTodayFromBuckets = useMemo(() => {
    const todayStartMs = electricityRange.startMs
    const todayEndMs = Math.min(electricityRange.endMs, Date.now())

    return parseFloat(
      electricityUsageBuckets
        .filter((bucket) => bucket.timestamp >= todayStartMs && bucket.timestamp <= todayEndMs)
        .reduce((sum, bucket) => sum + Math.max(0, Number(bucket.importKwh) || 0), 0)
        .toFixed(2),
    )
  }, [electricityRange.endMs, electricityRange.startMs, electricityUsageBuckets])

  // Card label adapts to the selected period
  const periodLabel = timeRange === 'today' ? 'Today' : timeRange === 'week' ? 'This Week' : 'This Month'

  // Electricity card: prefer chart total (most accurate), fall back to server metrics while loading
  const electricityCardValue = useMemo(() => {
    const chartValue = electricityUsageTotal > 0 ? electricityUsageTotal : 0
    const serverToday = Number(haMetricsSnapshot?.dailyElectricityKwh)
    const serverMonth = Number(haMetricsSnapshot?.monthlyElectricityKwh)

    if (timeRange === 'today') {
      const fallbackToday = Number.isFinite(serverToday)
        ? serverToday
        : Number(realTimeData.dailyUsage)
      const candidates = [
        chartValue,
        electricityTodayFromBuckets,
        Number.isFinite(fallbackToday) ? fallbackToday : 0,
      ]
      return Math.max(...candidates)
    }

    if (timeRange === 'month') {
      const fallbackMonth = Number.isFinite(serverMonth)
        ? serverMonth
        : Number(realTimeData.monthlyUsage)
      if (!Number.isFinite(fallbackMonth)) return chartValue
      return Math.max(chartValue, fallbackMonth)
    }

    return chartValue
  }, [
    electricityUsageTotal,
    haMetricsSnapshot?.dailyElectricityKwh,
    haMetricsSnapshot?.monthlyElectricityKwh,
    electricityTodayFromBuckets,
    realTimeData.dailyUsage,
    realTimeData.monthlyUsage,
    timeRange,
  ])
  // Gas card: day/month use server metrics, week uses chart total
  const gasCardValue = useMemo(() => {
    if (timeRange === 'today') {
      const serverDailyGas = Number(haMetricsSnapshot?.dailyGasM3)
      const realtimeDailyGas = Number(realTimeData.gasDailyUsage)
      const bucketDailyGas = Number(gasSelectedPeriodTotal)

      return parseFloat(
        Math.max(
          Number.isFinite(serverDailyGas) ? Math.max(0, serverDailyGas) : 0,
          Number.isFinite(realtimeDailyGas) ? Math.max(0, realtimeDailyGas) : 0,
          Number.isFinite(bucketDailyGas) ? Math.max(0, bucketDailyGas) : 0,
        ).toFixed(2),
      )
    }
    if (timeRange === 'month') {
      if (haMetricsSnapshot?.monthlyGasM3 !== null && haMetricsSnapshot?.monthlyGasM3 !== undefined) {
        return parseFloat(Math.max(0, haMetricsSnapshot.monthlyGasM3).toFixed(2))
      }
      return realTimeData.gasMonthlyUsage
    }
    // week or custom: use gas chart total
    return gasSelectedPeriodTotal
  }, [timeRange, haMetricsSnapshot?.dailyGasM3, haMetricsSnapshot?.monthlyGasM3, realTimeData.gasDailyUsage, realTimeData.gasMonthlyUsage, gasSelectedPeriodTotal])

  const hasGasCapability = useMemo(() => {
    const sourceGasEntity = haMetricsSnapshot?.sources?.gasEntityId || haMetricsSnapshot?.sources?.gasTotalEntityId
    if (typeof sourceGasEntity === 'string' && sourceGasEntity.trim().length > 0) {
      return true
    }
    return gasMeterReadings.length > 0
  }, [gasMeterReadings.length, haMetricsSnapshot?.sources?.gasEntityId, haMetricsSnapshot?.sources?.gasTotalEntityId])

  const apiConsistencyIssues = useMemo(() => {
    if (!haMetricsSnapshot) {
      return [] as string[]
    }

    const issues: string[] = []
    const entitiesForCheck = haEntities.length > 0 ? haEntities : lastKnownHaEntities

    const getEntityValue = (entityId: string | null, kind: 'energy' | 'gas') => {
      if (!entityId) {
        return null
      }

      const entity = entitiesForCheck.find(
        (candidate) => candidate.entity_id.toLowerCase() === entityId.toLowerCase(),
      )
      if (!entity) {
        return null
      }

      const parsed = parseNumericValue(entity.state)
      if (!Number.isFinite(parsed)) {
        return null
      }

      const normalized = kind === 'energy'
        ? convertEnergyToKwh(parsed, entity.unit_of_measurement)
        : convertGasToM3(parsed, entity.unit_of_measurement)

      return Number.isFinite(normalized) ? normalized : null
    }

    const addDriftIssue = (
      label: string,
      displayed: number,
      apiValue: number | null,
      unit: string,
      tolerance: number,
    ) => {
      if (!Number.isFinite(displayed) || apiValue === null || !Number.isFinite(apiValue)) {
        return
      }

      const drift = Math.abs(displayed - apiValue)
      if (drift > tolerance) {
        issues.push(
          `${label}: UI=${displayed.toFixed(3)} ${unit}, API=${apiValue.toFixed(3)} ${unit}, drift=${drift.toFixed(3)} ${unit}`,
        )
      }
    }

    // Only compare card values vs API daily metrics when viewing "today"
    // In week/month view the card shows a period total that won't match the daily API metric.
    if (timeRange === 'today') {
      addDriftIssue('Electricity today', realTimeData.dailyUsage, haMetricsSnapshot.dailyElectricityKwh, 'kWh', 0.01)
      addDriftIssue('Gas today', gasCardValue, haMetricsSnapshot.dailyGasM3, 'm3', 0.01)
    }
    if (timeRange === 'month') {
      addDriftIssue('Electricity month', realTimeData.monthlyUsage, haMetricsSnapshot.monthlyElectricityKwh, 'kWh', 0.01)
    }

    const checkSourceAlignment = (
      label: string,
      sourceEntityId: string | null,
      metricValue: number | null,
      kind: 'energy' | 'gas',
      unit: string,
      tolerance: number,
    ) => {
      if (metricValue === null) {
        return
      }

      const sourceValue = getEntityValue(sourceEntityId, kind)
      if (sourceValue === null) {
        return
      }

      const drift = Math.abs(sourceValue - metricValue)
      if (drift > tolerance) {
        issues.push(
          `${label}: metric=${metricValue.toFixed(3)} ${unit}, source=${sourceValue.toFixed(3)} ${unit}, drift=${drift.toFixed(3)} ${unit}`,
        )
      }
    }

    checkSourceAlignment(
      'Electricity daily source',
      haMetricsSnapshot.sources.dailyElectricityEntityId,
      haMetricsSnapshot.dailyElectricityKwh,
      'energy',
      'kWh',
      0.01,
    )
    checkSourceAlignment(
      'Electricity monthly source',
      haMetricsSnapshot.sources.monthlyElectricityEntityId,
      haMetricsSnapshot.monthlyElectricityKwh,
      'energy',
      'kWh',
      0.01,
    )
    checkSourceAlignment(
      'Gas daily source',
      haMetricsSnapshot.sources.dailyGasEntityId,
      haMetricsSnapshot.dailyGasM3,
      'gas',
      'm3',
      0.01,
    )
    checkSourceAlignment(
      'Gas monthly source',
      haMetricsSnapshot.sources.monthlyGasEntityId,
      haMetricsSnapshot.monthlyGasM3,
      'gas',
      'm3',
      0.01,
    )

    const now = new Date()
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    if (timeRange === 'today' && selectedStartDate === todayKey && selectedEndDate === todayKey) {
      // Only check gas drift — electricity chart total is authoritative (derived from HA history inter-bucket deltas)
      const gasTol = Math.max(0.3, (haMetricsSnapshot.dailyGasM3 ?? 0) * 0.05)
      addDriftIssue('Gas chart day total', gasSelectedPeriodTotal, haMetricsSnapshot.dailyGasM3, 'm3', gasTol)
    }

    return issues
  }, [
    electricityRange,
    electricityUsageBuckets,
    electricityUsageTotal,
    gasCardValue,
    gasSelectedPeriodTotal,
    haEntities,
    haMetricsSnapshot,
    lastKnownHaEntities,
    realTimeData.dailyUsage,
    realTimeData.monthlyUsage,
    selectedStartDate,
    selectedEndDate,
    timeRange,
  ])

  useEffect(() => {
    if (apiConsistencyIssues.length > 0) {
      if (import.meta.env.DEV) {
        console.warn('[API consistency] Detected metric drift:', {
          environmentId: selectedEnvironment,
          issues: apiConsistencyIssues,
        })
      }
    }
  }, [apiConsistencyIssues, selectedEnvironment])

  // Show loading screen while checking permissions
  if (isCheckingPermissions) {
    return (
      <div className="app-shell min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-16 h-16 border-4 border-brand-2 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-dark-2 text-lg">Loading your environments...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header with Environment Selector */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              {onOpenOverview ? (
                <button
                  type="button"
                  onClick={onOpenOverview}
                  className="p-1 rounded-md hover:bg-light-2 hover:bg-opacity-10 transition-all"
                  title="Back to overview"
                  aria-label="Back to overview"
                >
                  <Home className="w-8 h-8 text-brand-2" />
                </button>
              ) : (
                <Home className="w-8 h-8 text-brand-2" />
              )}
              <div>
                <h1 className="text-4xl md:text-5xl font-heavy text-light-2 mb-2">
                  {selectedEnvironmentName}
                </h1>
                <div className="flex items-center gap-2 text-light-1 text-sm md:text-base">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${haConnectionStatus === 'connected' ? 'bg-emerald-400' : haConnectionStatus === 'connecting' ? 'bg-amber-300' : 'bg-red-400'}`}
                  ></span>
                  <span>{haConnectionStatus === 'connected' ? 'Online' : haConnectionStatus === 'connecting' ? 'Connecting' : 'Offline'}</span>
                  <span className="opacity-70">|</span>
                  <span>Installed on {environmentInstalledOnLabel}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative settings-dropdown-container">
                <button
                  onClick={() => setShowSettingsDropdown(!showSettingsDropdown)}
                  className="p-2 bg-light-2 bg-opacity-20 text-light-2 border border-light-2 border-opacity-30 rounded-lg hover:bg-opacity-30 transition-all"
                  title="Open settings"
                >
                  <Settings className="w-5 h-5" />
                </button>
                {showSettingsDropdown && (
                  <div className="absolute right-0 mt-2 w-72 bg-dark-1 border border-light-2 border-opacity-30 rounded-lg shadow-xl z-50">
                    <div className="px-4 pt-3 pb-2 border-b border-light-2 border-opacity-10">
                      <label className="block text-xs font-medium uppercase tracking-wide text-light-1">Environment</label>
                      <select
                        value={selectedEnvironment}
                        onChange={(e) => {
                          const nextId = e.target.value
                          setSelectedEnvironment(nextId)
                          onEnvironmentChange?.(nextId)
                        }}
                        disabled={visibleEnvironments.length === 0}
                        className="mt-2 w-full bg-light-2 bg-opacity-20 text-light-2 border border-light-2 border-opacity-30 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                      >
                        {visibleEnvironments.length === 0 && (
                          <option value="" className="bg-dark-1 text-light-2">
                            No environments
                          </option>
                        )}
                        {visibleEnvironments.map((env) => (
                          <option key={env.id} value={env.id} className="bg-dark-1 text-light-2">
                            {env.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="py-1">
                      {isAdmin && onOpenOverview && (
                        <button
                          onClick={() => {
                            onOpenOverview()
                            setShowSettingsDropdown(false)
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                        >
                          <Home className="w-5 h-5" />
                          <div>
                            <div className="font-medium">Overview</div>
                            <div className="text-xs text-light-1">Back to environments</div>
                          </div>
                        </button>
                      )}

                      {isAdmin && onManageUsers && (
                        <button
                          onClick={() => {
                            onManageUsers()
                            setShowSettingsDropdown(false)
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                        >
                          <UsersIcon className="w-5 h-5" />
                          <div>
                            <div className="font-medium">Users</div>
                            <div className="text-xs text-light-1">Manage access</div>
                          </div>
                        </button>
                      )}

                      {onLogout && (
                        <button
                          onClick={() => {
                            onLogout()
                            setShowSettingsDropdown(false)
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-red-200 hover:bg-red-500 hover:bg-opacity-20 transition-all text-left border-t border-light-2 border-opacity-10"
                        >
                          <LogOut className="w-5 h-5" />
                          <div>
                            <div className="font-medium">Logout</div>
                            <div className="text-xs text-red-200 opacity-80">Sign out</div>
                          </div>
                        </button>
                      )}

                      <button
                        onClick={() => {
                          setShowPriceModal(true)
                          setShowSettingsDropdown(false)
                        }}
                        disabled={!selectedEnvironment}
                        className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                      >
                        <DollarSign className="w-5 h-5" />
                        <div>
                          <div className="font-medium">Energy Price</div>
                          <div className="text-xs text-light-1">Configure pricing & rates</div>
                        </div>
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => {
                            setShowHaConfig(true)
                            setShowSettingsDropdown(false)
                          }}
                          disabled={!selectedEnvironment}
                          className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left border-t border-light-2 border-opacity-10"
                        >
                          <Settings className="w-5 h-5" />
                          <div>
                            <div className="font-medium">Configure Sensors</div>
                            <div className="text-xs text-light-1">Choose visible sensors</div>
                          </div>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* No Environments Assigned Message */}
        {visibleEnvironments.length === 0 && !envLoading && (
          <div className="glass-panel rounded-3xl shadow-2xl p-12 text-center">
            <div className="max-w-md mx-auto">
              <div className="w-20 h-20 mx-auto mb-6 bg-dark-2 bg-opacity-20 rounded-full flex items-center justify-center">
                <Home className="w-10 h-10 text-dark-2" />
              </div>
              <h2 className="text-3xl font-heavy text-dark-1 mb-4">No Environments Assigned</h2>
              <p className="text-dark-2 text-lg mb-2">
                You don't have access to any environments yet.
              </p>
              <p className="text-dark-2">
                Please contact your sales contact person to request access.
              </p>
            </div>
          </div>
        )}

        {/* Main Content - Only show when there are environments */}
        {visibleEnvironments.length > 0 && (
          <>
            {/* Main Current Power Display */}
            <div className="glass-panel rounded-3xl shadow-2xl p-8 mb-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-dark-2 text-sm font-medium uppercase">Current Power Usage</p>
              <div className="flex items-baseline gap-2">
                <span className="text-6xl font-heavy text-transparent bg-clip-text bg-gradient-to-r from-brand-2 to-brand-3">
                  {realTimeData.currentPower}
                </span>
                <span className="text-2xl text-dark-2">kW</span>
              </div>
            </div>
            <div className="bg-gradient-to-br from-brand-1 to-brand-2 p-6 rounded-2xl">
              <Zap className="w-16 h-16 text-dark-1" />
            </div>
          </div>
        </div>

        {/* Energy Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <EnergyCard
            title={`Electricity ${periodLabel}`}
            value={electricityCardValue}
            unit="kWh"
            icon="zap"
          />
          {hasGasCapability && (
            <EnergyCard
              title={`Gas ${periodLabel}`}
              value={gasCardValue}
              unit="m³"
              icon="flame"
            />
          )}
        </div>

        {/* Time Range Selector */}
        <div className="glass-panel rounded-xl shadow-lg p-4 mb-8">
          <div className="flex gap-4">
            <button
              onClick={() => { handleTimeRangeChange('today'); setShowDatePicker(false) }}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'today'
                  ? 'glass-button'
                  : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
              }`}
            >
              Day
            </button>
            <button
              onClick={() => { handleTimeRangeChange('week'); setShowDatePicker(false) }}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'week'
                  ? 'glass-button'
                  : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
              }`}
            >
              Week
            </button>
            <button
              onClick={() => { handleTimeRangeChange('month'); setShowDatePicker(false) }}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'month'
                  ? 'glass-button'
                  : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
              }`}
            >
              Month
            </button>
            <button
              onClick={() => setShowDatePicker(!showDatePicker)}
              className={`py-3 px-4 rounded-lg font-medium transition-all flex items-center gap-1 ${
                showDatePicker
                  ? 'glass-button'
                  : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
              }`}
              title="Custom date range"
            >
              <Clock className="w-4 h-4" />
              <ChevronDown className={`w-4 h-4 transition-transform ${showDatePicker ? 'rotate-180' : ''}`} />
            </button>
          </div>
          {showDatePicker && (
            <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-light-2 border-opacity-10">
              <div>
                <label className="block text-xs text-light-1 mb-1">Start date</label>
                <input
                  type="date"
                  value={selectedStartDate}
                  max={selectedEndDate}
                  onChange={(e) => {
                    setSelectedStartDate(e.target.value)
                    if (e.target.value > selectedEndDate) setSelectedEndDate(e.target.value)
                  }}
                  className="w-full bg-dark-2 bg-opacity-70 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                />
              </div>
              <div>
                <label className="block text-xs text-light-1 mb-1">End date</label>
                <input
                  type="date"
                  value={selectedEndDate}
                  min={selectedStartDate}
                  onChange={(e) => {
                    setSelectedEndDate(e.target.value)
                    if (e.target.value < selectedStartDate) setSelectedStartDate(e.target.value)
                  }}
                  className="w-full bg-dark-2 bg-opacity-70 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                />
              </div>
            </div>
          )}
        </div>

        {apiConsistencyIssues.length > 0 && (
          <div className="glass-panel rounded-xl border border-red-400 border-opacity-60 p-4 mb-8">
            <h3 className="text-red-200 font-semibold mb-2">API consistency check detected drift</h3>
            <p className="text-light-1 text-sm mb-3">
              Displayed values differ from direct API/source values. The details below help identify the mismatched sensor.
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-red-100">
              {apiConsistencyIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Chart Section - Electricity and Gas charts */}
        <div className="space-y-8">
          {!entitiesLoaded && !isEnvironmentOffline && (
            <div className="glass-panel rounded-3xl shadow-2xl p-8 text-center">
              <div className="inline-block w-10 h-10 border-4 border-brand-2 border-t-transparent rounded-full animate-spin mb-3"></div>
              <p className="text-light-1">Loading sensors and chart data...</p>
            </div>
          )}

          {isEnvironmentOffline && (
            <div className="glass-panel rounded-3xl shadow-2xl p-6 border border-amber-300 border-opacity-40">
              <p className="text-light-2 font-semibold">This environment is currently offline.</p>
              <p className="text-light-1 text-sm mt-1">
                Last seen: {offlineLastSeenAt ? new Date(offlineLastSeenAt).toLocaleString('nl-NL') : 'unknown'}
              </p>
            </div>
          )}

          {entitiesLoaded && !isEnvironmentOffline && (
          <>
          {/* Power Sources Chart (instantaneous kW) */}
          <div className="glass-panel rounded-3xl shadow-2xl p-4 sm:p-6 md:p-8">
            <h2 className="text-2xl font-heavy text-dark-1 mb-6 flex items-center gap-2">
              <Clock className="w-6 h-6 text-brand-2" />
              Power sources
              {isLoadingHistory && chartData.length === 0 && (
                <span className="ml-3 inline-flex items-center gap-1.5 text-sm font-normal text-brand-2 opacity-75">
                  <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Laden…
                </span>
              )}
            </h2>
            <EnergyChart
              data={!entitiesLoaded || isEnvironmentOffline ? [] : chartData}
              timeRange={timeRange}
              unit="kW"
              seriesLabel="Power sources"
              rangeLabel={electricityRange.label}
              lineType="linear"
              signed={true}
            />
          </div>

          {/* Electricity Usage Chart (kWh per hour/day from statistics) */}
          <div className="glass-panel rounded-3xl shadow-2xl p-4 sm:p-6 md:p-8">
            <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-2xl font-heavy text-dark-1 flex items-center gap-2">
                <Clock className="w-6 h-6 text-brand-2" />
                Electricity usage
                {isLoadingUsage && (
                  <span className="ml-3 inline-flex items-center gap-1.5 text-sm font-normal text-brand-2 opacity-75">
                    <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Laden…
                  </span>
                )}
              </h2>

            </div>
            <EnergyChart
              data={!entitiesLoaded || isEnvironmentOffline ? [] : electricityUsageChartData}
              timeRange={timeRange}
              unit="kWh"
              seriesLabel="Electricity usage"
              rangeLabel={electricityRange.label}
              chartType="bar"
              barColor="rgb(74, 222, 128)"
            />
          </div>

          {/* Gas Chart */}
          <div className="glass-panel rounded-3xl shadow-2xl p-4 sm:p-6 md:p-8">
            <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-2xl font-heavy text-dark-1 flex items-center gap-2">
                <Flame className="w-6 h-6 text-brand-2" />
                Gas consumption
              </h2>

            </div>
            <EnergyChart
              data={!entitiesLoaded || isEnvironmentOffline ? [] : gasChartData}
              timeRange={timeRange}
              unit="m³"
              seriesLabel="Gas chart"
              rangeLabel={selectedRange.label}
              chartType="bar"
              barColor="rgb(234, 88, 12)"
            />
          </div>
          </>
          )}

          {/* Price Chart */}
          {showDynamicPriceChart && (
            <div className="glass-panel rounded-3xl shadow-2xl p-4 sm:p-6 md:p-8">
              <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-2xl font-heavy text-dark-1 flex items-center gap-2">
                  <DollarSign className="w-6 h-6 text-brand-2" />
                  Price Chart
                </h2>
                <div className="text-right">
                  {dynamicPriceUpdatedAt && (
                    <p className="text-xs text-light-1 opacity-80">
                      Updated: {new Date(dynamicPriceUpdatedAt).toLocaleString()}
                    </p>
                  )}
                  {showFixedPriceLinesOnChart && pricingConfig?.type === 'fixed' && (
                    <p className="text-xs text-light-1 opacity-80">Fixed comparison lines enabled</p>
                  )}
                </div>
              </div>

              {dynamicPriceChartLoading && dynamicPriceChartData.length === 0 && (
                <p className="text-light-1 text-sm mb-4">Loading dynamic price forecast...</p>
              )}

              {dynamicPriceChartError && (
                <p className="text-red-300 text-sm mb-4">{dynamicPriceChartError}</p>
              )}

              {dynamicPriceChartData.length > 0 && (
                <>
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dynamicPriceChartData} margin={{ top: 12, right: 16, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.12)" />
                        <XAxis
                          dataKey="time"
                          tick={{ fill: 'rgba(255,255,255,0.75)', fontSize: 11 }}
                          minTickGap={24}
                        />
                        <YAxis
                          tick={{ fill: 'rgba(255,255,255,0.75)', fontSize: 11 }}
                          tickFormatter={(value: number) => `EUR ${Number(value).toFixed(3)}`}
                          width={84}
                        />
                        <Tooltip
                          labelFormatter={(label, payload) => {
                            const first = Array.isArray(payload) && payload.length > 0
                              ? payload[0]
                              : null
                            return typeof first?.payload?.fullTime === 'string' ? first.payload.fullTime : String(label)
                          }}
                          formatter={(value: number | string) => {
                            const numericValue = Number(value)
                            return [`EUR ${numericValue.toFixed(4)} /kWh`, 'Price']
                          }}
                          contentStyle={{
                            background: 'rgba(15, 23, 42, 0.95)',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '0.75rem',
                            color: '#f8fafc',
                          }}
                          itemStyle={{ color: '#f8fafc' }}
                          labelStyle={{ color: '#f8fafc' }}
                        />
                        <Line
                          type="monotone"
                          dataKey="currentPrice"
                          stroke="#34d399"
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                          name="Current"
                        />
                        <Line
                          type="monotone"
                          dataKey="forecastPrice"
                          stroke="#f59e0b"
                          strokeWidth={2}
                          strokeDasharray="6 4"
                          dot={false}
                          connectNulls
                          name="Forecast"
                        />
                        {showFixedPriceLinesOnChart && pricingConfig?.type === 'fixed' && (
                          <Line
                            type="linear"
                            dataKey="fixedConsumerPrice"
                            stroke="#60a5fa"
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                            name="Fixed Consumer (incl. margin)"
                          />
                        )}
                        {showFixedPriceLinesOnChart && pricingConfig?.type === 'fixed' && (
                          <Line
                            type="linear"
                            dataKey="fixedProducerPrice"
                            stroke="#a78bfa"
                            strokeWidth={2}
                            strokeDasharray="4 4"
                            dot={false}
                            connectNulls
                            name="Fixed Producer (after margin)"
                          />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-4 text-xs text-light-1">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      Current dynamic
                    </span>
                    <span className="inline-flex items-center gap-2">
                      <span className="h-0 w-4 border-t-2 border-dashed border-amber-400" />
                      Forecast dynamic
                    </span>
                    {showFixedPriceLinesOnChart && pricingConfig?.type === 'fixed' && (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-0 w-4 border-t-2 border-blue-400" />
                        Fixed consumer
                      </span>
                    )}
                    {showFixedPriceLinesOnChart && pricingConfig?.type === 'fixed' && (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-0 w-4 border-t-2 border-dashed border-violet-400" />
                        Fixed producer
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-light-1 opacity-75 mt-3">
                    Dynamic ENTSOE prices shown for today and available forecast horizon.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Sensors Panel */}
        <div className="glass-panel rounded-3xl shadow-2xl p-8 mt-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-heavy text-dark-1">Sensors</h2>
          </div>

          {haLoading && <p className="text-light-1">Loading sensor data...</p>}
          {haError && <p className="text-red-300">{haError}</p>}
          {/* Toon altijd de laatst bekende sensoren */}
          {!isInitialLoading && (haEntities.length > 0 || lastKnownHaEntities.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(haEntities.length > 0 ? haEntities : lastKnownHaEntities).map((entity) => {
                  const actions = getControlActions(entity.domain)
                  return (
                    <div key={entity.entity_id} className="glass-card rounded-2xl p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="text-light-1 text-xs uppercase">{entity.domain}</p>
                          <p className="text-light-2 font-medium">
                            {entity.friendly_name || entity.entity_id}
                          </p>
                          <p className="text-light-1 text-xs">{entity.entity_id}</p>
                        </div>
                        <div className="text-light-2 text-sm">{entity.state}</div>
                      </div>
                      {actions.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {actions.map((action) => (
                            <button
                              key={`${entity.entity_id}-${action.action}`}
                              onClick={() => runHaAction(entity.entity_id, action.action)}
                              disabled={haActionId === entity.entity_id}
                              className="px-3 py-2 rounded-lg bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90 transition-all disabled:opacity-60"
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          {!isInitialLoading && haEntities.length === 0 && lastKnownHaEntities.length === 0 && (
            <p className="text-light-1">No sensors are visible for this account yet.</p>
          )}
        </div>

        {/* Footer Info */}
        <div className="mt-8 text-center text-light-1 text-sm">
          <p>Last updated: {new Date().toLocaleTimeString()}</p>
        </div>
          </>
        )}

        {showHaConfig && (
          <HomeAssistantConfig
            environmentId={selectedEnvironmentRequestId}
            environmentName={environments.find((env) => env.id === selectedEnvironment)?.name || selectedEnvironment}
            onClose={() => setShowHaConfig(false)}
            onSaved={() => {
              setHaError(null)
              setHaRefreshKey((prev) => prev + 1)
            }}
          />
        )}

        {showPriceModal && (
          <EnergyPriceModal
            environmentId={selectedEnvironmentRequestId}
            onClose={() => setShowPriceModal(false)}
            onSave={(config) => setPricingConfig(config)}
            getAuthToken={getAuthToken}
          />
        )}
      </div>
    </div>
  )
}
