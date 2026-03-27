import { createRemoteJWKSet, jwtVerify } from 'jose'
import { resolveEnvironmentConfig } from './_environment-storage.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const getOptionalEnv = (key) => {
  const value = process.env[key]
  return value && value.trim().length > 0 ? value : null
}

const HA_ENVIRONMENTS = {
  vacation: {
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
}

const ENV_METADATA_PREFIX = 'ha_env_v1_'

const managementTokenCache = { token: null, expiresAt: 0 }
const metadataCache = { value: null, expiresAt: 0 }
const metricsHistoryCache = new Map()

const parseCsvEnv = (value, fallback = []) => {
  const raw = String(value || '').trim()
  if (!raw) {
    return fallback
  }

  const parsed = raw
    .split(',')
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)

  return parsed.length > 0 ? parsed : fallback
}

const parseEnvironmentMap = (rawValue) => {
  if (!rawValue) {
    return {}
  }

  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {}
}

const parseHaConfig = (rawValue) => {
  if (!rawValue) {
    return {}
  }

  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {}
}

const decodeEnvironmentId = (encodedId) => {
  try {
    return Buffer.from(String(encodedId || ''), 'base64url').toString('utf8').trim()
  } catch {
    return ''
  }
}

const parseShardedEnvironmentMap = (metadata = {}) => {
  const entries = Object.keys(metadata || {}).filter(
    (key) => key.startsWith(ENV_METADATA_PREFIX) && key.endsWith('_url'),
  )

  return entries.reduce((acc, urlKey) => {
    const encodedId = urlKey.slice(ENV_METADATA_PREFIX.length, -'_url'.length)
    const environmentId = decodeEnvironmentId(encodedId)
    if (!environmentId) {
      return acc
    }

    const baseUrl = String(metadata[urlKey] || '').trim()
    const apiKey = String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_token`] || '').trim()
    if (!baseUrl || !apiKey) {
      return acc
    }

    acc[environmentId] = {
      name: String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_name`] || environmentId).trim() || environmentId,
      type: String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_type`] || 'home_assistant').trim() || 'home_assistant',
      config: {
        base_url: baseUrl,
        api_key: apiKey,
        site_id: String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_site_id`] || '').trim(),
        notes: String(metadata[`${ENV_METADATA_PREFIX}${encodedId}_notes`] || '').trim(),
      },
    }
    return acc
  }, {})
}

const getStoredEnvironmentMap = (metadata = {}) => {
  const haConfig = parseHaConfig(metadata.ha_config)

  return {
    ...parseEnvironmentMap(metadata.environments),
    ...parseEnvironmentMap(metadata.ha_environments),
    ...parseEnvironmentMap(haConfig.__environments),
    ...parseShardedEnvironmentMap(metadata),
  }
}

const GAS_TOTAL_ENTITY_ID_CANDIDATES = parseCsvEnv(process.env.HA_GAS_TOTAL_ENTITY_IDS, [
  'sensor.gas_meter_gas_consumption',
  'sensor.gas_meter_gasverbruik',
  'sensor.gas_total',
  'sensor.gas_consumption_total',
])

const ELECTRICITY_TOTAL_ENTITY_ID_CANDIDATES = parseCsvEnv(process.env.HA_ELECTRICITY_TOTAL_ENTITY_IDS, [])
const ELECTRICITY_PRODUCTION_TOTAL_ENTITY_ID_CANDIDATES = parseCsvEnv(
  process.env.HA_ELECTRICITY_PRODUCTION_TOTAL_ENTITY_IDS,
  [],
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const getManagementToken = async (domain) => {
  const now = Date.now()
  if (managementTokenCache.token && now < managementTokenCache.expiresAt - 60000) {
    return managementTokenCache.token
  }

  const fetchToken = async () => {
    const response = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: getEnv('AUTH0_M2M_CLIENT_ID'),
        client_secret: getEnv('AUTH0_M2M_CLIENT_SECRET'),
        audience: `https://${domain}/api/v2/`,
        grant_type: 'client_credentials',
      }),
    })
    if (!response.ok) {
      const body = await response.text();
      console.error('Failed to get management token:', response.status, body);
      throw new Error('Unable to get management token')
    }
    return response.json()
  }

  try {
    const data = await fetchToken()
    const expiresIn = Number(data.expires_in) || 600
    managementTokenCache.token = data.access_token
    managementTokenCache.expiresAt = Date.now() + expiresIn * 1000
    return managementTokenCache.token
  } catch (error) {
    await sleep(200)
    const data = await fetchToken()
    const expiresIn = Number(data.expires_in) || 600
    managementTokenCache.token = data.access_token
    managementTokenCache.expiresAt = Date.now() + expiresIn * 1000
    return managementTokenCache.token
  }
}

const getClientMetadata = async (domain, token) => {
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    const body = await response.text();
    // For debugging: throw an error with full Auth0 response
    const error = new Error('Unable to fetch app metadata - getClientMetadata');
    error.status = response.status;
    error.auth0Body = body;
    throw error;
  }
  const client = await response.json()
  return client.client_metadata || {}
}

const getCachedClientMetadata = async (domain, token) => {
  const now = Date.now()
  if (metadataCache.value && now < metadataCache.expiresAt) {
    return metadataCache.value
  }

  const metadata = await getClientMetadata(domain, token)
  metadataCache.value = metadata
  metadataCache.expiresAt = now + 60_000
  return metadata
}

const getVisibleEntityIds = (metadata, environmentId) => {
  const haConfig = parseHaConfig(metadata.ha_config)
  const envConfig = haConfig[environmentId] || {}
  const visibleEntityIds = envConfig.visible_entity_ids
  return Array.isArray(visibleEntityIds) ? visibleEntityIds : []
}

const getUserVisibleEntityIds = (userMetadata, environmentId) => {
  if (!userMetadata) return null
  const haConfig = parseHaConfig(userMetadata.ha_config)
  const envConfig = haConfig[environmentId] || {}
  const visibleEntityIds = envConfig.visible_entity_ids
  return Array.isArray(visibleEntityIds) ? visibleEntityIds : null
}

const parseNumericValue = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN
  }

  if (value === null || value === undefined) {
    return NaN
  }

  const source = String(value).trim()
  if (!source) {
    return NaN
  }

  let normalized = source.replace(/\s/g, '')
  const hasComma = normalized.includes(',')
  const hasDot = normalized.includes('.')

  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(',')
    const lastDot = normalized.lastIndexOf('.')
    normalized = lastComma > lastDot
      ? normalized.replace(/\./g, '').replace(',', '.')
      : normalized.replace(/,/g, '')
  } else if (hasComma && !hasDot) {
    normalized = normalized.replace(',', '.')
  }

  normalized = normalized.replace(/[^0-9+\-.]/g, '')
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : NaN
}

const toSearchable = (entity) => `${entity.entity_id} ${entity.friendly_name || ''}`.toLowerCase()

const findEntityByKeywords = (entities, includeKeywords, excludeKeywords = []) =>
  entities.find((entity) => {
    if (entity.domain !== 'sensor') {
      return false
    }

    const searchable = toSearchable(entity)
    const hasInclude = includeKeywords.some((keyword) => searchable.includes(String(keyword).toLowerCase()))
    const hasExclude = excludeKeywords.some((keyword) => searchable.includes(String(keyword).toLowerCase()))
    const numericState = Number.isFinite(parseNumericValue(entity.state))
    return hasInclude && !hasExclude && numericState
  })

