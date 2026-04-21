import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import {
  Users as UsersIcon,
  ShieldAlert,
  Settings,
  Home,
  Zap,
  LogOut,
  ChevronDown,
  X,
  Plus,
  Copy,
  Check,
  UserPlus,
  Shield,
  Eye,
} from 'lucide-react'

interface UsersProps {
  isAdmin: boolean
  onOpenOverview: () => void
  onOpenDashboard: () => void
  onLogout: () => void
}

interface UserEnvironment {
  id: string
  name: string
  role: string
}

interface UserRow {
  user_id: string
  email: string
  role: 'admin' | 'viewer'
  environments: UserEnvironment[]
}

interface EnvironmentOption {
  id: string
  label: string
}

// ---- Skeleton ---------------------------------------------------------------
function SkeletonRow() {
  return (
    <div className="border border-dark-2 border-opacity-10 rounded-xl p-4 animate-pulse">
      <div className="flex items-center gap-4">
        <div className="w-8 h-8 bg-dark-2 bg-opacity-20 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-dark-2 bg-opacity-20 rounded w-48" />
          <div className="h-3 bg-dark-2 bg-opacity-10 rounded w-32" />
        </div>
        <div className="h-6 w-16 bg-dark-2 bg-opacity-20 rounded-full" />
      </div>
    </div>
  )
}

// ---- Role badge -------------------------------------------------------------
function RoleBadge({ role, isSuperAdmin }: { role: string; isSuperAdmin?: boolean }) {
  if (isSuperAdmin) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-500 bg-opacity-20 text-yellow-300">
        <Shield className="w-3 h-3" /> SUPER ADMIN
      </span>
    )
  }
  if (role === 'admin') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-brand-2 bg-opacity-20 text-brand-2">
        <Shield className="w-3 h-3" /> ADMIN
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-dark-2 bg-opacity-20 text-dark-2">
      <Eye className="w-3 h-3" /> VIEWER
    </span>
  )
}

