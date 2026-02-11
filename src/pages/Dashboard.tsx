import { useEffect, useState } from 'react'
import EnergyCard from '../components/EnergyCard'
import EnergyChart from '../components/EnergyChart'
import HomeAssistantConfig from '../components/HomeAssistantConfig'
import { Zap, TrendingUp, Clock, Home, Settings } from 'lucide-react'
import { useAuth0 } from '@auth0/auth0-react'
import { HaEntity } from '../types'

interface EnvironmentConfig {
  id: string
  name: string
  url: string
}

interface DashboardProps {
  isAdmin: boolean
}

export default function Dashboard({ isAdmin }: DashboardProps) {
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>('')
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today')
  const [allowedEnvironmentIds, setAllowedEnvironmentIds] = useState<string[] | null>(null)
  const [environments, setEnvironments] = useState<EnvironmentConfig[]>([])
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError] = useState<string | null>(null)
  const [haEntities, setHaEntities] = useState<HaEntity[]>([])
  const [haLoading, setHaLoading] = useState(false)
  const [haError, setHaError] = useState<string | null>(null)
  const [haActionId, setHaActionId] = useState<string | null>(null)
  const [showHaConfig, setShowHaConfig] = useState(false)
  const [haRefreshKey, setHaRefreshKey] = useState(0)
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
        const loaded = Array.isArray(data?.environments) ? data.environments : []
        const next = loaded.map((env) => ({
          id: String(env.id),
          name: String(env.name || env.id),
          url: String(env.url || ''),
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
      const idTokenClaims = await getIdTokenClaims().catch(() => null)
      const rawIdToken = idTokenClaims?.__raw
      if (rawIdToken) {
        return rawIdToken
      }
      return getAccessTokenSilently()
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
    const loadHaEntities = async () => {
      if (!isAuthenticated) {
        setHaEntities([])
        return
      }

      if (!selectedEnvironment) {
        setHaEntities([])
        return
      }

      setHaLoading(true)
      setHaError(null)

      try {
        const token = await getAuthToken()
        const response = await fetch(`/.netlify/functions/ha-entities?environmentId=${selectedEnvironment}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new Error(data?.error || 'Unable to load Home Assistant data')
        }

        const data = await response.json()
        setHaEntities(Array.isArray(data?.entities) ? data.entities : [])
      } catch (error) {
        setHaError(error instanceof Error ? error.message : 'Unable to load Home Assistant data')
        setHaEntities([])
      } finally {
        setHaLoading(false)
      }
    }

    void loadHaEntities()
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
                onChange={(e) => setSelectedEnvironment(e.target.value)}
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
              <div className="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div>
              <span className="font-medium">
                Currently monitoring: {environments.find(e => e.id === selectedEnvironment)?.name}
              </span>
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
                  {mockData.currentPower}
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
            {mockData.trend}% higher than yesterday
          </p>
        </div>

        {/* Energy Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <EnergyCard
            title="Today's Usage"
            value={mockData.dailyUsage}
            unit="kWh"
            cost={mockData.costToday}
            icon="zap"
          />
          <EnergyCard
            title="This Month"
            value={mockData.monthlyUsage}
            unit="kWh"
            cost={mockData.costMonth}
            icon="calendar"
          />
          <EnergyCard
            title="Status"
            value="Active"
            unit=""
            cost={null}
            icon="activity"
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
          {!haLoading && !haError && haEntities.length === 0 && (
            <p className="text-light-1">No sensors selected for this environment.</p>
          )}

          {!haLoading && haEntities.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {haEntities.map((entity) => {
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
