import { useState, useCallback } from 'react'
import type { InstallationManifest, SensorValue, ViewerRole } from '../types/installation'

export interface InstallationStore {
  manifest: InstallationManifest | null
  sensorValues: SensorValue[]
  selectedSensorId: string | null
  role: ViewerRole
  isLoading: boolean
  error: string | null
  setManifest: (manifest: InstallationManifest | null) => void
  setSensorValues: (values: SensorValue[]) => void
  setSelectedSensorId: (id: string | null) => void
  setRole: (role: ViewerRole) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  getSensorValue: (entityId: string) => SensorValue | undefined
}

export function useInstallationStore(): InstallationStore {
  const [manifest, setManifest] = useState<InstallationManifest | null>(null)
  const [sensorValues, setSensorValues] = useState<SensorValue[]>([])
  const [selectedSensorId, setSelectedSensorId] = useState<string | null>(null)
  const [role, setRole] = useState<ViewerRole>('user')
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const getSensorValue = useCallback(
    (entityId: string) => sensorValues.find((v) => v.entityId === entityId),
    [sensorValues],
  )

  return {
    manifest,
    sensorValues,
    selectedSensorId,
    role,
    isLoading,
    error,
    setManifest,
    setSensorValues,
    setSelectedSensorId,
    setRole,
    setLoading,
    setError,
    getSensorValue,
  }
}