// ---- Toast ------------------------------------------------------------------
function Toast({ message, type }: { message: string; type: 'error' | 'success' }) {
  return (
    <div
      className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-xl text-sm font-medium transition-all ${
        type === 'error'
          ? 'bg-red-900 bg-opacity-90 text-red-200 border border-red-700'
          : 'bg-green-900 bg-opacity-90 text-green-200 border border-green-700'
      }`}
    >
      {message}
    </div>
  )
}

// =============================================================================
export default function Users({ isAdmin, onOpenOverview, onOpenDashboard, onLogout }: UsersProps) {
  const { user, getAccessTokenSilently } = useAuth0()

  const ownerEmail = ((import.meta.env.VITE_OWNER_EMAIL as string | undefined) ?? '').trim().toLowerCase()
  const userEmail = (user?.email ?? '').trim().toLowerCase()
  const isSuperAdmin =
    (user as any)?.['https://brouwer-ems/app_metadata']?.role === 'super_admin' ||
    (ownerEmail.length > 0 && userEmail === ownerEmail)

  const [users, setUsers] = useState<UserRow[]>([])
  const [environments, setEnvironments] = useState<EnvironmentOption[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'success' } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Invite modal
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'viewer'>('viewer')
  const [inviteEnvId, setInviteEnvId] = useState('')
  const [isInviting, setIsInviting] = useState(false)
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)

  // Per-user state
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)
  const [addEnvDropdownUserId, setAddEnvDropdownUserId] = useState<string | null>(null)
  const [pendingActionUserId, setPendingActionUserId] = useState<string | null>(null)

  // Nav dropdown
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false)

  const showToast = useCallback((message: string, type: 'error' | 'success') => {
    setToast({ message, type })
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }, [])

  const getAuthToken = useCallback(async () => {
    const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
    return getAccessTokenSilently({ authorizationParams: { audience } })
  }, [getAccessTokenSilently])

  // Load environments
  useEffect(() => {
    if (!isAdmin) return
    void (async () => {
      try {
        const token = await getAuthToken()
        const response = await fetch('/.netlify/functions/get-ha-environments', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) return
        const data = await response.json()
        const loaded = Array.isArray(data?.environments) ? data.environments : []
        setEnvironments(
          loaded.map((env: { id: string; name?: string }) => ({
            id: String(env.id),
            label: String(env.name || env.id),
          })),
        )
      } catch {
        // Non-blocking
      }
    })()
  }, [isAdmin, getAuthToken])

  // Load users
  const loadUsers = useCallback(async () => {
    if (!isAdmin) {
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/get-users', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || `Unable to load users (${response.status})`)
      }
      const data = await response.json()
      setUsers(data.users ?? [])
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to load users', 'error')
    } finally {
      setIsLoading(false)
    }
  }, [isAdmin, getAuthToken, showToast])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.users-settings-dropdown')) setShowSettingsDropdown(false)
      if (!t.closest('.add-env-dropdown')) setAddEnvDropdownUserId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleRemoveEnvironment = async (targetUser: UserRow, envId: string) => {
    setPendingActionUserId(targetUser.user_id)
    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/update-user-environment', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: targetUser.user_id,
          user_email: targetUser.email,
          environment_id: envId,
          action: 'remove',
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Failed to remove environment')
      }
      setUsers((prev) =>
        prev.map((u) =>
          u.user_id === targetUser.user_id
            ? { ...u, environments: u.environments.filter((e) => e.id !== envId) }
            : u,
        ),
      )
      showToast('Omgeving verwijderd', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to remove environment', 'error')
    } finally {
      setPendingActionUserId(null)
    }
  }

  const handleAddEnvironment = async (targetUser: UserRow, envId: string) => {
    setAddEnvDropdownUserId(null)
    setPendingActionUserId(targetUser.user_id)
    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/update-user-environment', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: targetUser.user_id,
          user_email: targetUser.email,
          environment_id: envId,
          action: 'add',
          role: 'viewer',
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Failed to add environment')
      }
      const envLabel = environments.find((e) => e.id === envId)?.label ?? envId
      setUsers((prev) =>
        prev.map((u) =>
          u.user_id === targetUser.user_id
            ? {
                ...u,
                environments: [...u.environments, { id: envId, name: envLabel, role: 'viewer' }],
              }
            : u,
        ),
      )
      showToast('Omgeving toegevoegd', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add environment', 'error')
    } finally {
      setPendingActionUserId(null)
    }
  }

  const handleInvite = async () => {
    if (!inviteEmail || !inviteEnvId) {
      showToast('Vul email en omgeving in', 'error')
      return
    }
    setIsInviting(true)
    setInviteLink(null)
    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/invite-user', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole, environment_id: inviteEnvId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || 'Failed to send invite')
      setInviteLink(data.invite_url)
      showToast(`Uitnodiging aangemaakt voor ${inviteEmail}`, 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to send invite', 'error')
    } finally {
      setIsInviting(false)
    }
  }

  const copyInviteLink = async () => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setInviteCopied(true)
      setTimeout(() => setInviteCopied(false), 2000)
    } catch {
      showToast('KopiÃ«ren mislukt', 'error')
    }
  }

  // ---------- Permission guard ----------
  if (!isAdmin) {
    return (
      <div className="app-shell min-h-screen p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="glass-panel rounded-2xl p-8 text-center">
            <ShieldAlert className="w-10 h-10 text-yellow-300 mx-auto mb-4" />
            <h1 className="text-2xl font-heavy text-light-2 mb-2">Admin access required</h1>
            <p className="text-light-1">You don't have permission to view users.</p>
          </div>
        </div>
      </div>
    )
  }

  // ---------- Main render ----------
  return (
    <div className="app-shell min-h-screen p-4 md:p-8">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <UsersIcon className="w-8 h-8 text-brand-2" />
            <div>
              <h1 className="text-3xl md:text-4xl font-heavy text-light-2">Users</h1>
              <p className="text-light-1">Beheer portal toegang en uitnodigingen</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowInviteModal(true)
                setInviteLink(null)
                setInviteEmail('')
                setInviteRole('viewer')
                setInviteEnvId(environments[0]?.id ?? '')
              }}
              className="flex items-center gap-2 px-4 py-2 bg-brand-2 text-light-2 rounded-lg font-medium hover:bg-brand-3 transition-all text-sm"
            >
              <UserPlus className="w-4 h-4" />
              + Gebruiker uitnodigen
            </button>

            <div className="relative users-settings-dropdown">
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
                      onClick={() => { onOpenOverview(); setShowSettingsDropdown(false) }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                    >
                      <Home className="w-5 h-5" /> <span className="font-medium">Overview</span>
                    </button>
                    <button
                      onClick={() => { onOpenDashboard(); setShowSettingsDropdown(false) }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                    >
                      <Zap className="w-5 h-5" /> <span className="font-medium">Open Dashboard</span>
                    </button>
                    <button
                      onClick={() => { onLogout(); setShowSettingsDropdown(false) }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-red-200 hover:bg-red-500 hover:bg-opacity-20 transition-all text-left border-t border-light-2 border-opacity-10"
                    >
                      <LogOut className="w-5 h-5" /> <span className="font-medium">Logout</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* User list */}
        <div className="glass-panel rounded-2xl p-6 shadow-xl space-y-3">
          {isLoading && (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          )}

          {!isLoading && users.length === 0 && (
            <p className="text-dark-2 text-center py-8">
              Nog geen gebruikers. Stuur een uitnodiging om te beginnen.
            </p>
          )}

          {!isLoading && users.map((u) => {
            const isExpanded = expandedUserId === u.user_id
            const isUserSuperAdmin = ownerEmail.length > 0 && u.email.toLowerCase() === ownerEmail
            const isPending = pendingActionUserId === u.user_id
            const userEnvIds = new Set(u.environments.map((e) => e.id))
            const availableToAdd = environments.filter((e) => !userEnvIds.has(e.id))

            return (
              <div key={u.user_id} className="border border-dark-2 border-opacity-10 rounded-xl overflow-visible">
                {/* Row header */}
                <div
                  className="bg-dark-2 bg-opacity-5 p-4 flex items-center gap-3 hover:bg-opacity-10 transition-colors cursor-pointer"
                  onClick={() => setExpandedUserId(isExpanded ? null : u.user_id)}
                >
                  <ChevronDown
                    className={`w-4 h-4 text-dark-2 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-dark-1 truncate">{u.email}</p>
                  </div>
                  <RoleBadge role={u.role} isSuperAdmin={isUserSuperAdmin} />
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="p-4 border-t border-dark-2 border-opacity-10">
                    <p className="text-xs font-semibold text-dark-2 uppercase tracking-wide mb-3">Omgevingen</p>

                    <div className="flex flex-wrap gap-2 mb-4">
                      {u.environments.length === 0 && (
                        <span className="text-xs text-dark-2 italic">Geen omgevingen</span>
                      )}
                      {u.environments.map((env) => (
                        <span
                          key={env.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1 bg-brand-2 bg-opacity-15 text-brand-2 rounded-full text-sm font-medium"
                        >
                          {env.name}
                          {!isUserSuperAdmin && (
                            <button
                              onClick={(e) => { e.stopPropagation(); void handleRemoveEnvironment(u, env.id) }}
                              disabled={isPending}
                              className="hover:text-red-300 transition-colors disabled:opacity-40"
                              aria-label={`Verwijder toegang tot ${env.name}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </span>
                      ))}

                      {/* + Omgeving dropdown */}
                      {!isUserSuperAdmin && availableToAdd.length > 0 && (
                        <div className="relative add-env-dropdown">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setAddEnvDropdownUserId(addEnvDropdownUserId === u.user_id ? null : u.user_id)
                            }}
                            disabled={isPending}
                            className="inline-flex items-center gap-1 px-3 py-1 border border-dark-2 border-opacity-30 text-dark-2 rounded-full text-sm hover:border-brand-2 hover:text-brand-2 transition-colors disabled:opacity-40"
                          >
                            <Plus className="w-3 h-3" /> Omgeving
                          </button>

                          {addEnvDropdownUserId === u.user_id && (
                            <div className="absolute left-0 top-full mt-1 z-50 bg-dark-1 border border-light-2 border-opacity-20 rounded-xl shadow-xl min-w-[180px] py-1">
                              {availableToAdd.map((env) => (
                                <button
                                  key={env.id}
                                  onClick={(e) => { e.stopPropagation(); void handleAddEnvironment(u, env.id) }}
                                  className="w-full text-left px-4 py-2 text-sm text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-colors"
                                >
                                  {env.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Invite modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-60 backdrop-blur-sm">
          <div className="bg-dark-1 border border-light-2 border-opacity-20 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-heavy text-light-2">Gebruiker uitnodigen</h2>
              <button
                onClick={() => setShowInviteModal(false)}
                className="p-1 text-light-2 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-light-1 mb-1">Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="gebruiker@voorbeeld.nl"
                  className="w-full px-3 py-2 rounded-lg bg-dark-2 bg-opacity-30 border border-light-2 border-opacity-20 text-light-2 placeholder-light-1 focus:outline-none focus:ring-2 focus:ring-brand-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-light-1 mb-1">Rol</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'admin' | 'viewer')}
                  className="w-full px-3 py-2 rounded-lg bg-dark-2 bg-opacity-30 border border-light-2 border-opacity-20 text-light-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                >
                  <option value="viewer">Viewer</option>
                  {isSuperAdmin && <option value="admin">Admin</option>}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-light-1 mb-1">Omgeving</label>
                <select
                  value={inviteEnvId}
                  onChange={(e) => setInviteEnvId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-dark-2 bg-opacity-30 border border-light-2 border-opacity-20 text-light-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
                >
                  <option value="">â€” Kies omgeving â€”</option>
                  {environments.map((env) => (
                    <option key={env.id} value={env.id}>{env.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {inviteLink && (
              <div className="mt-4 p-3 bg-green-900 bg-opacity-30 border border-green-700 border-opacity-40 rounded-xl">
                <p className="text-xs text-green-300 font-medium mb-2">Uitnodigingslink:</p>
                <div className="flex items-center gap-2">
                  <p className="text-xs text-green-200 truncate flex-1 font-mono">{inviteLink}</p>
                  <button
                    onClick={copyInviteLink}
                    className="shrink-0 p-1.5 rounded-lg bg-green-700 bg-opacity-40 text-green-200 hover:bg-opacity-60 transition-colors"
                  >
                    {inviteCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={handleInvite}
                disabled={isInviting}
                className="flex-1 px-4 py-2 rounded-lg bg-brand-2 text-light-2 font-medium hover:bg-brand-3 transition-all disabled:opacity-60"
              >
                {isInviting ? 'Uitnodiging versturen...' : 'Uitnodiging versturen'}
              </button>
              <button
                onClick={() => setShowInviteModal(false)}
                className="px-4 py-2 rounded-lg bg-dark-2 bg-opacity-20 text-dark-2 font-medium hover:bg-opacity-30 transition-all"
              >
                Sluiten
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} />}
    </div>
  )
}

