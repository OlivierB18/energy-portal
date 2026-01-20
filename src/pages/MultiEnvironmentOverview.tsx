import { useState } from 'react'
import { Home, Zap, Activity, Wifi, WifiOff, Settings } from 'lucide-react'
import EnvironmentConfig from '../components/EnvironmentConfig'
import { Environment } from '../types'

export default function MultiEnvironmentOverview() {
  const [showConfig, setShowConfig] = useState(false)
  const [environments, setEnvironments] = useState<Environment[]>([
    {
      id: 'home',
      name: 'Home',
      url: 'http://homeassistant.local:8123',
      status: 'online',
      currentPower: 2.45,
      dailyUsage: 12.8,
      lastUpdate: '2 minutes ago'
    },
    {
      id: 'office',
      name: 'Office',
      url: 'http://office-ha.local:8123',
      status: 'online',
      currentPower: 1.8,
      dailyUsage: 8.5,
      lastUpdate: '1 minute ago'
    },
    {
      id: 'vacation',
      name: 'Vacation Home',
      url: 'http://vacation-ha.local:8123',
      status: 'offline',
      lastUpdate: '3 hours ago'
    }
  ])

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
    <div className="min-h-screen bg-gradient-to-br from-dark-1 via-brand-2 to-brand-1 p-4 md:p-8">
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
              </div>
            </div>
            <button
              onClick={() => setShowConfig(true)}
              className="flex items-center gap-2 px-4 py-2 bg-light-2 bg-opacity-20 text-light-2 rounded-lg hover:bg-opacity-30 transition-all backdrop-blur-sm"
            >
              <Settings className="w-5 h-5" />
              Configure
            </button>
          </div>
        </div>

        {/* Environment Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {environments.map((env) => (
            <div
              key={env.id}
              className="bg-light-2 bg-opacity-95 rounded-2xl p-6 shadow-xl hover:shadow-2xl transition-all cursor-pointer backdrop-blur-lg"
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
                className="w-full mt-4 bg-gradient-to-r from-brand-2 to-brand-3 text-light-2 py-2 px-4 rounded-lg font-medium hover:shadow-lg transition-all"
                onClick={() => {
                  // In real app, this would navigate to the specific environment dashboard
                  console.log(`Navigate to ${env.name} dashboard`)
                }}
              >
                View Details
              </button>
            </div>
          ))}
        </div>

        {/* Summary Stats */}
        <div className="bg-light-2 bg-opacity-95 rounded-2xl p-6 shadow-xl backdrop-blur-lg">
          <h2 className="text-2xl font-heavy text-dark-1 mb-6">Environment Summary</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-2 mb-2">
                {environments.filter(e => e.status === 'online').length}/{environments.length}
              </div>
              <p className="text-dark-2">Environments Online</p>
            </div>
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-3 mb-2">
                {environments.reduce((sum, env) => sum + (env.currentPower || 0), 0).toFixed(1)}
              </div>
              <p className="text-dark-2">Total Current Power (kW)</p>
            </div>
            <div className="text-center">
              <div className="text-3xl font-heavy text-brand-4 mb-2">
                {environments.reduce((sum, env) => sum + (env.dailyUsage || 0), 0).toFixed(1)}
              </div>
              <p className="text-dark-2">Total Daily Usage (kWh)</p>
            </div>
          </div>
        </div>

        {/* Configuration Modal */}
        {showConfig && (
          <EnvironmentConfig
            environments={environments}
            onSave={(newEnvironments) => {
              setEnvironments(newEnvironments)
              setShowConfig(false)
            }}
            onClose={() => setShowConfig(false)}
          />
        )}
      </div>
    </div>
  )
}