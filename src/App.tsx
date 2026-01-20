import { useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import MultiEnvironmentOverview from './pages/MultiEnvironmentOverview'
import Dashboard from './pages/Dashboard'
import './App.css'

// Automatic deployment test - v1.1
function App() {
  const [currentView, setCurrentView] = useState<'overview' | 'dashboard'>('overview')
  const { isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0()

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-brand-4 via-brand-3 to-brand-2 flex items-center justify-center">
        <div className="text-light-2 text-xl">Loading...</div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-brand-4 via-brand-3 to-brand-2 flex items-center justify-center">
        <div className="bg-light-2 bg-opacity-10 backdrop-blur-sm rounded-2xl p-8 shadow-2xl max-w-md w-full mx-4">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-light-2 mb-2">Inside Out</h1>
            <h2 className="text-xl text-light-2 mb-6">Energy Portal</h2>
            <p className="text-light-2 mb-8 opacity-80">
              Secure access to your energy monitoring dashboard
            </p>
            <button
              onClick={() => loginWithRedirect()}
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
      {currentView === 'overview' ? (
        <MultiEnvironmentOverview />
      ) : (
        <Dashboard />
      )}

      {/* Simple Navigation */}
      <div className="fixed bottom-6 right-6 flex gap-2">
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