const isPowerUnit = (unit) => {
  const normalizedUnit = String(unit || '').trim().toLowerCase()
  return (
    normalizedUnit === 'w' ||
    normalizedUnit === 'kw' ||
    normalizedUnit === 'watt' ||
    normalizedUnit === 'kilowatt' ||
    normalizedUnit === 'va' ||
    normalizedUnit === 'kva'
  )
}

const convertPowerToKw = (rawValue, unit) => {
  if (!Number.isFinite(rawValue)) {
    return NaN
  }

  const normalizedUnit = String(unit || '').trim().toLowerCase()
  if (normalizedUnit === 'w' || normalizedUnit === 'watt' || normalizedUnit === 'va') {
    return rawValue / 1000
  }
  if (normalizedUnit === 'kw' || normalizedUnit === 'kilowatt' || normalizedUnit === 'kva') {
    return rawValue
  }
  return rawValue > 100 ? rawValue / 1000 : rawValue
}

const toMetricValue = (value) => (Number.isFinite(value) ? Number(value) : null)

const PRODUCTION_KEYWORDS = [
  'production',
  'producer',
  'solar',
  'pv',
  'generation',
  'yield',
  'opwek',
  'opgewekt',
  'export',
  'injection',
  'teruglever',
]

const getDashboardMetrics = (entities) => {
  if (!Array.isArray(entities) || entities.length === 0) {
    return null
  }

  const powerEntity =
    entities.find((entity) => (
      entity.domain === 'sensor' &&
      String(entity.device_class || '').toLowerCase() === 'power' &&
      Number.isFinite(parseNumericValue(entity.state))
    )) ||
    findEntityByKeywords(
      entities,
      [
        'current_power',
        'active_power',
        'power',
        'watt',
        'vermogen',
        'actueel vermogen',
        'actueel_vermogen',
        'huidig verbruik',
        'verbruik nu',
        'current usage',
        'current consumption',
        'load',
      ],
      ['today', 'daily', 'month', 'monthly', 'total', 'kwh', 'energy', 'gas', 'price', 'cost', 'tariff'],
    ) ||
    entities.find((entity) => (
      entity.domain === 'sensor' &&
      isPowerUnit(entity.unit_of_measurement) &&
      Number.isFinite(parseNumericValue(entity.state))
    ))

  const productionPowerEntity =
    findEntityByKeywords(
      entities,
      PRODUCTION_KEYWORDS,
      ['today', 'daily', 'month', 'monthly', 'total', 'kwh', 'energy', 'gas', 'price', 'cost', 'tariff'],
    ) ||
    entities.find((entity) => {
      if (entity.domain !== 'sensor') {
        return false
      }

      const searchable = toSearchable(entity)
      return (
        isPowerUnit(entity.unit_of_measurement) &&
        includesAny(searchable, PRODUCTION_KEYWORDS) &&
        Number.isFinite(parseNumericValue(entity.state))
      )
    })

  const pickElectricityPeriodEntity = (period, kind = 'consumption') => {
    const isProduction = kind === 'production'
    const isDaily = period === 'daily'
    const periodKeywords = isDaily
      ? ['today', 'daily', 'day', 'vandaag', 'dag']
      : ['month', 'monthly', 'this_month', 'maand']
    const energyContextKeywords = isProduction
      ? ['electricity', 'energy', 'production', 'producer', 'solar', 'pv', 'yield', 'opwek', 'opgewekt', 'kwh', 'export', 'injection', 'teruglever']
      : ['electricity', 'energy', 'consumption', 'meter', 'kwh', 'verbruik', 'import', 'net', 'grid']
    const preciseKeywords = isProduction
      ? (isDaily
          ? ['production_today', 'today_production', 'daily_production', 'solar_today', 'pv_today', 'opwek_vandaag', 'opgewekt_vandaag']
          : ['production_month', 'month_production', 'monthly_production', 'solar_month', 'pv_month', 'opwek_maand', 'opgewekt_maand'])
      : (isDaily
          ? ['energy_today', 'today_energy', 'daily_energy', 'consumption_today', 'verbruik_vandaag']
          : ['energy_month', 'month_energy', 'monthly_energy', 'consumption_month', 'verbruik_maand'])
    const tariffKeywords = ['tariff', 'tarif', 'tarief', 'peak', 'offpeak', 'dal', 'hoog', 'laag', 't1', 't2', 'normal', 'low', 'high']

    const candidates = entities
      .filter((entity) => {
        if (entity.domain !== 'sensor') {
          return false
        }

        const searchable = toSearchable(entity)
        if (includesAny(searchable, ['gas', 'price', 'cost', 'tariff', 'tarif', 'tarief'])) {
          return false
        }

        if (!isProduction && includesAny(searchable, PRODUCTION_KEYWORDS)) {
          return false
        }

        if (isProduction && !includesAny(searchable, PRODUCTION_KEYWORDS)) {
          return false
        }

        const numericState = Number.isFinite(parseNumericValue(entity.state))
        if (!numericState) {
          return false
        }

        const hasPeriod = includesAny(searchable, periodKeywords)
        const hasEnergyContext = includesAny(searchable, energyContextKeywords)
        return hasPeriod && hasEnergyContext
      })
      .map((entity) => {
        const searchable = toSearchable(entity)
        const deviceClass = String(entity.device_class || '').toLowerCase()
        const stateClass = String(entity.state_class || '').toLowerCase()
        let score = 0

        if (includesAny(searchable, preciseKeywords)) score += 5
        if (includesAny(searchable, isProduction ? ['production', 'producer', 'solar', 'pv', 'yield', 'export', 'injection', 'opwek'] : ['total', 'main', 'meter', 'consumption', 'verbruik', 'grid', 'net'])) score += 2
        if (isEnergyUnit(entity.unit_of_measurement)) score += 2
        if (deviceClass === 'energy') score += 2
        if (stateClass === 'measurement') score += 1
        if (includesAny(searchable, tariffKeywords)) score -= 3

        return { entity, score }
      })
      .sort((a, b) => b.score - a.score)

    return candidates[0]?.entity || null
  }

  const dailyElectricityEntity = pickElectricityPeriodEntity('daily')

  const monthlyElectricityEntity = pickElectricityPeriodEntity('monthly')

  const dailyProductionEntity = pickElectricityPeriodEntity('daily', 'production')

  const monthlyProductionEntity = pickElectricityPeriodEntity('monthly', 'production')

  const dailyGasEntity = findEntityByKeywords(
    entities,
    ['gas_today', 'daily_gas', 'today_gas', 'gas_day', 'gas_verbruik_dag', 'gas_consumption_today'],
    ['price', 'cost', 'tariff'],
  )

  const monthlyGasEntity = findEntityByKeywords(
    entities,
    ['gas_month', 'monthly_gas', 'month_gas', 'gas_verbruik_maand', 'gas_consumption_month'],
    ['price', 'cost', 'tariff'],
  )

  const currentPowerKw = powerEntity
    ? convertPowerToKw(parseNumericValue(powerEntity.state), powerEntity.unit_of_measurement)
    : NaN

  const currentProductionKw = productionPowerEntity
    ? convertPowerToKw(parseNumericValue(productionPowerEntity.state), productionPowerEntity.unit_of_measurement)
    : NaN

  const dailyElectricityKwh = dailyElectricityEntity
    ? parseNumericValue(dailyElectricityEntity.state)
    : NaN

  const monthlyElectricityKwh = monthlyElectricityEntity
    ? parseNumericValue(monthlyElectricityEntity.state)
    : NaN

  const dailyProductionKwh = dailyProductionEntity
    ? parseNumericValue(dailyProductionEntity.state)
    : NaN

  const monthlyProductionKwh = monthlyProductionEntity
    ? parseNumericValue(monthlyProductionEntity.state)
    : NaN

  const dailyGasM3 = dailyGasEntity
    ? parseNumericValue(dailyGasEntity.state)
    : NaN

  const monthlyGasM3 = monthlyGasEntity
    ? parseNumericValue(monthlyGasEntity.state)
    : NaN

  return {
    currentPowerKw: toMetricValue(currentPowerKw),
    currentProductionKw: toMetricValue(currentProductionKw),
    // Daily/monthly electricity always derived from history delta — never from snapshot sensors
    dailyElectricityKwh: null,
    monthlyElectricityKwh: null,
    dailyProductionKwh: toMetricValue(dailyProductionKwh),
    monthlyProductionKwh: toMetricValue(monthlyProductionKwh),
    dailyGasM3: toMetricValue(dailyGasM3),
    monthlyGasM3: toMetricValue(monthlyGasM3),
    sources: {
      currentPowerEntityId: powerEntity?.entity_id || null,
      currentProductionEntityId: productionPowerEntity?.entity_id || null,
      dailyElectricityEntityId: dailyElectricityEntity?.entity_id || null,
      monthlyElectricityEntityId: monthlyElectricityEntity?.entity_id || null,
      dailyProductionEntityId: dailyProductionEntity?.entity_id || null,
      monthlyProductionEntityId: monthlyProductionEntity?.entity_id || null,
      dailyGasEntityId: dailyGasEntity?.entity_id || null,
      monthlyGasEntityId: monthlyGasEntity?.entity_id || null,
    },
  }
}

