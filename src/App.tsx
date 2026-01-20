import { useState } from 'react'
import MultiEnvironmentOverview from './pages/MultiEnvironmentOverview'
import Dashboard from './pages/Dashboard'
import './App.css'

function App() {
  const [currentView, setCurrentView] = useState<'overview' | 'dashboard'>('overview')

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
      </div>
    </div>
  )
}

export default App
