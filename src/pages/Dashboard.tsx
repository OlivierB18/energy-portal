import { useEffect, useState, useMemo, useRef } from 'react'
import EnergyCard from '../components/EnergyCard'
import EnergyChart from '../components/EnergyChart'
import HomeAssistantConfig from '../components/HomeAssistantConfig'
import EnergyPriceModal from '../components/EnergyPriceModal'
import { Zap, Clock, Home, Settings, DollarSign, ChevronDown, Flame } from 'lucide-react'
import { useAuth0 } from '@auth0/auth0-react'
import { HaEntity, EnergyPricingConfig } from '../types'

interface EnvironmentConfig {
  id: string
  name: string
  type?: string
}

interface HaEnvironmentPayload {
  id: string
  name?: string
  type?: string
  config?: {
    baseUrl?: string
  }
}

interface DashboardProps {
  isAdmin: boolean
  selectedEnvironmentId?: string
  onEnvironmentChange?: (environmentId: string) => void
}

interface PowerSample {
  timestamp: number
  power: number
}

interface GasSample {
  timestamp: number
  gas: number
}

export default function Dashboard({
  isAdmin,
  selectedEnvironmentId,
  onEnvironmentChange,
}: DashboardProps) {
  const formatDateForInput = (date: Date) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const [selectedEnvironment, setSelectedEnvironment] = useState<string>(selectedEnvironmentId ?? '')
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today')
  const [selectedChartDate, setSelectedChartDate] = useState<string>(formatDateForInput(new Date()))
  const [allowedEnvironmentIds, setAllowedEnvironmentIds] = useState<string[] | null>(null)
  const [isCheckingPermissions, setIsCheckingPermissions] = useState(true)
  const [environments, setEnvironments] = useState<EnvironmentConfig[]>([])
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError] = useState<string | null>(null)
  const [haEntities, setHaEntities] = useState<HaEntity[]>([])
  // Laatst bekende sensoren (blijven altijd staan bij error)
  const [lastKnownHaEntities, setLastKnownHaEntities] = useState<HaEntity[]>([])
  const [haLoading, setHaLoading] = useState(false)
  const [haError, setHaError] = useState<string | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [haActionId, setHaActionId] = useState<string | null>(null)
  const [showHaConfig, setShowHaConfig] = useState(false)
  const [haRefreshKey, setHaRefreshKey] = useState(0)
  const [powerSamples, setPowerSamples] = useState<PowerSample[]>([])
  const [gasSamples, setGasSamples] = useState<GasSample[]>([])
  const [showPriceModal, setShowPriceModal] = useState(false)
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false)
  const [pricingConfig, setPricingConfig] = useState<EnergyPricingConfig | null>(null)
  // Home Assistant connection status: 'connecting' | 'connected' | 'error'
  const [haConnectionStatus, setHaConnectionStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently } = useAuth0()

  const getAuthToken = async () => {
    const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
    return getAccessTokenSilently({
      authorizationParams: { audience },
    })
  }

  useEffect(() => {
    const loadEnvironments = async () => {
      if (!isAuthenticated) {
        setEnvironments([])
        return
      }

      setEnvLoading(true)
      setEnvError(null)

      try {
        const token = await getAuthToken()
        const response = await fetch('/.netlify/functions/get-ha-environments', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new Error('Unable to load environments')
        }

        const data = await response.json()
        const loaded: HaEnvironmentPayload[] = Array.isArray(data?.environments)
          ? data.environments
          : []
        const next = loaded.map((env: HaEnvironmentPayload) => ({
          id: String(env.id),
          name: String(env.name || env.id),
          type: env.type,
        }))
        setEnvironments(next)
      } catch (error) {
        setEnvError(error instanceof Error ? error.message : 'Unable to load environments')
        setEnvironments([])
      } finally {
        setEnvLoading(false)
      }
    }

    void loadEnvironments()
  }, [getAccessTokenSilently, isAuthenticated])

  useEffect(() => {
    const getAuthToken = async () => {
      const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined
      return getAccessTokenSilently({
        authorizationParams: { audience },
      })
    }

    const loadAssignments = async () => {
      setIsCheckingPermissions(true)
      
      if (!isAuthenticated) {
        setAllowedEnvironmentIds(null)
        setIsCheckingPermissions(false)
        return
      }

      if (isAdmin) {
        setAllowedEnvironmentIds(null)
        setIsCheckingPermissions(false)
        return
      }

      try {
        const claims = await getIdTokenClaims()
        const envClaim = 'https://brouwer-ems/environments'
        const envs = (claims?.[envClaim] as string[] | undefined) ?? null

        if (envs && envs.length > 0) {
          setAllowedEnvironmentIds(envs)
          setIsCheckingPermissions(false)
          return
        }

        const token = await getAuthToken()
        const response = await fetch('/.netlify/functions/get-user-environments', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new Error('Unable to load user environments')
        }

        const data = await response.json()
        const ids = Array.isArray(data?.environmentIds) ? data.environmentIds : []
        setAllowedEnvironmentIds(ids)
      } catch {
        setAllowedEnvironmentIds([])
      } finally {
        setIsCheckingPermissions(false)
      }
    }

    void loadAssignments()
  }, [getAccessTokenSilently, getIdTokenClaims, isAuthenticated, isAdmin])

  const visibleEnvironments = allowedEnvironmentIds
    ? environments.filter((env) => allowedEnvironmentIds.includes(env.id))
    : environments

  const assignedEnvironmentLabels = allowedEnvironmentIds
    ? visibleEnvironments.map((env) => env.name)
    : []

  useEffect(() => {
    if (visibleEnvironments.length === 0) {
      setSelectedEnvironment('')
      return
    }

    if (!visibleEnvironments.find((env) => env.id === selectedEnvironment)) {
      setSelectedEnvironment(visibleEnvironments[0].id)
    }
  }, [selectedEnvironment, visibleEnvironments])

  useEffect(() => {
    if (selectedEnvironmentId && selectedEnvironmentId !== selectedEnvironment) {
      setSelectedEnvironment(selectedEnvironmentId)
    }
  }, [selectedEnvironment, selectedEnvironmentId])

  useEffect(() => {
    try {
      const key = `energy_pricing_${selectedEnvironment}`
      const saved = localStorage.getItem(key)
      if (saved) {
        const config: EnergyPricingConfig = JSON.parse(saved)
        setPricingConfig(config)
      } else {
        setPricingConfig(null)
      }
    } catch {
      setPricingConfig(null)
    }
  }, [selectedEnvironment])

  // Close settings dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showSettingsDropdown && !target.closest('.settings-dropdown-container')) {
        setShowSettingsDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSettingsDropdown])

  useEffect(() => {
    const loadHaEntities = async (silent = false) => {
      if (!isAuthenticated) {
        if (!silent) {
          setHaConnectionStatus('error')
        }
        return
      }
      if (!selectedEnvironment) {
        if (!silent) {
          setHaConnectionStatus('error')
        }
        return
      }
      
      if (!silent) {
        setHaLoading(true)
        setHaError(null)
        setHaConnectionStatus('connecting')
      }
      
      try {
        const token = await getAuthToken()
        // eslint-disable-next-line no-console
        console.log(`[HA] ${silent ? '🔄 SILENT' : '📥 INITIAL'} refresh starting...`)
        
        const response = await fetch(`/.netlify/functions/ha-entities?environmentId=${selectedEnvironment}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        
        // eslint-disable-next-line no-console
        console.log(`[HA] Response status: ${response.status}`)
        
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          // eslint-disable-next-line no-console
          console.error(`[HA] Error: ${data?.error || 'Unknown error'}`)
          if (!silent) {
            setHaConnectionStatus('error')
            setHaError(data?.error || 'Unable to load Home Assistant data')
          }
          // NEVER clear entities on error - keep showing last known data
          return
        }
        
        const data = await response.json()
        const entities = Array.isArray(data?.entities) ? data.entities : []
        // eslint-disable-next-line no-console
        console.log(`[HA] ✅ Loaded ${entities.length} entities`)
        
        // Update entities AND keep them as last known
        setHaEntities(entities)
        setLastKnownHaEntities(entities)
        
        if (!silent) {
          setHaConnectionStatus('connected')
          setHaError(null)
          setIsInitialLoading(false) // Only set false on successful initial load
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[HA] Fetch error:', error);
        if (!silent) {
          setHaError(error instanceof Error ? error.message : 'Unable to load Home Assistant data')
          setHaConnectionStatus('error')
          setIsInitialLoading(false) // Set false on error too so we show last known data
        }
        // NEVER clear entities on error - keep showing last known data
      } finally {
        if (!silent) {
          setHaLoading(false)
        }
      }
    }
    
    // Initial load 
    // eslint-disable-next-line no-console
    console.log('[HA] Starting initial load...')
    void loadHaEntities(false)
    
    // Auto-refresh every 10 seconds - ALWAYS silent, NEVER affects UI on error
    const interval = setInterval(() => {
      void loadHaEntities(true)
    }, 10000)
    
    return () => clearInterval(interval)
  }, [getAccessTokenSilently, isAuthenticated, selectedEnvironment, haRefreshKey])

  const getControlActions = (domain: string) => {
    switch (domain) {
      case 'switch':
      case 'light':
      case 'input_boolean':
        return [
          { label: 'On', action: 'turn_on' },
          { label: 'Off', action: 'turn_off' },
        ]
      case 'button':
        return [{ label: 'Press', action: 'press' }]
      case 'script':
        return [{ label: 'Run', action: 'turn_on' }]
      case 'scene':
        return [{ label: 'Activate', action: 'turn_on' }]
      default:
        return []
    }
  }

  const runHaAction = async (entityId: string, action: string) => {
    try {
      setHaActionId(entityId)
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/ha-service', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environmentId: selectedEnvironment,
          entityId,
          action,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Unable to run action')
      }

      const refresh = await fetch(`/.netlify/functions/ha-entities?environmentId=${selectedEnvironment}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (refresh.ok) {
        const data = await refresh.json()
        setHaEntities(Array.isArray(data?.entities) ? data.entities : [])
      }
    } catch (error) {
      setHaError(error instanceof Error ? error.message : 'Unable to run action')
    } finally {
      setHaActionId(null)
    }
  }

  // Mock data for demonstration - in real app, this would fetch from selected environment
  const configuredGasPrice = Number(import.meta.env.VITE_DEFAULT_GAS_PRICE_EUR_PER_M3)
  const gasRatePerM3 = Number.isFinite(configuredGasPrice) && configuredGasPrice > 0 ? configuredGasPrice : 1.35

  const mockData = {
    currentPower: 2.45,
    dailyUsage: 12.8,
    monthlyUsage: 285.3,
    gasDailyUsage: 0,
    gasMonthlyUsage: 0,
    gasChartValue: 0,
  }

  // Extract real-time energy data from Home Assistant entities
  const realTimeData = useMemo(() => {
    const entities = haEntities.length > 0 ? haEntities : lastKnownHaEntities
    
    // Helper function to parse numeric values from entity state
    const parseValue = (state: string): number => {
      const num = parseFloat(state)
      return isNaN(num) ? 0 : num
    }

    const environmentKey = selectedEnvironment || 'default'

    // Helper function to find entity by keywords in entity_id
    const findEntity = (keywords: string[], excludedKeywords: string[] = []): HaEntity | undefined => {
      return entities.find(entity => 
        entity.domain === 'sensor' &&
        keywords.some(keyword => entity.entity_id.toLowerCase().includes(keyword.toLowerCase())) &&
        !excludedKeywords.some(keyword => entity.entity_id.toLowerCase().includes(keyword.toLowerCase()))
      )
    }

    // Helper function to track energy usage locally when no sensor available
    const trackEnergyLocally = (currentPower: number): { daily: number; monthly: number } => {
      const now = new Date()
      const today = now.toDateString()
      const thisMonth = `${now.getFullYear()}-${now.getMonth() + 1}`
      
      // Get stored tracking data
      const keys = {
        daily: `energy_daily_${environmentKey}`,
        monthly: `energy_monthly_${environmentKey}`,
        date: `energy_date_${environmentKey}`,
        month: `energy_month_${environmentKey}`,
        lastUpdate: `energy_last_update_${environmentKey}`,
      }

      const storedDaily = localStorage.getItem(keys.daily)
      const storedMonthly = localStorage.getItem(keys.monthly)
      const storedDate = localStorage.getItem(keys.date)
      const storedMonth = localStorage.getItem(keys.month)
      const lastUpdate = localStorage.getItem(keys.lastUpdate)
      
      let dailyTotal = 0
      let monthlyTotal = 0
      
      // Reset daily if new day
      if (storedDate !== today) {
        localStorage.setItem(keys.date, today)
        localStorage.setItem(keys.daily, '0')
        dailyTotal = 0
      } else {
        dailyTotal = storedDaily ? parseFloat(storedDaily) : 0
      }
      
      // Reset monthly if new month
      if (storedMonth !== thisMonth) {
        localStorage.setItem(keys.month, thisMonth)
        localStorage.setItem(keys.monthly, '0')
        monthlyTotal = 0
      } else {
        monthlyTotal = storedMonthly ? parseFloat(storedMonthly) : 0
      }
      
      // Calculate energy used since last update (Power in kW × time in hours = kWh)
      if (lastUpdate && currentPower > 0) {
        const lastTime = new Date(lastUpdate).getTime()
        const nowTime = now.getTime()
        const hoursElapsed = (nowTime - lastTime) / (1000 * 60 * 60)
        
        // Only add if less than 1 hour elapsed (prevents big jumps on page reload)
        if (hoursElapsed < 1) {
          const energyUsed = currentPower * hoursElapsed
          dailyTotal += energyUsed
          monthlyTotal += energyUsed
          
          localStorage.setItem(keys.daily, dailyTotal.toString())
          localStorage.setItem(keys.monthly, monthlyTotal.toString())
        }
      }
      
      // Update last timestamp
      localStorage.setItem(keys.lastUpdate, now.toISOString())
      
      return {
        daily: dailyTotal,
        monthly: monthlyTotal,
      }
    }

    const trackEnergyFromMeter = (meterTotal: number): { daily: number; monthly: number } => {
      const now = new Date()
      const today = now.toDateString()
      const thisMonth = `${now.getFullYear()}-${now.getMonth() + 1}`
      const keys = {
        dailyDate: `energy_meter_daily_date_${environmentKey}`,
        dailyBase: `energy_meter_daily_base_${environmentKey}`,
        monthValue: `energy_meter_month_${environmentKey}`,
        monthBase: `energy_meter_month_base_${environmentKey}`,
      }

      const storedDailyDate = localStorage.getItem(keys.dailyDate)
      const storedDailyBase = parseFloat(localStorage.getItem(keys.dailyBase) || '0')
      const storedMonthValue = localStorage.getItem(keys.monthValue)
      const storedMonthBase = parseFloat(localStorage.getItem(keys.monthBase) || '0')

      let dailyBase = storedDailyBase
      let monthBase = storedMonthBase

      if (storedDailyDate !== today || !Number.isFinite(storedDailyBase)) {
        dailyBase = meterTotal
        localStorage.setItem(keys.dailyDate, today)
        localStorage.setItem(keys.dailyBase, meterTotal.toString())
      }

      if (storedMonthValue !== thisMonth || !Number.isFinite(storedMonthBase)) {
        monthBase = meterTotal
        localStorage.setItem(keys.monthValue, thisMonth)
        localStorage.setItem(keys.monthBase, meterTotal.toString())
      }

      return {
        daily: Math.max(0, meterTotal - dailyBase),
        monthly: Math.max(0, meterTotal - monthBase),
      }
    }

    const calculateUsageFromPowerSamples = (startMs: number, endMs: number) => {
      if (powerSamples.length < 2) {
        return 0
      }

      const sorted = [...powerSamples]
        .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.power))
        .sort((a, b) => a.timestamp - b.timestamp)

      let kwh = 0
      for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1]
        const current = sorted[index]

        if (current.timestamp <= startMs || previous.timestamp >= endMs) {
          continue
        }

        const segmentStart = Math.max(previous.timestamp, startMs)
        const segmentEnd = Math.min(current.timestamp, endMs)

        if (segmentEnd <= segmentStart) {
          continue
        }

        const hours = (segmentEnd - segmentStart) / (1000 * 60 * 60)
        const averagePowerKw = (previous.power + current.power) / 2
        kwh += averagePowerKw * hours
      }

      return kwh
    }

    // Helper function to derive gas daily/monthly from cumulative meter when dedicated sensors are missing
    const trackGasFromMeter = (gasMeterTotal: number): { daily: number; monthly: number } => {
      const now = new Date()
      const today = now.toDateString()
      const thisMonth = `${now.getFullYear()}-${now.getMonth() + 1}`
      const keys = {
        dailyDate: `gas_daily_date_${environmentKey}`,
        dailyBase: `gas_daily_base_${environmentKey}`,
        monthValue: `gas_month_${environmentKey}`,
        monthBase: `gas_month_base_${environmentKey}`,
      }

      const storedDailyDate = localStorage.getItem(keys.dailyDate)
      const storedDailyBase = parseFloat(localStorage.getItem(keys.dailyBase) || '0')
      const storedMonthValue = localStorage.getItem(keys.monthValue)
      const storedMonthBase = parseFloat(localStorage.getItem(keys.monthBase) || '0')

      let dailyBase = storedDailyBase
      let monthBase = storedMonthBase

      if (storedDailyDate !== today || !Number.isFinite(storedDailyBase)) {
        dailyBase = gasMeterTotal
        localStorage.setItem(keys.dailyDate, today)
        localStorage.setItem(keys.dailyBase, gasMeterTotal.toString())
      }

      if (storedMonthValue !== thisMonth || !Number.isFinite(storedMonthBase)) {
        monthBase = gasMeterTotal
        localStorage.setItem(keys.monthValue, thisMonth)
        localStorage.setItem(keys.monthBase, gasMeterTotal.toString())
      }

      return {
        daily: Math.max(0, gasMeterTotal - dailyBase),
        monthly: Math.max(0, gasMeterTotal - monthBase),
      }
    }

    // Find power sensor (current usage in W or kW)
    const powerEntity = findEntity(['power', 'watt', 'current_power', 'active_power'])
    let currentPower = powerEntity ? parseValue(powerEntity.state) : mockData.currentPower
    
    // eslint-disable-next-line no-console
    console.log('[Energy] Power entity:', powerEntity?.entity_id, '=', powerEntity?.state)
    
    // Convert W to kW if needed (if value is > 100, assume it's in Watts)
    if (currentPower > 100) {
      currentPower = currentPower / 1000
    }

    // Find daily/monthly/total electricity sensors (in kWh)
    const dailyEntity = findEntity(
      ['energy_today', 'daily_energy', 'today_energy', 'day_energy', 'daily', 'today'],
      ['gas', 'price', 'cost', 'tariff'],
    )
    const monthlyEntity = findEntity(
      ['energy_month', 'monthly_energy', 'month_energy', 'monthly', 'this_month', 'month'],
      ['gas', 'price', 'cost', 'tariff'],
    )
    const totalEnergyEntity = findEntity(
      ['energy_total', 'total_energy', 'total_consumption', 'kwh_total', 'consumption_total'],
      ['gas', 'price', 'cost', 'tariff'],
    )

    // eslint-disable-next-line no-console
    console.log(
      '[Energy] Detected sensors - Daily:',
      dailyEntity?.entity_id,
      'Monthly:',
      monthlyEntity?.entity_id,
      'Total:',
      totalEnergyEntity?.entity_id,
    )

    const gasDailyEntity = findEntity([
      'gas_today',
      'daily_gas',
      'today_gas',
      'gas_day',
      'gas_verbruik_dag',
      'gas_consumption_today',
    ])
    const gasMonthlyEntity = findEntity([
      'gas_month',
      'monthly_gas',
      'month_gas',
      'gas_verbruik_maand',
      'gas_consumption_month',
    ])
    const gasFlowEntity = findEntity(
      ['gas_flow', 'gas_rate', 'current_gas', 'gas_current', 'gas_usage', 'gas_consumption'],
      ['today', 'day', 'month', 'total', 'cost', 'price', 'tariff'],
    )
    const gasMeterEntity = findEntity([
      'gas_total',
      'total_gas',
      'gas_meter',
      'gas_m3',
      'gas_consumption_total',
    ])
    
    // Use sensor data if available, otherwise track locally
    let dailyUsage: number
    let monthlyUsage: number

    const nowTime = Date.now()
    const nowDate = new Date(nowTime)
    const startOfToday = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate(),
      0,
      0,
      0,
      0,
    ).getTime()
    const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1, 0, 0, 0, 0).getTime()

    const sampledDailyUsage = calculateUsageFromPowerSamples(startOfToday, nowTime)
    const sampledMonthlyUsage = calculateUsageFromPowerSamples(startOfMonth, nowTime)
    
    if (dailyEntity && monthlyEntity) {
      // Use sensor data
      dailyUsage = parseValue(dailyEntity.state)
      monthlyUsage = parseValue(monthlyEntity.state)

      // eslint-disable-next-line no-console
      console.log('[Energy] Using daily+monthly sensors - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else if (totalEnergyEntity) {
      const trackedFromMeter = trackEnergyFromMeter(parseValue(totalEnergyEntity.state))
      dailyUsage = dailyEntity ? parseValue(dailyEntity.state) : trackedFromMeter.daily
      monthlyUsage = monthlyEntity
        ? parseValue(monthlyEntity.state)
        : trackedFromMeter.monthly

      // eslint-disable-next-line no-console
      console.log('[Energy] Using total meter fallback - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else if (dailyEntity) {
      dailyUsage = parseValue(dailyEntity.state)

      if (sampledMonthlyUsage > 0) {
        monthlyUsage = sampledMonthlyUsage
      } else {
        const tracked = trackEnergyLocally(currentPower)
        monthlyUsage = Math.max(tracked.monthly, dailyUsage)
      }

      // eslint-disable-next-line no-console
      console.log('[Energy] Using daily sensor + sample/local monthly fallback - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else if (sampledDailyUsage > 0 || sampledMonthlyUsage > 0) {
      dailyUsage = sampledDailyUsage
      monthlyUsage = sampledMonthlyUsage

      // eslint-disable-next-line no-console
      console.log('[Energy] Using sampled history fallback - Daily:', dailyUsage, 'kWh, Monthly:', monthlyUsage, 'kWh')
    } else {
      // Track locally from power readings
      const tracked = trackEnergyLocally(currentPower)
      dailyUsage = tracked.daily
      monthlyUsage = tracked.monthly
      // eslint-disable-next-line no-console
      console.log('[Energy] Tracking locally - Daily:', dailyUsage.toFixed(3), 'kWh, Monthly:', monthlyUsage.toFixed(3), 'kWh')
    }

    let gasDailyUsage = 0
    let gasMonthlyUsage = 0

    if (gasDailyEntity || gasMonthlyEntity) {
      gasDailyUsage = gasDailyEntity ? parseValue(gasDailyEntity.state) : 0
      
      if (gasMonthlyEntity) {
        gasMonthlyUsage = parseValue(gasMonthlyEntity.state)
      } else if (gasDailyEntity) {
        // Accumulate when no monthly sensor
        const trackedGas = trackGasFromMeter(0)
        gasMonthlyUsage = trackedGas.monthly + gasDailyUsage
      }
    } else if (gasMeterEntity) {
      const trackedGas = trackGasFromMeter(parseValue(gasMeterEntity.state))
      gasDailyUsage = trackedGas.daily
      gasMonthlyUsage = trackedGas.monthly
    }

    const gasChartValue = gasFlowEntity
      ? parseValue(gasFlowEntity.state)
      : gasDailyUsage

    // Calculate energy costs using pricing config
    const consumerRate = (pricingConfig?.consumerPrice || 0.30) + (pricingConfig?.consumerMargin || 0)
    const electricityCostToday = dailyUsage * consumerRate
    const electricityCostMonth = monthlyUsage * consumerRate
    const gasCostToday = gasDailyUsage * gasRatePerM3
    const gasCostMonth = gasMonthlyUsage * gasRatePerM3
    const totalCostToday = electricityCostToday + gasCostToday
    const totalCostMonth = electricityCostMonth + gasCostMonth

    return {
      currentPower: parseFloat(currentPower.toFixed(2)),
      dailyUsage: parseFloat(dailyUsage.toFixed(1)),
      monthlyUsage: parseFloat(monthlyUsage.toFixed(1)),
      gasDailyUsage: parseFloat(gasDailyUsage.toFixed(2)),
      gasMonthlyUsage: parseFloat(gasMonthlyUsage.toFixed(2)),
      gasChartValue: parseFloat(gasChartValue.toFixed(3)),
      electricityCostToday: parseFloat(electricityCostToday.toFixed(2)),
      electricityCostMonth: parseFloat(electricityCostMonth.toFixed(2)),
      gasCostToday: parseFloat(gasCostToday.toFixed(2)),
      gasCostMonth: parseFloat(gasCostMonth.toFixed(2)),
      costToday: parseFloat(totalCostToday.toFixed(2)),
      costMonth: parseFloat(totalCostMonth.toFixed(2)),
    }
  }, [haEntities, lastKnownHaEntities, pricingConfig, selectedEnvironment, gasRatePerM3, powerSamples])

  const livePowerStorageKey = `energy_live_power_samples_${selectedEnvironment || 'default'}`
  const liveGasStorageKey = `energy_live_gas_samples_${selectedEnvironment || 'default'}`
  const latestPowerRef = useRef(realTimeData.currentPower)
  const latestGasRef = useRef(realTimeData.gasChartValue)

  useEffect(() => {
    latestPowerRef.current = realTimeData.currentPower
    latestGasRef.current = realTimeData.gasChartValue
  }, [realTimeData.currentPower, realTimeData.gasChartValue])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(livePowerStorageKey)
      if (!stored) {
        setPowerSamples([])
        return
      }

      const parsed: PowerSample[] = JSON.parse(stored)
      if (!Array.isArray(parsed)) {
        return
      }

      const cleaned = parsed.filter(
        (sample) => typeof sample.timestamp === 'number' && typeof sample.power === 'number',
      )
      setPowerSamples(cleaned)
    } catch {
      setPowerSamples([])
    }
  }, [livePowerStorageKey])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(liveGasStorageKey)
      if (!stored) {
        setGasSamples([])
        return
      }

      const parsed: GasSample[] = JSON.parse(stored)
      if (!Array.isArray(parsed)) {
        return
      }

      const cleaned = parsed.filter(
        (sample) => typeof sample.timestamp === 'number' && typeof sample.gas === 'number',
      )
      setGasSamples(cleaned)
    } catch {
      setGasSamples([])
    }
  }, [liveGasStorageKey])

  useEffect(() => {
    if (!selectedEnvironment || visibleEnvironments.length === 0) {
      return
    }

    const captureSamples = () => {
      const now = Date.now()

      setPowerSamples((prev) => {
        const lastSample = prev[prev.length - 1]
        if (lastSample && now - lastSample.timestamp < 8000) {
          return prev
        }

        const next = [...prev, { timestamp: now, power: latestPowerRef.current }]
        localStorage.setItem(livePowerStorageKey, JSON.stringify(next))
        return next
      })

      setGasSamples((prev) => {
        const lastSample = prev[prev.length - 1]
        if (lastSample && now - lastSample.timestamp < 8000) {
          return prev
        }

        const next = [...prev, { timestamp: now, gas: latestGasRef.current }]
        localStorage.setItem(liveGasStorageKey, JSON.stringify(next))
        return next
      })
    }

    captureSamples()
    const interval = window.setInterval(captureSamples, 10000)
    return () => window.clearInterval(interval)
  }, [liveGasStorageKey, livePowerStorageKey, selectedEnvironment, visibleEnvironments.length])

  const selectedRange = useMemo(() => {
    const [year, month, day] = selectedChartDate.split('-').map(Number)
    const isValidDate = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    const anchorDate = isValidDate
      ? new Date(year, month - 1, day)
      : new Date()

    const rangeStart = new Date(anchorDate)
    const rangeEnd = new Date(anchorDate)
    rangeEnd.setHours(23, 59, 59, 999)

    if (timeRange === 'week') {
      rangeStart.setDate(rangeStart.getDate() - 6)
      rangeStart.setHours(0, 0, 0, 0)
    } else if (timeRange === 'month') {
      rangeStart.setDate(1)
      rangeStart.setHours(0, 0, 0, 0)
    } else {
      rangeStart.setHours(0, 0, 0, 0)
    }

    return {
      startMs: rangeStart.getTime(),
      endMs: rangeEnd.getTime(),
      label: rangeEnd.toLocaleDateString(),
    }
  }, [selectedChartDate, timeRange])

  const mapSamplesToChartPoints = (
    samples: Array<{ timestamp: number; value: number }>,
    fallbackValue: number,
  ) => {
    const filtered = samples.filter(
      (sample) => sample.timestamp >= selectedRange.startMs && sample.timestamp <= selectedRange.endMs,
    )

    if (filtered.length === 0) {
      return [{
        time: new Date(selectedRange.endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        power: fallbackValue,
      }]
    }

    const maxPoints = timeRange === 'today' ? 1440 : 2000
    const step = Math.max(1, Math.ceil(filtered.length / maxPoints))
    const reduced = filtered.filter((_, index) => index % step === 0 || index === filtered.length - 1)

    return reduced.map((sample) => ({
      time: new Date(sample.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      power: sample.value,
    }))
  }

  const chartData = useMemo(() => {
    return mapSamplesToChartPoints(
      powerSamples.map((sample) => ({ timestamp: sample.timestamp, value: sample.power })),
      latestPowerRef.current,
    )
  }, [powerSamples, selectedRange.endMs, selectedRange.startMs, timeRange])

  const gasChartData = useMemo(() => {
    return mapSamplesToChartPoints(
      gasSamples.map((sample) => ({ timestamp: sample.timestamp, value: sample.gas })),
      latestGasRef.current,
    )
  }, [gasSamples, selectedRange.endMs, selectedRange.startMs, timeRange])

  // Show loading screen while checking permissions
  if (isCheckingPermissions) {
    return (
      <div className="app-shell min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-16 h-16 border-4 border-brand-2 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-dark-2 text-lg">Loading your environments...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header with Environment Selector */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <Home className="w-8 h-8 text-brand-2" />
              <div>
                <h1 className="text-4xl md:text-5xl font-heavy text-light-2 mb-2">
                  Inside-Out Foxtrot
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-light-2" />
              <select
                value={selectedEnvironment}
                onChange={(e) => {
                  const nextId = e.target.value
                  setSelectedEnvironment(nextId)
                  onEnvironmentChange?.(nextId)
                }}
                disabled={visibleEnvironments.length === 0}
                className="bg-light-2 bg-opacity-20 text-light-2 border border-light-2 border-opacity-30 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
              >
                {visibleEnvironments.length === 0 && (
                  <option value="" className="bg-dark-1 text-light-2">
                    No environments
                  </option>
                )}
                {visibleEnvironments.map((env) => (
                  <option key={env.id} value={env.id} className="bg-dark-1 text-light-2">
                    {env.name}
                  </option>
                ))}
              </select>
              <div className="relative settings-dropdown-container">
                <button
                  onClick={() => setShowSettingsDropdown(!showSettingsDropdown)}
                  disabled={!selectedEnvironment}
                  className="flex items-center gap-2 px-3 py-2 bg-light-2 bg-opacity-20 text-light-2 border border-light-2 border-opacity-30 rounded-lg hover:bg-opacity-30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Environment Settings"
                >
                  <Settings className="w-5 h-5" />
                  <span className="text-sm font-medium">Settings</span>
                  <ChevronDown className="w-4 h-4" />
                </button>
                {showSettingsDropdown && selectedEnvironment && (
                  <div className="absolute right-0 mt-2 w-56 bg-dark-1 border border-light-2 border-opacity-30 rounded-lg shadow-xl z-50">
                    <div className="py-1">
                      <button
                        onClick={() => {
                          setShowPriceModal(true)
                          setShowSettingsDropdown(false)
                        }}
                        className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left"
                      >
                        <DollarSign className="w-5 h-5" />
                        <div>
                          <div className="font-medium">Energy Price</div>
                          <div className="text-xs text-light-1">Configure pricing & rates</div>
                        </div>
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => {
                            setShowHaConfig(true)
                            setShowSettingsDropdown(false)
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-light-2 hover:bg-light-2 hover:bg-opacity-10 transition-all text-left border-t border-light-2 border-opacity-10"
                        >
                          <Settings className="w-5 h-5" />
                          <div>
                            <div className="font-medium">Configure Sensors</div>
                            <div className="text-xs text-light-1">Setup Home Assistant</div>
                          </div>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Current Environment Info */}
          <div className="bg-light-2 bg-opacity-10 rounded-xl p-4 backdrop-blur-sm">
            {visibleEnvironments.length > 0 ? (
              <>
                <div className="flex items-center gap-2 text-light-2">
                  {/* Status indicator: green=connected, red=error, yellow=connecting */}
                  <div
                    className={`w-3 h-3 rounded-full ${
                      haConnectionStatus === 'connected'
                        ? 'bg-green-400 animate-pulse'
                        : haConnectionStatus === 'connecting'
                        ? 'bg-yellow-400 animate-pulse'
                        : 'bg-red-500 animate-pulse'
                    }`}
                    title={
                      haConnectionStatus === 'connected'
                        ? 'Connected to Home Assistant'
                        : haConnectionStatus === 'connecting'
                        ? 'Connecting to Home Assistant...'
                        : 'Not connected to Home Assistant'
                    }
                  ></div>
                  <span className="font-medium">
                    Currently monitoring: {environments.find(e => e.id === selectedEnvironment)?.name}
                  </span>
                </div>
                <div className="mt-3 text-light-1 text-sm">
                  {allowedEnvironmentIds ? (
                    assignedEnvironmentLabels.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="opacity-80">Your environments:</span>
                        {assignedEnvironmentLabels.map((label) => (
                          <span
                            key={label}
                            className="px-2 py-1 rounded-full bg-light-2 bg-opacity-20 text-light-2 text-xs"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="opacity-80">No environments assigned.</span>
                    )
                  ) : (
                    <span className="opacity-80">All environments available.</span>
                  )}
                  {envLoading && <div className="mt-2 text-xs opacity-70">Loading environments...</div>}
                  {envError && <div className="mt-2 text-xs text-red-300">{envError}</div>}
                </div>
              </>
            ) : (
              <div className="text-light-2 text-center py-2">
                <span className="font-medium">No environments assigned</span>
              </div>
            )}
          </div>
        </div>

        {/* No Environments Assigned Message */}
        {visibleEnvironments.length === 0 && !envLoading && (
          <div className="glass-panel rounded-3xl shadow-2xl p-12 text-center">
            <div className="max-w-md mx-auto">
              <div className="w-20 h-20 mx-auto mb-6 bg-dark-2 bg-opacity-20 rounded-full flex items-center justify-center">
                <Home className="w-10 h-10 text-dark-2" />
              </div>
              <h2 className="text-3xl font-heavy text-dark-1 mb-4">No Environments Assigned</h2>
              <p className="text-dark-2 text-lg mb-2">
                You don't have access to any environments yet.
              </p>
              <p className="text-dark-2">
                Please contact your sales contact person to request access.
              </p>
            </div>
          </div>
        )}

        {/* Main Content - Only show when there are environments */}
        {visibleEnvironments.length > 0 && (
          <>
            {/* Main Current Power Display */}
            <div className="glass-panel rounded-3xl shadow-2xl p-8 mb-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-dark-2 text-sm font-medium uppercase">Current Power Usage</p>
              <div className="flex items-baseline gap-2">
                <span className="text-6xl font-heavy text-transparent bg-clip-text bg-gradient-to-r from-brand-2 to-brand-3">
                  {realTimeData.currentPower}
                </span>
                <span className="text-2xl text-dark-2">kW</span>
              </div>
            </div>
            <div className="bg-gradient-to-br from-brand-1 to-brand-2 p-6 rounded-2xl">
              <Zap className="w-16 h-16 text-dark-1" />
            </div>
          </div>
        </div>

        {/* Energy Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <EnergyCard
            title="Electricity Today"
            value={realTimeData.dailyUsage}
            unit="kWh"
            cost={realTimeData.electricityCostToday}
            icon="zap"
          />
          <EnergyCard
            title="Electricity This Month"
            value={realTimeData.monthlyUsage}
            unit="kWh"
            cost={realTimeData.electricityCostMonth}
            icon="calendar"
          />
          <EnergyCard
            title="Status"
            value={
              haConnectionStatus === 'connected'
                ? 'Active'
                : haConnectionStatus === 'connecting'
                ? 'Connecting...'
                : 'Error'
            }
            unit=""
            cost={null}
            icon="activity"
            status={haConnectionStatus}
          />
        </div>

        {/* Cost Breakdown */}
        <div className="glass-panel rounded-2xl shadow-lg p-6 mb-8">
          <h3 className="text-xl font-heavy text-dark-1 mb-4">Cost Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="glass-card rounded-xl p-4">
              <p className="text-light-1 text-sm font-medium mb-3">Today</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between text-light-2">
                  <span>Electricity cost</span>
                  <span>€{realTimeData.electricityCostToday.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-light-2">
                  <span>Gas cost</span>
                  <span>€{realTimeData.gasCostToday.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-light-2 font-heavy border-t border-dark-2 border-opacity-20 pt-2">
                  <span>Total</span>
                  <span>€{realTimeData.costToday.toFixed(2)}</span>
                </div>
              </div>
            </div>
            <div className="glass-card rounded-xl p-4">
              <p className="text-light-1 text-sm font-medium mb-3">This Month</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between text-light-2">
                  <span>Electricity cost</span>
                  <span>€{realTimeData.electricityCostMonth.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-light-2">
                  <span>Gas cost</span>
                  <span>€{realTimeData.gasCostMonth.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-light-2 font-heavy border-t border-dark-2 border-opacity-20 pt-2">
                  <span>Total</span>
                  <span>€{realTimeData.costMonth.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Time Range Selector */}
        <div className="glass-panel rounded-xl shadow-lg p-4 mb-8">
          <div className="flex flex-col md:flex-row md:items-center gap-4">
            <div className="flex gap-4 flex-1">
              <button
                onClick={() => setTimeRange('today')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'today'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Day
              </button>
              <button
                onClick={() => setTimeRange('week')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'week'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Week
              </button>
              <button
                onClick={() => setTimeRange('month')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  timeRange === 'month'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Month
              </button>
            </div>
            <div className="md:w-56">
              <label className="block text-xs text-light-1 mb-1">Selected date</label>
              <input
                type="date"
                value={selectedChartDate}
                onChange={(event) => setSelectedChartDate(event.target.value)}
                className="w-full bg-dark-2 bg-opacity-70 text-light-2 border border-light-2 border-opacity-20 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-2"
              />
            </div>
          </div>
        </div>

        {/* Chart Section */}
        <div className="glass-panel rounded-3xl shadow-2xl p-8">
          <h2 className="text-2xl font-heavy text-dark-1 mb-6 flex items-center gap-2">
            <Clock className="w-6 h-6 text-brand-2" />
            Electricity Consumption Chart
          </h2>
          <EnergyChart
            data={chartData}
            timeRange={timeRange}
            unit="kW"
            seriesLabel="Electricity consumption"
            rangeLabel={selectedRange.label}
          />
        </div>

        {/* Gas Chart Section */}
        <div className="glass-panel rounded-3xl shadow-2xl p-8 mt-8">
          <h2 className="text-2xl font-heavy text-dark-1 mb-6 flex items-center gap-2">
            <Flame className="w-6 h-6 text-brand-2" />
            Gas Consumption Chart
          </h2>
          <EnergyChart
            data={gasChartData}
            timeRange={timeRange}
            unit="m³"
            seriesLabel="Gas consumption"
            rangeLabel={selectedRange.label}
          />
        </div>

        {/* Home Assistant Panel */}
        <div className="glass-panel rounded-3xl shadow-2xl p-8 mt-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-heavy text-dark-1">Home Assistant</h2>
          </div>

          {haLoading && <p className="text-light-1">Loading Home Assistant data...</p>}
          {haError && <p className="text-red-300">{haError}</p>}
          {/* Toon altijd de laatst bekende sensoren */}
          {!isInitialLoading && (haEntities.length > 0 || lastKnownHaEntities.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(haEntities.length > 0 ? haEntities : lastKnownHaEntities).map((entity) => {
                  const actions = getControlActions(entity.domain)
                  return (
                    <div key={entity.entity_id} className="glass-card rounded-2xl p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="text-light-1 text-xs uppercase">{entity.domain}</p>
                          <p className="text-light-2 font-medium">
                            {entity.friendly_name || entity.entity_id}
                          </p>
                          <p className="text-light-1 text-xs">{entity.entity_id}</p>
                        </div>
                        <div className="text-light-2 text-sm">{entity.state}</div>
                      </div>
                      {actions.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {actions.map((action) => (
                            <button
                              key={`${entity.entity_id}-${action.action}`}
                              onClick={() => runHaAction(entity.entity_id, action.action)}
                              disabled={haActionId === entity.entity_id}
                              className="px-3 py-2 rounded-lg bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90 transition-all disabled:opacity-60"
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
        </div>

        {/* Footer Info */}
        <div className="mt-8 text-center text-light-1 text-sm">
          <p>Last updated: {new Date().toLocaleTimeString()}</p>
        </div>
          </>
        )}

        {showHaConfig && (
          <HomeAssistantConfig
            environmentId={selectedEnvironment}
            environmentName={environments.find((env) => env.id === selectedEnvironment)?.name || selectedEnvironment}
            onClose={() => setShowHaConfig(false)}
            onSaved={() => {
              setHaError(null)
              setHaRefreshKey((prev) => prev + 1)
            }}
          />
        )}

        {showPriceModal && (
          <EnergyPriceModal
            environmentId={selectedEnvironment}
            onClose={() => setShowPriceModal(false)}
            onSave={(config) => setPricingConfig(config)}
            getAuthToken={getAccessTokenSilently}
          />
        )}
      </div>
    </div>
  )
}