const includesAny = (value, items) => items.some((item) => value.includes(item))

const isEnergyUnit = (unit) => {
  const normalized = String(unit || '').trim().toLowerCase()
  return normalized === 'kwh' || normalized === 'wh' || normalized === 'mwh'
}

const isGasUnit = (unit) => {
  const normalized = String(unit || '').trim().toLowerCase()
  return normalized === 'm3' || normalized === 'm^3' || normalized === 'm³'
}

const getEntitySearchFlags = (searchable) => {
  const isDailyLike = includesAny(searchable, ['today', 'daily', 'day'])
  const isMonthlyLike = includesAny(searchable, ['month', 'monthly'])
  const isNetLike = includesAny(searchable, [
    'net',
    'netto',
    'grid total',
    'grid_total',
    'total net',
    'totaal net',
    'net_consumption',
    'netto verbruik',
  ])
  const isTariffLike = includesAny(searchable, [
    'tariff',
    'tarif',
    'tarief',
    'peak',
    'offpeak',
    'dal',
    'hoog',
    'laag',
    't1',
    't2',
    'normal',
    'low',
    'high',
  ])
  const isAggregateLike = includesAny(searchable, [
    'total',
    'meter',
    'consumption',
    'main',
    'grid',
    'verbruik',
  ])

  return {
    isDailyLike,
    isMonthlyLike,
    isNetLike,
    isTariffLike,
    isAggregateLike,
  }
}

const pickTotalElectricityCandidates = (entities) => {
  const normalizedMap = new Map(
    entities.map((entity) => [String(entity.entity_id || '').trim().toLowerCase(), entity]),
  )

  const explicitMatchId = ELECTRICITY_TOTAL_ENTITY_ID_CANDIDATES.find((candidateId) => normalizedMap.has(candidateId))
  if (explicitMatchId) {
    const explicitEntity = normalizedMap.get(explicitMatchId)
    const explicitRawValue = parseNumericValue(explicitEntity?.state)
    const explicitValueKwh = convertEnergyToKwh(explicitRawValue, explicitEntity?.unit_of_measurement)

    if (explicitEntity && Number.isFinite(explicitValueKwh)) {
      return [{
        entity: explicitEntity,
        score: Number.MAX_SAFE_INTEGER,
        stateClass: String(explicitEntity.state_class || '').toLowerCase(),
        isPhaseLike: false,
        currentValueKwh: explicitValueKwh,
        isDailyLike: false,
        isMonthlyLike: false,
        isTariffLike: false,
        isAggregateLike: true,
      }]
    }
  }

  const candidates = entities
    .filter((entity) => {
      if (entity.domain !== 'sensor') {
        return false
      }

      const searchable = toSearchable(entity)
      if (includesAny(searchable, ['gas', 'price', 'cost'])) {
        return false
      }

      if (includesAny(searchable, ['production', 'producer', 'export', 'injection', 'teruglever'])) {
        return false
      }

      if (includesAny(searchable, ['power', 'watt', 'actueel vermogen', 'current_power'])) {
        return false
      }

      const unit = String(entity.unit_of_measurement || '').trim().toLowerCase()
      const deviceClass = String(entity.device_class || '').toLowerCase()
      const stateClass = String(entity.state_class || '').toLowerCase()

      if (isPowerUnit(unit) || deviceClass === 'power') {
        return false
      }

      const numericState = Number.isFinite(parseNumericValue(entity.state))
      if (!numericState) {
        return false
      }

      const hasCumulativeSemantics =
        stateClass === 'total_increasing' ||
        stateClass === 'total' ||
        deviceClass === 'energy' ||
        isEnergyUnit(unit)

      if (!hasCumulativeSemantics) {
        return false
      }

      return (
        isEnergyUnit(entity.unit_of_measurement) ||
        String(entity.device_class || '').toLowerCase() === 'energy' ||
        includesAny(searchable, ['energy', 'consumption', 'meter', 'kwh'])
      )
    })
    .map((entity) => {
      const searchable = toSearchable(entity)
      const stateClass = String(entity.state_class || '').toLowerCase()
      const deviceClass = String(entity.device_class || '').toLowerCase()
      const flags = getEntitySearchFlags(searchable)
      const isPhaseLike = includesAny(searchable, ['l1', 'l2', 'l3', 'phase', 'fase'])
      let score = 0

      if (deviceClass === 'energy') score += 5
      if (stateClass === 'total_increasing') score += 5
      if (stateClass === 'total') score += 4
      if (flags.isNetLike) score += 6
      if (flags.isAggregateLike) score += 3
      if (isEnergyUnit(entity.unit_of_measurement)) score += 2
      if (flags.isDailyLike || flags.isMonthlyLike) score -= 8
      if (flags.isTariffLike) score -= 1
      if (isPhaseLike) score -= 1

      const rawState = parseNumericValue(entity.state)
      const currentValueKwh = convertEnergyToKwh(rawState, entity.unit_of_measurement)

      return {
        entity,
        score,
        stateClass,
        isPhaseLike,
        currentValueKwh,
        ...flags,
      }
    })
    .filter((candidate) => !candidate.isDailyLike && !candidate.isMonthlyLike)
    .sort((a, b) => b.score - a.score)

  return candidates
}

