export interface SensorPosition {
  x: number
  y: number
}

export interface ManifestSensor {
  id: string
  entityId: string
  label: string
  position: SensorPosition
  unit?: string
  warnAbove?: number
  warnBelow?: number
}

export interface ManifestPart {
  id: string
  name: string
  type: string
  position: SensorPosition
  size?: { width: number; height: number }
  color?: string
  sensors?: ManifestSensor[]
}

export interface InstallationManifest {
  id: string
  name: string
  description?: string
  viewBox?: string
  parts: ManifestPart[]
}

export interface SensorValue {
  entityId: string
  state: string
  unit: string
  available: boolean
  lastUpdated: string
}

export type ViewerRole = 'user' | 'admin'
