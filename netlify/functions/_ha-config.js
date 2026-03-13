const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

const parseEnvironmentMap = (rawValue) => {
  if (!rawValue) {
    return {}
  }

  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  return rawValue && typeof rawValue === 'object' ? rawValue : {}
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

export const mapMetadataEnvironments = (metadata = {}) => {
  const envMap = parseEnvironmentMap(metadata.environments)
  return Object.entries(envMap)
    .map(([id, env]) => ({
      id: normalizeText(id),
      name: normalizeText(env?.name) || normalizeText(id),
      type: normalizeText(env?.type) || 'home_assistant',
      config: mapEnvironmentConfig(env),
    }))
    .filter((env) => env.id)
}

export const mapLegacyHaEnvironments = (metadata = {}) => {
  const legacyMap = metadata.ha_environments || {}
  return Object.entries(legacyMap)
    .map(([id, env]) => ({
      id: normalizeText(id),
      name: normalizeText(env?.name) || normalizeText(id),
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
  const merged = []
  const seen = new Set()

  for (const list of environmentLists) {
    for (const env of list || []) {
      if (!env || !env.id || seen.has(env.id)) {
        continue
      }

      seen.add(env.id)
      merged.push(env)
    }
  }

  return merged
}

const findEnvironmentMatch = (environments, environmentId) => {
  const rawId = normalizeText(environmentId)
  if (!rawId) {
    return null
  }

  const lower = rawId.toLowerCase()

  return environments.find((env) => env.id === rawId)
    || environments.find((env) => env.id.toLowerCase() === lower)
    || environments.find((env) => (env.name || '').toLowerCase() === lower)
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