const pickTotalElectricityProductionCandidates = (entities) => {
  const normalizedMap = new Map(
    entities.map((entity) => [String(entity.entity_id || '').trim().toLowerCase(), entity]),
  )

  const explicitMatchId = ELECTRICITY_PRODUCTION_TOTAL_ENTITY_ID_CANDIDATES.find((candidateId) => normalizedMap.has(candidateId))
  if (explicitMatchId) {
    const explicitEntity = normalizedMap.get(explicitMatchId)
    const explicitRawValue = parseNumericValue(explicitEntity?.state)
    const explicitValueKwh = convertEnergyToKwh(explicitRawValue, explicitEntity?.unit_of_measurement)

    if (explicitEntity && Number.isFinite(explicitValueKwh)) {
      return [{
        entity: explicitEntity,
        score: Number.MAX_SAFE_INTEGER,
        stateClass: String(explicitEntity.state_class || '').toLowerCase(),
        isPhaseLike: false,
        currentValueKwh: explicitValueKwh,
        isDailyLike: false,
        isMonthlyLike: false,
        isTariffLike: false,
        isAggregateLike: true,
      }]
    }
  }

  const candidates = entities
    .filter((entity) => {
      if (entity.domain !== 'sensor') {
        return false
      }

      const searchable = toSearchable(entity)
      if (includesAny(searchable, ['gas', 'price', 'cost'])) {
        return false
      }

      if (!includesAny(searchable, PRODUCTION_KEYWORDS)) {
        return false
      }

      if (includesAny(searchable, ['power', 'watt', 'actueel vermogen', 'current_power'])) {
        return false
      }

      const unit = String(entity.unit_of_measurement || '').trim().toLowerCase()
      const deviceClass = String(entity.device_class || '').toLowerCase()
      const stateClass = String(entity.state_class || '').toLowerCase()

      if (isPowerUnit(unit) || deviceClass === 'power') {
        return false
      }

      const numericState = Number.isFinite(parseNumericValue(entity.state))
      if (!numericState) {
        return false
      }

      const hasCumulativeSemantics =
        stateClass === 'total_increasing' ||
        stateClass === 'total' ||
        deviceClass === 'energy' ||
        isEnergyUnit(unit)

      if (!hasCumulativeSemantics) {
        return false
      }

      return (
        isEnergyUnit(entity.unit_of_measurement) ||
        String(entity.device_class || '').toLowerCase() === 'energy' ||
        includesAny(searchable, ['energy', 'production', 'export', 'injection', 'kwh'])
      )
    })
    .map((entity) => {
      const searchable = toSearchable(entity)
      const stateClass = String(entity.state_class || '').toLowerCase()
      const deviceClass = String(entity.device_class || '').toLowerCase()
      const flags = getEntitySearchFlags(searchable)
      const isPhaseLike = includesAny(searchable, ['l1', 'l2', 'l3', 'phase', 'fase'])
      let score = 0

      if (deviceClass === 'energy') score += 5
      if (stateClass === 'total_increasing') score += 5
      if (stateClass === 'total') score += 4
      if (includesAny(searchable, ['production', 'producer', 'solar', 'pv', 'yield', 'opwek', 'opgewekt'])) score += 6
      if (includesAny(searchable, ['export', 'injection', 'teruglever'])) score += 5
      if (flags.isAggregateLike) score += 3
      if (isEnergyUnit(entity.unit_of_measurement)) score += 2
      if (flags.isDailyLike || flags.isMonthlyLike) score -= 8
      if (flags.isTariffLike) score -= 1
      if (isPhaseLike) score -= 1

      const rawState = parseNumericValue(entity.state)
      const currentValueKwh = convertEnergyToKwh(rawState, entity.unit_of_measurement)

      return {
        entity,
        score,
        stateClass,
        isPhaseLike,
        currentValueKwh,
        ...flags,
      }
    })
    .filter((candidate) => !candidate.isDailyLike && !candidate.isMonthlyLike)
    .sort((a, b) => b.score - a.score)

  return candidates
}

const convertEnergyToKwh = (value, unit) => {
  if (!Number.isFinite(value)) {
    return NaN
  }

  const normalized = String(unit || '').trim().toLowerCase()
  if (normalized === 'wh') {
    return value / 1000
  }
  if (normalized === 'mwh') {
    return value * 1000
  }
  return value
}

const convertGasToM3 = (value, unit) => {
  if (!Number.isFinite(value)) {
    return NaN
  }

  const normalized = String(unit || '').trim().toLowerCase()
  if (normalized === 'l' || normalized === 'liter' || normalized === 'liters') {
    return value / 1000
  }
  return value
}

const pickTotalGasEntity = (entities) => {
  const normalizedMap = new Map(
    entities.map((entity) => [String(entity.entity_id || '').trim().toLowerCase(), entity]),
  )

  const explicitMatchId = GAS_TOTAL_ENTITY_ID_CANDIDATES.find((candidateId) => normalizedMap.has(candidateId))
  if (explicitMatchId) {
    return normalizedMap.get(explicitMatchId)
  }

  const candidates = entities
    .filter((entity) => {
      if (entity.domain !== 'sensor') {
        return false
      }

      const searchable = toSearchable(entity)
      if (!searchable.includes('gas')) {
        return false
      }

      if (includesAny(searchable, ['price', 'cost', 'tariff', 'tarif', 'tarief', 'flow', 'rate'])) {
        return false
      }

      const numericState = Number.isFinite(parseNumericValue(entity.state))
      if (!numericState) {
        return false
      }

      return (
        isGasUnit(entity.unit_of_measurement) ||
        String(entity.device_class || '').toLowerCase() === 'gas' ||
        includesAny(searchable, ['meter', 'consumption', 'verbruik'])
      )
    })
    .map((entity) => {
      const searchable = toSearchable(entity)
      const stateClass = String(entity.state_class || '').toLowerCase()
      const deviceClass = String(entity.device_class || '').toLowerCase()
      const isDailyLike = includesAny(searchable, ['today', 'daily', 'day', 'vandaag', 'dag'])
      const isMonthlyLike = includesAny(searchable, ['month', 'monthly', 'maand'])
      let score = 0

      if (deviceClass === 'gas') score += 5
      if (stateClass === 'total_increasing') score += 5
      if (stateClass === 'total') score += 4
      if (includesAny(searchable, ['meter', 'consumption', 'gas_meter', 'verbruik'])) score += 3
      if (isGasUnit(entity.unit_of_measurement)) score += 2
      if (isDailyLike || isMonthlyLike) score -= 8

      const rawState = parseNumericValue(entity.state)
      const currentValueM3 = convertGasToM3(rawState, entity.unit_of_measurement)

      return { entity, score, isDailyLike, isMonthlyLike, currentValueM3 }
    })
    .sort((a, b) => b.score - a.score)

  const preferred = candidates.find((candidate) => !candidate.isDailyLike && !candidate.isMonthlyLike)
  return preferred?.entity || candidates[0]?.entity || null
}

