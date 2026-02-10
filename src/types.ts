export interface Environment {
  id: string
  name: string
  url: string
  token?: string
  status: 'online' | 'offline' | 'connecting'
  currentPower?: number
  dailyUsage?: number
  lastUpdate?: string
}

export interface HaEntity {
  entity_id: string
  state: string
  domain: string
  friendly_name?: string
}