import { useEffect, useMemo, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { Search, Save, X } from 'lucide-react'
import { HaEntity } from '../types'

interface HomeAssistantConfigProps {
  environmentId: string
  environmentName: string
  onClose: () => void
  onSaved: () => void
}

export default function HomeAssistantConfig({
  environmentId,
  environmentName,
  onClose,
  onSaved,
}: HomeAssistantConfigProps) {
  const { getAccessTokenSilently } = useAuth0()
  const [entities, setEntities] = useState<HaEntity[]>([])
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filteredEntities = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) {
      return entities
    }

    return entities.filter((entity) => {
      const name = entity.friendly_name?.toLowerCase() || ''
      const id = entity.entity_id.toLowerCase()
      return name.includes(query) || id.includes(query)
    })
  }, [entities, filter])

  useEffect(() => {
    const loadConfig = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const token = await getAccessTokenSilently()
        const [entitiesResponse, configResponse] = await Promise.all([
          fetch(`/.netlify/functions/ha-entities?environmentId=${environmentId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`/.netlify/functions/get-environment-config?environmentId=${environmentId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ])

        if (!entitiesResponse.ok) {
          throw new Error('Unable to load Home Assistant entities')
        }

        if (!configResponse.ok) {
          throw new Error('Unable to load environment config')
        }

        const entitiesData = await entitiesResponse.json()
        const configData = await configResponse.json()
        const nextEntities = Array.isArray(entitiesData.entities) ? entitiesData.entities : []
        const nextSelected = Array.isArray(configData.visibleEntityIds)
          ? configData.visibleEntityIds
          : []

        setEntities(nextEntities)
        setSelectedEntityIds(nextSelected)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load configuration')
      } finally {
        setIsLoading(false)
      }
    }

    void loadConfig()
  }, [environmentId, getAccessTokenSilently])

  const toggleSelection = (entityId: string) => {
    setSelectedEntityIds((prev) =>
      prev.includes(entityId) ? prev.filter((item) => item !== entityId) : [...prev, entityId],
    )
  }

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)

    try {
      const token = await getAccessTokenSilently()
      const response = await fetch('/.netlify/functions/save-environment-config', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environmentId,
          visibleEntityIds: selectedEntityIds,
        }),
      })

      if (!response.ok) {
        throw new Error('Unable to save configuration')
      }

      onSaved()
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save configuration')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
      <div className="glass-panel rounded-2xl shadow-2xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden">
        <div className="p-6 flex items-center justify-between border-b border-dark-2 border-opacity-20">
          <div>
            <h2 className="text-2xl font-heavy text-light-2">Home Assistant Sensors</h2>
            <p className="text-light-1 text-sm">{environmentName} - select what non-admins can see</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-light-2 hover:bg-opacity-10 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-light-1" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto max-h-[65vh]">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-dark-2 bg-opacity-70 rounded-lg px-3 py-2 flex-1">
              <Search className="w-4 h-4 text-light-1" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search entities"
                className="bg-transparent text-light-2 w-full focus:outline-none"
              />
            </div>
            <div className="text-sm text-light-1">
              Selected: {selectedEntityIds.length}
            </div>
          </div>

          {error && <div className="text-red-300 text-sm">{error}</div>}
          {isLoading && <div className="text-light-1">Loading entities...</div>}

          {!isLoading && !error && filteredEntities.length === 0 && (
            <div className="text-light-1">No entities found.</div>
          )}

          {!isLoading && filteredEntities.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredEntities.map((entity) => (
                <label
                  key={entity.entity_id}
                  className="glass-card rounded-xl p-4 flex items-center gap-3 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedEntityIds.includes(entity.entity_id)}
                    onChange={() => toggleSelection(entity.entity_id)}
                  />
                  <div>
                    <div className="text-light-2 font-medium">
                      {entity.friendly_name || entity.entity_id}
                    </div>
                    <div className="text-light-1 text-xs">{entity.entity_id}</div>
                    <div className="text-light-1 text-xs">State: {entity.state}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="p-6 flex justify-end gap-3 border-t border-dark-2 border-opacity-20">
          <button
            onClick={onClose}
            className="px-4 py-2 text-light-1 hover:bg-light-2 hover:bg-opacity-10 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-2 px-6 py-2 glass-button rounded-lg transition-colors disabled:opacity-60"
          >
            <Save className="w-4 h-4" />
            {isSaving ? 'Saving...' : 'Save selection'}
          </button>
        </div>
      </div>
    </div>
  )
}
