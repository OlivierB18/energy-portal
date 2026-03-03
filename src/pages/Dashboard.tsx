import { useEffect, useState, useMemo } from 'react'
import EnergyCard from '../components/EnergyCard'
import EnergyChart from '../components/EnergyChart'
import HomeAssistantConfig from '../components/HomeAssistantConfig'
import { Zap, TrendingUp, Clock, Home, Settings } from 'lucide-react'
import { useAuth0 } from '@auth0/auth0-react'
import { HaEntity } from '../types'

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
}

export default function Dashboard({
  isAdmin,
  selectedEnvironmentId,
  onEnvironmentChange,
}: DashboardProps) {
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>(selectedEnvironmentId ?? '')
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today')
  const [allowedEnvironmentIds, setAllowedEnvironmentIds] = useState<string[] | null>(null)
  const [environments, setEnvironments] = useState<EnvironmentConfig[]>([])
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError] = useState<string | null>(null)
  const [haEntities, setHaEntities] = useState<HaEntity[]>([])
  // Laatst bekende sensoren (blijven altijd staan bij error)
  const [lastKnownHaEntities, setLastKnownHaEntities] = useState<HaEntity[]>([])
  const [haLoading, setHaLoading] = useState(false)
  const [haError, setHaError] = useState<string | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [haActionId, setHaActionId] = useState<string | null>(null)
  const [showHaConfig, setShowHaConfig] = useState(false)
  const [haRefreshKey, setHaRefreshKey] = useState(0)
  // Home Assistant connection status: 'connecting' | 'connected' | 'error'
  const [haConnectionStatus, setHaConnectionStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently } = useAuth0()

  const getAuthToken = async () => {
    const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
    return getAccessTokenSilently({
      authorizationParams: { audience },
    })
  }

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
        const next = loaded.map((env: HaEnvironmentPayload) => ({
          id: String(env.id),
          name: String(env.name || env.id),
          type: env.type,
        }))
        setEnvironments(next)
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

  const visibleEnvironments = allowedEnvironmentIds
    ? environments.filter((env) => allowedEnvironmentIds.includes(env.id))
    : environments

  const assignedEnvironmentLabels = allowedEnvironmentIds
    ? visibleEnvironments.map((env) => env.name)
    : []

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
            setHaError(data?.error || 'Unable to load Home Assistant data')
          }
          // NEVER clear entities on error - keep showing last known data
          return
        }
        
        const data = await response.json()
        const entities = Array.isArray(data?.entities) ? data.entities : []
        // eslint-disable-next-line no-console
        console.log(`[HA] ✅ Loaded ${entities.length} entities`)
        
        // Update entities AND keep them as last known
        setHaEntities(entities)
        setLastKnownHaEntities(entities)
        
        if (!silent) {
          setHaConnectionStatus('connected')
          setHaError(null)
          setIsInitialLoading(false) // Only set false on successful initial load
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[HA] Fetch error:', error);
        if (!silent) {
          setHaError(error instanceof Error ? error.message : 'Unable to load Home Assistant data')
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
  }, [getAccessTokenSilently, isAuthenticated, selectedEnvironment, haRefreshKey])

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
        setHaEntities(Array.isArray(data?.entities) ? data.entities : [])
      }
    } catch (error) {
      setHaError(error instanceof Error ? error.message : 'Unable to run action')
    } finally {
      setHaActionId(null)
    }
  }

  // Mock data for demonstration - in real app, this would fetch from selected environment
  const mockData = {
    currentPower: 2.45,
    dailyUsage: 12.8,
    monthlyUsage: 285.3,
    costToday: 3.84,
    costMonth: 85.59,
    trend: 8.5,
  }

  // Extract real-time energy data from Home Assistant entities
  const realTimeData = useMemo(() => {
    const entities = haEntities.length > 0 ? haEntities : lastKnownHaEntities
    
    // Helper function to parse numeric values from entity state
    const parseValue = (state: string): number => {
      const num = parseFloat(state)
      return isNaN(num) ? 0 : num
    }

    // Helper function to find entity by keywords in entity_id
    const findEntity = (keywords: string[]): HaEntity | undefined => {
      return entities.find(entity => 
        entity.domain === 'sensor' && 
        keywords.some(keyword => entity.entity_id.toLowerCase().includes(keyword.toLowerCase()))
      )
    }

    // Helper function to track energy usage locally when no sensor available
    const trackEnergyLocally = (currentPower: number): { daily: number; monthly: number } => {
      const now = new Date()
      const today = now.toDateString()
      const thisMonth = `${now.getFullYear()}-${now.getMonth() + 1}`
      
      // Get stored tracking data
      const storedDaily = localStorage.getItem('energy_daily')
      const storedMonthly = localStorage.getItem('energy_monthly')
      const storedDate = localStorage.getItem('energy_date')
      const storedMonth = localStorage.getItem('energy_month')
      const lastUpdate = localStorage.getItem('energy_last_update')
      
      let dailyTotal = 0
      let monthlyTotal = 0
      
      // Reset daily if new day
      if (storedDate !== today) {
        localStorage.setItem('energy_date', today)
        localStorage.setItem('energy_daily', '0')
        dailyTotal = 0
      } else {
        dailyTotal = storedDaily ? parseFloat(storedDaily) : 0
      }
      
      // Reset monthly if new month
      if (storedMonth !== thisMonth) {
        localStorage.setItem('energy_month', thisMonth)
        localStorage.setItem('energy_monthly', '0')
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
          
          localStorage.setItem('energy_daily', dailyTotal.toString())
          localStorage.setItem('energy_monthly', monthlyTotal.toString())
        }
      }
      
      // Update last timestamp
      localStorage.setItem('energy_last_update', now.toISOString())
      
      return {
        daily: dailyTotal,
        monthly: monthlyTotal,
      }
    }

    // Find power sensor (current usage in W or kW)
    const powerEntity = findEntity(['power', 'watt', 'current_power', 'active_power'])
    let currentPower = powerEntity ? parseValue(powerEntity.state) : mockData.currentPower
    
    // eslint-disable-next-line no-console
    console.log('[Energy] Power entity:', powerEntity?.entity_id, '=', powerEntity?.state)
    
    // Convert W to kW if needed (if value is > 100, assume it's in Watts)
    if (currentPower > 100) {
      currentPower = currentPower / 1000
    }

    // Find daily energy sensor (in kWh)
    const dailyEntity = findEntity(['energy_today', 'daily_energy', 'today', 'day_energy'])
    const monthlyEntity = findEntity(['energy_month', 'monthly_energy', 'month_energy'])
    
    // Use sensor data if available, otherwise track locally
    let dailyUsage: number
    let monthlyUsage: number
    
    if (dailyEntity || monthlyEntity) {
      // Use sensor data
      dailyUsage = dailyEntity ? parseValue(dailyEntity.state) : 0
      monthlyUsage = monthlyEntity ? parseValue(monthlyEntity.state) : 0
      // eslint-disable-next-line no-console
      console.log('[Energy] Using sensor data - Daily:', dailyUsage, 'Monthly:', monthlyUsage)
    } else {
      // Track locally from power readings
      const tracked = trackEnergyLocally(currentPower)
      dailyUsage = tracked.daily
      monthlyUsage = tracked.monthly
      // eslint-disable-next-line no-console
      console.log('[Energy] Tracking locally - Daily:', dailyUsage.toFixed(3), 'kWh, Monthly:', monthlyUsage.toFixed(3), 'kWh')
    }

    // Calculate estimated costs (€0.30 per kWh as example rate)
    const pricePerKwh = 0.30
    const costToday = dailyUsage * pricePerKwh
    const costMonth = monthlyUsage * pricePerKwh

    return {
      currentPower: parseFloat(currentPower.toFixed(2)),
      dailyUsage: parseFloat(dailyUsage.toFixed(1)),
      monthlyUsage: parseFloat(monthlyUsage.toFixed(1)),
      costToday: parseFloat(costToday.toFixed(2)),
      costMonth: parseFloat(costMonth.toFixed(2)),
      trend: mockData.trend, // TODO: Calculate from history
    }
  }, [haEntities, lastKnownHaEntities])

  const chartData = [
    { time: '00:00', power: 0.5 },
    { time: '04:00', power: 0.2 },
    { time: '08:00', power: 1.2 },
    { time: '12:00', power: 2.8 },
    { time: '16:00', power: 3.2 },
    { time: '20:00', power: 2.1 },
    { time: '23:59', power: 0.8 },
  ]

  return (
    <div className="app-shell min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header with Environment Selector */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <Home className="w-8 h-8 text-brand-2" />
              <div>
                <h1 className="text-4xl md:text-5xl font-heavy text-light-2 mb-2">
                  Multi-Environment Energy Monitor
                </h1>
                <p className="text-light-1 text-lg">Monitor all your Home Assistant environments</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-light-2" />
              <select
                value={selectedEnvironment}
                onChange={(e) => {
                  const nextId = e.target.value
                  setSelectedEnvironment(nextId)
                  onEnvironmentChange?.(nextId)
                }}
                disabled={visibleEnvironments.length === 0}
                className="bg-light-2 bg-opacity-20 text-light-2 border border-light-2 border-opacity-30 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
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
          </div>

          {/* Current Environment Info */}
          <div className="bg-light-2 bg-opacity-10 rounded-xl p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-light-2">
              {/* Status indicator: green=connected, red=error, yellow=connecting */}
              <div
                className={`w-3 h-3 rounded-full ${
                  haConnectionStatus === 'connected'
                    ? 'bg-green-400 animate-pulse'
                    : haConnectionStatus === 'connecting'
                    ? 'bg-yellow-400 animate-pulse'
                    : 'bg-red-500 animate-pulse'
                }`}
                title={
                  haConnectionStatus === 'connected'
                    ? 'Connected to Home Assistant'
                    : haConnectionStatus === 'connecting'
                    ? 'Connecting to Home Assistant...'
                    : 'Not connected to Home Assistant'
                }
              ></div>
              <span className="font-medium">
                Currently monitoring: {environments.find(e => e.id === selectedEnvironment)?.name}
              </span>
              {/* DEBUG: Toon actuele connectie-status */}
              <span className="ml-4 text-xs text-yellow-300 bg-dark-2 px-2 py-1 rounded" style={{fontFamily:'monospace'}}>status: {haConnectionStatus}</span>
            </div>
            <div className="mt-3 text-light-1 text-sm">
              {allowedEnvironmentIds ? (
                assignedEnvironmentLabels.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="opacity-80">Your environments:</span>
                    {assignedEnvironmentLabels.map((label) => (
                      <span
                        key={label}
                        className="px-2 py-1 rounded-full bg-light-2 bg-opacity-20 text-light-2 text-xs"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="opacity-80">No environments assigned.</span>
                )
              ) : (
                <span className="opacity-80">All environments available.</span>
              )}
              {envLoading && <div className="mt-2 text-xs opacity-70">Loading environments...</div>}
              {envError && <div className="mt-2 text-xs text-red-300">{envError}</div>}
            </div>
          </div>
        </div>

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
          <p className="text-brand-2 font-medium flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            {realTimeData.trend}% higher than yesterday
          </p>
        </div>

        {/* Energy Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <EnergyCard
            title="Today's Usage"
            value={realTimeData.dailyUsage}
            unit="kWh"
            cost={realTimeData.costToday}
            icon="zap"
          />
          <EnergyCard
            title="This Month"
            value={realTimeData.monthlyUsage}
            unit="kWh"
            cost={realTimeData.costMonth}
            icon="calendar"
          />
          <EnergyCard
            title="Status"
            value={
              haConnectionStatus === 'connected'
                ? 'Active'
                : haConnectionStatus === 'connecting'
                ? 'Connecting...'
                : 'Error'
            }
            unit=""
            cost={null}
            icon="activity"
            status={haConnectionStatus}
          />
        </div>

        {/* Time Range Selector */}
        <div className="glass-panel rounded-xl shadow-lg p-4 mb-8">
          <div className="flex gap-4">
            <button
              onClick={() => setTimeRange('today')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'today'
                  ? 'glass-button'
                  : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setTimeRange('week')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'week'
                  ? 'glass-button'
                  : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
              }`}
            >
              This Week
            </button>
            <button
              onClick={() => setTimeRange('month')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'month'
                  ? 'glass-button'
                  : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
              }`}
            >
              This Month
            </button>
          </div>
        </div>

        {/* Chart Section */}
        <div className="glass-panel rounded-3xl shadow-2xl p-8">
          <h2 className="text-2xl font-heavy text-dark-1 mb-6 flex items-center gap-2">
            <Clock className="w-6 h-6 text-brand-2" />
            Energy Consumption Chart
          </h2>
          <EnergyChart data={chartData} timeRange={timeRange} />
        </div>

        {/* Home Assistant Panel */}
        <div className="glass-panel rounded-3xl shadow-2xl p-8 mt-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-heavy text-dark-1">Home Assistant</h2>
            {isAdmin && (
              <button
                onClick={() => setShowHaConfig(true)}
                className="glass-button px-4 py-2 rounded-lg font-medium"
              >
                Configure sensors
              </button>
            )}
          </div>

          {haLoading && <p className="text-light-1">Loading Home Assistant data...</p>}
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
        </div>

        {/* Footer Info */}
        <div className="mt-8 text-center text-light-1 text-sm">
          <p>Last updated: {new Date().toLocaleTimeString()}</p>
        </div>

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
      </div>
    </div>
  )
}
