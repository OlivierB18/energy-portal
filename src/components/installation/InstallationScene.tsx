import type { InstallationManifest, SensorValue } from '../../types/installation'
import InstallationPart from './InstallationPart'

const SCENE_MIN_HEIGHT = '240px'
const SCENE_MAX_HEIGHT = '480px'

interface InstallationSceneProps {
  manifest: InstallationManifest
  sensorValues: SensorValue[]
  selectedSensorId: string | null
  isAdmin: boolean
  onSensorClick: (sensorId: string) => void
}

export default function InstallationScene({
  manifest,
  sensorValues,
  selectedSensorId,
  isAdmin,
  onSensorClick,
}: InstallationSceneProps) {
  const viewBox = manifest.viewBox ?? '0 0 800 500'

  return (
    <div className="w-full overflow-x-auto rounded-xl bg-dark-2 bg-opacity-30">
      <svg
        viewBox={viewBox}
        className="w-full h-auto"
        style={{ minHeight: SCENE_MIN_HEIGHT, maxHeight: SCENE_MAX_HEIGHT }}
        aria-label={`Installation diagram: ${manifest.name}`}
        role="img"
      >
        <defs>
          <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.4" />
          </filter>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
          </pattern>
        </defs>

        {/* Background grid */}
        <rect width="100%" height="100%" fill="url(#grid)" />

        {/* Installation parts */}
        {manifest.parts.map((part) => (
          <InstallationPart
            key={part.id}
            part={part}
            sensorValues={sensorValues}
            selectedSensorId={selectedSensorId}
            isAdmin={isAdmin}
            onSensorClick={onSensorClick}
          />
        ))}

        {/* Admin mode overlay hint */}
        {isAdmin && (
          <text
            x="8"
            y="16"
            fontSize={10}
            fill="#f59e0b"
            fontFamily="system-ui, sans-serif"
            opacity={0.8}
          >
            Admin mode
          </text>
        )}
      </svg>
    </div>
  )
}
