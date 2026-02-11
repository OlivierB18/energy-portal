export type EnvironmentType = 'home_assistant' | 'website' | 'solar' | 'other'

export interface EnvironmentConfigFields {
  baseUrl?: string
  apiKey?: string
  siteId?: string
  notes?: string
}

export interface Environment {
  id: string
  name: string
  type: EnvironmentType
  config: EnvironmentConfigFields
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