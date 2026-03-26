import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  getMergedEnvironments,
  sanitizeEnvironments,
  saveBlobEnvironments,
  stripShardedEnvironmentMetadata,
} from './_environment-storage.js'

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

const managementTokenCache = { token: null, expiresAt: 0 }

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
    throw new Error('Unable to fetch app metadata')
  }

  const client = await response.json()
  return client.client_metadata || {}
}

const updateClientMetadata = async (domain, token, metadata) => {
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_metadata: metadata }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || 'Unable to update app metadata')
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
  if (!userId) {
    return ''
  }

  const response = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(userId)}?fields=email&include_fields=true`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  )

  if (!response.ok) {
    return ''
  }

  const data = await response.json()
  return typeof data.email === 'string' ? data.email.toLowerCase() : ''
}

const getOwnerEmail = () => (process.env.OWNER_EMAIL || '').trim().toLowerCase()

const getAdminAllowlist = () =>
  (process.env.ADMIN_EMAILS || process.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

const getForceEmail = () => (process.env.ADMIN_FORCE_EMAIL || '').trim().toLowerCase()

const isEmailAllowed = (email, allowlist, forceEmail) => {
  if (!email) {
    return false
  }

  if (forceEmail && email === forceEmail) {
    return true
  }

  return allowlist.includes(email)
}

const hasAdminRoleClaim = (payload, rolesClaim) => {
  const rolesValue = payload[rolesClaim]
  const roles = Array.isArray(rolesValue)
    ? rolesValue
    : typeof rolesValue === 'string'
      ? [rolesValue]
      : []
  return roles.includes('admin')
}

const verifyAdmin = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing token')
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const rolesClaim = process.env.AUTH0_ROLES_CLAIM || 'https://brouwer-ems/roles'
  const allowlist = getAdminAllowlist()
  const forceEmail = getForceEmail()
  const ownerEmail = getOwnerEmail()
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })

  const emailFromPayload = getEmailFromPayload(payload)
  if ((ownerEmail && emailFromPayload === ownerEmail) || isEmailAllowed(emailFromPayload, allowlist, forceEmail)) {
    return
  }

  const emailFromUserInfo = emailFromPayload ? '' : await getUserInfoEmail(domain, token)
  if ((ownerEmail && emailFromUserInfo === ownerEmail) || isEmailAllowed(emailFromUserInfo, allowlist, forceEmail)) {
    return
  }

  if (hasAdminRoleClaim(payload, rolesClaim)) {
    return
  }

  try {
    const managementToken = await getManagementToken(domain)
    const emailFromManagement = await getUserEmailFromManagement(domain, managementToken, payload.sub)
    if ((ownerEmail && emailFromManagement === ownerEmail) || isEmailAllowed(emailFromManagement, allowlist, forceEmail)) {
      return
    }
  } catch {
    // Ignore management fallback errors and continue normal deny path.
  }

  throw new Error('Admin only')
}

const normalizeEnvironments = (environments) => {
  if (!Array.isArray(environments)) {
    return []
  }

  return environments
    .map((env) => ({
      id: String(env.id || '').trim(),
      name: String(env.name || '').trim(),
      type: String(env.type || 'home_assistant').trim(),
      config: {
        baseUrl: String(env.config?.baseUrl || env.baseUrl || env.url || '').trim(),
        apiKey: String(env.config?.apiKey || env.apiKey || env.token || '').trim(),
        siteId: String(env.config?.siteId || env.siteId || '').trim(),
        notes: String(env.config?.notes || env.notes || '').trim(),
      },
    }))
    .filter((env) => env.id && env.name)
}

const ENV_METADATA_PREFIX = 'ha_env_v1_'

const encodeEnvironmentId = (environmentId) => {
  const normalized = String(environmentId || '').trim()
  if (!normalized) {
    return ''
  }

  return Buffer.from(normalized, 'utf8').toString('base64url')
}

const decodeEnvironmentId = (encodedId) => {
  try {
    return Buffer.from(String(encodedId || ''), 'base64url').toString('utf8').trim()
  } catch {
    return ''
  }
}

const buildEnvironmentMetadataKey = (environmentId, suffix) => {
  const encodedId = encodeEnvironmentId(environmentId)
  if (!encodedId) {
    return ''
  }

  return `${ENV_METADATA_PREFIX}${encodedId}_${suffix}`
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

const normalizeText = (value) => String(value || '').trim()

const ensureMetadataValueLength = (key, value) => {
  const normalizedValue = normalizeText(value)
  if (normalizedValue.length > 255) {
    throw new Error(`Value for '${key}' exceeds Auth0 metadata limit (255 chars)`)
  }
  return normalizedValue
}

const getEnvironmentFromMetadata = (metadata, environmentId) => {
  const urlKey = buildEnvironmentMetadataKey(environmentId, 'url')
  const tokenKey = buildEnvironmentMetadataKey(environmentId, 'token')

  if (!urlKey || !tokenKey) {
    return null
  }

  const baseUrl = normalizeText(metadata?.[urlKey])
  const apiKey = normalizeText(metadata?.[tokenKey])
  if (!baseUrl || !apiKey) {
    return null
  }

  return {
    baseUrl,
    apiKey,
  }
}

const getShardedEnvironmentsFromMetadata = (metadata = {}) => {
  const urlKeys = Object.keys(metadata || {}).filter(
    (key) => key.startsWith(ENV_METADATA_PREFIX) && key.endsWith('_url'),
  )

  return urlKeys.reduce((acc, urlKey) => {
    const encodedId = urlKey.slice(ENV_METADATA_PREFIX.length, -'_url'.length)
    const environmentId = decodeEnvironmentId(encodedId)
    if (!environmentId) {
      return acc
    }

    const tokenKey = `${ENV_METADATA_PREFIX}${encodedId}_token`
    const nameKey = `${ENV_METADATA_PREFIX}${encodedId}_name`
    const typeKey = `${ENV_METADATA_PREFIX}${encodedId}_type`
    const siteIdKey = `${ENV_METADATA_PREFIX}${encodedId}_site_id`
    const notesKey = `${ENV_METADATA_PREFIX}${encodedId}_notes`

    const baseUrl = normalizeText(metadata[urlKey])
    const apiKey = normalizeText(metadata[tokenKey])
    if (!baseUrl || !apiKey) {
      return acc
    }

    acc.push({
      id: environmentId,
      name: normalizeText(metadata[nameKey]) || environmentId,
      type: normalizeText(metadata[typeKey]) || 'home_assistant',
      config: {
        baseUrl,
        apiKey,
        siteId: normalizeText(metadata[siteIdKey]),
        notes: normalizeText(metadata[notesKey]),
      },
    })

    return acc
  }, [])
}

const toMetadataEnvironmentFields = (environments) => {
  return environments.reduce((acc, env) => {
    const urlKey = buildEnvironmentMetadataKey(env.id, 'url')
    const tokenKey = buildEnvironmentMetadataKey(env.id, 'token')
    const nameKey = buildEnvironmentMetadataKey(env.id, 'name')
    const typeKey = buildEnvironmentMetadataKey(env.id, 'type')
    const siteIdKey = buildEnvironmentMetadataKey(env.id, 'site_id')
    const notesKey = buildEnvironmentMetadataKey(env.id, 'notes')

    if (!urlKey || !tokenKey || !nameKey || !typeKey || !siteIdKey || !notesKey) {
      return acc
    }

    acc[urlKey] = ensureMetadataValueLength(urlKey, env.config.baseUrl)
    acc[tokenKey] = ensureMetadataValueLength(tokenKey, env.config.apiKey)
    acc[nameKey] = ensureMetadataValueLength(nameKey, env.name)
    acc[typeKey] = ensureMetadataValueLength(typeKey, env.type)
    acc[siteIdKey] = ensureMetadataValueLength(siteIdKey, env.config.siteId)
    acc[notesKey] = ensureMetadataValueLength(notesKey, env.config.notes)
    return acc
  }, {})
}

const parseNumericValue = (rawValue) => {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : NaN
  }

  if (rawValue === null || rawValue === undefined) {
    return NaN
  }

  const source = String(rawValue).trim()
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

const includesAny = (value, items) => items.some((item) => value.includes(String(item).toLowerCase()))

const isPowerUnit = (unit) => {
  const normalized = String(unit || '').trim().toLowerCase()
  return (
    normalized === 'w' ||
    normalized === 'kw' ||
    normalized === 'watt' ||
    normalized === 'kilowatt' ||
    normalized === 'va' ||
    normalized === 'kva'
  )
}

const isEnergyUnit = (unit) => {
  const normalized = String(unit || '').trim().toLowerCase()
  return normalized === 'kwh' || normalized === 'wh' || normalized === 'mwh'
}

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

const detectElectricityPeriodEntity = (entities, period) => {
  const isDaily = period === 'daily'
  const periodKeywords = isDaily
    ? ['today', 'daily', 'day', 'vandaag', 'dag']
    : ['month', 'monthly', 'this_month', 'maand']
  const energyContextKeywords = ['electricity', 'energy', 'consumption', 'meter', 'kwh', 'verbruik']
  const preciseKeywords = isDaily
    ? ['energy_today', 'today_energy', 'daily_energy', 'consumption_today', 'verbruik_vandaag']
    : ['energy_month', 'month_energy', 'monthly_energy', 'consumption_month', 'verbruik_maand']
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
      if (includesAny(searchable, ['total', 'main', 'meter', 'consumption'])) score += 2
      if (isEnergyUnit(entity.unit_of_measurement)) score += 2
      if (deviceClass === 'energy') score += 2
      if (stateClass === 'measurement') score += 1
      if (includesAny(searchable, tariffKeywords)) score -= 3

      return { entity, score }
    })
    .sort((a, b) => b.score - a.score)

  return candidates[0]?.entity || null
}

const PRODUCTION_KEYWORDS_DETECT = [
  'production', 'export', 'injection', 'teruglever', 'solar', 'pv', 'yield', 'opwek',
]

const detectEnvironmentSensors = async ({ environmentId, baseUrl, token }) => {
  const normalizedBaseUrl = normalizeText(baseUrl).replace(/\/+$/, '')
  const normalizedToken = normalizeText(token)

  if (!normalizedBaseUrl || !normalizedToken) {
    throw new Error(`Missing Home Assistant credentials for '${environmentId}'`)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)

  let response
  try {
    response = await fetch(`${normalizedBaseUrl}/api/states`, {
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(
      `Home Assistant discovery failed for '${environmentId}' (status ${response.status})${details ? `: ${details.slice(0, 180)}` : ''}`,
    )
  }

  const payload = await response.json()
  const entities = Array.isArray(payload)
    ? payload
      .filter((item) => typeof item?.entity_id === 'string')
      .map((item) => ({
        entity_id: String(item.entity_id),
        state: item.state,
        domain: String(item.entity_id || '').split('.')[0] || 'unknown',
        friendly_name: item.attributes?.friendly_name,
        unit_of_measurement: item.attributes?.unit_of_measurement,
        device_class: item.attributes?.device_class,
        state_class: item.attributes?.state_class,
      }))
    : []

  // --- Electricity consumption sensors (all tariff sensors) ---
  // Find ALL entities that are cumulative energy sensors (kWh) for consumption (not production)
  const electricityConsumptionEntities = entities
    .filter((entity) => {
      if (entity.domain !== 'sensor') return false
      const stateClass = String(entity.state_class || '').toLowerCase()
      if (stateClass !== 'total_increasing' && stateClass !== 'total') return false
      const deviceClass = String(entity.device_class || '').toLowerCase()
      if (deviceClass !== 'energy') return false
      const unit = String(entity.unit_of_measurement || '').trim().toLowerCase()
      if (unit !== 'kwh') return false
      const searchable = toSearchable(entity)
      if (includesAny(searchable, PRODUCTION_KEYWORDS_DETECT)) return false
      const entityId = entity.entity_id.toLowerCase()
      if (includesAny(entityId, ['gas', 'price', 'cost', 'tariff_name'])) return false
      if (!Number.isFinite(parseNumericValue(entity.state))) return false
      return true
    })
    .sort((a, b) => (parseNumericValue(b.state) || 0) - (parseNumericValue(a.state) || 0))

  const electricityConsumptionEntityIds = electricityConsumptionEntities.map((e) => e.entity_id)
  const electricityTotalEntityId = electricityConsumptionEntityIds[0] || null

  // --- Electricity production sensors (return feed / teruglevering) ---
  const electricityProductionEntities = entities
    .filter((entity) => {
      if (entity.domain !== 'sensor') return false
      const stateClass = String(entity.state_class || '').toLowerCase()
      if (stateClass !== 'total_increasing' && stateClass !== 'total') return false
      const deviceClass = String(entity.device_class || '').toLowerCase()
      if (deviceClass !== 'energy') return false
      const unit = String(entity.unit_of_measurement || '').trim().toLowerCase()
      if (unit !== 'kwh') return false
      const searchable = toSearchable(entity)
      if (!includesAny(searchable, PRODUCTION_KEYWORDS_DETECT)) return false
      if (!Number.isFinite(parseNumericValue(entity.state))) return false
      return true
    })

  const electricityProductionEntityIds = electricityProductionEntities.map((e) => e.entity_id)

  // --- Power consumption sensor (live instantaneous value) ---
  const POWER_CONSUMPTION_PRIORITY = ['power_consumption', 'active_power', 'actueel_vermogen']
  const powerConsumptionEntity =
    entities.find((entity) => {
      if (entity.domain !== 'sensor') return false
      const deviceClass = String(entity.device_class || '').toLowerCase()
      if (deviceClass !== 'power') return false
      const stateClass = String(entity.state_class || '').toLowerCase()
      if (stateClass === 'total_increasing' || stateClass === 'total') return false
      const searchable = toSearchable(entity)
      if (includesAny(searchable, ['production', 'solar', 'pv', 'export'])) return false
      if (!Number.isFinite(parseNumericValue(entity.state))) return false
      // Prefer entities with priority keywords in entity_id
      return POWER_CONSUMPTION_PRIORITY.some((kw) => entity.entity_id.toLowerCase().includes(kw))
    }) ||
    entities.find((entity) => {
      if (entity.domain !== 'sensor') return false
      const deviceClass = String(entity.device_class || '').toLowerCase()
      if (deviceClass !== 'power') return false
      const stateClass = String(entity.state_class || '').toLowerCase()
      if (stateClass === 'total_increasing' || stateClass === 'total') return false
      const searchable = toSearchable(entity)
      if (includesAny(searchable, ['production', 'solar', 'pv', 'export'])) return false
      return Number.isFinite(parseNumericValue(entity.state))
    }) ||
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
      ['today', 'daily', 'month', 'monthly', 'total', 'kwh', 'energy', 'gas', 'price', 'cost', 'tariff',
        'production', 'solar', 'pv', 'export'],
    ) ||
    entities.find((entity) => (
      entity.domain === 'sensor' &&
      isPowerUnit(entity.unit_of_measurement) &&
      Number.isFinite(parseNumericValue(entity.state))
    ))

  const powerConsumptionEntityId = powerConsumptionEntity?.entity_id || null

  // --- Gas total sensor (cumulative meter) ---
  const GAS_TOTAL_CANDIDATES = [
    'sensor.gas_meter_gas_consumption',
    'sensor.gas_meter_gasverbruik',
    'sensor.gas_total',
    'sensor.gas_consumption_total',
  ]
  const entityById = new Map(entities.map((e) => [e.entity_id.toLowerCase(), e]))
  const gasTotalEntity =
    GAS_TOTAL_CANDIDATES.map((id) => entityById.get(id)).find(Boolean) ||
    entities
      .filter((entity) => {
        if (entity.domain !== 'sensor') return false
        const searchable = toSearchable(entity)
        if (!searchable.includes('gas')) return false
        const stateClass = String(entity.state_class || '').toLowerCase()
        const deviceClass = String(entity.device_class || '').toLowerCase()
        const unit = String(entity.unit_of_measurement || '').trim().toLowerCase()
        const isDailyLike = includesAny(searchable, ['today', 'daily', 'day', 'vandaag', 'dag'])
        const isMonthlyLike = includesAny(searchable, ['month', 'monthly', 'maand'])
        if (isDailyLike || isMonthlyLike) return false
        if (includesAny(searchable, ['price', 'cost', 'tariff', 'flow', 'rate'])) return false
        if (!Number.isFinite(parseNumericValue(entity.state))) return false
        return (
          stateClass === 'total_increasing' ||
          stateClass === 'total' ||
          deviceClass === 'gas' ||
          unit === 'm3' || unit === 'm³' || unit === 'ft³'
        )
      })
      .sort((a, b) => {
        const scoreOf = (e) => {
          let s = 0
          const sc = String(e.state_class || '').toLowerCase()
          const dc = String(e.device_class || '').toLowerCase()
          if (sc === 'total_increasing') s += 5
          if (sc === 'total') s += 4
          if (dc === 'gas') s += 5
          return s
        }
        return scoreOf(b) - scoreOf(a)
      })[0] || null

  const gasTotalEntityId = gasTotalEntity?.entity_id || null

  const visibleEntityIds = Array.from(new Set([
    ...electricityConsumptionEntityIds,
    ...electricityProductionEntityIds,
    powerConsumptionEntityId,
    gasTotalEntityId,
  ].filter(Boolean)))

  console.log(
    '[sensor-detection] environment=' + environmentId +
    ' consumption=' + JSON.stringify(electricityConsumptionEntityIds) +
    ' production=' + JSON.stringify(electricityProductionEntityIds) +
    ' power=' + powerConsumptionEntityId +
    ' gas=' + gasTotalEntityId,
  )

  return {
    entityCount: entities.length,
    visibleEntityIds,
    sources: {
      electricityConsumptionEntityIds,
      electricityTotalEntityId,
      electricityProductionEntityIds,
      powerConsumptionEntityId,
      gasTotalEntityId,
    },
  }
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    await verifyAdmin(event)

    const body = JSON.parse(event.body || '{}')
    const incomingEnvironments = normalizeEnvironments(body.environments)

    if (incomingEnvironments.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No environments provided' }) }
    }

    const domain = getEnv('AUTH0_DOMAIN')
    const managementToken = await getManagementToken(domain)
    const metadata = await getClientMetadata(domain, managementToken)
    const currentHaConfig = parseHaConfig(metadata.ha_config)

    // Non-destructive merge: incoming environments overwrite same IDs, others remain untouched.
    const { environments: existingEnvironments } = await getMergedEnvironments({
      event,
      metadata,
      getOptionalEnv,
    })
    const existingById = new Map(
      existingEnvironments.map((env) => [normalizeText(env.id).toLowerCase(), env]),
    )

    const mergedById = new Map(existingEnvironments.map((env) => [env.id, env]))
    for (const env of incomingEnvironments) {
      mergedById.set(env.id, env)
    }
    const mergedEnvironments = sanitizeEnvironments(Array.from(mergedById.values()))

    const autoDetectionByEnvironment = new Map()
    for (const env of incomingEnvironments) {
      if (env.type !== 'home_assistant') {
        continue
      }

      const nextBaseUrl = normalizeText(env.config.baseUrl)
      const nextApiKey = normalizeText(env.config.apiKey)
      if (!nextBaseUrl || !nextApiKey) {
        continue
      }

      const previousEnv = existingById.get(normalizeText(env.id).toLowerCase())
      const previousBaseUrl = normalizeText(previousEnv?.config?.baseUrl)
      const previousApiKey = normalizeText(previousEnv?.config?.apiKey)
      const credentialsChanged = previousBaseUrl !== nextBaseUrl || previousApiKey !== nextApiKey

      const previousEnvConfig = parseHaConfig(currentHaConfig[env.id])
      const previousVisibleEntityIds = Array.isArray(previousEnvConfig.visible_entity_ids)
        ? previousEnvConfig.visible_entity_ids
        : []

      const previousSources = previousEnvConfig?.sources || {}
      const hasConsumptionSourceList = Array.isArray(previousSources.electricityConsumptionEntityIds)
      const hasProductionSourceList = Array.isArray(previousSources.electricityProductionEntityIds)
      const hasPowerSource = typeof previousSources.powerConsumptionEntityId === 'string' &&
        previousSources.powerConsumptionEntityId.trim().length > 0
      const hasGasSource = typeof previousSources.gasTotalEntityId === 'string' &&
        previousSources.gasTotalEntityId.trim().length > 0
      const hasNewSourceShape = hasConsumptionSourceList && hasProductionSourceList && hasPowerSource && hasGasSource

      const shouldDetect = credentialsChanged || previousVisibleEntityIds.length === 0 || !hasNewSourceShape
      if (!shouldDetect) {
        continue
      }

      try {
        const detected = await detectEnvironmentSensors({
          environmentId: env.id,
          baseUrl: nextBaseUrl,
          token: nextApiKey,
        })

        autoDetectionByEnvironment.set(env.id, {
          status: 'ok',
          credentialsChanged,
          ...detected,
        })
      } catch (detectError) {
        autoDetectionByEnvironment.set(env.id, {
          status: 'error',
          credentialsChanged,
          error: detectError instanceof Error ? detectError.message : 'Sensor auto-detection failed',
        })
      }
    }

    await saveBlobEnvironments(event, mergedEnvironments)

    // Persist detected sensor sources into ha_config so ha-entities.js can use them
    for (const [envId, detectionResult] of autoDetectionByEnvironment.entries()) {
      if (detectionResult.status === 'ok') {
        currentHaConfig[envId] = {
          ...(currentHaConfig[envId] || {}),
          visible_entity_ids: detectionResult.visibleEntityIds,
          sources: detectionResult.sources,
        }
      }
    }

    let metadataCleanupWarning = null
    try {
      const serializedHaConfig = JSON.stringify(currentHaConfig)

      const compactClientMetadata = {
        ...stripShardedEnvironmentMetadata(metadata),
        environments: null,
        ha_environments: null,
        ha_config: serializedHaConfig,
      }

      await updateClientMetadata(domain, managementToken, compactClientMetadata)
    } catch (cleanupError) {
      metadataCleanupWarning = cleanupError instanceof Error
        ? cleanupError.message
        : 'Unable to compact Auth0 metadata'
      console.warn('[SAVE-HA-ENVIRONMENTS] Metadata cleanup warning:', metadataCleanupWarning)
    }

    const detectionSummary = Object.fromEntries(
      Array.from(autoDetectionByEnvironment.entries()).map(([environmentId, result]) => [
        environmentId,
        result.status === 'ok'
          ? {
              status: 'ok',
              visibleEntityCount: result.visibleEntityIds.length,
              entityCount: result.entityCount,
            }
          : {
              status: 'error',
              error: result.error,
            },
      ]),
    )

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        environmentsSaved: mergedEnvironments.length,
        incomingSaved: incomingEnvironments.length,
        autoDetection: detectionSummary,
        ...(metadataCleanupWarning ? { warning: metadataCleanupWarning } : {}),
      }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const statusCode = message === 'Admin only' ? 403 : 500
    return {
      statusCode,
      body: JSON.stringify({ error: message }),
    }
  }
}
