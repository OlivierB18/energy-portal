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