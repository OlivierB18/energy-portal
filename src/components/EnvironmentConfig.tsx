import { useState } from 'react'
import { Settings, Plus, Trash2, Save, X } from 'lucide-react'
import { Environment } from '../types'

interface EnvironmentConfigProps {
  environments: Environment[]
  onSave: (environments: Environment[]) => void
  onClose: () => void
}

export default function EnvironmentConfig({ environments: initialEnvironments, onSave, onClose }: EnvironmentConfigProps) {
  const [environments, setEnvironments] = useState<Environment[]>(initialEnvironments)

  const addEnvironment = () => {
    const newEnv: Environment = {
      id: `env_${Date.now()}`,
      name: `Environment ${environments.length + 1}`,
      url: '',
      token: '',
      status: 'offline'
    }
    setEnvironments([...environments, newEnv])
  }

  const removeEnvironment = (id: string) => {
    setEnvironments(environments.filter(env => env.id !== id))
  }

  const updateEnvironment = (id: string, field: keyof Environment, value: string) => {
    setEnvironments(environments.map(env =>
      env.id === id ? { ...env, [field]: value } : env
    ))
  }

  const handleSave = () => {
    onSave(environments)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="glass-panel rounded-2xl shadow-2xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Settings className="w-6 h-6 text-brand-2" />
              <h2 className="text-2xl font-heavy text-dark-1">Environment Configuration</h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-light-2 hover:bg-opacity-10 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-light-1" />
            </button>
          </div>

          {/* Instructions */}
          <div className="glass-panel border border-brand-2 border-opacity-30 rounded-lg p-4 mb-6">
            <h3 className="font-medium text-light-2 mb-2">How to configure Home Assistant access:</h3>
            <ol className="text-sm text-light-1 space-y-1">
              <li>1. Go to your Home Assistant instance</li>
              <li>2. Navigate to Settings → People → Long-Lived Access Tokens</li>
              <li>3. Create a new token and copy it</li>
              <li>4. Enter your HA URL (e.g., http://homeassistant.local:8123) and token below</li>
            </ol>
          </div>

          {/* Environment List */}
          <div className="space-y-4 mb-6">
            {environments.map((env, index) => (
              <div key={env.id} className="border border-dark-2 border-opacity-20 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-light-2">Environment {index + 1}</h4>
                  <button
                    onClick={() => removeEnvironment(env.id)}
                    className="p-1 text-red-500 hover:bg-red-50 rounded transition-colors"
                    disabled={environments.length === 1}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-light-1 mb-1">
                      Environment Name
                    </label>
                    <input
                      type="text"
                      value={env.name}
                      onChange={(e) => updateEnvironment(env.id, 'name', e.target.value)}
                      className="w-full px-3 py-2 border border-dark-2 border-opacity-20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-2"
                      placeholder="e.g., Home, Office, Vacation Home"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-light-1 mb-1">
                      Home Assistant URL
                    </label>
                    <input
                      type="url"
                      value={env.url}
                      onChange={(e) => updateEnvironment(env.id, 'url', e.target.value)}
                      className="w-full px-3 py-2 border border-dark-2 border-opacity-20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-2"
                      placeholder="http://homeassistant.local:8123"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-light-1 mb-1">
                      Access Token
                    </label>
                    <input
                      type="password"
                      value={env.token}
                      onChange={(e) => updateEnvironment(env.id, 'token', e.target.value)}
                      className="w-full px-3 py-2 border border-dark-2 border-opacity-20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-2"
                      placeholder="Your long-lived access token"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Add Environment Button */}
          <button
            onClick={addEnvironment}
            className="flex items-center gap-2 px-4 py-2 bg-brand-2 text-light-2 rounded-lg hover:bg-brand-3 transition-colors mb-6"
          >
            <Plus className="w-4 h-4" />
            Add Environment
          </button>

          {/* Action Buttons */}
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-light-1 hover:bg-light-2 hover:bg-opacity-10 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-6 py-2 bg-brand-2 text-light-2 rounded-lg hover:bg-brand-3 transition-colors"
            >
              <Save className="w-4 h-4" />
              Save Configuration
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}