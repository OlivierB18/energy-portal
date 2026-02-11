import { useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import MultiEnvironmentOverview from './pages/MultiEnvironmentOverview'
import Dashboard from './pages/Dashboard'
import Users from './pages/Users'
import './App.css'

// Automatic deployment test - v1.1
function App() {
  const [currentView, setCurrentView] = useState<'overview' | 'dashboard' | 'users'>('overview')
  const [isAdmin, setIsAdmin] = useState(false)
  const [assignedEnvironmentIds, setAssignedEnvironmentIds] = useState<string[] | null>(null)
  const [environmentLabelMap, setEnvironmentLabelMap] = useState<Record<string, string>>({})
  const { isAuthenticated, isLoading, loginWithRedirect, logout, getIdTokenClaims, getAccessTokenSilently, user } = useAuth0()

  const decodeJwtPayload = (token: string) => {
    try {
      const payload = token.split('.')[1]
      if (!payload) {
        return null
      }
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
      const json = atob(padded)
      return JSON.parse(json) as Record<string, unknown>
    } catch {
      return null
    }
  }

  const getRolesFromClaims = (claims: Record<string, unknown> | null | undefined) => {
    if (!claims) {
      return [] as string[]
    }

    const roleClaimCandidates = [
      'https://brouwer-ems/roles',
      'https://brouwer-ems/role',
      'roles',
      'role',
    ]

    for (const key of roleClaimCandidates) {
      const value = claims[key]
      if (Array.isArray(value)) {
        return value.filter((item) => typeof item === 'string') as string[]
      }
      if (typeof value === 'string') {
        return [value]
      }
    }

    return [] as string[]
  }

  const getEmailFromClaims = (claims: Record<string, unknown> | null | undefined) => {
    if (!claims) {
      return ''
    }

    const emailValue = claims.email ?? claims['https://brouwer-ems/email']
    return typeof emailValue === 'string' ? emailValue : ''
  }

  useEffect(() => {
    const loadRoles = async () => {
      if (!isAuthenticated) {
        setIsAdmin(false)
        return
      }

      try {
        const claims = (await getIdTokenClaims()) as Record<string, unknown> | undefined
        let roles = getRolesFromClaims(claims)

        if (roles.length === 0) {
          const accessToken = await getAccessTokenSilently().catch(() => null)
          if (accessToken) {
            const accessClaims = decodeJwtPayload(accessToken)
            roles = getRolesFromClaims(accessClaims)
          }
        }

        const allowlist = ((import.meta.env.VITE_ADMIN_EMAILS as string | undefined) ?? 'olivier@inside-out.tech')
          .split(',')
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean)
        const claimEmail = getEmailFromClaims(claims)
        const email = (user?.email || claimEmail).toLowerCase()
        const isAllowedEmail = email.length > 0 && allowlist.includes(email)

        const nextIsAdmin = roles.includes('admin') || isAllowedEmail
        setIsAdmin(nextIsAdmin)
        setCurrentView((prev) => (nextIsAdmin ? prev : 'dashboard'))
      } catch {
        setIsAdmin(false)
        setCurrentView('dashboard')
      }
    }

    void loadRoles()
  }, [getAccessTokenSilently, getIdTokenClaims, isAuthenticated, user?.email])

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
        setAssignedEnvironmentIds(null)
        return
      }

      if (isAdmin) {
        setAssignedEnvironmentIds(null)
        return
      }

      try {
        const claims = await getIdTokenClaims()
        const envClaim = 'https://brouwer-ems/environments'
        const envs = (claims?.[envClaim] as string[] | undefined) ?? null

        if (envs && envs.length > 0) {
          setAssignedEnvironmentIds(envs)
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
        setAssignedEnvironmentIds(ids)
      } catch {
        setAssignedEnvironmentIds([])
      }
    }

    void loadAssignments()
  }, [getAccessTokenSilently, getIdTokenClaims, isAuthenticated, isAdmin])

  useEffect(() => {
    const loadEnvironmentLabels = async () => {
      if (!isAuthenticated) {
        setEnvironmentLabelMap({})
        return
      }

      try {
        const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
        const token = await getAccessTokenSilently({
          authorizationParams: { audience },
        })
        const response = await fetch('/.netlify/functions/get-ha-environments', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new Error('Unable to load environments')
        }

        const data = await response.json()
        const loaded = Array.isArray(data?.environments) ? data.environments : []
        const nextMap = loaded.reduce((acc, env) => {
          const id = String(env.id)
          const label = String(env.name || env.id)
          if (id) {
            acc[id] = label
          }
          return acc
        }, {} as Record<string, string>)
        setEnvironmentLabelMap(nextMap)
      } catch {
        setEnvironmentLabelMap({})
      }
    }

    void loadEnvironmentLabels()
  }, [getAccessTokenSilently, isAuthenticated])

  if (isLoading) {
    return (
      <div className="app-shell min-h-screen flex items-center justify-center">
        <div className="text-light-2 text-xl">Loading...</div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="app-shell min-h-screen flex items-center justify-center">
        <div className="bg-light-2 bg-opacity-10 backdrop-blur-sm rounded-2xl p-8 shadow-2xl max-w-md w-full mx-4">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-light-2 mb-2">Inside Out</h1>
            <h2 className="text-xl text-light-2 mb-6">Energy Portal</h2>
            <p className="text-light-2 mb-8 opacity-80">
              Secure access to your energy monitoring dashboard
            </p>
            <button
              onClick={() => loginWithRedirect({ authorizationParams: { scope: 'openid profile email' } })}
              className="w-full bg-brand-2 hover:bg-brand-1 text-light-2 font-semibold py-3 px-6 rounded-lg transition-all duration-200 shadow-lg hover:shadow-xl"
            >
              Sign In
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="App">
      {isAdmin && currentView === 'overview' && (
        <MultiEnvironmentOverview
          isAdmin={isAdmin}
          onManageUsers={() => setCurrentView('users')}
        />
      )}
      {currentView === 'dashboard' && <Dashboard isAdmin={isAdmin} />}
      {isAdmin && currentView === 'users' && <Users isAdmin={isAdmin} />}

      {isAuthenticated && (
        <div className="fixed bottom-6 left-6 z-40 bg-light-2 bg-opacity-30 text-light-2 rounded-xl px-4 py-3 backdrop-blur-sm shadow-lg max-w-xs">
          <div className="text-xs uppercase tracking-wide opacity-80">Logged in as</div>
          <div className="text-sm font-medium truncate">{user?.name || user?.email || 'Unknown user'}</div>
          <div className="mt-3 text-xs uppercase tracking-wide opacity-80">Environments</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(assignedEnvironmentIds === null
              ? Object.keys(environmentLabelMap)
              : assignedEnvironmentIds
            )
              .map((envId) => environmentLabelMap[envId])
              .filter(Boolean)
              .map((label) => (
                <span
                  key={label}
                  className="px-2 py-1 rounded-full bg-light-2 bg-opacity-20 text-xs text-light-2"
                >
                  {label}
                </span>
              ))}
            {assignedEnvironmentIds && assignedEnvironmentIds.length === 0 && (
              <span className="text-xs text-light-1 opacity-80">No environments assigned</span>
            )}
          </div>
        </div>
      )}

      {/* Simple Navigation */}
      <div className="fixed bottom-6 right-6 flex gap-2">
        {isAdmin && (
          <button
            onClick={() => setCurrentView('overview')}
            className={`px-4 py-2 rounded-lg font-medium transition-all ${
              currentView === 'overview'
                ? 'bg-brand-2 text-light-2 shadow-lg'
                : 'bg-light-2 bg-opacity-20 text-light-2 hover:bg-opacity-30 backdrop-blur-sm'
            }`}
          >
            Overview
          </button>
        )}
        <button
          onClick={() => setCurrentView('dashboard')}
          className={`px-4 py-2 rounded-lg font-medium transition-all ${
            currentView === 'dashboard'
              ? 'bg-brand-2 text-light-2 shadow-lg'
              : 'bg-light-2 bg-opacity-20 text-light-2 hover:bg-opacity-30 backdrop-blur-sm'
          }`}
        >
          Environment
        </button>
        {isAdmin && (
          <button
            onClick={() => setCurrentView('users')}
            className={`px-4 py-2 rounded-lg font-medium transition-all ${
              currentView === 'users'
                ? 'bg-brand-2 text-light-2 shadow-lg'
                : 'bg-light-2 bg-opacity-20 text-light-2 hover:bg-opacity-30 backdrop-blur-sm'
            }`}
          >
            Users
          </button>
        )}
        <button
          onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
          className="px-4 py-2 rounded-lg font-medium transition-all bg-red-500 bg-opacity-20 text-red-100 hover:bg-opacity-30 backdrop-blur-sm"
        >
          Logout
        </button>
      </div>
    </div>
  )
}

export default App
