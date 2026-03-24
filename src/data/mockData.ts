import type { SensorValue } from '../types/installation'

export const mockSensorValues: SensorValue[] = [
  {
    entityId: 'sensor.heat_pump_power',
    state: '3.2',
    unit: 'kW',
    available: true,
    lastUpdated: new Date().toISOString(),
  },
  {
    entityId: 'sensor.heat_pump_flow_temperature',
    state: '45.5',
    unit: '°C',
    available: true,
    lastUpdated: new Date().toISOString(),
  },
  {
    entityId: 'sensor.heat_pump_return_temperature',
    state: '38.2',
    unit: '°C',
    available: true,
    lastUpdated: new Date().toISOString(),
  },
  {
    entityId: 'sensor.boiler_temperature',
    state: '60.1',
    unit: '°C',
    available: true,
    lastUpdated: new Date().toISOString(),
  },
  {
    entityId: 'sensor.solar_power',
    state: '1.8',
    unit: 'kW',
    available: true,
    lastUpdated: new Date().toISOString(),
  },
  {
    entityId: 'sensor.indoor_temperature',
    state: '21.3',
    unit: '°C',
    available: true,
    lastUpdated: new Date().toISOString(),
  },
]
