import type { ManifestPart, SensorValue } from '../../types/installation'
import SensorMarker from './SensorMarker'

interface InstallationPartProps {
  part: ManifestPart
  sensorValues: SensorValue[]
  selectedSensorId: string | null
  isAdmin: boolean
  onSensorClick: (sensorId: string) => void
}

const PART_ICONS: Record<string, string> = {
  heat_pump: '♨',
  boiler: '🔥',
  solar: '☀',
  room: '🏠',
  buffer: '💧',
  underfloor: '🌡',
}

export default function InstallationPart({
  part,
  sensorValues,
  selectedSensorId,
  isAdmin,
  onSensorClick,
}: InstallationPartProps) {
  const { position, size = { width: 120, height: 80 } } = part
  const icon = PART_ICONS[part.type] ?? '⚙'

  return (
    <g>
      {/* Part body */}
      <rect
        x={position.x}
        y={position.y}
        width={size.width}
        height={size.height}
        rx={8}
        fill={part.color ?? '#334155'}
        fillOpacity={0.25}
        stroke={part.color ?? '#64748b'}
        strokeWidth={1.5}
      />
      {/* Part icon */}
      <text
        x={position.x + size.width / 2}
        y={position.y + size.height / 2 - 6}
        fontSize={20}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {icon}
      </text>
      {/* Part name */}
      <text
        x={position.x + size.width / 2}
        y={position.y + size.height - 10}
        fontSize={10}
        fill="#cbd5e1"
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
        fontWeight="600"
      >
        {part.name}
      </text>

      {/* Sensor markers */}
      {(part.sensors ?? []).map((sensor) => (
        <SensorMarker
          key={sensor.id}
          sensor={sensor}
          value={sensorValues.find((v) => v.entityId === sensor.entityId)}
          isSelected={selectedSensorId === sensor.id}
          isAdmin={isAdmin}
          onClick={onSensorClick}
        />
      ))}
    </g>
  )
}
