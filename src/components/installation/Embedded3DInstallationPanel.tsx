import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronsUpDown, RefreshCw } from 'lucide-react'
import type { InstallationManifest, ManifestSensor, SensorValue } from '../../types/installation'
import type { ViewerRole } from '../../types/installation'
import { fetchAllSensorValues } from '../../services/HomeAssistantService'
import { useInstallationStore } from '../../stores/useInstallationStore'
import InstallationScene from './InstallationScene'
import SensorDetailPopup from './SensorDetailPopup'
import KPIOverlayCards from './KPIOverlayCards'
import ModelSwitcher from './ModelSwitcher'
import RoleSwitcher from './RoleSwitcher'
import AdminPartPanel from './AdminPartPanel'
import SensorPlacementTool from './SensorPlacementTool'

import hvacV1 from '../../data/manifests/hvac-v1.manifest.json'
import hvacV2 from '../../data/manifests/hvac-v2.manifest.json'

const AVAILABLE_MANIFESTS: InstallationManifest[] = [
  hvacV1 as InstallationManifest,
  hvacV2 as InstallationManifest,
]

const REFRESH_INTERVAL_MS = 15_000

interface Embedded3DInstallationPanelProps {
  environmentId: string
  isAdmin: boolean
  getAuthToken: () => Promise<string>
}

function getAllEntityIds(manifest: InstallationManifest): string[] {
  const ids: string[] = []
  for (const part of manifest.parts) {
    for (const sensor of part.sensors ?? []) {
      if (sensor.entityId && !ids.includes(sensor.entityId)) {
        ids.push(sensor.entityId)
      }
    }
  }
  return ids
}

function findSensorById(manifest: InstallationManifest, sensorId: string): ManifestSensor | undefined {
  for (const part of manifest.parts) {
    const sensor = (part.sensors ?? []).find((s) => s.id === sensorId)
    if (sensor) return sensor
  }
  return undefined
}

export default function Embedded3DInstallationPanel({
  environmentId,
  isAdmin,
  getAuthToken,
}: Embedded3DInstallationPanelProps) {
  const store = useInstallationStore()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [currentManifestId, setCurrentManifestId] = useState(AVAILABLE_MANIFESTS[0].id)
  const [role, setRole] = useState<ViewerRole>('user')
  const [showPlacementTool, setShowPlacementTool] = useState(false)
  const [popupSensorId, setPopupSensorId] = useState<string | null>(null)
  const [sensorValues, setSensorValues] = useState<SensorValue[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const manifest = AVAILABLE_MANIFESTS.find((m) => m.id === currentManifestId) ?? AVAILABLE_MANIFESTS[0]
  const entityIds = getAllEntityIds(manifest)

  const loadSensorData = useCallback(
    async (silent = false) => {
      if (!environmentId || entityIds.length === 0) {
        return
      }

      if (!silent) {
        setIsLoading(true)
        setError(null)
      }

      try {
        const values = await fetchAllSensorValues(entityIds, environmentId, getAuthToken)
        setSensorValues(values)
        setLastUpdated(new Date().toLocaleTimeString())
        if (!silent) setError(null)
      } catch (err) {
        if (!silent) {
          setError(err instanceof Error ? err.message : 'Unable to load sensor data')
        }
        // eslint-disable-next-line no-console
        console.warn('[InstallationViewer] Sensor data refresh failed:', err)
      } finally {
        if (!silent) setIsLoading(false)
      }
    },
    [environmentId, entityIds.join(','), getAuthToken], // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    void loadSensorData(false)

    intervalRef.current = setInterval(() => {
      void loadSensorData(true)
    }, REFRESH_INTERVAL_MS)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [loadSensorData])

  // Reset popup when manifest changes
  useEffect(() => {
    setPopupSensorId(null)
    store.setSelectedSensorId(null)
  }, [currentManifestId, store.setSelectedSensorId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSensorClick = (sensorId: string) => {
    const next = popupSensorId === sensorId ? null : sensorId
    setPopupSensorId(next)
    store.setSelectedSensorId(next)
  }

  const selectedSensor = popupSensorId ? findSensorById(manifest, popupSensorId) : undefined
  const selectedValue = selectedSensor
    ? sensorValues.find((v) => v.entityId === selectedSensor.entityId)
    : undefined

  const handlePlaceSensor = (sensor: Omit<ManifestSensor, 'id'>) => {
    // In a real implementation, this would persist the sensor placement
    console.info('[InstallationViewer] New sensor placement:', sensor)
    setShowPlacementTool(false)
  }

  return (
    <div className="glass-panel rounded-3xl shadow-2xl p-6 mb-8">
      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-light-2">Installation Viewer</h2>
          {lastUpdated && (
            <span className="text-xs text-light-1 opacity-70">Updated {lastUpdated}</span>
          )}
          {isLoading && (
            <RefreshCw className="w-3.5 h-3.5 text-brand-2 animate-spin" />
          )}
        </div>

        <div className="flex items-center gap-2">
          <ModelSwitcher
            manifests={AVAILABLE_MANIFESTS}
            currentId={currentManifestId}
            onChange={setCurrentManifestId}
          />

          {isAdmin && (
            <RoleSwitcher role={role} onChange={setRole} />
          )}

          <button
            type="button"
            onClick={() => void loadSensorData(false)}
            disabled={isLoading}
            className="p-1.5 text-light-1 hover:text-light-2 transition-colors disabled:opacity-50"
            title="Refresh sensor data"
            aria-label="Refresh sensor data"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setIsCollapsed((c) => !c)}
            className="p-1.5 text-light-1 hover:text-light-2 transition-colors"
            title={isCollapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Expand installation viewer' : 'Collapse installation viewer'}
          >
            <ChevronsUpDown className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <>
          {error && (
            <p className="text-red-300 text-sm mb-3">{error}</p>
          )}

          <div className={`flex gap-4 ${role === 'admin' ? 'items-start' : ''}`}>
            {/* Scene */}
            <div className="relative flex-1 min-w-0">
              <InstallationScene
                manifest={manifest}
                sensorValues={sensorValues}
                selectedSensorId={popupSensorId}
                isAdmin={role === 'admin'}
                onSensorClick={handleSensorClick}
              />

              {/* Sensor detail popup */}
              {selectedSensor && (
                <div className="absolute top-4 left-4">
                  <SensorDetailPopup
                    sensor={selectedSensor}
                    value={selectedValue}
                    onClose={() => {
                      setPopupSensorId(null)
                      store.setSelectedSensorId(null)
                    }}
                  />
                </div>
              )}
            </div>

            {/* Admin sidebar */}
            {role === 'admin' && (
              <div className="w-56 shrink-0 space-y-3">
                <AdminPartPanel
                  parts={manifest.parts}
                  selectedSensorId={popupSensorId}
                  onSelectSensor={(id) => {
                    setPopupSensorId(id)
                    store.setSelectedSensorId(id)
                  }}
                />
                {showPlacementTool ? (
                  <SensorPlacementTool
                    onPlace={handlePlaceSensor}
                    onCancel={() => setShowPlacementTool(false)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowPlacementTool(true)}
                    className="w-full text-xs text-amber-400 hover:text-amber-300 border border-amber-500 border-opacity-30 rounded-lg px-3 py-2 transition-colors"
                  >
                    + Add new sensor
                  </button>
                )}
              </div>
            )}
          </div>

          {/* KPI overlay cards */}
          <KPIOverlayCards sensorValues={sensorValues} />
        </>
      )}
    </div>
  )
}
