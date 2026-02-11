import { useEffect, useState } from 'react'
import { Home, Zap, Activity, Wifi, WifiOff, Settings } from 'lucide-react'
import EnvironmentConfig from '../components/EnvironmentConfig'
import EnvironmentDetails from '../components/EnvironmentDetails'
import { Environment } from '../types'
import { useAuth0 } from '@auth0/auth0-react'

interface MultiEnvironmentOverviewProps {
  isAdmin: boolean
  onManageUsers: () => void
  onOpenEnvironment: (environmentId: string) => void
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

interface UserSummary {
  user_id: string
  name?: string
  email?: string
  environmentIds?: string[]
}

export default function MultiEnvironmentOverview({
  isAdmin,
  onManageUsers,
  onOpenEnvironment,
}: MultiEnvironmentOverviewProps) {
  const [showConfig, setShowConfig] = useState(false)
  const [allowedEnvironmentIds, setAllowedEnvironmentIds] = useState<string[] | null>(null)
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError] = useState<string | null>(null)
  const [detailEnvironment, setDetailEnvironment] = useState<Environment | null>(null)
  const [detailUsers, setDetailUsers] = useState<UserSummary[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently } = useAuth0()
  const [environments, setEnvironments] = useState<Environment[]>([])

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
        const nextEnvironments: Environment[] = loaded.map((env: HaEnvironmentPayload) => ({
          id: String(env.id),
          name: String(env.name || env.id),
          type: (env.type as Environment['type']) || 'home_assistant',
          config: {
            baseUrl: env.config?.baseUrl || '',
            apiKey: env.config?.apiKey || '',
            siteId: env.config?.siteId || '',
            notes: env.config?.notes || '',
          },
          status: 'offline',
          lastUpdate: 'just now',
        }))
        setEnvironments(nextEnvironments)
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

  const loadEnvironmentUsers = async (environmentId: string) => {
    if (!isAdmin) {
      setDetailUsers([])
      return
    }

    setDetailLoading(true)
    setDetailError(null)

    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/list-users', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        throw new Error('Unable to load users')
      }

