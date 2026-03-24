import type { SensorValue } from '../../types/installation'
import { Zap, Thermometer, Sun } from 'lucide-react'

interface KPIOverlayCardsProps {
  sensorValues: SensorValue[]
}

interface KPI {
  label: string
  entityKeywords: string[]
  icon: React.ReactNode
  unit: string
  color: string
}

const KPIS: KPI[] = [
  {
    label: 'Heat Pump Power',
    entityKeywords: ['heat_pump_power', 'hp_power'],
    icon: <Zap className="w-4 h-4" />,
    unit: 'kW',
    color: 'text-blue-400',
  },
  {
    label: 'Flow Temperature',
    entityKeywords: ['flow_temperature', 'flow_temp'],
    icon: <Thermometer className="w-4 h-4" />,
    unit: '°C',
    color: 'text-red-400',
  },
  {
    label: 'Solar Production',
    entityKeywords: ['solar_power', 'pv_power'],
    icon: <Sun className="w-4 h-4" />,
    unit: 'kW',
    color: 'text-amber-400',
  },
]

function findSensorForKPI(sensorValues: SensorValue[], keywords: string[]): SensorValue | undefined {
  return sensorValues.find((v) =>
    keywords.some((kw) => v.entityId.toLowerCase().includes(kw.toLowerCase())),
  )
}

export default function KPIOverlayCards({ sensorValues }: KPIOverlayCardsProps) {
  if (sensorValues.length === 0) {
    return null
  }

  const kpis = KPIS.map((kpi) => ({
    ...kpi,
    sensor: findSensorForKPI(sensorValues, kpi.entityKeywords),
  })).filter((kpi) => kpi.sensor !== undefined)

  if (kpis.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-3 mt-3">
      {kpis.map((kpi) => {
        const sensor = kpi.sensor!
        const displayValue = sensor.available
          ? `${sensor.state}${sensor.unit ? ` ${sensor.unit}` : ''}`
          : '–'

        return (
          <div
            key={kpi.label}
            className="flex items-center gap-2 bg-dark-2 bg-opacity-60 rounded-lg px-3 py-2 border border-light-2 border-opacity-10"
          >
            <span className={kpi.color}>{kpi.icon}</span>
            <div>
              <div className="text-xs text-light-1">{kpi.label}</div>
              <div className={`text-sm font-semibold ${sensor.available ? kpi.color : 'text-gray-500'}`}>
                {displayValue}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
