import { useState } from 'react'
import type { ManifestSensor } from '../../types/installation'
import { MapPin } from 'lucide-react'

interface SensorPlacementToolProps {
  onPlace: (sensor: Omit<ManifestSensor, 'id'>) => void
  onCancel: () => void
}

export default function SensorPlacementTool({ onPlace, onCancel }: SensorPlacementToolProps) {
  const [entityId, setEntityId] = useState('')
  const [label, setLabel] = useState('')
  const [unit, setUnit] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!entityId.trim() || !label.trim()) {
      return
    }

    onPlace({
      entityId: entityId.trim(),
      label: label.trim(),
      unit: unit.trim() || undefined,
      position: { x: 400, y: 250 },
    })
  }

  return (
    <div className="bg-dark-2 bg-opacity-80 rounded-xl p-4 border border-amber-500 border-opacity-50">
      <div className="flex items-center gap-2 mb-3">
        <MapPin className="w-4 h-4 text-amber-400" />
        <h3 className="text-amber-400 text-xs font-semibold uppercase tracking-wide">
          Place Sensor
        </h3>
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <div>
          <label className="block text-xs text-light-1 mb-1">Entity ID</label>
          <input
            type="text"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="sensor.my_sensor"
            className="w-full bg-dark-1 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
            required
          />
        </div>
        <div>
          <label className="block text-xs text-light-1 mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Temperature"
            className="w-full bg-dark-1 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
            required
          />
        </div>
        <div>
          <label className="block text-xs text-light-1 mb-1">Unit (optional)</label>
          <input
            type="text"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="°C"
            className="w-full bg-dark-1 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={!entityId.trim() || !label.trim()}
            className="flex-1 bg-amber-500 text-dark-1 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Place
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 bg-dark-1 text-light-1 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-opacity-80 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