      const data = await response.json()
      const users = Array.isArray(data?.users) ? data.users : []
      const filtered = users.filter((user: UserSummary) =>
        Array.isArray(user.environmentIds)
          ? user.environmentIds.includes(environmentId)
          : false,
      )
      setDetailUsers(filtered)
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'Unable to load users')
      setDetailUsers([])
    } finally {
      setDetailLoading(false)
    }
  }

  const openDetails = (env: Environment) => {
    setDetailEnvironment(env)
    setDetailUsers([])
    setDetailError(null)
    void loadEnvironmentUsers(env.id)
  }

  const visibleEnvironments = allowedEnvironmentIds
    ? environments.filter((env) => allowedEnvironmentIds.includes(env.id))
    : environments

  const handleSaveEnvironments = async (nextEnvironments: Environment[]) => {
    setEnvError(null)

    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/save-ha-environments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environments: nextEnvironments.map((env) => ({
            id: env.id,
            name: env.name,
            type: env.type,
            config: env.config,
          })),
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Unable to save environments')
      }

      const updated = nextEnvironments.map((env) => ({
        ...env,
        status: env.status || 'offline',
        lastUpdate: env.lastUpdate || 'just now',
      }))
      setEnvironments(updated)
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
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <Home className="w-8 h-8 text-brand-2" />
              <div>
                <h1 className="text-4xl md:text-5xl font-heavy text-light-2 mb-2">
                  Multi-Environment Overview
                </h1>
                <p className="text-light-1 text-lg">Monitor all your Home Assistant environments in one place</p>
                <p className="text-light-1 text-sm opacity-80">Developer: Olivier Brouwer</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <button
                  onClick={onManageUsers}
                  className="flex items-center gap-2 px-4 py-2 bg-light-2 bg-opacity-20 text-light-2 rounded-lg hover:bg-opacity-30 transition-all backdrop-blur-sm"
                >
                  <Settings className="w-5 h-5" />
                  Users
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={() => setShowConfig(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-brand-2 text-light-2 rounded-lg hover:bg-brand-3 transition-all"
                >
                  <Settings className="w-5 h-5" />
                  Add environment
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={() => setShowConfig(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-light-2 bg-opacity-20 text-light-2 rounded-lg hover:bg-opacity-30 transition-all backdrop-blur-sm"
                >
                  <Settings className="w-5 h-5" />
                  Configure
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Environment Grid */}
        {envLoading && <p className="text-light-1 mb-6">Loading environments...</p>}
        {envError && <p className="text-red-300 mb-6">{envError}</p>}
        {!envLoading && !envError && visibleEnvironments.length === 0 && (
          <p className="text-light-1 mb-6">No environments configured yet.</p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {visibleEnvironments.map((env) => (
            <div
              key={env.id}
              className="glass-card rounded-2xl p-6 shadow-xl hover:shadow-2xl transition-all cursor-pointer"
            >
              {/* Environment Header */}
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-heavy text-dark-1">{env.name}</h3>
                <div className={`flex items-center gap-1 ${getStatusColor(env.status)}`}>
                  {getStatusIcon(env.status)}
                  <span className="text-sm font-medium capitalize">{env.status}</span>
                </div>
              </div>

              {/* Environment Stats */}
              {env.status === 'online' ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-dark-2 text-sm">Current Power</span>
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-brand-2" />
                      <span className="font-heavy text-dark-1">{env.currentPower} kW</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-dark-2 text-sm">Daily Usage</span>
                    <span className="font-medium text-dark-1">{env.dailyUsage} kWh</span>
                  </div>
                  <div className="pt-2 border-t border-dark-2 border-opacity-10">
                    <p className="text-xs text-dark-2">Last update: {env.lastUpdate}</p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-4">
                  <WifiOff className="w-8 h-8 text-red-400 mx-auto mb-2" />
                  <p className="text-dark-2 text-sm">Environment offline</p>
                  <p className="text-xs text-dark-2 mt-1">Last seen: {env.lastUpdate}</p>
                </div>
              )}

              {/* Action Button */}
              <button
                className="w-full mt-4 glass-button py-2 px-4 rounded-lg font-medium transition-all"
                onClick={() => openDetails(env)}
              >
                View Details
              </button>
            </div>
          ))}
        </div>

        {/* Summary Stats */}
        <div className="glass-panel rounded-2xl p-6 shadow-xl">
          <h2 className="text-2xl font-heavy text-dark-1 mb-6">Environment Summary</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-2 mb-2">
                {visibleEnvironments.filter(e => e.status === 'online').length}/{visibleEnvironments.length}
              </div>
              <p className="text-dark-2">Environments Online</p>
            </div>
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-3 mb-2">
                {visibleEnvironments.reduce((sum, env) => sum + (env.currentPower || 0), 0).toFixed(1)}
              </div>
              <p className="text-dark-2">Total Current Power (kW)</p>
            </div>
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-4 mb-2">
                {visibleEnvironments.reduce((sum, env) => sum + (env.dailyUsage || 0), 0).toFixed(1)}
              </div>
              <p className="text-dark-2">Total Daily Usage (kWh)</p>
            </div>
          </div>
        </div>

        {/* Configuration Modal */}
        {showConfig && (
          <EnvironmentConfig
            environments={environments}
            onSave={handleSaveEnvironments}
            onClose={() => setShowConfig(false)}
          />
        )}

        {detailEnvironment && (
          <EnvironmentDetails
            environment={detailEnvironment}
            users={detailUsers}
            isLoading={detailLoading}
            error={detailError}
            onClose={() => setDetailEnvironment(null)}
            onOpenDashboard={() => {
              onOpenEnvironment(detailEnvironment.id)
              setDetailEnvironment(null)
            }}
          />
        )}
      </div>
    </div>
  )
}