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

interface HaMetricsSnapshot {
  currentPowerKw: number | null
  dailyElectricityKwh: number | null
  monthlyElectricityKwh: number | null
  dailyGasM3: number | null
  monthlyGasM3: number | null
  powerEntityId: string | null
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
  
  if (range === 'today') {
    // For today: show time on top line, date on bottom
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const dateStr = date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
    return `${time}\n${dateStr}`
  } else if (range === 'week') {
    // For week: show date with weekday
    const dateStr = date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
    const dayStr = date.toLocaleDateString([], { weekday: 'short' })
    return `${dayStr}\n${dateStr}`
  } else {
    // For month: just date
    return date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
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

  return {
    currentPowerKw: toNumberOrNull(value.currentPowerKw),
    dailyElectricityKwh: toNumberOrNull(value.dailyElectricityKwh),
    monthlyElectricityKwh: toNumberOrNull(value.monthlyElectricityKwh),
    dailyGasM3: toNumberOrNull(value.dailyGasM3),
    monthlyGasM3: toNumberOrNull(value.monthlyGasM3),
    powerEntityId: typeof value?.sources === 'object' && value?.sources !== null &&
      typeof (value.sources as Record<string, unknown>).currentPowerEntityId === 'string'
      ? String((value.sources as Record<string, unknown>).currentPowerEntityId)
      : null,
  }
}

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
  const [selectedChartDate, setSelectedChartDate] = useState<string>(formatDateForInput(new Date()))
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
  const [gasMeterReadings, setGasMeterReadings] = useState<Array<{ timestamp: number; value: number }>>([])
  const [showPriceModal, setShowPriceModal] = useState(false)
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false)
  const [pricingConfig, setPricingConfig] = useState<EnergyPricingConfig | null>(null)
  const [dynamicConsumerPriceKwh, setDynamicConsumerPriceKwh] = useState<number | null>(null)
  const [showDynamicPriceChart, setShowDynamicPriceChart] = useState(false)
  const [dynamicPricePoints, setDynamicPricePoints] = useState<DynamicPricePoint[]>([])
  const [dynamicPriceUpdatedAt, setDynamicPriceUpdatedAt] = useState<string | null>(null)
  const [dynamicPriceChartLoading, setDynamicPriceChartLoading] = useState(false)
  const [dynamicPriceChartError, setDynamicPriceChartError] = useState<string | null>(null)
  const [showFixedPriceLinesOnChart, setShowFixedPriceLinesOnChart] = useState(true)
  // Sensor connection status: 'connecting' | 'connected' | 'error'
  const [_haConnectionStatus, setHaConnectionStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently, user } = useAuth0()

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
  const dynamicPriceCacheKey = `energy_dynamic_price_${selectedEnvironment || 'default'}`
  const dynamicPriceChartPreferenceKey = `energy_dynamic_chart_visible_${selectedEnvironment || 'default'}`
  const dynamicPriceFixedLinesPreferenceKey = `energy_dynamic_chart_show_fixed_lines_${selectedEnvironment || 'default'}`

  useEffect(() => {
    const loadEnvironments = async () => {
      if (!isAuthenticated) {
        setEnvironments([])
        return
      }

      try {
        const cached = localStorage.getItem(haEnvironmentsCacheKey)
        if (cached) {
          const parsed = JSON.parse(cached)
          const cachedEnvironments = normalizeEnvironmentConfigs(parsed)

          if (cachedEnvironments.length > 0) {
            setEnvironments(cachedEnvironments)
          }
        }
      } catch {
        // Ignore cache parse errors and continue with network fetch.
      }

      setEnvLoading(true)
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
        setEnvironments(next)
        localStorage.setItem(haEnvironmentsCacheKey, JSON.stringify(next))
      } catch (error) {
        setEnvError(error instanceof Error ? error.message : 'Unable to load environments')
      } finally {
        setEnvLoading(false)
      }
    }

    void loadEnvironments()
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
    const getAuthToken = async () => {
      const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
      return getAccessTokenSilently({
        authorizationParams: { audience },
      })
    }

    const loadAssignments = async () => {
      setIsCheckingPermissions(true)
      
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

      try {
        const claims = await getIdTokenClaims()
        const envClaim = 'https://brouwer-ems/environments'
        const envs = (claims?.[envClaim] as string[] | undefined) ?? null

        if (envs && envs.length > 0) {
          setAllowedEnvironmentIds(envs)
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
      } catch {
        setAllowedEnvironmentIds([])
      } finally {
        setIsCheckingPermissions(false)
      }
    }

    void loadAssignments()
  }, [getAccessTokenSilently, getIdTokenClaims, isAuthenticated, isAdmin])

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
        if (resolvedPrice !== null && Number.isFinite(resolvedPrice) && resolvedPrice >= 0) {
          setDynamicConsumerPriceKwh(resolvedPrice)
          localStorage.setItem(dynamicPriceCacheKey, JSON.stringify({
            value: resolvedPrice,
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
    getAuthToken,
    isAuthenticated,
    selectedEnvironment,
    showDynamicPriceChart,
  ])

  useEffect(() => {
    if (!selectedEnvironment || pricingConfig?.type !== 'dynamic') {
      setDynamicConsumerPriceKwh(null)
      return
    }

    try {
      const cached = localStorage.getItem(dynamicPriceCacheKey)
      if (!cached) {
        return
      }

      const parsed = JSON.parse(cached)
      const value = Number(parsed?.value)
      if (Number.isFinite(value) && value >= 0) {
        setDynamicConsumerPriceKwh(value)
      }
    } catch {
      // Ignore parse errors and refresh from API.
    }
  }, [dynamicPriceCacheKey, pricingConfig?.type, selectedEnvironment])

  useEffect(() => {
    setHaEntities([])
    setLastKnownHaEntities([])
    setHaMetricsSnapshot(null)
    setIsInitialLoading(true)

    if (!selectedEnvironment) {
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
    const loadHaEntities = async (silent = false) => {
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
        // eslint-disable-next-line no-console
        console.log(`[HA] ${silent ? '🔄 SILENT' : '📥 INITIAL'} refresh starting...`)
        
        const response = await fetch(`/.netlify/functions/ha-entities?environmentId=${selectedEnvironment}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        
        // eslint-disable-next-line no-console
        console.log(`[HA] Response status: ${response.status}`)
        
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          // eslint-disable-next-line no-console
          console.error(`[HA] Error: ${data?.error || 'Unknown error'}`)
          if (!silent) {
            setHaConnectionStatus('error')
            setHaError(data?.error || 'Unable to load sensor data')
          }
          // NEVER clear entities on error - keep showing last known data
          return
        }
        
        const data = await response.json()
        const entities = Array.isArray(data?.entities) ? data.entities : []
        const metrics = normalizeHaMetricsSnapshot(data?.metrics)
        // eslint-disable-next-line no-console
        console.log(`[HA] ✅ Loaded ${entities.length} entities`)
        
        // Update entities AND keep them as last known
        setHaEntities(entities)
        setLastKnownHaEntities(entities)
        setHaMetricsSnapshot(metrics)
        localStorage.setItem(haEntitiesCacheKey, JSON.stringify({ entities, metrics }))
        
        if (!silent) {
          setHaConnectionStatus('connected')
          setHaError(null)
          setIsInitialLoading(false) // Only set false on successful initial load
        }
      } catch (error) {
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
    
    return () => clearInterval(interval)
  }, [getAccessTokenSilently, haEntitiesCacheKey, isAuthenticated, selectedEnvironment, haRefreshKey])

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
        localStorage.setItem(
          haEntitiesCacheKey,
          JSON.stringify({ entities: refreshedEntities, metrics: refreshedMetrics }),
        )
      }
    } catch (error) {
      setHaError(error instanceof Error ? error.message : 'Unable to run action')
    } finally {
      setHaActionId(null)
    }
  }

  const configuredGasPrice = Number(import.meta.env.VITE_DEFAULT_GAS_PRICE_EUR_PER_M3)
  const gasRatePerM3 = Number.isFinite(configuredGasPrice) && configuredGasPrice > 0 ? configuredGasPrice : 1.35

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

        return isPowerUnit(entity.unit_of_measurement) && Number.isFinite(parseNumericValue(entity.state))
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

    // Helper function to track energy usage locally when no sensor available
    const trackEnergyLocally = (currentPower: number): { daily: number; monthly: number } => {
      const now = new Date()
      const today = now.toDateString()
      const thisMonth = `${now.getFullYear()}-${now.getMonth() + 1}`
      
      // Get stored tracking data
      const keys = {
        daily: `energy_daily_${environmentKey}`,
        monthly: `energy_monthly_${environmentKey}`,
        date: `energy_date_${environmentKey}`,
        month: `energy_month_${environmentKey}`,
        lastUpdate: `energy_last_update_${environmentKey}`,
      }

      const storedDaily = localStorage.getItem(keys.daily)
      const storedMonthly = localStorage.getItem(keys.monthly)
      const storedDate = localStorage.getItem(keys.date)
      const storedMonth = localStorage.getItem(keys.month)
      const lastUpdate = localStorage.getItem(keys.lastUpdate)
      
      let dailyTotal = 0
      let monthlyTotal = 0
      
      // Reset daily if new day
      if (storedDate !== today) {
        localStorage.setItem(keys.date, today)
        localStorage.setItem(keys.daily, '0')
        dailyTotal = 0
      } else {
        dailyTotal = storedDaily ? parseFloat(storedDaily) : 0
      }
      
      // Reset monthly if new month
      if (storedMonth !== thisMonth) {
        localStorage.setItem(keys.month, thisMonth)
        localStorage.setItem(keys.monthly, '0')
        monthlyTotal = 0
      } else {
        monthlyTotal = storedMonthly ? parseFloat(storedMonthly) : 0
      }
      
      // Calculate energy used since last update (Power in kW × time in hours = kWh)
      if (lastUpdate && currentPower > 0) {
        const lastTime = new Date(lastUpdate).getTime()
        const nowTime = now.getTime()
        const hoursElapsed = (nowTime - lastTime) / (1000 * 60 * 60)
        
        // Only add if less than 1 hour elapsed (prevents big jumps on page reload)
        if (hoursElapsed < 1) {
          const energyUsed = currentPower * hoursElapsed
          dailyTotal += energyUsed
          monthlyTotal += energyUsed
          
          localStorage.setItem(keys.daily, dailyTotal.toString())
          localStorage.setItem(keys.monthly, monthlyTotal.toString())
        }
      }
      
      // Update last timestamp
      localStorage.setItem(keys.lastUpdate, now.toISOString())
      
      return {
        daily: dailyTotal,
        monthly: monthlyTotal,
      }
    }

    const trackEnergyFromMeter = (meterTotal: number): { daily: number; monthly: number } => {
      const now = new Date()
      const today = now.toDateString()
      const thisMonth = `${now.getFullYear()}-${now.getMonth() + 1}`
      const keys = {
        dailyDate: `energy_meter_daily_date_${environmentKey}`,
        dailyBase: `energy_meter_daily_base_${environmentKey}`,
        monthValue: `energy_meter_month_${environmentKey}`,
        monthBase: `energy_meter_month_base_${environmentKey}`,
      }

      const storedDailyDate = localStorage.getItem(keys.dailyDate)
      const storedDailyBase = parseFloat(localStorage.getItem(keys.dailyBase) || '0')
      const storedMonthValue = localStorage.getItem(keys.monthValue)
      const storedMonthBase = parseFloat(localStorage.getItem(keys.monthBase) || '0')

      let dailyBase = storedDailyBase
      let monthBase = storedMonthBase

      if (storedDailyDate !== today || !Number.isFinite(storedDailyBase)) {
        dailyBase = meterTotal
        localStorage.setItem(keys.dailyDate, today)
        localStorage.setItem(keys.dailyBase, meterTotal.toString())
      }

      if (storedMonthValue !== thisMonth || !Number.isFinite(storedMonthBase)) {
        monthBase = meterTotal
        localStorage.setItem(keys.monthValue, thisMonth)
        localStorage.setItem(keys.monthBase, meterTotal.toString())
      }

      return {
        daily: Math.max(0, meterTotal - dailyBase),
        monthly: Math.max(0, meterTotal - monthBase),
      }
    }

    const calculateUsageFromPowerSamples = (startMs: number, endMs: number) => {
      if (powerSamples.length < 2) {
        return 0
      }

      const sorted = [...powerSamples]
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
    let currentPower = powerEntity ? parseValue(powerEntity.state) : 0
    
    // eslint-disable-next-line no-console
    console.log('[Energy] Power entity:', powerEntity?.entity_id, '=', powerEntity?.state)
    
    currentPower = convertPowerToKw(currentPower, powerEntity?.unit_of_measurement)

    // Find daily/monthly/total electricity sensors (in kWh)
    const dailyEntity = findEntity(
      ['energy_today', 'daily_energy', 'today_energy', 'day_energy', 'daily', 'today'],
      ['gas', 'price', 'cost', 'tariff'],
    )
    const monthlyEntity = findEntity(
      ['energy_month', 'monthly_energy', 'month_energy', 'monthly', 'this_month', 'month'],
      ['gas', 'price', 'cost', 'tariff'],
    )
    const totalEnergyEntity = findEntity(
      ['energy_total', 'total_energy', 'total_consumption', 'kwh_total', 'consumption_total'],
      ['gas', 'price', 'cost', 'tariff'],
    )

    if (serverMetrics?.currentPowerKw !== null && serverMetrics?.currentPowerKw !== undefined) {
      currentPower = serverMetrics.currentPowerKw
    } else if (currentPower <= 0 && totalEnergyEntity) {
      currentPower = derivePowerFromEnergyMeter(parseValue(totalEnergyEntity.state))
    }

    // eslint-disable-next-line no-console
    console.log(
      '[Energy] Detected sensors - Daily:',
      dailyEntity?.entity_id,
      'Monthly:',
      monthlyEntity?.entity_id,
      'Total:',
      totalEnergyEntity?.entity_id,
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

    const sampledDailyUsage = calculateUsageFromPowerSamples(startOfToday, nowTime)
    const sampledMonthlyUsage = calculateUsageFromPowerSamples(startOfMonth, nowTime)
    
    if (dailyEntity && monthlyEntity) {
      // Use sensor data
      dailyUsage = parseValue(dailyEntity.state)
      monthlyUsage = parseValue(monthlyEntity.state)

      // eslint-disable-next-line no-console
      console.log('[Energy] Using daily+monthly sensors - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else if (totalEnergyEntity) {
      const trackedFromMeter = trackEnergyFromMeter(parseValue(totalEnergyEntity.state))
      dailyUsage = dailyEntity ? parseValue(dailyEntity.state) : trackedFromMeter.daily
      monthlyUsage = monthlyEntity
        ? parseValue(monthlyEntity.state)
        : trackedFromMeter.monthly

      // eslint-disable-next-line no-console
      console.log('[Energy] Using total meter fallback - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else if (dailyEntity) {
      dailyUsage = parseValue(dailyEntity.state)

      if (sampledMonthlyUsage > 0) {
        monthlyUsage = sampledMonthlyUsage
      } else {
        const tracked = trackEnergyLocally(currentPower)
        monthlyUsage = Math.max(tracked.monthly, dailyUsage)
      }

      // eslint-disable-next-line no-console
      console.log('[Energy] Using daily sensor + sample/local monthly fallback - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else if (sampledDailyUsage > 0 || sampledMonthlyUsage > 0) {
      dailyUsage = sampledDailyUsage
      monthlyUsage = sampledMonthlyUsage

      // eslint-disable-next-line no-console
      console.log('[Energy] Using sampled history fallback - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else {
      // Track locally from power readings
      const tracked = trackEnergyLocally(currentPower)
      dailyUsage = tracked.daily
      monthlyUsage = tracked.monthly
      // eslint-disable-next-line no-console
      console.log('[Energy] Tracking locally - Daily:', dailyUsage.toFixed(3), 'kWh, Monthly:', monthlyUsage.toFixed(3), 'kWh')
    }

    if (serverMetrics?.dailyElectricityKwh !== null && serverMetrics?.dailyElectricityKwh !== undefined) {
      dailyUsage = serverMetrics.dailyElectricityKwh
    }
    if (serverMetrics?.monthlyElectricityKwh !== null && serverMetrics?.monthlyElectricityKwh !== undefined) {
      monthlyUsage = serverMetrics.monthlyElectricityKwh
    }

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
    const electricityCostToday = dailyUsage * consumerRate
    const electricityCostMonth = monthlyUsage * consumerRate
    const gasCostToday = gasDailyUsage * gasRatePerM3
    const gasCostMonth = gasMonthlyUsage * gasRatePerM3
    const totalCostToday = electricityCostToday + gasCostToday
    const totalCostMonth = electricityCostMonth + gasCostMonth

    return {
      currentPower: parseFloat(currentPower.toFixed(2)),
      dailyUsage: parseFloat(dailyUsage.toFixed(1)),
      monthlyUsage: parseFloat(monthlyUsage.toFixed(1)),
      gasDailyUsage: parseFloat(gasDailyUsage.toFixed(2)),
      gasMonthlyUsage: parseFloat(gasMonthlyUsage.toFixed(2)),
      gasChartValue: parseFloat(gasChartValue.toFixed(3)),
      electricityCostToday: parseFloat(electricityCostToday.toFixed(2)),
      electricityCostMonth: parseFloat(electricityCostMonth.toFixed(2)),
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
    selectedEnvironment,
    gasRatePerM3,
    powerSamples,
  ])

  const powerHistoryScope = useMemo(() => {
    const source = haMetricsSnapshot?.powerEntityId || 'fallback'
    return String(source).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120)
  }, [haMetricsSnapshot?.powerEntityId])

  const livePowerStorageKey = `energy_live_power_samples_${selectedEnvironment || 'default'}_${powerHistoryScope}`
  const liveGasStorageKey = `energy_gas_hourly_data_${selectedEnvironment || 'default'}`
  const latestPowerRef = useRef(realTimeData.currentPower)

  useEffect(() => {
    latestPowerRef.current = realTimeData.currentPower
  }, [realTimeData.currentPower])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(livePowerStorageKey)
      if (!stored) {
        setPowerSamples([])
        return
      }

      const parsed: PowerSample[] = JSON.parse(stored)
      if (!Array.isArray(parsed)) {
        return
      }

      const cleaned = parsed.filter(
        (sample) => typeof sample.timestamp === 'number' && typeof sample.power === 'number',
      )
      setPowerSamples(cleaned)
    } catch {
      setPowerSamples([])
    }
  }, [livePowerStorageKey])

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

  // Fetch electricity history
  useEffect(() => {
    if (!selectedEnvironment || !isAuthenticated) {
      return
    }

    const fetchHistoricalData = async () => {
      try {
        console.log('[HA History] Starting fetch for environment:', selectedEnvironment)

        const preferredPowerEntityId = haMetricsSnapshot?.powerEntityId || null
        const powerHistoryScopeKey = String(preferredPowerEntityId || 'fallback')
          .replace(/[^a-zA-Z0-9_.-]/g, '_')
          .slice(0, 120)

        // Get last fetch timestamp from localStorage
        const lastFetchKey = `ha_history_last_fetch_${selectedEnvironment}_${powerHistoryScopeKey}`
        const lastFetchStr = localStorage.getItem(lastFetchKey)
        const lastFetch = lastFetchStr ? new Date(lastFetchStr) : null

        const now = new Date()
        const isIncrementalFetch = Boolean(
          lastFetch && (now.getTime() - lastFetch.getTime()) < 8 * 24 * 60 * 60 * 1000,
        )
        const startTime = isIncrementalFetch
          ? new Date(lastFetch!.getTime() - 60000)
          : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

        if (isIncrementalFetch) {
          console.log('[HA History] Incremental fetch from', startTime.toISOString())
        } else {
          console.log('[HA History] Full 7-day fetch from', startTime.toISOString())
        }

        // Find power entity - prefer server-selected metrics source for admin/non-admin parity.
        const powerEntity = preferredPowerEntityId
          ? { entity_id: preferredPowerEntityId }
          : haEntities.find(
            (e) => {
              const id = e.entity_id.toLowerCase()
              // Prioritize electricity meter, exclude binary sensors
              return !id.startsWith('binary_sensor') && (
                id.includes('electricity_meter_power_consumption') ||
                id.includes('electricity_meter') && id.includes('power') ||
                id.includes('meter') && id.includes('power') && id.includes('consumption')
              )
            }
          ) || haEntities.find(
            (e) => {
              const id = e.entity_id.toLowerCase()
              // Fallback to any power/watt sensor that's not binary
              return !id.startsWith('binary_sensor') && id.startsWith('sensor.') && (
                id.includes('current_power') ||
                (id.includes('power') && (id.includes('consumption') || id.includes('watt')))
              )
            }
          )

        console.log('[HA History] Available entities:', haEntities.map((e) => e.entity_id).join(', '))
        console.log('[HA History] Preferred power entity from metrics:', preferredPowerEntityId)
        console.log('[HA History] Found power entity:', powerEntity?.entity_id)

        if (!powerEntity) {
          console.error('[HA History] No power entity found from', haEntities.length, 'entities')
          return
        }

        const entityIds = [powerEntity.entity_id]

        console.log('[HA History] Fetching entities:', entityIds.join(', '))
        console.log('[HA History] Fetching from', startTime.toISOString(), 'to', now.toISOString())

        const token = await getAuthToken()
        const url = `/.netlify/functions/ha-history?environmentId=${encodeURIComponent(selectedEnvironment)}&startTime=${encodeURIComponent(startTime.toISOString())}&endTime=${encodeURIComponent(now.toISOString())}&entityIds=${encodeURIComponent(entityIds.join(','))}`
        
        console.log('[HA History] Request URL:', url)

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.error('[HA History] Failed to fetch:', response.status, errorText)
          return
        }

        const result = await response.json()
        const historyData = result.entities || []

        console.log('[HA History] Retrieved data for', historyData.length, 'entities:', JSON.stringify(historyData.map((e: any) => ({ entity_id: e.entity_id, samples: e.history?.length || 0 }))))

        // Process power data
        const powerData = historyData.find((h: any) => h.entity_id === powerEntity?.entity_id)
        if (powerData?.history && powerData.history.length > 0) {
          const newPowerSamples: PowerSample[] = powerData.history.map((state: any) => ({
            timestamp: state.timestamp,
            power: state.value > 100 ? state.value / 1000 : state.value, // Convert W to kW if needed
          }))

          setPowerSamples((prev) => {
            const combined = [...prev, ...newPowerSamples]
            const uniqueMap = new Map()
            combined.forEach((sample) => {
              const key = Math.floor(sample.timestamp / 10000) * 10000
              if (!uniqueMap.has(key) || sample.timestamp > uniqueMap.get(key).timestamp) {
                uniqueMap.set(key, sample)
              }
            })
            const merged = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp)
            localStorage.setItem(livePowerStorageKey, JSON.stringify(merged))
            return merged
          })

          console.log('[HA History] Loaded', newPowerSamples.length, 'power samples')
        }

        // Save fetch timestamp for incremental updates
        localStorage.setItem(lastFetchKey, now.toISOString())
        console.log('[HA History] Saved fetch timestamp for incremental updates')
      } catch (error) {
        console.error('[HA History] Error fetching historical data:', error)
      }
    }

    void fetchHistoricalData()
  }, [
    selectedEnvironment,
    isAuthenticated,
    haEntities,
    haMetricsSnapshot,
    livePowerStorageKey,
    getAuthToken,
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
        localStorage.setItem(livePowerStorageKey, JSON.stringify(next))
        return next
      })
    }

    captureSamples()
    const interval = window.setInterval(captureSamples, 10000)
    return () => window.clearInterval(interval)
  }, [livePowerStorageKey, selectedEnvironment, visibleEnvironments.length])


  const selectedRange = useMemo(() => {
    const [year, month, day] = selectedChartDate.split('-').map(Number)
    const isValidDate = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    const anchorDate = isValidDate
      ? new Date(year, month - 1, day)
      : new Date()

    const rangeStart = new Date(anchorDate)
    const rangeEnd = new Date(anchorDate)
    rangeEnd.setHours(23, 59, 59, 999)

    if (timeRange === 'week') {
      rangeStart.setDate(rangeStart.getDate() - 6)
      rangeStart.setHours(0, 0, 0, 0)
    } else if (timeRange === 'month') {
      rangeStart.setDate(1)
      rangeStart.setHours(0, 0, 0, 0)
    } else {
      rangeStart.setHours(0, 0, 0, 0)
    }

    return {
      startMs: rangeStart.getTime(),
      endMs: rangeEnd.getTime(),
      label: rangeEnd.toLocaleDateString(),
    }
  }, [selectedChartDate, timeRange])

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

  const bucketPowerSamples = useCallback(
    (
      startMs: number,
      endMs: number,
      bucketMs: number,
      fallbackPower: number,
      aggregationMode: 'average' | 'peak' = 'average',
    ) => {
      const sorted = powerSamples
        .filter((sample) => sample.timestamp >= startMs - bucketMs && sample.timestamp <= endMs)
        .sort((a, b) => a.timestamp - b.timestamp)

      const bucketStart = Math.floor(startMs / bucketMs) * bucketMs
      const bucketEnd = Math.ceil(endMs / bucketMs) * bucketMs
      const buckets: Array<{ start: number; value: number }> = []

      let index = 0
      let lastKnownPower = Number.isFinite(fallbackPower) ? fallbackPower : 0

      while (index < sorted.length && sorted[index].timestamp < bucketStart) {
        lastKnownPower = sorted[index].power
        index += 1
      }

      for (let t = bucketStart; t < bucketEnd; t += bucketMs) {
        const nextT = t + bucketMs
        let sum = 0
        let count = 0
        let maxInBucket = Number.NEGATIVE_INFINITY

        while (index < sorted.length && sorted[index].timestamp < nextT) {
          const sample = sorted[index]
          if (sample.timestamp >= t) {
            sum += sample.power
            count += 1
            if (sample.power > maxInBucket) {
              maxInBucket = sample.power
            }
          }
          lastKnownPower = sample.power
          index += 1
        }

        const bucketValue = count > 0
          ? (aggregationMode === 'peak' ? maxInBucket : sum / count)
          : lastKnownPower
        buckets.push({
          start: t,
          value: parseFloat(Math.max(0, bucketValue).toFixed(3)),
        })
      }

      return buckets
    },
    [powerSamples],
  )

  const chartData = useMemo(() => {
    const bucketMs = timeRange === 'today' ? 300_000 : 86_400_000
    const aggregationMode = timeRange === 'today' ? 'peak' : 'average'
    const buckets = bucketPowerSamples(
      selectedRange.startMs,
      selectedRange.endMs,
      bucketMs,
      realTimeData.currentPower,
      aggregationMode,
    )

    if (buckets.length === 0) {
      return [{
        time: '',
        power: 0,
      }]
    }

    return buckets.map((bucket) => ({
      time: formatChartAxisLabel(bucket.start, timeRange),
      power: bucket.value,
    }))
  }, [
    bucketPowerSamples,
    selectedRange.startMs,
    selectedRange.endMs,
    realTimeData.currentPower,
    timeRange,
  ])

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

  const gasSelectedPeriodLabel = timeRange === 'today'
    ? 'Gas Day Total'
    : timeRange === 'week'
      ? 'Gas Week Total'
      : 'Gas Month Total'

  // Gas card values: use local meter readings to compute daily/monthly totals
  const gasTodayCardValue = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
    const readings = gasMeterReadings.filter((r) => r.timestamp >= startOfToday)
    if (readings.length >= 2) {
      const total = Math.max(0, readings[readings.length - 1].value - readings[0].value)
      return parseFloat(Math.max(realTimeData.gasDailyUsage, total).toFixed(2))
    }
    return realTimeData.gasDailyUsage
  }, [gasMeterReadings, realTimeData.gasDailyUsage])

  const gasMonthCardValue = useMemo(() => {
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime()
    const readings = gasMeterReadings.filter((r) => r.timestamp >= startOfMonth)
    if (readings.length >= 2) {
      const total = Math.max(0, readings[readings.length - 1].value - readings[0].value)
      return parseFloat(Math.max(realTimeData.gasMonthlyUsage, total).toFixed(2))
    }
    return realTimeData.gasMonthlyUsage
  }, [gasMeterReadings, realTimeData.gasMonthlyUsage])

  const gasTodayCardCost = parseFloat((gasTodayCardValue * gasRatePerM3).toFixed(2))
  const gasMonthCardCost = parseFloat((gasMonthCardValue * gasRatePerM3).toFixed(2))

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
              <Home className="w-8 h-8 text-brand-2" />
              <div>
                <h1 className="text-4xl md:text-5xl font-heavy text-light-2 mb-2">
                  Inside-Out Foxtrot
                </h1>
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
            value={realTimeData.dailyUsage}
            unit="kWh"
            cost={realTimeData.electricityCostToday}
            icon="zap"
          />
          <EnergyCard
            title="Electricity This Month"
            value={realTimeData.monthlyUsage}
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
                onClick={() => setTimeRange('today')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'today'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Day
              </button>
              <button
                onClick={() => setTimeRange('week')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'week'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Week
              </button>
              <button
                onClick={() => setTimeRange('month')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'month'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Month
              </button>
            </div>
            <div className="md:w-56">
              <label className="block text-xs text-light-1 mb-1">Selected date</label>
              <input
                type="date"
                value={selectedChartDate}
                onChange={(event) => setSelectedChartDate(event.target.value)}
                className="w-full bg-dark-2 bg-opacity-70 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
              />
            </div>
          </div>
        </div>

        {/* Chart Section - Electricity and Gas charts */}
        <div className="space-y-8">
          {/* Electricity Chart */}
          <div className="glass-panel rounded-3xl shadow-2xl p-4 sm:p-6 md:p-8">
            <h2 className="text-2xl font-heavy text-dark-1 mb-6 flex items-center gap-2">
              <Clock className="w-6 h-6 text-brand-2" />
              Electricity Chart
            </h2>
            <EnergyChart
              data={chartData}
              timeRange={timeRange}
              unit="kW"
              seriesLabel="Electricity chart"
              rangeLabel={selectedRange.label}
              lineType="linear"
            />
          </div>

          {/* Gas Chart */}
          <div className="glass-panel rounded-3xl shadow-2xl p-4 sm:p-6 md:p-8">
            <div className="mb-6 flex flex-col gap-4">
              <h2 className="text-2xl font-heavy text-dark-1 flex items-center gap-2">
                <Flame className="w-6 h-6 text-brand-2" />
                Gas Chart
              </h2>
              <div className="glass-card rounded-xl px-4 py-3">
                <p className="text-light-1 text-xs font-medium uppercase">{gasSelectedPeriodLabel}</p>
                <p className="text-2xl font-heavy text-light-2">{gasSelectedPeriodTotal.toFixed(2)} m³</p>
              </div>
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