const fetchEntityHistorySeries = async (baseUrl, token, entity, startIso, endIso) => {
  const entityId = entity?.entity_id
  if (!entityId) {
    return []
  }

  const historyUrl = new URL(baseUrl)
  historyUrl.pathname = `/api/history/period/${startIso}`
  historyUrl.searchParams.append('filter_entity_id', entityId)
  historyUrl.searchParams.append('end_time', endIso)

  const response = await fetch(historyUrl.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    console.warn('[HA-ENTITIES] History fetch failed for', entityId, 'status:', response.status)
    return []
  }

  const payload = await response.json()
  const historyEntries = Array.isArray(payload)
    ? payload.find((entry) => Array.isArray(entry) && entry[0]?.entity_id === entityId) || payload[0] || []
    : []

  return (Array.isArray(historyEntries) ? historyEntries : [])
    .map((state) => {
      const timestamp = new Date(state?.last_changed || state?.last_updated).getTime()
      const rawValue = parseNumericValue(state?.state)
      const value = entity?.kind === 'gas'
        ? convertGasToM3(rawValue, entity?.unit_of_measurement)
        : convertEnergyToKwh(rawValue, entity?.unit_of_measurement)
      if (!Number.isFinite(timestamp) || !Number.isFinite(value)) {
        return null
      }
      return { timestamp, value }
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp)
}

const getSeriesValueAtTime = (series, targetTimestamp) => {
  if (!Array.isArray(series) || series.length === 0) {
    return null
  }

  let before = null
  for (const point of series) {
    if (point.timestamp <= targetTimestamp) {
      before = point
      continue
    }

    if (before) {
      return before.value
    }

    return point.value
  }

  return before ? before.value : null
}

const deriveDailyMonthlyDeltas = (series, latestValueOverride = null, nowTimestampOverride = null) => {
  if (!Array.isArray(series) || series.length === 0) {
    return { daily: null, monthly: null }
  }

  const seriesLatest = series[series.length - 1]
  const effectiveTimestamp = Number.isFinite(nowTimestampOverride)
    ? nowTimestampOverride
    : seriesLatest?.timestamp
  const effectiveValue = Number.isFinite(latestValueOverride)
    ? latestValueOverride
    : seriesLatest?.value

  const latest = {
    timestamp: effectiveTimestamp,
    value: effectiveValue,
  }

  if (!latest || !Number.isFinite(latest.value)) {
    return { daily: null, monthly: null }
  }

  const nowDate = new Date(latest.timestamp)
  const dayStart = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
    0,
    0,
    0,
    0,
  ).getTime()
  const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1, 0, 0, 0, 0).getTime()

  const dayStartValue = getSeriesValueAtTime(series, dayStart)
  const monthStartValue = getSeriesValueAtTime(series, monthStart)

  const daily = Number.isFinite(dayStartValue)
    ? Math.max(0, latest.value - dayStartValue)
    : null

  const monthly = Number.isFinite(monthStartValue)
    ? Math.max(0, latest.value - monthStartValue)
    : null

  return {
    daily: Number.isFinite(daily) ? Number(daily.toFixed(3)) : null,
    monthly: Number.isFinite(monthly) ? Number(monthly.toFixed(3)) : null,
  }
}

