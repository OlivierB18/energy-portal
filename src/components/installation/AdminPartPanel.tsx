import type { ManifestPart, ManifestSensor } from '../../types/installation'
import { Plus, Trash2 } from 'lucide-react'

interface AdminPartPanelProps {
  parts: ManifestPart[]
  selectedSensorId: string | null
  onSelectSensor: (id: string | null) => void
  onAddSensor?: (partId: string, sensor: Omit<ManifestSensor, 'id'>) => void
  onRemoveSensor?: (partId: string, sensorId: string) => void
}

export default function AdminPartPanel({
  parts,
  selectedSensorId,
  onSelectSensor,
  onAddSensor,
  onRemoveSensor,
}: AdminPartPanelProps) {
  return (
    <div className="bg-dark-2 bg-opacity-60 rounded-xl p-4 border border-amber-500 border-opacity-30">
      <h3 className="text-amber-400 text-xs font-semibold uppercase tracking-wide mb-3">
        Installation Parts
      </h3>
      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {parts.map((part) => (
          <div key={part.id} className="bg-dark-1 bg-opacity-50 rounded-lg p-2">
            <div className="text-light-2 text-xs font-medium mb-1">{part.name}</div>
            {(part.sensors ?? []).map((sensor) => (
              <div
                key={sensor.id}
                className={`flex items-center justify-between p-1.5 rounded cursor-pointer transition-all text-xs ${
                  selectedSensorId === sensor.id
                    ? 'bg-amber-500 bg-opacity-20 text-amber-300'
                    : 'text-light-1 hover:bg-light-2 hover:bg-opacity-10'
                }`}
                onClick={() => onSelectSensor(selectedSensorId === sensor.id ? null : sensor.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    onSelectSensor(selectedSensorId === sensor.id ? null : sensor.id)
                  }
                }}
                aria-pressed={selectedSensorId === sensor.id}
              >
                <span>{sensor.label}</span>
                {onRemoveSensor && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemoveSensor(part.id, sensor.id)
                    }}
                    className="text-red-400 hover:text-red-300 transition-colors ml-2"
                    title="Remove sensor"
                    aria-label={`Remove sensor ${sensor.label}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
            {onAddSensor && (
              <button
                type="button"
                onClick={() =>
                  onAddSensor(part.id, {
                    entityId: '',
                    label: 'New Sensor',
                    position: {
                      x: part.position.x + (part.size?.width ?? 80) / 2,
                      y: part.position.y - 20,
                    },
                  })
                }
                className="mt-1 flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add sensor
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
