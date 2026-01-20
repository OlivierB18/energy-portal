import { useState } from 'react'
import EnergyCard from '../components/EnergyCard'
import EnergyChart from '../components/EnergyChart'
import { Zap, TrendingUp, Clock, Home, Settings } from 'lucide-react'

interface Environment {
  id: string
  name: string
  url: string
  token: string
}

export default function Dashboard() {
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>('home')
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today')

  // Mock environments - in real app, this would come from config
  const environments: Environment[] = [
    { id: 'home', name: 'Home', url: 'http://homeassistant.local:8123', token: 'your_token_here' },
    { id: 'office', name: 'Office', url: 'http://office-ha.local:8123', token: 'your_token_here' },
    { id: 'vacation', name: 'Vacation Home', url: 'http://vacation-ha.local:8123', token: 'your_token_here' }
  ]

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
    <div className="min-h-screen bg-gradient-to-br from-dark-1 via-brand-2 to-brand-1 p-4 md:p-8">
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
                className="bg-light-2 bg-opacity-20 text-light-2 border border-light-2 border-opacity-30 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
              >
                {environments.map((env) => (
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
          </div>
        </div>

        {/* Main Current Power Display */}
        <div className="bg-light-2 rounded-3xl shadow-2xl p-8 mb-8 backdrop-blur-lg bg-opacity-95">
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
        <div className="bg-light-2 rounded-xl shadow-lg p-4 mb-8 backdrop-blur-lg bg-opacity-95">
          <div className="flex gap-4">
            <button
              onClick={() => setTimeRange('today')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'today'
                  ? 'bg-gradient-to-r from-brand-2 to-brand-3 text-light-2'
                  : 'bg-light-1 text-dark-1 hover:bg-brand-1 hover:bg-opacity-10'
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setTimeRange('week')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'week'
                  ? 'bg-gradient-to-r from-brand-2 to-brand-3 text-light-2'
                  : 'bg-light-1 text-dark-1 hover:bg-brand-1 hover:bg-opacity-10'
              }`}
            >
              This Week
            </button>
            <button
              onClick={() => setTimeRange('month')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                timeRange === 'month'
                  ? 'bg-gradient-to-r from-brand-2 to-brand-3 text-light-2'
                  : 'bg-light-1 text-dark-1 hover:bg-brand-1 hover:bg-opacity-10'
              }`}
            >
              This Month
            </button>
          </div>
        </div>

        {/* Chart Section */}
        <div className="bg-light-2 rounded-3xl shadow-2xl p-8 backdrop-blur-lg bg-opacity-95">
          <h2 className="text-2xl font-heavy text-dark-1 mb-6 flex items-center gap-2">
            <Clock className="w-6 h-6 text-brand-2" />
            Energy Consumption Chart
          </h2>
          <EnergyChart data={chartData} timeRange={timeRange} />
        </div>

        {/* Footer Info */}
        <div className="mt-8 text-center text-light-1 text-sm">
          <p>Last updated: {new Date().toLocaleTimeString()}</p>
        </div>
      </div>
    </div>
  )
}