const enrichMetricsWithHistoryFallback = async ({
  metrics,
  entities,
  baseUrl,
  token,
  environmentId,
  storedSources,
}) => {
  if (!metrics || !Array.isArray(entities) || entities.length === 0) {
    return metrics
  }

  const needsElectricityFallback =
    metrics.dailyElectricityKwh === null || metrics.monthlyElectricityKwh === null
  const needsProductionFallback =
    metrics.dailyProductionKwh === null || metrics.monthlyProductionKwh === null
  const needsGasFallback =
    metrics.dailyGasM3 === null || metrics.monthlyGasM3 === null

  // Source of truth for electricity day/month should come from the cumulative
  // net meter history to align with HA Energy dashboard totals.
  const shouldDeriveElectricityFromTotalHistory = true
  const shouldDeriveProductionFromTotalHistory = true
  const shouldDeriveGasFromTotalHistory = true

  if (
    !shouldDeriveElectricityFromTotalHistory &&
    !shouldDeriveProductionFromTotalHistory &&
    !shouldDeriveGasFromTotalHistory &&
    !needsElectricityFallback &&
    !needsProductionFallback &&
    !needsGasFallback
  ) {
    return metrics
  }

  const cacheKey = `v2:${String(environmentId || 'default')}`
  const nowMs = Date.now()
  const cached = metricsHistoryCache.get(cacheKey)
  if (cached && nowMs < cached.expiresAt) {
    return {
      ...metrics,
      dailyElectricityKwh:
        shouldDeriveElectricityFromTotalHistory
          ? cached.values.dailyElectricityKwh ?? metrics.dailyElectricityKwh ?? null
          : metrics.dailyElectricityKwh ?? cached.values.dailyElectricityKwh ?? null,
      monthlyElectricityKwh:
        shouldDeriveElectricityFromTotalHistory
          ? cached.values.monthlyElectricityKwh ?? metrics.monthlyElectricityKwh ?? null
          : metrics.monthlyElectricityKwh ?? cached.values.monthlyElectricityKwh ?? null,
      dailyProductionKwh:
        shouldDeriveProductionFromTotalHistory
          ? cached.values.dailyProductionKwh ?? metrics.dailyProductionKwh ?? null
          : metrics.dailyProductionKwh ?? cached.values.dailyProductionKwh ?? null,
      monthlyProductionKwh:
        shouldDeriveProductionFromTotalHistory
          ? cached.values.monthlyProductionKwh ?? metrics.monthlyProductionKwh ?? null
          : metrics.monthlyProductionKwh ?? cached.values.monthlyProductionKwh ?? null,
      dailyGasM3:
        shouldDeriveGasFromTotalHistory
          ? cached.values.dailyGasM3 ?? metrics.dailyGasM3 ?? null
          : metrics.dailyGasM3 ?? cached.values.dailyGasM3 ?? null,
      monthlyGasM3:
        shouldDeriveGasFromTotalHistory
          ? cached.values.monthlyGasM3 ?? metrics.monthlyGasM3 ?? null
          : metrics.monthlyGasM3 ?? cached.values.monthlyGasM3 ?? null,
      sources: {
        ...metrics.sources,
        ...cached.sources,
      },
    }
  }

  const nowIso = new Date(nowMs).toISOString()
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1, 0, 0, 0, 0)
  const startIso = monthStart.toISOString()

  const fallbackValues = {
    dailyElectricityKwh: null,
    monthlyElectricityKwh: null,
    dailyProductionKwh: null,
    monthlyProductionKwh: null,
    dailyGasM3: null,
    monthlyGasM3: null,
  }

  const fallbackSources = {}

  if (shouldDeriveElectricityFromTotalHistory || needsElectricityFallback) {
    // Use stored consumption entity IDs from sensor detection (Fix A) if available,
    // otherwise fall back to auto-detection via pickTotalElectricityCandidates.
    const storedConsumptionIds = Array.isArray(storedSources?.electricityConsumptionEntityIds) &&
      storedSources.electricityConsumptionEntityIds.length > 0
      ? storedSources.electricityConsumptionEntityIds
      : null

    let selectedCandidates = []

    if (storedConsumptionIds) {
      // Use the pre-detected entity IDs directly — build minimal candidate objects
      const entityById = new Map(entities.map((e) => [e.entity_id, e]))
      selectedCandidates = storedConsumptionIds
        .map((id) => {
          const entity = entityById.get(id)
          if (!entity) return null
          const rawState = parseNumericValue(entity.state)
          const currentValueKwh = convertEnergyToKwh(rawState, entity.unit_of_measurement)
          return { entity, currentValueKwh }
        })
        .filter(Boolean)
      console.log('[HA-ENTITIES] Using stored consumption entity IDs:', storedConsumptionIds)
    } else {
      const electricityCandidates = pickTotalElectricityCandidates(entities)

      if (electricityCandidates.length > 0) {
        const aggregateCandidates = electricityCandidates.filter(
          (candidate) => candidate.isAggregateLike && !candidate.isTariffLike && !candidate.isPhaseLike,
        )

        const strongestAggregate = aggregateCandidates
          .filter((candidate) => Number.isFinite(candidate.currentValueKwh))
          .sort((a, b) => {
            if (b.score !== a.score) {
              return b.score - a.score
            }
            return b.currentValueKwh - a.currentValueKwh
          })[0]

        const phaseCandidates = electricityCandidates.filter((candidate) => candidate.isPhaseLike)
        const tariffCandidates = electricityCandidates.filter((candidate) => candidate.isTariffLike)

        const hasTrustedAggregate = Boolean(
          strongestAggregate &&
          (strongestAggregate.stateClass === 'total_increasing' || strongestAggregate.stateClass === 'total'),
        )

        selectedCandidates = tariffCandidates.length >= 2
          ? tariffCandidates.slice(0, 4)
          : hasTrustedAggregate
            ? [strongestAggregate]
            : phaseCandidates.length >= 2
              ? phaseCandidates.slice(0, 3)
              : (() => {
                  const highestValueCandidate = electricityCandidates
                    .filter((candidate) => Number.isFinite(candidate.currentValueKwh))
                    .sort((a, b) => b.currentValueKwh - a.currentValueKwh)[0]
                  return [highestValueCandidate || electricityCandidates[0]]
                })()
      }
    }

    if (selectedCandidates.length > 0) {
      let dailySum = 0
      let monthlySum = 0
      let hasDaily = false
      let hasMonthly = false
      const usedEntityIds = []

      for (const candidate of selectedCandidates) {
        const sourceEntity = {
          ...candidate.entity,
          kind: 'energy',
        }

        const electricitySeries = await fetchEntityHistorySeries(
          baseUrl,
          token,
          sourceEntity,
          startIso,
          nowIso,
        )
        const liveValue = Number.isFinite(candidate.currentValueKwh) ? candidate.currentValueKwh : null
        const deltas = deriveDailyMonthlyDeltas(electricitySeries, liveValue, nowMs)

        if (deltas.daily !== null) {
          dailySum += deltas.daily
          hasDaily = true
        }
        if (deltas.monthly !== null) {
          monthlySum += deltas.monthly
          hasMonthly = true
        }

        usedEntityIds.push(candidate.entity.entity_id)
      }

      fallbackValues.dailyElectricityKwh = hasDaily ? Number(dailySum.toFixed(3)) : null
      fallbackValues.monthlyElectricityKwh = hasMonthly ? Number(monthlySum.toFixed(3)) : null
      fallbackSources.electricityTotalEntityIds = usedEntityIds
      fallbackSources.electricityTotalEntityId = usedEntityIds[0] || null
      // Also expose as electricityConsumptionEntityIds so Dashboard.tsx can use them for chart fetch
      fallbackSources.electricityConsumptionEntityIds = usedEntityIds

      console.log(
        '[HA-ENTITIES] Electricity fallback derived from:',
        usedEntityIds,
        'daily:',
        fallbackValues.dailyElectricityKwh,
        'monthly:',
        fallbackValues.monthlyElectricityKwh,
      )
    }
  }

  // ALWAYS ensure electricityTotalEntityIds and electricityConsumptionEntityIds are set
  // so the electricity usage statistics chart can fetch kWh data.
  if (!fallbackSources.electricityTotalEntityIds || fallbackSources.electricityTotalEntityIds.length === 0) {
    const storedConsumptionIds = Array.isArray(storedSources?.electricityConsumptionEntityIds) &&
      storedSources.electricityConsumptionEntityIds.length > 0
      ? storedSources.electricityConsumptionEntityIds
      : null

    if (storedConsumptionIds) {
      fallbackSources.electricityTotalEntityIds = storedConsumptionIds
      fallbackSources.electricityTotalEntityId = storedConsumptionIds[0]
      fallbackSources.electricityConsumptionEntityIds = storedConsumptionIds
    } else {
      const candidates = pickTotalElectricityCandidates(entities)
      const cumulativeCandidates = candidates.filter(
        (c) => c.stateClass === 'total_increasing' || c.stateClass === 'total' || String(c.entity?.device_class || '').toLowerCase() === 'energy',
      )
      const chosen = (cumulativeCandidates.length > 0 ? cumulativeCandidates : candidates).slice(0, 4)
      if (chosen.length > 0) {
        const ids = chosen.map((c) => c.entity.entity_id)
        fallbackSources.electricityTotalEntityIds = ids
        if (!fallbackSources.electricityTotalEntityId) {
          fallbackSources.electricityTotalEntityId = ids[0]
        }
        fallbackSources.electricityConsumptionEntityIds = ids
        console.log('[HA-ENTITIES] Computed electricityTotalEntityIds (always-set):', ids)
      }
    }
  }

  if (shouldDeriveProductionFromTotalHistory || needsProductionFallback) {
    const productionCandidates = pickTotalElectricityProductionCandidates(entities)

    if (productionCandidates.length > 0) {
      const aggregateCandidates = productionCandidates.filter(
        (candidate) => candidate.isAggregateLike && !candidate.isTariffLike && !candidate.isPhaseLike,
      )

      const strongestAggregate = aggregateCandidates
        .filter((candidate) => Number.isFinite(candidate.currentValueKwh))
        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score
          }
          return b.currentValueKwh - a.currentValueKwh
        })[0]

      const phaseCandidates = productionCandidates.filter((candidate) => candidate.isPhaseLike)
      const hasTrustedAggregate = Boolean(
        strongestAggregate &&
        (strongestAggregate.stateClass === 'total_increasing' || strongestAggregate.stateClass === 'total'),
      )

      const selectedCandidates = hasTrustedAggregate
        ? [strongestAggregate]
        : phaseCandidates.length >= 2
          ? phaseCandidates.slice(0, 3)
          : [productionCandidates[0]]

      let dailySum = 0
      let monthlySum = 0
      let hasDaily = false
      let hasMonthly = false
      const usedEntityIds = []

      for (const candidate of selectedCandidates) {
        const sourceEntity = {
          ...candidate.entity,
          kind: 'energy',
        }

        const productionSeries = await fetchEntityHistorySeries(
          baseUrl,
          token,
          sourceEntity,
          startIso,
          nowIso,
        )
        const liveValue = Number.isFinite(candidate.currentValueKwh) ? candidate.currentValueKwh : null
        const deltas = deriveDailyMonthlyDeltas(productionSeries, liveValue, nowMs)

        if (deltas.daily !== null) {
          dailySum += deltas.daily
          hasDaily = true
        }
        if (deltas.monthly !== null) {
          monthlySum += deltas.monthly
          hasMonthly = true
        }

        usedEntityIds.push(candidate.entity.entity_id)
      }

      fallbackValues.dailyProductionKwh = hasDaily ? Number(dailySum.toFixed(3)) : null
      fallbackValues.monthlyProductionKwh = hasMonthly ? Number(monthlySum.toFixed(3)) : null
      fallbackSources.electricityProductionTotalEntityIds = usedEntityIds
      fallbackSources.electricityProductionTotalEntityId = usedEntityIds[0] || null
      // Also expose as electricityProductionEntityIds so Dashboard.tsx can use them for chart fetch
      fallbackSources.electricityProductionEntityIds = usedEntityIds

      console.log(
        '[HA-ENTITIES] Production fallback derived from:',
        usedEntityIds,
        'daily:',
        fallbackValues.dailyProductionKwh,
        'monthly:',
        fallbackValues.monthlyProductionKwh,
      )
    }
  }

  if (shouldDeriveGasFromTotalHistory || needsGasFallback) {
    const gasTotalEntity = pickTotalGasEntity(entities)
    if (gasTotalEntity?.entity_id) {
      console.log('[HA-ENTITIES] Selected gas total entity:', gasTotalEntity.entity_id)
      const gasSeries = await fetchEntityHistorySeries(
        baseUrl,
        token,
        { ...gasTotalEntity, kind: 'gas' },
        startIso,
        nowIso,
      )
      const liveGasValue = convertGasToM3(parseNumericValue(gasTotalEntity.state), gasTotalEntity.unit_of_measurement)
      const deltas = deriveDailyMonthlyDeltas(gasSeries, liveGasValue, nowMs)
      fallbackValues.dailyGasM3 = deltas.daily
      fallbackValues.monthlyGasM3 = deltas.monthly
      fallbackSources.gasTotalEntityId = gasTotalEntity.entity_id

      console.log(
        '[HA-ENTITIES] Gas fallback derived from:',
        gasTotalEntity.entity_id,
        'daily:',
        fallbackValues.dailyGasM3,
        'monthly:',
        fallbackValues.monthlyGasM3,
      )
    }
  }

  metricsHistoryCache.set(cacheKey, {
    expiresAt: nowMs + 30_000,
    values: fallbackValues,
    sources: fallbackSources,
  })

  return {
    ...metrics,
    dailyElectricityKwh:
      shouldDeriveElectricityFromTotalHistory
        ? fallbackValues.dailyElectricityKwh ?? metrics.dailyElectricityKwh ?? null
        : metrics.dailyElectricityKwh ?? fallbackValues.dailyElectricityKwh ?? null,
    monthlyElectricityKwh:
      shouldDeriveElectricityFromTotalHistory
        ? fallbackValues.monthlyElectricityKwh ?? metrics.monthlyElectricityKwh ?? null
        : metrics.monthlyElectricityKwh ?? fallbackValues.monthlyElectricityKwh ?? null,
    dailyProductionKwh:
      shouldDeriveProductionFromTotalHistory
        ? fallbackValues.dailyProductionKwh ?? metrics.dailyProductionKwh ?? null
        : metrics.dailyProductionKwh ?? fallbackValues.dailyProductionKwh ?? null,
    monthlyProductionKwh:
      shouldDeriveProductionFromTotalHistory
        ? fallbackValues.monthlyProductionKwh ?? metrics.monthlyProductionKwh ?? null
        : metrics.monthlyProductionKwh ?? fallbackValues.monthlyProductionKwh ?? null,
    dailyGasM3:
      shouldDeriveGasFromTotalHistory
        ? fallbackValues.dailyGasM3 ?? metrics.dailyGasM3 ?? null
        : metrics.dailyGasM3 ?? fallbackValues.dailyGasM3 ?? null,
    monthlyGasM3:
      shouldDeriveGasFromTotalHistory
        ? fallbackValues.monthlyGasM3 ?? metrics.monthlyGasM3 ?? null
        : metrics.monthlyGasM3 ?? fallbackValues.monthlyGasM3 ?? null,
    sources: {
      ...metrics.sources,
      ...fallbackSources,
    },
  }
}

