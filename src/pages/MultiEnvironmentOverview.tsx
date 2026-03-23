import { useEffect, useState } from 'react'
import { Home, Zap, Activity, Wifi, WifiOff, Settings, LayoutDashboard, Users as UsersIcon, LogOut } from 'lucide-react'
import EnvironmentConfig from '../components/EnvironmentConfig'
import { Environment } from '../types'
import { useAuth0 } from '@auth0/auth0-react'

const OVERVIEW_TEXT_STORAGE_KEY = 'overview_text_config_v1'
const HA_ENVIRONMENTS_CACHE_KEY = 'ha_environments_cache_v1'
const OVERVIEW_STATUS_CACHE_KEY = 'overview_status_cache_v2'
const OVERVIEW_REFRESH_INTERVAL_MS = 10_000
const OVERVIEW_OFFLINE_THRESHOLD = 6
const OVERVIEW_STALE_AFTER_MS = OVERVIEW_REFRESH_INTERVAL_MS * OVERVIEW_OFFLINE_THRESHOLD

interface OverviewStatusSnapshot {
  status: Environment['status']
  currentPower?: number
  dailyUsage?: number
  lastUpdate?: string
  lastSeenAt?: number
}

const readOverviewStatusCache = (): Record<string, OverviewStatusSnapshot> => {
  try {
    const stored = localStorage.getItem(OVERVIEW_STATUS_CACHE_KEY)
    if (!stored) {
      return {}
    }

    const parsed = JSON.parse(stored)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, OverviewStatusSnapshot>
      : {}
  } catch {
    return {}
  }
}

