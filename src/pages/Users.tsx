import { useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { Users as UsersIcon, ShieldAlert, Settings, Home, Zap, LogOut, ChevronDown, Lock } from 'lucide-react'
import UserSensorConfig from '../components/UserSensorConfig'

interface UsersProps {
  isAdmin: boolean
  onOpenOverview: () => void
  onOpenDashboard: () => void
  onLogout: () => void
}

interface UserRow {
  user_id: string
  email?: string
  name?: string
  last_login?: string
  created_at?: string
  environmentIds?: string[]
}

interface EnvironmentOption {
  id: string
  label: string
  type?: string
}

export default function Users({ isAdmin, onOpenOverview, onOpenDashboard, onLogout }: UsersProps) {
  const { getAccessTokenSilently, getIdTokenClaims } = useAuth0()
  const [users, setUsers] = useState<UserRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteEnvironments, setInviteEnvironments] = useState<string[]>([])
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [isInviting, setIsInviting] = useState(false)
  const [resettingUserId, setResettingUserId] = useState<string | null>(null)
  const [environmentOptions, setEnvironmentOptions] = useState<EnvironmentOption[]>([])
  const [envError, setEnvError] = useState<string | null>(null)
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false)
  const [selectedUserForSensorConfig, setSelectedUserForSensorConfig] = useState<{ userId: string; email: string; environmentId: string; environmentName: string } | null>(null)
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)

  const adminEmailAllowlist = ((import.meta.env.VITE_ADMIN_EMAILS as string | undefined) ?? 'olivier@inside-out.tech')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

  useEffect(() => {
    const loadUsers = async () => {
      if (!isAdmin) {
        setIsLoading(false)
        return
      }

      try {
        const token = await getAuthToken()
        const response = await fetch('/.netlify/functions/list-users', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })

        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new Error(data?.error || `Unable to load users (${response.status})`)
        }

        const data = await response.json()
        setUsers(data.users ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load users')
      } finally {
        setIsLoading(false)
      }
    }

    void loadUsers()
  }, [getAccessTokenSilently, getIdTokenClaims, isAdmin])

  useEffect(() => {
    const loadEnvironments = async () => {
      if (!isAdmin) {
        return
      }

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
        const options = loaded.map((env: { id: string; name?: string; type?: string }) => ({
          id: String(env.id),
          label: String(env.name || env.id),
          type: env.type,
        }))
        setEnvironmentOptions(options)
      } catch (err) {
        setEnvError(err instanceof Error ? err.message : 'Unable to load environments')
      }
    }

    void loadEnvironments()
  }, [isAdmin])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showSettingsDropdown && !target.closest('.users-settings-dropdown')) {
        setShowSettingsDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSettingsDropdown])

  const getAuthToken = async () => {
    const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
    return getAccessTokenSilently({
      authorizationParams: { audience },
    })
  }

  const handleInvite = async () => {
    if (!inviteEmail) {
      setError('Email is required to invite a user')
      return
    }

    setError(null)
    setInviteLink(null)
    setIsInviting(true)

    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/create-user', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: inviteEmail,
          name: inviteName,
          environmentIds: inviteEnvironments,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Unable to create user')
      }

      const data = await response.json()
      setInviteLink(data.inviteLink ?? null)
      setInviteEmail('')
      setInviteName('')
      setInviteEnvironments([])
      setUsers((prev) => [data.user, ...prev])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create user')
    } finally {
      setIsInviting(false)
    }
  }

  const sendPasswordReset = async (email: string) => {
    setError(null)
    setResettingUserId(email)

    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/send-password-reset', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Unable to send reset email')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send reset email')
    } finally {
      setResettingUserId(null)
    }
  }

  if (!isAdmin) {
    return (
      <div className="app-shell min-h-screen p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="glass-panel rounded-2xl p-8 text-center">
            <ShieldAlert className="w-10 h-10 text-yellow-300 mx-auto mb-4" />
            <h1 className="text-2xl font-heavy text-light-2 mb-2">Admin access required</h1>
            <p className="text-light-1">You don’t have permission to view users.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell min-h-screen p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <UsersIcon className="w-8 h-8 text-brand-2" />
            <div>
              <h1 className="text-3xl md:text-4xl font-heavy text-light-2">Users</h1>
              <p className="text-light-1">Manage and review portal accounts</p>
            </div>
          </div>

          <div className="relative users-settings-dropdown shrink-0">
            <button
              onClick={() => setShowSettingsDropdown((prev) => !prev)}
              className="p-2 bg-light-2 bg-opacity-20 text-light-2 border border-light-2 border-opacity-30 rounded-lg hover:bg-opacity-30 transition-all backdrop-blur-sm"
              aria-label="Open settings"
            >
              <Settings className="w-5 h-5" />
            </button>

            {showSettingsDropdown && (
              <div className="absolute right-0 mt-2 w-56 bg-dark-1 border border-light-2 border-opacity-30 rounded-lg shadow-xl z-50">
                <div className="py-1">
                  <button
                    onClick={() => {
                      onOpenOverview()
                      setShowSettingsDropdown(false)
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                  >
                    <Home className="w-5 h-5" />
                    <span className="font-medium">Overview</span>
                  </button>

                  <button
                    onClick={() => {
                      onOpenDashboard()
                      setShowSettingsDropdown(false)
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                  >
                    <Zap className="w-5 h-5" />
                    <span className="font-medium">Open Dashboard</span>
                  </button>

                  <button
                    onClick={() => {
                      onLogout()
                      setShowSettingsDropdown(false)
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-red-200 hover:bg-red-500 hover:bg-opacity-20 transition-all text-left border-t border-light-2 border-opacity-10"
                  >
                    <LogOut className="w-5 h-5" />
                    <span className="font-medium">Logout</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="glass-panel rounded-2xl p-6 shadow-xl mb-6">
          <h2 className="text-xl font-heavy text-dark-1 mb-4">Invite user</h2>
          {envError && <p className="text-red-600 mb-4">{envError}</p>}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
              placeholder="Name (optional)"
              className="w-full rounded-lg border border-dark-2 border-opacity-20 px-3 py-2"
            />
            <input
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="Email"
              type="email"
              className="w-full rounded-lg border border-dark-2 border-opacity-20 px-3 py-2"
            />
            <div className="flex flex-wrap gap-2">
              {environmentOptions.map((env) => (
                <label key={env.id} className="flex items-center gap-2 text-sm text-dark-2">
                  <input
                    type="checkbox"
                    checked={inviteEnvironments.includes(env.id)}
                    onChange={(event) => {
                      setInviteEnvironments((prev) =>
                        event.target.checked
                          ? [...prev, env.id]
                          : prev.filter((id) => id !== env.id),
                      )
                    }}
                  />
                  {env.label}
                </label>
              ))}
              {environmentOptions.length === 0 && (
                <span className="text-xs text-dark-2">No environments available</span>
              )}
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleInvite}
              disabled={isInviting}
              className="px-4 py-2 rounded-lg bg-brand-2 text-light-2 font-medium hover:bg-brand-3 transition-all disabled:opacity-60"
            >
              {isInviting ? 'Creating...' : 'Create user'}
            </button>
            {inviteLink && (
              <div className="text-sm text-dark-2">
                Invite link: <a href={inviteLink} className="text-brand-2 underline" target="_blank">Open</a>
              </div>
            )}
          </div>
        </div>

        <div className="glass-panel rounded-2xl p-6 shadow-xl">
          {isLoading && <p className="text-dark-2">Loading users...</p>}
          {error && <p className="text-red-600">{error}</p>}
          {!isLoading && !error && users.length === 0 && (
            <p className="text-dark-2">No users found.</p>
          )}

          {!isLoading && !error && users.length > 0 && (
            <div className="space-y-2">
              {users.map((user) => {
                const isAdminUser = !!user.email && adminEmailAllowlist.includes(user.email.toLowerCase())
                const isExpanded = expandedUserId === user.user_id

                return (
                  <div key={user.user_id} className="border border-dark-2 border-opacity-10 rounded-xl overflow-hidden">
                    {/* User Header Row */}
                    <div className="bg-dark-2 bg-opacity-5 p-4 flex items-center justify-between hover:bg-opacity-10 transition-colors">
                      <div className="flex items-center gap-4 flex-1">
                        <button
                          onClick={() => setExpandedUserId(isExpanded ? null : user.user_id)}
                          className="p-1 hover:bg-dark-2 hover:bg-opacity-20 rounded transition-colors"
                        >
                          <ChevronDown
                            className={`w-5 h-5 text-dark-2 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          />
                        </button>
                        <div className="flex-1">
                          <h3 className="font-semibold text-dark-1">{user.name ?? user.email ?? '—'}</h3>
                          <p className="text-sm text-dark-2">{user.email ?? '—'}</p>
                        </div>
                        {isAdminUser && (
                          <div className="flex items-center gap-1 px-2 py-1 bg-brand-2 bg-opacity-20 rounded-lg">
                            <Lock className="w-3 h-3 text-brand-2" />
                            <span className="text-xs font-medium text-brand-2">Admin</span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-dark-2">
                        <div className="text-right">
                          <div className="font-medium">Last login</div>
                          <div>{user.last_login ? new Date(user.last_login).toLocaleDateString() : '—'}</div>
                        </div>
                      </div>
                    </div>

                    {/* Expanded Content */}
                    {isExpanded && (
                      <div className="p-4 bg-dark-2 bg-opacity-2 border-t border-dark-2 border-opacity-10 space-y-4">
                        {/* Environments & Sensors Section */}
                        <div>
                          <h4 className="text-sm font-semibold text-dark-1 mb-3">Environments & Sensors</h4>
                          <div className="space-y-2">
                            {environmentOptions.length === 0 ? (
                              <p className="text-xs text-dark-2">No environments available</p>
                            ) : (
                              environmentOptions.map((env) => {
                                const hasAccess = user.environmentIds?.includes(env.id) ?? false
                                return (
                                  <div key={env.id} className="flex items-center justify-between p-3 bg-dark-2 bg-opacity-5 rounded-lg border border-dark-2 border-opacity-10">
                                    <div className="flex items-center gap-3 flex-1">
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={hasAccess}
                                          disabled={isAdminUser}
                                          onChange={(event) => {
                                            if (isAdminUser) return
                                            const next = event.target.checked
                                              ? [...(user.environmentIds ?? []), env.id]
                                              : (user.environmentIds ?? []).filter((id) => id !== env.id)
                                            setUsers((prev) =>
                                              prev.map((u) =>
                                                u.user_id === user.user_id
                                                  ? { ...u, environmentIds: next }
                                                  : u,
                                              ),
                                            )
                                          }}
                                          className="rounded"
                                        />
                                        <span className="text-sm font-medium text-dark-1">{env.label}</span>
                                      </label>
                                    </div>
                                    {!isAdminUser && hasAccess && user.email && (
                                      <button
                                        onClick={() => {
                                          if (user.email) {
                                            setSelectedUserForSensorConfig({
                                              userId: user.user_id,
                                              email: user.email,
                                              environmentId: env.id,
                                              environmentName: env.label,
                                            })
                                          }
                                        }}
                                        className="px-3 py-1 text-xs font-medium rounded-lg bg-green-600 bg-opacity-30 text-green-200 hover:bg-opacity-50 transition-all"
                                      >
                                        Configure Sensors
                                      </button>
                                    )}
                                  </div>
                                )
                              })
                            )}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="border-t border-dark-2 border-opacity-10 pt-3">
                          <p className="text-xs font-semibold text-dark-2 mb-2">Account Actions</p>
                          {user.email && (
                            <button
                              onClick={() => sendPasswordReset(user.email ?? '')}
                              disabled={resettingUserId === user.email}
                              className="w-full px-3 py-2 rounded-lg bg-dark-2 bg-opacity-10 text-dark-2 text-sm font-medium hover:bg-opacity-20 transition-all disabled:opacity-60"
                            >
                              {resettingUserId === user.email ? 'Sending Password Reset...' : 'Send Password Reset Email'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {selectedUserForSensorConfig && (
        <UserSensorConfig
          userId={selectedUserForSensorConfig.userId}
          userEmail={selectedUserForSensorConfig.email}
          environmentId={selectedUserForSensorConfig.environmentId}
          environmentName={selectedUserForSensorConfig.environmentName}
          onClose={() => setSelectedUserForSensorConfig(null)}
          onSaved={() => {
            setSelectedUserForSensorConfig(null)
            // Reload users to show updated state
            const loadUsers = async () => {
              try {
                const token = await getAuthToken()
                const response = await fetch('/.netlify/functions/list-users', {
                  headers: {
                    Authorization: `Bearer ${token}`,
                  },
                })

                if (!response.ok) {
                  const data = await response.json().catch(() => null)
                  throw new Error(data?.error || `Unable to load users (${response.status})`)
                }

                const data = await response.json()
                setUsers(data.users ?? [])
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unable to load users')
              }
            }

            void loadUsers()
          }}
        />
      )}
    </div>
  )
}