const getHaConfig = (metadata, environmentId) => {
  const envMap = getStoredEnvironmentMap(metadata)
  const envConfig = envMap[environmentId]

  if (envConfig) {
    if (envConfig.type && envConfig.type !== 'home_assistant') {
      throw new Error('Environment is not Home Assistant')
    }

    const config = envConfig.config || {}
    const baseUrl = config.base_url || config.baseUrl || envConfig.base_url || envConfig.url
    const token = config.api_key || config.apiKey || envConfig.token
    if (baseUrl && token) {
      return { baseUrl, token }
    }
  }

  const legacyMap = parseEnvironmentMap(metadata.ha_environments)
  const legacy = legacyMap[environmentId]
  if (legacy) {
    const baseUrl = legacy.base_url || legacy.url
    const token = legacy.token
    if (baseUrl && token) {
      return { baseUrl, token }
    }
  }

  const fallback = HA_ENVIRONMENTS[environmentId]
  if (!fallback) {
    throw new Error('Unknown environment')
  }

  return {
    baseUrl: getEnv(fallback.urlEnv),
    token: getEnv(fallback.tokenEnv),
  }
}

const getEmailFromPayload = (payload) => {
  const emailValue = payload.email || payload['https://brouwer-ems/email'] || payload['email']
  return typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
}

const getUserInfoEmail = async (domain, token) => {
  const response = await fetch(`https://${domain}/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    return ''
  }

  const data = await response.json()
  return typeof data.email === 'string' ? data.email.toLowerCase() : ''
}

const getUserEmailFromManagement = async (domain, token, userId) => {
  try {
    const response = await fetch(
      `https://${domain}/api/v2/users/${encodeURIComponent(userId)}?fields=email&include_fields=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    )

    if (!response.ok) {
      console.log('[HA-ENTITIES] Failed to fetch user email from management, status:', response.status)
      return ''
    }

    const data = await response.json()
    return typeof data.email === 'string' ? data.email.toLowerCase() : ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log('[HA-ENTITIES] Error fetching user email from management:', message)
    return ''
  }
}

const getOwnerEmail = () => (process.env.OWNER_EMAIL || '').trim().toLowerCase()

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

const getForceEmail = () => (process.env.ADMIN_FORCE_EMAIL || '').trim().toLowerCase()

const isEmailAllowed = (email, allowlist, forceEmail) => {
  if (!email) return false
  if (forceEmail && email === forceEmail) return true
  return allowlist.includes(email)
}

