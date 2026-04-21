const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')
const ENV_METADATA_PREFIX = 'ha_env_v1_'

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
    const decoded = Buffer.from(String(encodedId || ''), 'base64url').toString('utf8')
    return normalizeText(decoded)
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

    acc[environmentId] = {
      name: normalizeText(metadata[nameKey]) || environmentId,
      type: normalizeText(metadata[typeKey]) || 'home_assistant',
      config: {
        base_url: baseUrl,
        api_key: apiKey,
        site_id: normalizeText(metadata[siteIdKey]),
        notes: normalizeText(metadata[notesKey]),
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

const normalizePricing = (value) => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const numberOrNull = (input) => {
    const parsed = Number(input)
    return Number.isFinite(parsed) ? parsed : null
  }

  const normalized = {
    type: value.type === 'dynamic' ? 'dynamic' : 'fixed',
    consumerPrice: numberOrNull(value.consumerPrice),
    producerPrice: numberOrNull(value.producerPrice),
    consumerMargin: numberOrNull(value.consumerMargin),
    producerMargin: numberOrNull(value.producerMargin),
    updatedAt: normalizeText(value.updatedAt || value.updated_at),
  }

  const hasAnyNumeric = [
    normalized.consumerPrice,
    normalized.producerPrice,
    normalized.consumerMargin,
    normalized.producerMargin,
  ].some((item) => item !== null)

  if (!hasAnyNumeric) {
    return null
  }

  return normalized
}

export const HA_ENVIRONMENTS = {
  vacation: {
    name: 'Brouwer TEST',
    urlEnv: 'HA_BROUWER_TEST_URL',
    tokenEnv: 'HA_BROUWER_TEST_TOKEN',
  },
}

export const getFallbackEnvironments = (getOptionalEnv) => {
  return Object.entries(HA_ENVIRONMENTS)
    .map(([id, env]) => {
      const baseUrl = normalizeText(getOptionalEnv(env.urlEnv))
      const token = normalizeText(getOptionalEnv(env.tokenEnv))
      if (!baseUrl || !token) {
        return null
      }

      return {
        id,
        name: normalizeText(env.name) || id,
        type: 'home_assistant',
        config: {
          baseUrl,
          apiKey: token,
          siteId: '',
          notes: '',
        },
      }
    })
    .filter(Boolean)
}

const mapEnvironmentConfig = (env = {}) => {
  const config = env.config || {}
  const pricing = normalizePricing(
    config.energy_pricing ||
    config.energyPricing ||
    env.energy_pricing ||
    env.energyPricing ||
    env.pricing,
  )

  return {
    baseUrl: normalizeText(config.base_url || config.baseUrl || env.base_url || env.url),
    apiKey: normalizeText(config.api_key || config.apiKey || env.token),
    siteId: normalizeText(config.site_id || config.siteId),
    notes: normalizeText(config.notes),
    ...(pricing ? { pricing } : {}),
  }
}

const normalizeLegacyIds = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean)
  }

  const single = normalizeText(value)
  return single ? [single] : []
}

export const mapMetadataEnvironments = (metadata = {}) => {
  const envMap = getStoredEnvironmentMap(metadata)
  return Object.entries(envMap)
    .map(([id, env]) => ({
      id: normalizeText(id),
      name: normalizeText(env?.name) || normalizeText(id),
      legacyIds: normalizeLegacyIds(env?.legacyIds),
      type: normalizeText(env?.type) || 'home_assistant',
      config: mapEnvironmentConfig(env),
    }))
    .filter((env) => env.id)
}

export const mapLegacyHaEnvironments = (metadata = {}) => {
  const legacyMap = parseEnvironmentMap(metadata.ha_environments)
  return Object.entries(legacyMap)
    .map(([id, env]) => ({
      id: normalizeText(id),
      name: normalizeText(env?.name) || normalizeText(id),
      legacyIds: normalizeLegacyIds(env?.legacyIds),
      type: 'home_assistant',
      config: {
        baseUrl: normalizeText(env?.base_url || env?.url),
        apiKey: normalizeText(env?.token),
        siteId: '',
        notes: '',
      },
    }))
    .filter((env) => env.id)
}

export const mergeEnvironments = (...environmentLists) => {
  const mergedById = new Map()

  for (const list of environmentLists) {
    for (const env of list || []) {
      if (!env || !env.id) {
        continue
      }

      const current = mergedById.get(env.id)
      if (!current) {
        mergedById.set(env.id, {
          ...env,
          legacyIds: normalizeLegacyIds(env.legacyIds),
          config: {
            baseUrl: normalizeText(env.config?.baseUrl),
            apiKey: normalizeText(env.config?.apiKey),
            siteId: normalizeText(env.config?.siteId),
            notes: normalizeText(env.config?.notes),
            ...(env.config?.pricing ? { pricing: env.config.pricing } : {}),
          },
        })
        continue
      }

      const nextConfig = {
        baseUrl: normalizeText(current.config?.baseUrl) || normalizeText(env.config?.baseUrl),
        apiKey: normalizeText(current.config?.apiKey) || normalizeText(env.config?.apiKey),
        siteId: normalizeText(current.config?.siteId) || normalizeText(env.config?.siteId),
        notes: normalizeText(current.config?.notes) || normalizeText(env.config?.notes),
      }

      if (current.config?.pricing || env.config?.pricing) {
        nextConfig.pricing = current.config?.pricing || env.config?.pricing
      }

      mergedById.set(env.id, {
        ...current,
        name: current.name || env.name,
        legacyIds: Array.from(new Set([
          ...normalizeLegacyIds(current.legacyIds),
          ...normalizeLegacyIds(env.legacyIds),
        ])),
        type: current.type || env.type,
        config: nextConfig,
      })
    }
  }

  return Array.from(mergedById.values())
}

const findEnvironmentMatch = (environments, environmentId) => {
  const rawId = normalizeText(environmentId)
  if (!rawId) {
    return null
  }

  const lower = rawId.toLowerCase()

  return environments.find((env) => env.id === rawId)
    || environments.find((env) => env.id.toLowerCase() === lower)
    || environments.find((env) => env.name && env.name.toLowerCase() === lower)
    || environments.find((env) => (env.legacyIds || []).some((alias) => alias.toLowerCase() === lower))
}

export const resolveHaConfig = ({ metadata = {}, environmentId, getOptionalEnv }) => {
  const metadataEnvironments = mapMetadataEnvironments(metadata)
  const legacyEnvironments = mapLegacyHaEnvironments(metadata)
  const fallbackEnvironments = getFallbackEnvironments(getOptionalEnv)

  const merged = mergeEnvironments(metadataEnvironments, legacyEnvironments, fallbackEnvironments)
  const matched = findEnvironmentMatch(merged, environmentId)

  if (!matched) {
    throw new Error(`Unknown environment: ${environmentId}`)
  }

  const baseUrl = normalizeText(matched.config?.baseUrl)
  const token = normalizeText(matched.config?.apiKey)

  if (!baseUrl || !token) {
    throw new Error(`Environment '${matched.id}' is missing Home Assistant baseUrl or token`)
  }

  return {
    baseUrl,
    token,
    environment: matched,
  }
}
