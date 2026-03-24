import type { ManifestSensor, SensorValue } from '../../types/installation'

const LABEL_CHAR_WIDTH = 7
const LABEL_PADDING = 8
const LABEL_MIN_WIDTH = 40

interface SensorMarkerProps {
  sensor: ManifestSensor
  value: SensorValue | undefined
  isSelected: boolean
  isAdmin: boolean
  onClick: (sensorId: string) => void
}

function getSensorStatus(sensor: ManifestSensor, value: SensorValue | undefined): 'ok' | 'warn' | 'unavailable' {
  if (!value || !value.available) {
    return 'unavailable'
  }

  const numeric = parseFloat(value.state)
  if (!Number.isFinite(numeric)) {
    return 'ok'
  }

  if (sensor.warnAbove !== undefined && numeric > sensor.warnAbove) {
    return 'warn'
  }

  if (sensor.warnBelow !== undefined && numeric < sensor.warnBelow) {
    return 'warn'
  }

  return 'ok'
}

export default function SensorMarker({ sensor, value, isSelected, isAdmin, onClick }: SensorMarkerProps) {
  const status = getSensorStatus(sensor, value)

  const bgColor = isSelected
    ? '#f59e0b'
    : status === 'unavailable'
      ? '#6b7280'
      : status === 'warn'
        ? '#ef4444'
        : '#10b981'

  const label = value?.available
    ? `${value.state}${value.unit ? ` ${value.unit}` : ''}`
    : '–'

  return (
    <g
      className={isAdmin ? 'cursor-move' : 'cursor-pointer'}
      onClick={() => onClick(sensor.id)}
      role="button"
      aria-label={`${sensor.label}: ${label}`}
    >
      {/* Outer ring for selection */}
      {isSelected && (
        <circle
          cx={sensor.position.x}
          cy={sensor.position.y}
          r={18}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={2}
          strokeDasharray="4 2"
          opacity={0.9}
        />
      )}
      {/* Main circle */}
      <circle
        cx={sensor.position.x}
        cy={sensor.position.y}
        r={13}
        fill={bgColor}
        opacity={0.9}
        filter="url(#shadow)"
      />
      {/* Value label background */}
      <rect
        x={sensor.position.x + 16}
        y={sensor.position.y - 12}
        width={Math.max(label.length * LABEL_CHAR_WIDTH + LABEL_PADDING, LABEL_MIN_WIDTH)}
        height={22}
        rx={4}
        fill="rgba(15,23,42,0.85)"
        stroke={bgColor}
        strokeWidth={1}
      />
      {/* Value text */}
      <text
        x={sensor.position.x + 20}
        y={sensor.position.y + 2}
        fontSize={10}
        fill="#f1f5f9"
        fontFamily="monospace"
      >
        {label}
      </text>
      {/* Sensor label */}
      <text
        x={sensor.position.x}
        y={sensor.position.y + 26}
        fontSize={9}
        fill="#94a3b8"
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
      >
        {sensor.label}
      </text>
    </g>
  )
}