const verifyAuth = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing token')
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')

  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })

  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()
  const ownerEmail = getOwnerEmail()
  const debugMode = (process.env.DEBUG_ADMIN || '').toLowerCase() === 'true'
  const debug = []

  let resolvedEmail = getEmailFromPayload(payload)
  if (resolvedEmail) {
    debug.push({ source: 'id_token', email: resolvedEmail })
  }

  if (!resolvedEmail) {
    const emailFromUserInfo = await getUserInfoEmail(domain, token)
    if (emailFromUserInfo) {
      resolvedEmail = emailFromUserInfo
      debug.push({ source: 'userinfo', email: emailFromUserInfo })
    }
  }

  if (!resolvedEmail) {
    try {
      const managementToken = await getManagementToken(domain)
      const emailFromManagement = await getUserEmailFromManagement(domain, managementToken, payload.sub)
      if (emailFromManagement) {
        resolvedEmail = emailFromManagement
        debug.push({ source: 'management', email: emailFromManagement })
      }
    } catch (error) {
      if (debugMode) {
        debug.push({ result: 'management_fetch_failed', message: error?.message })
      }
    }
  }

  const isAdmin = (ownerEmail && resolvedEmail === ownerEmail) || isEmailAllowed(resolvedEmail, allowlist, forceEmail)

  if (debugMode) {
    debug.push({
      result: isAdmin ? 'allowed_by_email_allowlist' : 'denied',
      resolvedEmail,
      allowlist,
      forceEmail,
    })
  }

  return {
    payload,
    isAdmin,
    resolvedEmail,
    debug: debugMode ? debug : undefined,
  }
}

export const handler = async (event) => {
  console.log('ha-entities handler started - REAL DATA MODE');
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const environmentId = event.queryStringParameters?.environmentId
    if (!environmentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId' }) }
    }

    const { isAdmin, payload, resolvedEmail } = await verifyAuth(event)
    console.log('[HA-ENTITIES] Auth resolved. isAdmin:', isAdmin, 'email:', resolvedEmail || 'unknown')

    const domain = getEnv('AUTH0_DOMAIN')

    let metadata = {}
    let userMetadata = null
    try {
      const managementToken = await getManagementToken(domain)
      metadata = await getCachedClientMetadata(domain, managementToken)

      // Fetch user's own metadata for user-specific sensor visibility and environment access
      if (payload?.sub) {
        try {
          const userResponse = await fetch(
            `https://${domain}/api/v2/users/${encodeURIComponent(payload.sub)}?fields=app_metadata,user_metadata&include_fields=true`,
            { headers: { Authorization: `Bearer ${managementToken}` } },
          )
          if (userResponse.ok) {
            const userData = await userResponse.json()
            userMetadata = userData.user_metadata || null
            console.log('[HA-ENTITIES] Fetched user metadata, has user_metadata:', !!userMetadata)

            // Non-admin users may only access environments assigned to them
            if (!isAdmin) {
              const allowedEnvIds = Array.isArray(userData.app_metadata?.environmentIds)
                ? userData.app_metadata.environmentIds
                : []
              if (!allowedEnvIds.includes(environmentId)) {
                return { statusCode: 403, body: JSON.stringify({ error: 'Access denied to this environment' }) }
              }
            }
          } else {
            console.log('[HA-ENTITIES] Failed to fetch user metadata, status:', userResponse.status)
            if (!isAdmin) {
              return { statusCode: 403, body: JSON.stringify({ error: 'Unable to verify environment access' }) }
            }
          }
        } catch (userMetadataError) {
          console.warn('Failed to fetch user metadata:', userMetadataError instanceof Error ? userMetadataError.message : userMetadataError)
          if (!isAdmin) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Unable to verify environment access' }) }
          }
        }
      }
    } catch (metadataError) {
      console.warn('ha-entities metadata warning:', metadataError instanceof Error ? metadataError.message : metadataError)
    }

    const { baseUrl, token } = await resolveEnvironmentConfig({
      event,
      metadata,
      environmentId,
      getOptionalEnv,
    })
    
    console.log('Fetching from Home Assistant:', baseUrl);
    const response = await fetch(`${baseUrl}/api/states`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    
    if (!response.ok) {
      const body = await response.text();
      console.error('Failed to fetch Home Assistant state:', response.status, body);
      return { 
        statusCode: 502, 
        body: JSON.stringify({ 
          error: 'Unable to fetch Home Assistant state', 
          status: response.status, 
          details: body 
        }) 
      }
    }
    
    const data = await response.json()
    console.log('Received all entities from HA:', Array.isArray(data) ? data.length : 0);
    
    // Filter to show ALMOST everything EXCEPT update entities and internal stuff
    const blockedDomains = ['update', 'script', 'automation', 'group', 'number', 'input_number', 'input_select', 'input_datetime']
    
    const allEntities = Array.isArray(data)
      ? data
        .filter(entity => {
          const domain = String(entity.entity_id || '').split('.')[0]
          // Block unwanted domains, allow everything else
          return !blockedDomains.includes(domain)
        })
        .map((entity) => ({
          entity_id: entity.entity_id,
          state: entity.state,
          domain: String(entity.entity_id || '').split('.')[0] || 'unknown',
          friendly_name: entity.attributes?.friendly_name || entity.entity_id,
          unit_of_measurement: entity.attributes?.unit_of_measurement,
          device_class: entity.attributes?.device_class,
          state_class: entity.attributes?.state_class,
        }))
      : []

    let metrics = getDashboardMetrics(allEntities)

    // Read stored sensor sources from ha_config (saved by save-ha-environments.js) so that
    // enrichMetricsWithHistoryFallback can use the pre-detected tariff/production entity IDs.
    const storedHaConfig = parseHaConfig(metadata.ha_config)
    const storedEnvSources = storedHaConfig[environmentId]?.sources || null
    if (storedEnvSources) {
      console.log('[HA-ENTITIES] Found stored env sources for', environmentId, ':', JSON.stringify(storedEnvSources))
    }

    metrics = await enrichMetricsWithHistoryFallback({
      metrics,
      entities: allEntities,
      baseUrl,
      token,
      environmentId,
      storedSources: storedEnvSources,
    })
    let entities = allEntities

    if (metrics?.sources) {
      console.log('[HA-ENTITIES] Metrics sources:', metrics.sources)
    }

    if (!isAdmin) {
      // Check for user-specific sensor visibility only
      const userVisibleIds = getUserVisibleEntityIds(userMetadata, environmentId)
      console.log('[HA-ENTITIES] Non-admin user, userVisibleIds:', userVisibleIds ? userVisibleIds.length : 'null')
      
      if (userVisibleIds !== null && userVisibleIds.length > 0) {
        // User has user-specific sensor config - use it
        const allowedSet = new Set(userVisibleIds.map((entityId) => String(entityId)))
        const beforeFilterCount = entities.length
        entities = entities.filter((entity) => allowedSet.has(entity.entity_id))
        console.log('[HA-ENTITIES] Applied user-specific visibility filter:', entities.length, 'of', beforeFilterCount, 'entities')
      } else {
        // No user-specific config OR empty list - hide all entities by default
        const beforeFilterCount = entities.length
        entities = []
        console.log('[HA-ENTITIES] No user-specific sensor config - hiding all entities. Was', beforeFilterCount, 'entities')
      }
    }

    console.log('Filtered to useful entities:', entities.length);

    return {
      statusCode: 200,
      body: JSON.stringify({ entities, metrics }),
    }
  } catch (error) {
    console.error('ha-entities handler error:', error);
    const message = error instanceof Error ? error.message : 'Server error';
    const statusCode = message === 'Missing token' ? 401 : 500
    return {
      statusCode,
      body: JSON.stringify({
        error: message,
        details: 'Check env vars: HA_BROUWER_TEST_URL, HA_BROUWER_TEST_TOKEN'
      }),
    };
  }
}
