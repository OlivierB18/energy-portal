import { X } from 'lucide-react'
import { Environment } from '../types'

interface EnvironmentUser {
  user_id: string
  name?: string
  email?: string
}

interface EnvironmentDetailsProps {
  environment: Environment
  users: EnvironmentUser[]
  isLoading: boolean
  error: string | null
  onClose: () => void
  onOpenDashboard: () => void
}

const formatType = (type: Environment['type']) => {
  switch (type) {
    case 'home_assistant':
      return 'Home Assistant'
    case 'solar':
      return 'Solar / Inverter'
    case 'website':
      return 'Website'
    default:
      return 'Other'
  }
}

const maskToken = (token?: string) => {
  if (!token) {
    return 'Not set'
  }
  if (token.length <= 8) {
    return 'Set'
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

export default function EnvironmentDetails({
  environment,
  users,
  isLoading,
  error,
  onClose,
  onOpenDashboard,
}: EnvironmentDetailsProps) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
      <div className="glass-panel rounded-2xl shadow-2xl max-w-3xl w-full mx-4 max-h-[90vh] overflow-hidden">
        <div className="p-6 flex items-center justify-between border-b border-dark-2 border-opacity-20">
          <div>
            <h2 className="text-2xl font-heavy text-light-2">{environment.name}</h2>
            <p className="text-light-1 text-sm">Environment details</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-light-2 hover:bg-opacity-10 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-light-1" />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto max-h-[65vh]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="glass-card rounded-xl p-4">
              <p className="text-xs uppercase text-light-1">Environment ID</p>
              <p className="text-light-2 font-medium">{environment.id}</p>
            </div>
            <div className="glass-card rounded-xl p-4">
              <p className="text-xs uppercase text-light-1">Type</p>
              <p className="text-light-2 font-medium">{formatType(environment.type)}</p>
            </div>
            <div className="glass-card rounded-xl p-4">
              <p className="text-xs uppercase text-light-1">Base URL</p>
              <p className="text-light-2 font-medium">
                {environment.config.baseUrl || 'Not set'}
              </p>
            </div>
            <div className="glass-card rounded-xl p-4">
              <p className="text-xs uppercase text-light-1">API Key / Token</p>
              <p className="text-light-2 font-medium">
                {maskToken(environment.config.apiKey)}
              </p>
            </div>
            <div className="glass-card rounded-xl p-4">
              <p className="text-xs uppercase text-light-1">Site / Device ID</p>
              <p className="text-light-2 font-medium">
                {environment.config.siteId || 'Not set'}
              </p>
            </div>
            <div className="glass-card rounded-xl p-4">
              <p className="text-xs uppercase text-light-1">Notes</p>
              <p className="text-light-2 font-medium">
                {environment.config.notes || 'None'}
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-heavy text-light-2 mb-3">Users on this environment</h3>
            {isLoading && <p className="text-light-1">Loading users...</p>}
            {error && <p className="text-red-300">{error}</p>}
            {!isLoading && !error && users.length === 0 && (
              <p className="text-light-1">No users assigned yet.</p>
            )}
            {!isLoading && !error && users.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {users.map((user) => (
                  <span
                    key={user.user_id}
                    className="px-3 py-1 rounded-full bg-light-2 bg-opacity-20 text-light-2 text-xs"
                  >
                    {user.name || user.email || 'Unknown user'}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="p-6 flex justify-end gap-3 border-t border-dark-2 border-opacity-20">
          <button
            onClick={onClose}
            className="px-4 py-2 text-light-1 hover:bg-light-2 hover:bg-opacity-10 rounded-lg transition-colors"
          >
            Close
          </button>
          <button
            onClick={onOpenDashboard}
            className="px-4 py-2 glass-button rounded-lg transition-colors"
          >
            Open dashboard
          </button>
        </div>
      </div>
    </div>
  )
}