const writeOverviewStatusCache = (cache: Record<string, OverviewStatusSnapshot>) => {
  try {
    localStorage.setItem(OVERVIEW_STATUS_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Ignore local cache write failures.
  }
}

const updateOverviewStatusCache = (
  environmentId: string,
  updates: Partial<OverviewStatusSnapshot>,
) => {
  const cache = readOverviewStatusCache()
  const existing = cache[environmentId] || { status: 'offline' as const }
  cache[environmentId] = {
    ...existing,
    ...updates,
  }
  writeOverviewStatusCache(cache)
}

const getCachedOverviewStatus = (environmentId: string): OverviewStatusSnapshot | null => {
  const cache = readOverviewStatusCache()
  const snapshot = cache[environmentId]
  if (!snapshot) {
    return null
  }

  const lastSeenAt = typeof snapshot.lastSeenAt === 'number' ? snapshot.lastSeenAt : 0
  const isFresh = lastSeenAt > 0 && (Date.now() - lastSeenAt) <= OVERVIEW_STALE_AFTER_MS

  return {
    ...snapshot,
    status: isFresh ? 'online' : 'offline',
  }
}

interface OverviewTextConfig {
  title: string
  menuOpenDashboard: string
  menuUsers: string
  menuAddEnvironment: string
  menuConfigure: string
  menuLogout: string
  loadingEnvironments: string
  noEnvironments: string
  currentPower: string
  dailyUsage: string
  lastUpdate: string
  environmentOffline: string
  lastSeen: string
  cardOpenDashboard: string
  summaryTitle: string
  environmentsOnline: string
  totalCurrentPower: string
  totalDailyUsage: string
}

const DEFAULT_OVERVIEW_TEXT: OverviewTextConfig = {
  title: 'Inside-Out Foxtrot',
  menuOpenDashboard: 'Open Dashboard',
  menuUsers: 'Users',
  menuAddEnvironment: 'Add Environment',
  menuConfigure: 'Configure',
  menuLogout: 'Logout',
  loadingEnvironments: 'Loading environments...',
  noEnvironments: 'No environments configured yet.',
  currentPower: 'Current Power',
  dailyUsage: 'Daily Usage',
  lastUpdate: 'Last update',
  environmentOffline: 'Environment offline',
  lastSeen: 'Last seen',
  cardOpenDashboard: 'Open Dashboard',
  summaryTitle: 'Environment Summary',
  environmentsOnline: 'Environments Online',
  totalCurrentPower: 'Total Current Power (kW)',
  totalDailyUsage: 'Total Daily Usage (kWh)',
}

interface MultiEnvironmentOverviewProps {
  isAdmin: boolean
  onManageUsers: () => void
  onOpenDashboard: () => void
  onOpenEnvironment: (environmentId: string) => void
  onLogout: () => void
}

interface HaEnvironmentPayload {
  id: string
  name?: string
  type?: string
  config?: {
    baseUrl?: string
    apiKey?: string
    siteId?: string
    notes?: string
  }
}

export default function MultiEnvironmentOverview({
  isAdmin,
  onManageUsers,
  onOpenDashboard,
  onOpenEnvironment,
  onLogout,
}: MultiEnvironmentOverviewProps) {
  const [showConfig, setShowConfig] = useState(false)
  const [showActionsDropdown, setShowActionsDropdown] = useState(false)
  const [allowedEnvironmentIds, setAllowedEnvironmentIds] = useState<string[] | null>(null)
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError] = useState<string | null>(null)
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently } = useAuth0()
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [isEditMode, setIsEditMode] = useState(false)
  const [isSavingEditMode, setIsSavingEditMode] = useState(false)
  const [overviewText, setOverviewText] = useState<OverviewTextConfig>(DEFAULT_OVERVIEW_TEXT)
  const [environmentNamesAtEditStart, setEnvironmentNamesAtEditStart] = useState<Record<string, string>>({})

  const getAuthToken = async () => {
    const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
    return getAccessTokenSilently({
      authorizationParams: { audience },
    })
  }

  const environmentIdsSignature = environments.map((env) => env.id).join('|')

  useEffect(() => {
    try {
      const stored = localStorage.getItem(OVERVIEW_TEXT_STORAGE_KEY)
      if (!stored) {
        return
      }

      const parsed = JSON.parse(stored) as Partial<OverviewTextConfig>
      setOverviewText((prev) => {
        const next = { ...prev }

        ;(Object.keys(DEFAULT_OVERVIEW_TEXT) as Array<keyof OverviewTextConfig>).forEach((key) => {
          const candidate = parsed[key]
          if (typeof candidate === 'string') {
            next[key] = candidate
          }
        })

        return next
      })
    } catch {
      // Ignore malformed local storage data and continue with defaults.
    }
  }, [])

  useEffect(() => {
    const loadEnvironments = async () => {
      if (!isAuthenticated) {
        setEnvironments([])
        return
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

        // Build a map of current environments to preserve their status across reloads
        const currentById = new Map(environments.map((env) => [String(env.id), env]))

        const nextEnvironments: Environment[] = loaded.map((env: HaEnvironmentPayload) => {
          const envId = String(env.id)
          const existing = currentById.get(envId)
          const cachedStatus = getCachedOverviewStatus(envId)
          const resolvedStatus = existing?.status && existing.status !== 'connecting'
            ? existing.status
            : cachedStatus?.status ?? 'offline'

          return {
            id: envId,
            name: String(env.name || env.id),
            type: (env.type as Environment['type']) || 'home_assistant',
            config: {
              baseUrl: env.config?.baseUrl || '',
              apiKey: env.config?.apiKey || '',
              siteId: env.config?.siteId || '',
              notes: env.config?.notes || '',
            },
            status: resolvedStatus,
            currentPower: existing?.currentPower ?? cachedStatus?.currentPower,
            dailyUsage: existing?.dailyUsage ?? cachedStatus?.dailyUsage,
            lastUpdate: existing?.lastUpdate ?? cachedStatus?.lastUpdate ?? '-',
          }
        })

        const dedupedEnvironments: Environment[] = []
        const seenIdKeys = new Set<string>()
        const seenSignatureKeys = new Set<string>()

        for (const env of nextEnvironments) {
          const idKey = String(env.id || '').trim().toLowerCase()
          if (!idKey || seenIdKeys.has(idKey)) {
            continue
          }

          const signatureKey = [
            String(env.name || '').trim().toLowerCase(),
            String(env.type || '').trim().toLowerCase(),
            String(env.config?.baseUrl || '').trim().toLowerCase(),
          ].join('|')

          if (signatureKey !== '||' && seenSignatureKeys.has(signatureKey)) {
            continue
          }

          seenIdKeys.add(idKey)
          if (signatureKey !== '||') {
            seenSignatureKeys.add(signatureKey)
          }

          dedupedEnvironments.push(env)
        }

        setEnvironments(dedupedEnvironments)
      } catch (error) {
        setEnvError(error instanceof Error ? error.message : 'Unable to load environments')
        setEnvironments([])
      } finally {
        setEnvLoading(false)
      }
    }

    void loadEnvironments()
  }, [getAccessTokenSilently, isAuthenticated])

  useEffect(() => {
    const getAuthToken = async () => {
      const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
      return getAccessTokenSilently({
        authorizationParams: { audience },
      })
    }

    const loadAssignments = async () => {
      if (!isAuthenticated) {
        setAllowedEnvironmentIds(null)
        return
      }

      if (isAdmin) {
        setAllowedEnvironmentIds(null)
        return
      }

      try {
        const claims = await getIdTokenClaims()
        const envClaim = 'https://brouwer-ems/environments'
        const envs = (claims?.[envClaim] as string[] | undefined) ?? null

        if (envs && envs.length > 0) {
          setAllowedEnvironmentIds(envs)
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
      }
    }

    void loadAssignments()
  }, [getAccessTokenSilently, getIdTokenClaims, isAuthenticated, isAdmin])

  useEffect(() => {
    type LiveEntity = {
      entity_id: string
      state: string
      domain: string
      unit_of_measurement?: string
    }

    type LiveMetrics = {
      currentPowerKw?: number | string | null
      dailyElectricityKwh?: number | string | null
    }

    const parseValue = (value?: string | number | null): number => {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0
      }

      const parsed = parseFloat(typeof value === 'string' ? value : '')
      return Number.isNaN(parsed) ? 0 : parsed
    }

    const parseMetricValue = (value?: number | string | null): number | null => {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null
      }

      if (typeof value === 'string') {
        const parsed = parseFloat(value)
        return Number.isNaN(parsed) ? null : parsed
      }

      return null
    }

    const normalizePowerToKw = (power: number, unit?: string) => {
      const normalizedUnit = String(unit || '').trim().toLowerCase()
      if (normalizedUnit === 'w' || normalizedUnit === 'watt' || normalizedUnit === 'watts') {
        return power / 1000
      }

      if (normalizedUnit === 'kw' || normalizedUnit === 'kilowatt' || normalizedUnit === 'kilowatts') {
        return power
      }

      return power > 100 ? power / 1000 : power
    }

    const findSensorByKeywords = (
      entities: LiveEntity[],
      includeKeywords: string[],
      excludeKeywords: string[] = [],
    ) => {
      return entities.find((entity) =>
        entity.domain === 'sensor' &&
        includeKeywords.some((keyword) => entity.entity_id.toLowerCase().includes(keyword.toLowerCase())) &&
        !excludeKeywords.some((keyword) => entity.entity_id.toLowerCase().includes(keyword.toLowerCase())),
      )
    }

    const deriveLiveData = (entities: LiveEntity[], metrics: LiveMetrics | null) => {
      const serverPower = parseMetricValue(metrics?.currentPowerKw)
      const serverDailyUsage = parseMetricValue(metrics?.dailyElectricityKwh)

      const powerEntity = findSensorByKeywords(
        entities,
        ['power', 'watt', 'current_power', 'active_power', 'vermogen'],
        ['energy', 'kwh', 'daily', 'today', 'day', 'month'],
      )
      const dailyEntity = findSensorByKeywords(
        entities,
        [
          'energy_today',
          'daily_energy',
          'today_energy',
          'day_energy',
          'consumption_today',
          'day_consumption',
          'verbruik_dag',
          'daily',
          'today',
        ],
        ['gas', 'price', 'cost', 'tariff', 'euro'],
      )

      const currentPower =
        serverPower ??
        normalizePowerToKw(parseValue(powerEntity?.state), powerEntity?.unit_of_measurement)
      const dailyUsage = serverDailyUsage ?? parseValue(dailyEntity?.state)

      const normalizedCurrentPower = Number.isFinite(currentPower) ? currentPower : 0
      const normalizedDailyUsage = Math.max(0, dailyUsage)

      return {
        currentPower: Number(normalizedCurrentPower.toFixed(2)),
        dailyUsage: Number(normalizedDailyUsage.toFixed(2)),
      }
    }

    const environmentIds = environmentIdsSignature ? environmentIdsSignature.split('|') : []
    let latestRefreshRequestId = 0
    let isDisposed = false

    // Track consecutive failures per environment so a single transient error
    // does not flash the card offline while it still has valid last-known data.
    // NOT persisted across component remounts (e.g., navigating away and back),
    // so the failure counter resets but the data (status, lastUpdate) is preserved.
    const failureCounts: Record<string, number> = {}

    const applyRefreshResult = (result: {
      environmentId: string
      status: 'online' | 'offline'
      currentPower?: number
      dailyUsage?: number
      lastUpdate?: string
    }) => {
      if (result.status === 'online') {
        failureCounts[result.environmentId] = 0
        updateOverviewStatusCache(result.environmentId, {
          status: 'online',
          currentPower: result.currentPower,
          dailyUsage: result.dailyUsage,
          lastUpdate: result.lastUpdate,
          lastSeenAt: Date.now(),
        })
      } else {
        failureCounts[result.environmentId] = (failureCounts[result.environmentId] ?? 0) + 1
      }

      setEnvironments((prev) =>
        prev.map((env) => {
          if (env.id !== result.environmentId) {
            return env
          }

          // If the refresh failed but the card was already online, keep showing
          // the last-known data until we've seen enough consecutive failures.
          if (result.status === 'offline' && env.status === 'online') {
            const consecutive = failureCounts[result.environmentId] ?? 0
            if (consecutive < OVERVIEW_OFFLINE_THRESHOLD) {
              return env
            }
          }

          if (result.status === 'offline') {
            updateOverviewStatusCache(result.environmentId, {
              status: 'offline',
            })
          }

          return {
            ...env,
            status: result.status,
            currentPower: result.currentPower ?? env.currentPower,
            dailyUsage: result.dailyUsage ?? env.dailyUsage,
            lastUpdate: result.lastUpdate ?? env.lastUpdate,
          }
        }),
      )
    }

    const fetchEnvironmentStatus = async (environmentId: string, token: string) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 6000)

      try {
        const response = await fetch(`/.netlify/functions/ha-entities?environmentId=${environmentId}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })

        if (!response.ok) {
          return {
            environmentId,
            status: 'offline' as const,
          }
        }

        const data = await response.json()
        const entities: LiveEntity[] = Array.isArray(data?.entities) ? data.entities : []
        const metrics: LiveMetrics | null =
          data && typeof data === 'object' && data.metrics && typeof data.metrics === 'object'
            ? (data.metrics as LiveMetrics)
            : null
        const liveData = deriveLiveData(entities, metrics)

        return {
          environmentId,
          status: 'online' as const,
          currentPower: liveData.currentPower,
          dailyUsage: liveData.dailyUsage,
          lastUpdate: new Date().toLocaleTimeString(),
        }
      } catch {
        return {
          environmentId,
          status: 'offline' as const,
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    const refreshEnvironmentStatuses = async () => {
      if (!isAuthenticated || environmentIds.length === 0) {
        return
      }

      const refreshRequestId = ++latestRefreshRequestId

      try {
        const token = await getAuthToken()
        if (isDisposed || refreshRequestId !== latestRefreshRequestId) {
          return
        }

        const refreshTasks = environmentIds.map(async (environmentId) => {
          const result = await fetchEnvironmentStatus(environmentId, token)

          if (isDisposed || refreshRequestId !== latestRefreshRequestId) {
            return
          }

          applyRefreshResult(result)
        })

        await Promise.all(refreshTasks)
      } catch {
        if (isDisposed || refreshRequestId !== latestRefreshRequestId) {
          return
        }

        // Auth token failure counts as a failure for every environment.
        // Use the same threshold so a brief auth hiccup doesn't flash all cards.
        environmentIds.forEach((id) => {
          failureCounts[id] = (failureCounts[id] ?? 0) + 1
        })
        
        setEnvironments((prev) =>
          prev.map((env) => {
            const consecutive = failureCounts[env.id] ?? 0
            if (env.status === 'online' && consecutive < OVERVIEW_OFFLINE_THRESHOLD) {
              return env
            }
            updateOverviewStatusCache(env.id, {
              status: 'offline',
            })
            return { ...env, status: 'offline' as const }
          }),
        )
      }
    }

    void refreshEnvironmentStatuses()
    const interval = setInterval(() => {
      void refreshEnvironmentStatuses()
    }, OVERVIEW_REFRESH_INTERVAL_MS)

    return () => {
      isDisposed = true
      latestRefreshRequestId += 1
      clearInterval(interval)
    }
  }, [environmentIdsSignature, getAccessTokenSilently, isAuthenticated])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showActionsDropdown && !target.closest('.overview-settings-dropdown')) {
        setShowActionsDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showActionsDropdown])

  const visibleEnvironments = allowedEnvironmentIds
    ? environments.filter((env) => allowedEnvironmentIds.includes(env.id))
    : environments

  const updateOverviewText = (key: keyof OverviewTextConfig, value: string) => {
    setOverviewText((prev) => ({
      ...prev,
      [key]: value,
    }))
  }

  const updateEnvironmentName = (environmentId: string, value: string) => {
    setEnvironments((prev) =>
      prev.map((env) =>
        env.id === environmentId
          ? {
              ...env,
              name: value,
            }
          : env,
      ),
    )
  }

  const persistEnvironments = async (nextEnvironments: Environment[]) => {
    const requestBody = JSON.stringify({
      environments: nextEnvironments.map((env) => ({
        id: env.id,
        name: env.name,
        type: env.type,
        config: env.config,
      })),
    })

    const performSaveRequest = async (token: string) => {
      const response = await fetch('/.netlify/functions/save-ha-environments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
      })

      if (response.ok) {
        return
      }

      const data = await response.json().catch(() => null)
      throw new Error(data?.error || 'Unable to save environments')
    }

    const accessToken = await getAuthToken()
    try {
      await performSaveRequest(accessToken)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const idTokenClaims = await getIdTokenClaims().catch(() => null)
      const idToken = typeof idTokenClaims?.__raw === 'string' ? idTokenClaims.__raw : ''

      if (message !== 'Admin only' || !idToken) {
        throw error
      }

      await performSaveRequest(idToken)
    }

    const updated = nextEnvironments.map((env) => ({
      ...env,
      status: env.status || 'offline',
      lastUpdate: env.lastUpdate || 'just now',
    }))
    setEnvironments(updated)

    const compactCache = updated.map((env) => ({
      id: env.id,
      name: env.name,
      type: env.type,
    }))
    localStorage.setItem(HA_ENVIRONMENTS_CACHE_KEY, JSON.stringify(compactCache))
    window.dispatchEvent(new CustomEvent('ha-environments-updated', { detail: compactCache }))
  }

  const hasEnvironmentNameChanges = () => {
    if (!isEditMode) {
      return false
    }

    const changedExistingNames = environments.some((env) => environmentNamesAtEditStart[env.id] !== env.name)
    const deletedEnvironment = Object.keys(environmentNamesAtEditStart).some(
      (environmentId) => !environments.some((env) => env.id === environmentId),
    )
    return changedExistingNames || deletedEnvironment
  }

  const handleEditToggle = async () => {
    if (!isEditMode) {
      setEnvError(null)
      setEnvironmentNamesAtEditStart(
        environments.reduce<Record<string, string>>((acc, env) => {
          acc[env.id] = env.name
          return acc
        }, {}),
      )
      setIsEditMode(true)
      return
    }

    if (isSavingEditMode) {
      return
    }

    setIsSavingEditMode(true)
    setEnvError(null)

    try {
      localStorage.setItem(OVERVIEW_TEXT_STORAGE_KEY, JSON.stringify(overviewText))

      if (hasEnvironmentNameChanges()) {
        await persistEnvironments(environments)
      }

      setIsEditMode(false)
      setEnvironmentNamesAtEditStart({})
    } catch (error) {
      setEnvError(error instanceof Error ? error.message : 'Unable to save edit mode changes')
    } finally {
      setIsSavingEditMode(false)
    }
  }

  const handleSaveEnvironments = async (nextEnvironments: Environment[]) => {
    setEnvError(null)

    try {
      await persistEnvironments(nextEnvironments)
      setShowConfig(false)
    } catch (error) {
      setEnvError(error instanceof Error ? error.message : 'Unable to save environments')
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online': return 'text-green-400'
      case 'offline': return 'text-red-400'
      case 'connecting': return 'text-yellow-400'
      default: return 'text-gray-400'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online': return <Wifi className="w-4 h-4" />
      case 'offline': return <WifiOff className="w-4 h-4" />
      default: return <Activity className="w-4 h-4" />
    }
  }

  return (
    <div className="app-shell min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex items-center gap-4 min-w-0">
              <Home className="w-8 h-8 text-brand-2" />
              <div className="min-w-0">
                {isEditMode ? (
                  <input
                    type="text"
                    value={overviewText.title}
                    onChange={(event) => updateOverviewText('title', event.target.value)}
                    className="w-full md:min-w-[22rem] text-3xl md:text-5xl font-heavy leading-tight bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded-lg px-3 py-1 focus:outline-none focus:ring-2 focus:ring-brand-2"
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  <h1 className="text-3xl md:text-5xl font-heavy text-light-2 leading-tight">
                    {overviewText.title}
                  </h1>
                )}
              </div>
            </div>
            <div className="relative overview-settings-dropdown shrink-0">
              <button
                onClick={() => setShowActionsDropdown((prev) => !prev)}
                className="p-2 bg-light-2 bg-opacity-20 text-light-2 border border-light-2 border-opacity-30 rounded-lg hover:bg-opacity-30 transition-all backdrop-blur-sm"
                aria-label="Open settings"
              >
                <Settings className="w-5 h-5" />
              </button>

              {showActionsDropdown && (
                <div className="absolute right-0 mt-2 w-64 bg-dark-1 border border-light-2 border-opacity-30 rounded-lg shadow-xl z-50">
                  <div className="py-1">
                    <button
                      onClick={() => {
                        onOpenDashboard()
                        setShowActionsDropdown(false)
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                    >
                      <LayoutDashboard className="w-5 h-5" />
                      {isEditMode ? (
                        <input
                          type="text"
                          value={overviewText.menuOpenDashboard}
                          onChange={(event) => updateOverviewText('menuOpenDashboard', event.target.value)}
                          className="w-full bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-20 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-2"
                          onClick={(event) => event.stopPropagation()}
                        />
                      ) : (
                        <span className="font-medium">{overviewText.menuOpenDashboard}</span>
                      )}
                    </button>

                    {isAdmin && (
                      <button
                        onClick={() => {
                          onManageUsers()
                          setShowActionsDropdown(false)
                        }}
                        className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                      >
                        <UsersIcon className="w-5 h-5" />
                        {isEditMode ? (
                          <input
                            type="text"
                            value={overviewText.menuUsers}
                            onChange={(event) => updateOverviewText('menuUsers', event.target.value)}
                            className="w-full bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-20 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-2"
                            onClick={(event) => event.stopPropagation()}
                          />
                        ) : (
                          <span className="font-medium">{overviewText.menuUsers}</span>
                        )}
                      </button>
                    )}

                    {isAdmin && (
                      <button
                        onClick={() => {
                          setShowConfig(true)
                          setShowActionsDropdown(false)
                        }}
                        className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                      >
                        <Settings className="w-5 h-5" />
                        {isEditMode ? (
                          <input
                            type="text"
                            value={overviewText.menuAddEnvironment}
                            onChange={(event) => updateOverviewText('menuAddEnvironment', event.target.value)}
                            className="w-full bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-20 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-2"
                            onClick={(event) => event.stopPropagation()}
                          />
                        ) : (
                          <span className="font-medium">{overviewText.menuAddEnvironment}</span>
                        )}
                      </button>
                    )}

                    {isAdmin && (
                      <button
                        onClick={() => {
                          setShowConfig(true)
                          setShowActionsDropdown(false)
                        }}
                        className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                      >
                        <Settings className="w-5 h-5" />
                        {isEditMode ? (
                          <input
                            type="text"
                            value={overviewText.menuConfigure}
                            onChange={(event) => updateOverviewText('menuConfigure', event.target.value)}
                            className="w-full bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-20 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-2"
                            onClick={(event) => event.stopPropagation()}
                          />
                        ) : (
                          <span className="font-medium">{overviewText.menuConfigure}</span>
                        )}
                      </button>
                    )}

                    <button
                      onClick={() => {
                        onLogout()
                        setShowActionsDropdown(false)
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-red-200 hover:bg-red-500 hover:bg-opacity-20 transition-all text-left border-t border-light-2 border-opacity-10"
                    >
                      <LogOut className="w-5 h-5" />
                      {isEditMode ? (
                        <input
                          type="text"
                          value={overviewText.menuLogout}
                          onChange={(event) => updateOverviewText('menuLogout', event.target.value)}
                          className="w-full bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-20 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-2"
                          onClick={(event) => event.stopPropagation()}
                        />
                      ) : (
                        <span className="font-medium">{overviewText.menuLogout}</span>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          {isEditMode && (
            <p className="text-light-1 text-sm">Edit mode is active. Click Save in the bottom-left corner to store changes.</p>
          )}
        </div>

        {/* Environment Grid */}
        {envLoading && (
          <p className="text-light-1 mb-6">
            {isEditMode ? (
              <input
                type="text"
                value={overviewText.loadingEnvironments}
                onChange={(event) => updateOverviewText('loadingEnvironments', event.target.value)}
                className="w-full max-w-xl bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              overviewText.loadingEnvironments
            )}
          </p>
        )}
        {envError && <p className="text-red-300 mb-6">{envError}</p>}
        {!envLoading && !envError && visibleEnvironments.length === 0 && (
          <p className="text-light-1 mb-6">
            {isEditMode ? (
              <input
                type="text"
                value={overviewText.noEnvironments}
                onChange={(event) => updateOverviewText('noEnvironments', event.target.value)}
                className="w-full max-w-xl bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              overviewText.noEnvironments
            )}
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {visibleEnvironments.map((env) => (
            <div
              key={env.id}
              className={`glass-card rounded-2xl p-6 shadow-xl transition-all ${isEditMode ? 'cursor-default' : 'hover:shadow-2xl cursor-pointer'}`}
              onClick={() => {
                if (!isEditMode) {
                  onOpenEnvironment(env.id)
                }
              }}
              role={isEditMode ? undefined : 'button'}
              tabIndex={isEditMode ? -1 : 0}
              onKeyDown={(event) => {
                if (isEditMode) {
                  return
                }

                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenEnvironment(env.id)
                }
              }}
            >
              {/* Environment Header */}
              <div className="flex items-center justify-between mb-4">
                {isEditMode ? (
                  <input
                    type="text"
                    value={env.name}
                    onChange={(event) => updateEnvironmentName(env.id, event.target.value)}
                    className="w-full mr-3 bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 font-heavy focus:outline-none focus:ring-2 focus:ring-brand-2"
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  <h3 className="text-xl font-heavy text-dark-1">{env.name}</h3>
                )}
                <div className={`flex items-center gap-1 ${getStatusColor(env.status)}`}>
                  {getStatusIcon(env.status)}
                  <span className="text-sm font-medium capitalize">{env.status}</span>
                </div>
              </div>

              {/* Environment Stats */}
              {env.status === 'online' ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-dark-2 text-sm">
                      {isEditMode ? (
                        <input
                          type="text"
                          value={overviewText.currentPower}
                          onChange={(event) => updateOverviewText('currentPower', event.target.value)}
                          className="w-36 bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-2"
                          onClick={(event) => event.stopPropagation()}
                        />
                      ) : (
                        overviewText.currentPower
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-brand-2" />
                      <span className="font-heavy text-dark-1">{env.currentPower} kW</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-dark-2 text-sm">
                      {isEditMode ? (
                        <input
                          type="text"
                          value={overviewText.dailyUsage}
                          onChange={(event) => updateOverviewText('dailyUsage', event.target.value)}
                          className="w-36 bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-2"
                          onClick={(event) => event.stopPropagation()}
                        />
                      ) : (
                        overviewText.dailyUsage
                      )}
                    </span>
                    <span className="font-medium text-dark-1">{env.dailyUsage} kWh</span>
                  </div>
                  <div className="pt-2 border-t border-dark-2 border-opacity-10">
                    <p className="text-xs text-dark-2">
                      {isEditMode ? (
                        <input
                          type="text"
                          value={overviewText.lastUpdate}
                          onChange={(event) => updateOverviewText('lastUpdate', event.target.value)}
                          className="w-32 bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-2"
                          onClick={(event) => event.stopPropagation()}
                        />
                      ) : (
                        overviewText.lastUpdate
                      )}
                      : {env.lastUpdate}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-4">
                  <WifiOff className="w-8 h-8 text-red-400 mx-auto mb-2" />
                  <p className="text-dark-2 text-sm">
                    {isEditMode ? (
                      <input
                        type="text"
                        value={overviewText.environmentOffline}
                        onChange={(event) => updateOverviewText('environmentOffline', event.target.value)}
                        className="w-full max-w-[12rem] mx-auto bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-xs text-center focus:outline-none focus:ring-2 focus:ring-brand-2"
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : (
                      overviewText.environmentOffline
                    )}
                  </p>
                  <p className="text-xs text-dark-2 mt-1">
                    {isEditMode ? (
                      <input
                        type="text"
                        value={overviewText.lastSeen}
                        onChange={(event) => updateOverviewText('lastSeen', event.target.value)}
                        className="w-24 bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-xs text-center focus:outline-none focus:ring-2 focus:ring-brand-2"
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : (
                      overviewText.lastSeen
                    )}
                    : {env.lastUpdate}
                  </p>
                </div>
              )}

              {/* Action Button */}
              <button
                className={`w-full mt-4 glass-button py-2 px-4 rounded-lg font-medium transition-all ${isEditMode ? 'opacity-70' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!isEditMode) {
                    onOpenEnvironment(env.id)
                  }
                }}
              >
                {isEditMode ? (
                  <input
                    type="text"
                    value={overviewText.cardOpenDashboard}
                    onChange={(event) => updateOverviewText('cardOpenDashboard', event.target.value)}
                    className="w-full bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-brand-2"
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  overviewText.cardOpenDashboard
                )}
              </button>
            </div>
          ))}
        </div>

        {/* Summary Stats */}
        <div className="glass-panel rounded-2xl p-6 shadow-xl">
          {isEditMode ? (
            <input
              type="text"
              value={overviewText.summaryTitle}
              onChange={(event) => updateOverviewText('summaryTitle', event.target.value)}
              className="w-full max-w-md text-2xl font-heavy bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-3 py-2 mb-6 focus:outline-none focus:ring-2 focus:ring-brand-2"
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <h2 className="text-2xl font-heavy text-dark-1 mb-6">{overviewText.summaryTitle}</h2>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-2 mb-2">
                {visibleEnvironments.filter(e => e.status === 'online').length}/{visibleEnvironments.length}
              </div>
              <p className="text-dark-2">
                {isEditMode ? (
                  <input
                    type="text"
                    value={overviewText.environmentsOnline}
                    onChange={(event) => updateOverviewText('environmentsOnline', event.target.value)}
                    className="w-full max-w-[14rem] mx-auto bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-brand-2"
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  overviewText.environmentsOnline
                )}
              </p>
            </div>
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-3 mb-2">
                {visibleEnvironments.reduce((sum, env) => sum + (env.currentPower || 0), 0).toFixed(1)}
              </div>
              <p className="text-dark-2">
                {isEditMode ? (
                  <input
                    type="text"
                    value={overviewText.totalCurrentPower}
                    onChange={(event) => updateOverviewText('totalCurrentPower', event.target.value)}
                    className="w-full max-w-[14rem] mx-auto bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-brand-2"
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  overviewText.totalCurrentPower
                )}
              </p>
            </div>
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-4 mb-2">
                {visibleEnvironments.reduce((sum, env) => sum + (env.dailyUsage || 0), 0).toFixed(1)}
              </div>
              <p className="text-dark-2">
                {isEditMode ? (
                  <input
                    type="text"
                    value={overviewText.totalDailyUsage}
                    onChange={(event) => updateOverviewText('totalDailyUsage', event.target.value)}
                    className="w-full max-w-[14rem] mx-auto bg-black bg-opacity-35 text-light-2 border border-light-2 border-opacity-30 rounded px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-brand-2"
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  overviewText.totalDailyUsage
                )}
              </p>
            </div>
          </div>
        </div>

        {isAdmin && (
          <button
            onClick={() => {
              void handleEditToggle()
            }}
            className="fixed left-4 bottom-4 z-40 glass-button px-5 py-3 rounded-xl font-semibold shadow-lg transition-all disabled:opacity-60"
            disabled={isSavingEditMode}
          >
            {isSavingEditMode ? 'Saving...' : isEditMode ? 'Save' : 'Edit'}
          </button>
        )}

        {/* Configuration Modal */}
        {showConfig && (
          <EnvironmentConfig
            environments={environments}
            onSave={handleSaveEnvironments}
            onClose={() => setShowConfig(false)}
          />
        )}
      </div>
    </div>
  )
}