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
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>('')

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
        const profileEmail = typeof user?.email === 'string' ? user.email : ''
        const email = (claimEmail || profileEmail).toLowerCase()
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
    if (!isAuthenticated) {
      setCurrentView('overview')
    }
  }, [isAuthenticated])

  const handleLogout = () => {
    void logout({ logoutParams: { returnTo: window.location.origin } })
  }

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
          onOpenDashboard={() => setCurrentView('dashboard')}
          onOpenEnvironment={(environmentId) => {
            setSelectedEnvironmentId(environmentId)
            setCurrentView('dashboard')
          }}
          onLogout={handleLogout}
        />
      )}
      {currentView === 'dashboard' && (
        <Dashboard
          isAdmin={isAdmin}
          selectedEnvironmentId={selectedEnvironmentId}
          onEnvironmentChange={setSelectedEnvironmentId}
          onOpenOverview={isAdmin ? () => setCurrentView('overview') : undefined}
          onManageUsers={isAdmin ? () => setCurrentView('users') : undefined}
          onLogout={handleLogout}
        />
      )}
      {isAdmin && currentView === 'users' && (
        <Users
          isAdmin={isAdmin}
          onOpenOverview={() => setCurrentView('overview')}
          onOpenDashboard={() => setCurrentView('dashboard')}
          onLogout={handleLogout}
        />
      )}
    </div>
  )
}

export default App
