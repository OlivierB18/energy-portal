import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import EnergyCard from '../components/EnergyCard'
import EnergyChart from '../components/EnergyChart'
import HomeAssistantConfig from '../components/HomeAssistantConfig'
import EnergyPriceModal from '../components/EnergyPriceModal'
import { Zap, Clock, Home, Settings, DollarSign, Flame, Users as UsersIcon, LogOut } from 'lucide-react'
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

const GAS_METER_ENTITY_ID = 'sensor.gas_meter_gas_consumption'
const DYNAMIC_PRICE_CHART_EVENT = 'energy-dynamic-chart-visibility-changed'
const HA_ENVIRONMENTS_UPDATED_EVENT = 'ha-environments-updated'
const MAX_LIVE_SAMPLE_POINTS = 8000
const MAX_ARCHIVE_HOURLY_POINTS = 60000
const ARCHIVE_LOOKBACK_DAYS = 365 * 6
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

const storeLocalJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[Storage] Failed to persist local cache for key:', key, error)
  }
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
  const dateStr = date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })

  if (range === 'today') {
    return `${time}\n${dateStr}`
  }

  if (range === 'week') {
    const dayStr = date.toLocaleDateString([], { weekday: 'short' })
    return `${time}\n${dayStr} ${dateStr}`
  }

  return `${time}\n${dateStr}`
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
  const [electricityUsageBuckets, setElectricityUsageBuckets] = useState<Array<{ timestamp: number; kwh: number }>>([])
  const [isLoadingUsage, setIsLoadingUsage] = useState(false)
  const [gasMeterReadings, setGasMeterReadings] = useState<Array<{ timestamp: number; value: number }>>([])
  const [showPriceModal, setShowPriceModal] = useState(false)
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false)
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

  const handleStartDateChange = useCallback((nextStartDate: string) => {
    setSelectedStartDate(nextStartDate)
    setSelectedEndDate((currentEndDate) => (nextStartDate > currentEndDate ? nextStartDate : currentEndDate))
  }, [])

  const handleEndDateChange = useCallback((nextEndDate: string) => {
    setSelectedEndDate(nextEndDate)
    setSelectedStartDate((currentStartDate) => (nextEndDate < currentStartDate ? nextEndDate : currentStartDate))
  }, [])

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
  const haEntitiesCacheKey = `ha_entities_cache_v4_${selectedEnvironment || 'default'}_${userCacheScope}`
  const userEnvironmentIdsCacheKey = `user_environment_ids_cache_v1_${userCacheScope}`
  const dynamicPriceCacheKey = `energy_dynamic_price_${selectedEnvironment || 'default'}`
  const dynamicPriceChartPreferenceKey = `energy_dynamic_chart_visible_${selectedEnvironment || 'default'}`
  const dynamicPriceFixedLinesPreferenceKey = `energy_dynamic_chart_show_fixed_lines_${selectedEnvironment || 'default'}`

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
        const response = await fetch('/.netlify/functions/get-ha-environments', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new Error('Unable to load environments')
        }

        const data = await response.json()
        const loaded: HaEnvironmentPayload[] = Array.isArray(data?.environments)
          ? data.environments
          : []
        const next = loaded.map((env: HaEnvironmentPayload) => ({
          id: String(env.id),
          name: String(env.name || env.id),
          type: env.type,
        }))
        if (!isDisposed) {
          setEnvironments(next)
        }
        localStorage.setItem(haEnvironmentsCacheKey, JSON.stringify(next))
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
      setSelectedEnvironment('')
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
    let isMounted = true

    const loadPricing = async () => {
      if (!selectedEnvironment) {
        setPricingConfig(null)
        return
      }

      const key = `energy_pricing_${selectedEnvironment}`

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
        const response = await fetch(`/.netlify/functions/get-energy-pricing?environmentId=${encodeURIComponent(selectedEnvironment)}`, {
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
          localStorage.setItem(key, JSON.stringify(normalized))
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
  }, [selectedEnvironment, isAuthenticated, getAuthToken])

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

          localStorage.setItem(dynamicPriceCacheKey, JSON.stringify({
            value: resolvedPrice,
            electricityValue: resolvedPrice,
            gasValue: resolvedGasPrice,
            updatedAt: new Date().toISOString(),
          }))
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
      }
    } catch {
      // Ignore entity cache parse errors.
    }
  }, [haEntitiesCacheKey, selectedEnvironment])

  // Load last known good values from Blobs — shown before live data arrives
  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated) {
      return
    }

    let isCancelled = false

    const loadSnapshot = async () => {
      try {
        const token = await getAuthToken()
        if (isCancelled) return
        const response = await fetch(
          `/.netlify/functions/save-snapshot?environmentId=${encodeURIComponent(selectedEnvironment)}`,
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

    const loadHaEntities = async (silent = false) => {
      const requestId = ++latestRequestId

      if (!isAuthenticated) {
        if (!silent) {
          setHaConnectionStatus('error')
        }
        return
      }
      if (!selectedEnvironment) {
        if (!silent) {
          setHaConnectionStatus('error')
        }
        return
      }
      
      if (!silent) {
        setHaLoading(true)
        setHaError(null)
        setHaConnectionStatus('connecting')
      }
      
      try {
        const token = await getAuthToken()
        if (isDisposed || requestId !== latestRequestId) {
          return
        }

        // eslint-disable-next-line no-console
        console.log(`[HA] ${silent ? '🔄 SILENT' : '📥 INITIAL'} refresh starting...`)
        
        const response = await fetch(`/.netlify/functions/ha-entities?environmentId=${selectedEnvironment}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (isDisposed || requestId !== latestRequestId) {
          return
        }
        
        // eslint-disable-next-line no-console
        console.log(`[HA] Response status: ${response.status}`)
        
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          // eslint-disable-next-line no-console
          console.error(`[HA] Error: ${data?.error || 'Unknown error'}`)
          if (!silent) {
            setHaConnectionStatus('error')
            setHaError(data?.error || 'Unable to load sensor data')
            setIsInitialLoading(false)
          }
          // NEVER clear entities on error - keep showing last known data
          return
        }
        
        const data = await response.json()
        if (isDisposed || requestId !== latestRequestId) {
          return
        }

        const entities = Array.isArray(data?.entities) ? data.entities : []
        const metrics = normalizeHaMetricsSnapshot(data?.metrics)
        // eslint-disable-next-line no-console
        console.log(`[HA] ✅ Loaded ${entities.length} entities`)
        
        // Update entities AND keep them as last known
        setHaEntities(entities)
        setLastKnownHaEntities(entities)
        setHaMetricsSnapshot(metrics)
        storeLocalJson(haEntitiesCacheKey, { entities, metrics })
        setHaConnectionStatus('connected')
        setHaError(null)

        // Persist latest known values to Netlify Blobs for offline fallback
        // Fire-and-forget: do NOT await, do NOT block rendering, do NOT show errors
        if (metrics && selectedEnvironment) {
          const SNAPSHOT_THROTTLE_MS = 5 * 60 * 1000 // 5 minutes
          const lastSent = snapshotSaveLastSentMs.get(selectedEnvironment) ?? 0
          if (Date.now() - lastSent > SNAPSHOT_THROTTLE_MS) {
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

        // eslint-disable-next-line no-console
        console.error('[HA] Fetch error:', error);
        if (!silent) {
          setHaError(error instanceof Error ? error.message : 'Unable to load sensor data')
          setHaConnectionStatus('error')
          setIsInitialLoading(false) // Set false on error too so we show last known data
        }
        // NEVER clear entities on error - keep showing last known data
      } finally {
        if (!silent) {
          setHaLoading(false)
        }
      }
    }
    
    // Initial load 
    // eslint-disable-next-line no-console
    console.log('[HA] Starting initial load...')
    void loadHaEntities(false)
    
    // Auto-refresh every 10 seconds - ALWAYS silent, NEVER affects UI on error
    const interval = setInterval(() => {
      void loadHaEntities(true)
    }, 10000)
    
    return () => {
      isDisposed = true
      latestRequestId += 1
      clearInterval(interval)
    }
  }, [getAuthToken, haEntitiesCacheKey, isAuthenticated, selectedEnvironment, haRefreshKey])

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

      const refresh = await fetch(`/.netlify/functions/ha-entities?environmentId=${selectedEnvironment}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

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
    
    // Helper function to parse numeric values from entity state
    const parseValue = (state: string): number => {
      const parsed = parseNumericValue(state)
      return Number.isFinite(parsed) ? parsed : 0
    }

    const environmentKey = selectedEnvironment || 'default'

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

      localStorage.setItem(keys.total, meterTotalKwh.toString())
      localStorage.setItem(keys.ts, now.toString())

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
        localStorage.setItem(keys.dailyDate, today)
        localStorage.setItem(keys.dailyBase, gasMeterTotal.toString())
      }

      if (storedMonthValue !== thisMonth || !Number.isFinite(storedMonthBase)) {
        monthBase = gasMeterTotal
        localStorage.setItem(keys.monthValue, thisMonth)
        localStorage.setItem(keys.monthBase, gasMeterTotal.toString())
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
      ['energy_total', 'total_energy', 'total_consumption', 'kwh_total', 'consumption_total'],
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

  const livePowerStorageKey = `energy_live_power_samples_v3_${selectedEnvironment || 'default'}_${powerHistoryScope}`
  const liveProductionStorageKey = `energy_live_production_samples_v2_${selectedEnvironment || 'default'}_${productionHistoryScope}`
  const liveGasStorageKey = `energy_gas_hourly_data_${selectedEnvironment || 'default'}`
  const historyArchiveStorageKey = `energy_history_archive_hourly_v2_${selectedEnvironment || 'default'}`
  const legacyHistoryArchiveStorageKeys = useMemo(
    () => [
      `energy_history_archive_hourly_v1_${selectedEnvironment || 'default'}_${powerHistoryScope}_${productionHistoryScope}`,
      `energy_history_archive_hourly_v1_${selectedEnvironment || 'default'}_fallback_fallback`,
    ],
    [selectedEnvironment, powerHistoryScope, productionHistoryScope],
  )
  const environmentInstalledOnStorageKey = `energy_environment_installed_on_v3_${selectedEnvironment || 'default'}`
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
        setPowerSamples([])
        return
      }

      const parsed = JSON.parse(stored)
      const cleaned = sanitizePowerSampleArray(parsed).slice(-MAX_LIVE_SAMPLE_POINTS)
      setPowerSamples(cleaned)
    } catch {
      setPowerSamples([])
    }
  }, [livePowerStorageKey])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(liveProductionStorageKey)
      if (!stored) {
        setProductionSamples([])
        return
      }

      const parsed = JSON.parse(stored)
      const cleaned = sanitizePowerSampleArray(parsed).slice(-MAX_LIVE_SAMPLE_POINTS)
      setProductionSamples(cleaned)
    } catch {
      setProductionSamples([])
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
    if (!selectedEnvironment || !isAuthenticated) {
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
        pushEntityId(metricSources?.gasTotalEntityId)
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
        const selectedIds = prioritizedIds.slice(0, 30)

        const url = `/.netlify/functions/ha-history?environmentId=${encodeURIComponent(selectedEnvironment)}&startTime=${encodeURIComponent(startTimeIso)}&endTime=${encodeURIComponent(endTimeIso)}&entityIds=${encodeURIComponent(selectedIds.join(','))}&mode=history`
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })

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
            localStorage.setItem(environmentInstalledOnStorageKey, String(canonicalInstalledOnMs))
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
  ])

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
    if (!selectedEnvironment || !isAuthenticated) {
      return
    }

    const fetchGasHourly = async () => {
      try {
        const token = await getAuthToken()
        const url = `/.netlify/functions/get-gas-hourly?environmentId=${encodeURIComponent(selectedEnvironment)}&hoursBack=200`
        
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          console.error('[Gas Hourly] Fetch failed:', response.status)
          return
        }

        const data = await response.json()
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
          // Cache in localStorage for instant display on next load
          localStorage.setItem(liveGasStorageKey, JSON.stringify(readings))
        } else {
          console.log('[Gas Hourly] No hourly data')
          setGasMeterReadings([])
        }
      } catch (error) {
        console.error('[Gas Hourly] Error:', error)
      }
    }

    fetchGasHourly()
    const interval = window.setInterval(fetchGasHourly, 5 * 60 * 1000) // Refresh every 5 min
    return () => window.clearInterval(interval)
  }, [getAuthToken, isAuthenticated, liveGasStorageKey, selectedEnvironment])

  // Pre-warm cache for week and month ranges so switching is instant
  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated || haEntities.length === 0) {
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
      const cacheKey = `ha_history_v5_${selectedEnvironment}_${cacheStartKey}_${cacheEndKey}`

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
        const url = `/.netlify/functions/ha-history?environmentId=${encodeURIComponent(selectedEnvironment)}&startTime=${encodeURIComponent(new Date(startMs).toISOString())}&endTime=${encodeURIComponent(new Date(clampedEnd).toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}`
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
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
          localStorage.setItem(cacheKey, JSON.stringify({ fetchTime: Date.now(), powerSamples, productionSamples }))
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
  }, [selectedEnvironment, isAuthenticated, haEntities.length, environmentInstalledOnMs, getAuthToken])

  // Clear stale bucket/statistic-ID caches when the selected environment changes
  const prevSelectedEnvironmentRef = useRef<string>('')
  useEffect(() => {
    const prev = prevSelectedEnvironmentRef.current
    if (prev && prev !== selectedEnvironment) {
      // Clear only keys belonging to the previous environment
      const keysToRemove = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
        (key): key is string =>
          key !== null && (
            key.startsWith(`ha_electricity_buckets_v3_${prev}_`) ||
            key === `ha_statistic_ids_v1_${prev}`
          ),
      )
      keysToRemove.forEach((k) => localStorage.removeItem(k))
    }
    prevSelectedEnvironmentRef.current = selectedEnvironment
  }, [selectedEnvironment])

  // Fetch electricity usage statistics (kWh per hour/day) — matches HA "Electricity usage" bar chart
  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated) {
      return
    }

    let isDisposed = false

    const fetchUsageStatistics = async () => {
      const bounds = getBoundsFromInputDates(selectedStartDate, selectedEndDate)
      const now = Date.now()
      const clampedEnd = Math.min(bounds.endMs, now)

      // For month range, clamp start to installed-on date (use the LATER of month-start and install date)
      const startMs = timeRange === 'month'
        ? Math.max(bounds.startMs, environmentInstalledOnMs ?? bounds.startMs)
        : bounds.startMs

      if (environmentInstalledOnMs && startMs === environmentInstalledOnMs) {
        console.log('[Usage Stats] startMs:', new Date(startMs).toISOString(), '(from installedOn)')
      } else {
        console.log('[Usage Stats] startMs:', new Date(startMs).toISOString())
      }

      if (clampedEnd <= startMs) return

      // statistics period: hour for today/week, day for month
      const period = timeRange === 'month' ? 'day' : 'hour'

      // --- Step C: load persistent incremental cache ---
      const bucketCacheKey = `ha_electricity_buckets_v3_${selectedEnvironment}_${period}`
      let cachedBuckets: Array<{ timestamp: number; kwh: number }> = []
      try {
        const raw = localStorage.getItem(bucketCacheKey)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed?.buckets)) {
            cachedBuckets = parsed.buckets
            // Show cached data immediately so chart is never blank on reload
            if (!isDisposed) setElectricityUsageBuckets(cachedBuckets)
          }
        }
      } catch { /* ignore */ }

      // Determine incremental fetch range: from (lastCachedBucket - 2h) to now
      let fetchStartMs = startMs
      if (cachedBuckets.length > 0) {
        const lastTs = cachedBuckets[cachedBuckets.length - 1].timestamp
        // Overlap by 2 hours to handle late-arriving data and bucket boundary alignment
        fetchStartMs = Math.max(startMs, lastTs - 2 * 3600_000)
      }

      // --- Step A: get confirmed statistic IDs from HA ---
      // Priority 1: use electricityConsumptionEntityIds + electricityProductionEntityIds from sources
      // (set by ha-entities.js enrichMetricsWithHistoryFallback from stored detection in Fix A)
      const sources = haMetricsSnapshotRef.current?.sources
      const storedConsumptionIds: string[] = Array.from(new Set([
        ...(sources?.electricityConsumptionEntityIds ?? []),
        ...(sources?.electricityTotalEntityIds ?? []),
        sources?.electricityTotalEntityId,
      ].filter((id): id is string => typeof id === 'string' && id.length > 0)))
      const storedProductionIds: string[] = Array.from(new Set([
        ...(sources?.electricityProductionEntityIds ?? []),
        ...(sources?.electricityProductionTotalEntityIds ?? []),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0)))

      // All entity IDs to fetch statistics for (consumption + production together)
      let entityIds: string[] = []
      // Track which IDs are production so we can build the net map
      let productionEntityIdsForFetch: string[] = []

      if (storedConsumptionIds.length > 0) {
        // Priority 1: use stored detection results
        entityIds = [...storedConsumptionIds, ...storedProductionIds]
        productionEntityIdsForFetch = storedProductionIds
        console.log('[Usage Stats] Using stored consumption IDs:', storedConsumptionIds.join(', '))
        if (storedProductionIds.length > 0) {
          console.log('[Usage Stats] Using stored production IDs:', storedProductionIds.join(', '))
        }
      } else {
        // Priority 2: try get-ha-statistic-ids then fall back to detectEnergyEntities
        const statisticIdCacheKey = `ha_statistic_ids_v1_${selectedEnvironment}`
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
              `/.netlify/functions/get-ha-statistic-ids?environmentId=${encodeURIComponent(selectedEnvironment)}`,
              { headers: { Authorization: `Bearer ${token}` } },
            )
            if (!isDisposed && idsResponse.ok) {
              const idsResult = await idsResponse.json()
              if (Array.isArray(idsResult?.statistic_ids) && idsResult.statistic_ids.length > 0) {
                entityIds = idsResult.statistic_ids
                try {
                  localStorage.setItem(statisticIdCacheKey, JSON.stringify({ fetchTime: Date.now(), ids: entityIds }))
                } catch { /* ignore quota errors */ }
              }
            }
          } catch (err) {
            console.warn('[Usage Stats] get-ha-statistic-ids failed, falling back:', err)
          }
        }

        if (entityIds.length === 0) {
          const detected = detectEnergyEntities(haEntitiesRef.current)
          entityIds = detected.electricityTotalEntityIds
        }
      }

      if (entityIds.length === 0) {
        console.log('[Usage Stats] No energy total entities found')
        return
      }

      console.log('[Usage Stats] Using statistic IDs from HA:', entityIds.join(', '))

      setIsLoadingUsage(true)

      try {
        const token = await getAuthToken()
        if (isDisposed) return

        let url = `/.netlify/functions/ha-history?environmentId=${encodeURIComponent(selectedEnvironment)}&startTime=${encodeURIComponent(new Date(fetchStartMs).toISOString())}&endTime=${encodeURIComponent(new Date(clampedEnd).toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}&mode=statistics&period=${period}`

        if (productionEntityIdsForFetch.length > 0) {
          url += `&productionEntityIds=${encodeURIComponent(productionEntityIdsForFetch.join(','))}`
        }

        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!response.ok || isDisposed) {
          if (!isDisposed) setIsLoadingUsage(false)
          return
        }

        const result = await response.json()
        if (isDisposed) return

        const historyData: Array<{ entity_id: string; is_production: boolean; history: Array<{ timestamp: number; change: number; value: number }> }> =
          Array.isArray(result?.entities) ? result.entities : []

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

        // Net map: consumption - production (values can be negative = net return feed hour)
        const netMap = new Map<number, number>()
        for (const [ts, consVal] of consumptionMap) {
          netMap.set(ts, consVal - (productionMap.get(ts) ?? 0))
        }
        // Also include any production-only buckets (if production > consumption for a bucket)
        for (const [ts, prodVal] of productionMap) {
          if (!netMap.has(ts)) {
            netMap.set(ts, -(prodVal))
          }
        }

        const newBuckets = Array.from(netMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([timestamp, kwh]) => ({ timestamp, kwh: Number(kwh.toFixed(3)) }))

        // Merge new buckets into cached buckets: overwrite same timestamps, append new ones
        const mergedMap = new Map<number, number>(cachedBuckets.map((b) => [b.timestamp, b.kwh]))
        for (const b of newBuckets) {
          mergedMap.set(b.timestamp, b.kwh)
        }
        // Only keep buckets within the current range
        const mergedBuckets = Array.from(mergedMap.entries())
          .filter(([ts]) => ts >= startMs && ts <= clampedEnd)
          .sort((a, b) => a[0] - b[0])
          .map(([timestamp, kwh]) => ({ timestamp, kwh }))

        if (!isDisposed) setElectricityUsageBuckets(mergedBuckets)

        if (mergedBuckets.length > 0) {
          const firstDate = new Date(mergedBuckets[0].timestamp).toISOString().slice(0, 10)
          const lastDate = new Date(mergedBuckets[mergedBuckets.length - 1].timestamp).toISOString().slice(0, 10)
          console.log(`[Usage Stats] Fetched ${mergedBuckets.length} buckets, range: ${firstDate} → ${lastDate}`)
        }

        try {
          localStorage.setItem(bucketCacheKey, JSON.stringify({ buckets: mergedBuckets }))
          console.log(`[Usage Stats] Cached ${mergedBuckets.length} buckets to localStorage`)
        } catch { /* ignore quota errors */ }
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
    haEntities.length,
    haMetricsSnapshot?.sources?.electricityTotalEntityId,
    haMetricsSnapshot?.sources?.electricityConsumptionEntityIds,
  ])

  // Fetch electricity history
  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated) {
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
        const cacheKey = `ha_history_v5_${selectedEnvironment}_${cacheStartKey}_${cacheEndKey}`
        // History data for power (kW) entities — cache for 5 min.
        const cacheTtlMs = 5 * 60_000
        let staleCachedSamples: PowerSample[] | null = null
        let staleCachedProductionSamples: PowerSample[] | null = null
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

        const productionEntity = preferredProductionEntity || detectedProductionEntity || currentHaEntities.find(
          (e) => {
            const id = e.entity_id.toLowerCase()
            return !id.startsWith('binary_sensor') && id.startsWith('sensor.') && (
              id.includes('production') ||
              id.includes('solar') ||
              id.includes('pv') ||
              id.includes('yield') ||
              id.includes('opwek') ||
              id.includes('opgewekt') ||
              id.includes('export') ||
              id.includes('injection') ||
              id.includes('teruglever')
            )
          },
        )

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
        const url = `/.netlify/functions/ha-history?environmentId=${encodeURIComponent(selectedEnvironment)}&startTime=${encodeURIComponent(startTime.toISOString())}&endTime=${encodeURIComponent(endTime.toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}`
        
        console.log('[HA History] Request URL:', url)

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })

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

          // Store fetched range samples directly so they are always visible for the selected date regardless of live-samples trim
          setHistoricalRangeSamples(newPowerSamples)

          setPowerSamples((prev) => {
            const trimmed = mergePowerSamples([prev, newPowerSamples], { maxPoints: MAX_LIVE_SAMPLE_POINTS })
            storeLocalJson(livePowerStorageKey, trimmed)
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

          setHistoricalProductionRangeSamples(newProductionSamples)

          setProductionSamples((prev) => {
            const trimmed = mergePowerSamples([prev, newProductionSamples], { maxPoints: MAX_LIVE_SAMPLE_POINTS })
            storeLocalJson(liveProductionStorageKey, trimmed)
            return trimmed
          })

          console.log('[HA History] Loaded', newProductionSamples.length, 'production samples')
        } else if (staleCachedProductionSamples === null) {
          // Only clear if we had nothing to show from stale cache
          setHistoricalProductionRangeSamples([])
        }

        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({
              fetchTime: Date.now(),
              powerSamples: newPowerSamples,
              productionSamples: newProductionSamples,
            }),
          )
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
      } catch (error) {
        console.error('[HA History] Error fetching historical data:', error)
        if (!isDisposed) setIsLoadingHistory(false)
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
    historyArchiveStorageKey,
    livePowerStorageKey,
    liveProductionStorageKey,
  ])

  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated) {
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
                  localStorage.setItem(environmentInstalledOnStorageKey, String(nextInstalledOnMs))
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

        const productionEntity = preferredProductionEntity || currentHaEntities.find(
          (entity) => {
            const id = entity.entity_id.toLowerCase()
            return !id.startsWith('binary_sensor') && id.startsWith('sensor.') && (
              id.includes('production') ||
              id.includes('solar') ||
              id.includes('pv') ||
              id.includes('yield') ||
              id.includes('opwek') ||
              id.includes('opgewekt') ||
              id.includes('export') ||
              id.includes('injection') ||
              id.includes('teruglever')
            )
          },
        )

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

        const archiveUrl = `/.netlify/functions/ha-history?environmentId=${encodeURIComponent(selectedEnvironment)}&startTime=${encodeURIComponent(archiveStartTime.toISOString())}&endTime=${encodeURIComponent(archiveEndTime.toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}&mode=statistics&period=hour`

        const response = await fetch(archiveUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })

        let historyData: any[] = []
        if (response.ok) {
          const result = await response.json()
          if (isDisposed) {
            return
          }

          historyData = Array.isArray(result?.entities) ? result.entities : []
        } else {
          console.warn('[HA History] Statistics bootstrap failed, trying history fallback for month window')
        }

        const hasStatisticsRows = historyData.some(
          (entry) => Array.isArray(entry?.history) && entry.history.length > 0,
        )

        if (!hasStatisticsRows) {
          const selectedBounds = getBoundsFromInputDates(selectedStartDate, selectedEndDate)
          const fallbackStartMs = Math.max(0, selectedBounds.startMs - 24 * 60 * 60_000)
          const fallbackHistoryUrl = `/.netlify/functions/ha-history?environmentId=${encodeURIComponent(selectedEnvironment)}&startTime=${encodeURIComponent(new Date(fallbackStartMs).toISOString())}&endTime=${encodeURIComponent(archiveEndTime.toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}&mode=history`

          const historyFallbackResponse = await fetch(fallbackHistoryUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          })

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
            localStorage.setItem(environmentInstalledOnStorageKey, String(nextInstalledOnMs))
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
        storeLocalJson(livePowerStorageKey, trimmed)
        return trimmed
      })

      setProductionSamples((prev) => {
        const lastSample = prev[prev.length - 1]
        if (lastSample && now - lastSample.timestamp < 8000) {
          return prev
        }

        const next = [...prev, { timestamp: now, power: latestProductionRef.current }]
        const trimmed = next.slice(-MAX_LIVE_SAMPLE_POINTS)
        storeLocalJson(liveProductionStorageKey, trimmed)
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

    const anchorDate = parseInputDate(selectedEndDate) || new Date()
    const nextStart = new Date(anchorDate)

    if (nextRange === 'week') {
      nextStart.setDate(anchorDate.getDate() - 6)
    } else if (nextRange === 'month') {
      nextStart.setDate(1)
    }

    setSelectedStartDate(formatDateForInput(nextStart))
    setSelectedEndDate(formatDateForInput(anchorDate))
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

      if (readings.length < 2) {
        return [] as Array<{ start: number; change: number }>
      }

      const bucketStart = Math.floor(startMs / bucketMs) * bucketMs
      const bucketEnd = Math.ceil(endMs / bucketMs) * bucketMs
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
      const staleThresholdMs = Math.max(bucketMs * 3, 45 * 60_000)

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

        while (powerIndex < sortedPower.length && sortedPower[powerIndex].timestamp < nextT) {
          lastKnownPower = sortedPower[powerIndex].power
          lastPowerTimestamp = sortedPower[powerIndex].timestamp
          powerIndex += 1
        }

        while (productionIndex < sortedProduction.length && sortedProduction[productionIndex].timestamp < nextT) {
          lastKnownProduction = sortedProduction[productionIndex].power
          lastProductionTimestamp = sortedProduction[productionIndex].timestamp
          productionIndex += 1
        }

        const isFutureBucket = t > nowMs
        const hasPowerValue = lastKnownPower !== null && lastPowerTimestamp !== null && (nextT - lastPowerTimestamp) <= staleThresholdMs
        const hasProductionValue = lastKnownProduction !== null && lastProductionTimestamp !== null && (nextT - lastProductionTimestamp) <= staleThresholdMs

        let bucketValue: number | null = null
        if (!isFutureBucket) {
          if (powerSeriesIsSigned) {
            bucketValue = hasPowerValue ? lastKnownPower : null
          } else if (hasPowerValue || hasProductionValue) {
            const powerValue = hasPowerValue ? Number(lastKnownPower) : 0
            const productionValue = hasProductionValue ? Number(lastKnownProduction) : 0
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
    const rangeSpanMs = Math.max(0, electricityRange.endMs - electricityRange.startMs)
    const bucketMs = timeRange === 'today'
      ? 60_000
      : timeRange === 'week'
        ? 15 * 60_000
        : rangeSpanMs > 120 * 24 * 60 * 60_000
          ? 6 * 60 * 60_000
          : rangeSpanMs > 45 * 24 * 60 * 60_000
            ? 60 * 60_000
            : 15 * 60_000

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
  const electricityUsageChartData = useMemo(() => {
    if (electricityUsageBuckets.length === 0) return [] as Array<{ time: string; power: number | null }>
    return electricityUsageBuckets
      .filter((b) => b.timestamp >= electricityRange.startMs && b.timestamp <= electricityRange.endMs)
      .map((b) => ({
        time: formatChartAxisLabel(b.timestamp, timeRange),
        power: b.kwh,
      }))
  }, [electricityUsageBuckets, electricityRange.startMs, electricityRange.endMs, timeRange])

  const gasChartData = useMemo(() => {
    const bucketMs = timeRange === 'today' ? 3_600_000 : 86_400_000
    const buckets = bucketGasReadings(selectedRange.startMs, selectedRange.endMs, bucketMs)

    if (buckets.length === 0) {
      // No local readings yet — show empty chart
      return [{ time: '', power: 0 }]
    }

    return buckets.map((b) => {
      const time = formatChartAxisLabel(b.start, timeRange)
      return { time, power: Math.max(0, b.change) }
    })
  }, [bucketGasReadings, selectedRange.startMs, selectedRange.endMs, timeRange])

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
        .reduce((sum, b) => sum + b.kwh, 0)
        .toFixed(2),
    )
  }, [electricityUsageBuckets, electricityRange.startMs, electricityRange.endMs])

  // Card total always equals sum of chart buckets — single source of truth
  // When viewing today: use today chart total; when viewing month: use month chart total.
  const electricityTodayCardValue = useMemo(() => {
    if (timeRange === 'today' && electricityUsageTotal > 0) {
      return electricityUsageTotal
    }
    return realTimeData.dailyUsage
  }, [timeRange, electricityUsageTotal, realTimeData.dailyUsage])

  const electricityMonthCardValue = useMemo(() => {
    if (timeRange === 'month' && electricityUsageTotal > 0) {
      return electricityUsageTotal
    }
    return realTimeData.monthlyUsage
  }, [timeRange, electricityUsageTotal, realTimeData.monthlyUsage])

  // Gas card values: use local meter readings to compute daily/monthly totals
  const gasTodayCardValue = useMemo(() => {
    if (haMetricsSnapshot?.dailyGasM3 !== null && haMetricsSnapshot?.dailyGasM3 !== undefined) {
      return parseFloat(Math.max(0, haMetricsSnapshot.dailyGasM3).toFixed(2))
    }

    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
    const readings = gasMeterReadings.filter((r) => r.timestamp >= startOfToday)
    if (readings.length >= 2) {
      const total = Math.max(0, readings[readings.length - 1].value - readings[0].value)
      return parseFloat(total.toFixed(2))
    }
    return realTimeData.gasDailyUsage
  }, [gasMeterReadings, haMetricsSnapshot?.dailyGasM3, realTimeData.gasDailyUsage])

  const gasMonthCardValue = useMemo(() => {
    if (haMetricsSnapshot?.monthlyGasM3 !== null && haMetricsSnapshot?.monthlyGasM3 !== undefined) {
      return parseFloat(Math.max(0, haMetricsSnapshot.monthlyGasM3).toFixed(2))
    }

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime()
    const readings = gasMeterReadings.filter((r) => r.timestamp >= startOfMonth)
    if (readings.length >= 2) {
      const total = Math.max(0, readings[readings.length - 1].value - readings[0].value)
      return parseFloat(total.toFixed(2))
    }
    return realTimeData.gasMonthlyUsage
  }, [gasMeterReadings, haMetricsSnapshot?.monthlyGasM3, realTimeData.gasMonthlyUsage])

  const gasTodayCardCost = parseFloat((gasTodayCardValue * gasRatePerM3).toFixed(2))
  const gasMonthCardCost = parseFloat((gasMonthCardValue * gasRatePerM3).toFixed(2))

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

    addDriftIssue('Electricity today', realTimeData.dailyUsage, haMetricsSnapshot.dailyElectricityKwh, 'kWh', 0.01)
    addDriftIssue('Electricity month', realTimeData.monthlyUsage, haMetricsSnapshot.monthlyElectricityKwh, 'kWh', 0.01)
    addDriftIssue('Gas today', gasTodayCardValue, haMetricsSnapshot.dailyGasM3, 'm3', 0.01)
    addDriftIssue('Gas month', gasMonthCardValue, haMetricsSnapshot.monthlyGasM3, 'm3', 0.01)

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
      addDriftIssue('Gas chart day total', gasSelectedPeriodTotal, haMetricsSnapshot.dailyGasM3, 'm3', 0.05)
      if (electricityUsageBuckets.length > 0 && electricityUsageTotal > 0) {
        addDriftIssue('Electricity usage chart day total', electricityUsageTotal, haMetricsSnapshot.dailyElectricityKwh, 'kWh', 0.5)
      }
    }
    if (timeRange === 'month') {
      if (electricityUsageBuckets.length > 0 && electricityUsageTotal > 0) {
        addDriftIssue('Electricity usage chart month total', electricityUsageTotal, haMetricsSnapshot.monthlyElectricityKwh, 'kWh', 1.0)
      }
    }

    return issues
  }, [
    electricityUsageBuckets,
    electricityUsageTotal,
    gasMonthCardValue,
    gasSelectedPeriodTotal,
    gasTodayCardValue,
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
      console.warn('[API consistency] Detected metric drift:', {
        environmentId: selectedEnvironment,
        issues: apiConsistencyIssues,
      })
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <EnergyCard
            title="Electricity Today"
            value={electricityTodayCardValue}
            unit="kWh"
            cost={realTimeData.electricityCostToday}
            icon="zap"
          />
          <EnergyCard
            title="Electricity This Month"
            value={electricityMonthCardValue}
            unit="kWh"
            cost={realTimeData.electricityCostMonth}
            icon="calendar"
          />
          <EnergyCard
            title="Gas Today"
            value={gasTodayCardValue}
            unit="m³"
            cost={gasTodayCardCost}
            icon="flame"
          />
          <EnergyCard
            title="Gas This Month"
            value={gasMonthCardValue}
            unit="m³"
            cost={gasMonthCardCost}
            icon="flame"
          />
        </div>

        {/* Time Range Selector */}
        <div className="glass-panel rounded-xl shadow-lg p-4 mb-8">
          <div className="flex flex-col md:flex-row md:items-center gap-4">
            <div className="flex gap-4 flex-1">
              <button
                onClick={() => handleTimeRangeChange('today')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'today'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Day
              </button>
              <button
                onClick={() => handleTimeRangeChange('week')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'week'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Week
              </button>
              <button
                onClick={() => handleTimeRangeChange('month')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'month'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Month
              </button>
            </div>
            <div className="md:w-[26rem]">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-light-1 mb-1">Start date</label>
                  <input
                    type="date"
                    value={selectedStartDate}
                    max={selectedEndDate}
                    onChange={(event) => handleStartDateChange(event.target.value)}
                    className="w-full bg-dark-2 bg-opacity-70 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                  />
                </div>
                <div>
                  <label className="block text-xs text-light-1 mb-1">End date</label>
                  <input
                    type="date"
                    value={selectedEndDate}
                    min={selectedStartDate}
                    onChange={(event) => handleEndDateChange(event.target.value)}
                    className="w-full bg-dark-2 bg-opacity-70 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                  />
                </div>
              </div>
            </div>
          </div>
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
          {/* Power Sources Chart (instantaneous kW) */}
          <div className="glass-panel rounded-3xl shadow-2xl p-4 sm:p-6 md:p-8">
            <h2 className="text-2xl font-heavy text-dark-1 mb-6 flex items-center gap-2">
              <Clock className="w-6 h-6 text-brand-2" />
              Power sources
              {isLoadingHistory && (
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
              data={chartData}
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
              {!isLoadingUsage && electricityUsageTotal > 0 && (
                <span className="inline-flex items-center rounded-full bg-brand-2/15 px-3 py-1 text-sm font-semibold text-brand-2">
                  +{electricityUsageTotal.toFixed(2)} kWh
                </span>
              )}
            </div>
            <EnergyChart
              data={electricityUsageChartData}
              timeRange={timeRange}
              unit="kWh"
              seriesLabel="Electricity usage"
              rangeLabel={electricityRange.label}
              chartType="bar"
            />
          </div>

          {/* Gas Chart */}
          <div className="glass-panel rounded-3xl shadow-2xl p-4 sm:p-6 md:p-8">
            <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-2xl font-heavy text-dark-1 flex items-center gap-2">
                <Flame className="w-6 h-6 text-brand-2" />
                Gas consumption
              </h2>
              {gasSelectedPeriodTotal > 0 && (
                <span className="inline-flex items-center rounded-full bg-orange-500/15 px-3 py-1 text-sm font-semibold text-orange-400">
                  {gasSelectedPeriodTotal.toFixed(2)} m³
                </span>
              )}
            </div>
            <EnergyChart
              data={gasChartData}
              timeRange={timeRange}
              unit="m³"
              seriesLabel="Gas chart"
              rangeLabel={selectedRange.label}
              chartType="bar"
            />
          </div>

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
            environmentId={selectedEnvironment}
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
            environmentId={selectedEnvironment}
            onClose={() => setShowPriceModal(false)}
            onSave={(config) => setPricingConfig(config)}
            getAuthToken={getAuthToken}
          />
        )}
      </div>
    </div>
  )
}
