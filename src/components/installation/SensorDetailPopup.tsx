import type { ManifestSensor, SensorValue } from '../../types/installation'
import { X } from 'lucide-react'

interface SensorDetailPopupProps {
  sensor: ManifestSensor
  value: SensorValue | undefined
  onClose: () => void
}

export default function SensorDetailPopup({ sensor, value, onClose }: SensorDetailPopupProps) {
  const displayValue = value?.available
    ? `${value.state}${value.unit ? ` ${value.unit}` : ''}`
    : 'Unavailable'

  const statusColor = !value || !value.available
    ? 'text-gray-400'
    : 'text-emerald-400'

  const lastUpdated = value?.lastUpdated
    ? new Date(value.lastUpdated).toLocaleString()
    : '–'

  return (
    <div className="absolute z-50 bg-dark-1 border border-light-2 border-opacity-30 rounded-xl shadow-2xl p-4 min-w-[220px]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-light-2 font-semibold text-sm">{sensor.label}</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-light-1 hover:text-light-2 transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className={`text-2xl font-bold mb-2 ${statusColor}`}>
        {displayValue}
      </div>

      <div className="space-y-1 text-xs text-light-1">
        <div className="flex justify-between">
          <span>Entity</span>
          <span className="text-light-2 font-mono">{sensor.entityId}</span>
        </div>
        <div className="flex justify-between">
          <span>Last updated</span>
          <span className="text-light-2">{lastUpdated}</span>
        </div>
        {sensor.warnAbove !== undefined && (
          <div className="flex justify-between">
            <span>Warn above</span>
            <span className="text-amber-400">
              {sensor.warnAbove}
              {sensor.unit ?? ''}
            </span>
          </div>
        )}
        {sensor.warnBelow !== undefined && (
          <div className="flex justify-between">
            <span>Warn below</span>
            <span className="text-amber-400">
              {sensor.warnBelow}
              {sensor.unit ?? ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
