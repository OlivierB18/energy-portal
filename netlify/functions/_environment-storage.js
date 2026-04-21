import { connectLambda, getStore } from '@netlify/blobs'
import {
  getFallbackEnvironments,
  mapLegacyHaEnvironments,
  mapMetadataEnvironments,
  mergeEnvironments,
} from './_ha-config.js'

const ENVIRONMENT_STORE_NAME = 'ha-environments'
const ENVIRONMENT_STORE_KEY = 'environments'
const ENV_METADATA_PREFIX = 'ha_env_v1_'

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')
const normalizeKey = (value) => normalizeText(value).toLowerCase()

const toEnvironmentSlug = (value) => {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)

  return normalized || 'environment'
}

const uniqueSlug = (base, used) => {
  if (!used.has(base)) {
    used.add(base)
    return base
  }

  let index = 2
  while (index < 10000) {
    const suffix = `-${index}`
    const room = Math.max(1, 50 - suffix.length)
    const candidate = `${base.slice(0, room)}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
    index += 1
  }

  return base
}

const normalizeEnvironment = (env = {}) => ({
  id: normalizeText(env.id),
  name: normalizeText(env.name || env.id),
  type: normalizeText(env.type) || 'home_assistant',
  legacyIds: Array.isArray(env.legacyIds)
    ? env.legacyIds.map((id) => normalizeText(id)).filter(Boolean)
    : [],
  config: {
    baseUrl: normalizeText(env.config?.baseUrl || env.config?.base_url || env.baseUrl || env.base_url || env.url),
    apiKey: normalizeText(env.config?.apiKey || env.config?.api_key || env.apiKey || env.api_key || env.token),
    siteId: normalizeText(env.config?.siteId || env.config?.site_id || env.siteId || env.site_id),
    notes: normalizeText(env.config?.notes || env.notes),
  },
})

const normalizeEnvironments = (environments) => {
  if (!Array.isArray(environments)) {
    return []
  }

  const usedIds = new Set()

  return environments
    .map((env) => normalizeEnvironment(env))
    .filter((env) => env.name)
    .map((env) => {
      const generatedId = toEnvironmentSlug(env.name)
      const canonicalId = uniqueSlug(generatedId, usedIds)
      const legacyIds = Array.from(new Set([
        ...env.legacyIds,
        env.id && env.id !== canonicalId ? env.id : '',
      ].filter(Boolean)))

      return {
        ...env,
        id: canonicalId,
        legacyIds,
      }
    })
}

export const sanitizeEnvironments = (environments) => {
  const normalized = normalizeEnvironments(environments)
  const deduped = []
  const seenIds = new Set()
  const seenNameConfig = new Set()

  for (const env of normalized) {
    const idKey = normalizeKey(env.id)
    if (!idKey || seenIds.has(idKey)) {
      continue
    }

    const signatureKey = [
      normalizeKey(env.name),
      normalizeKey(env.type),
      normalizeKey(env.config?.baseUrl),
    ].join('|')

    if (signatureKey !== '||' && seenNameConfig.has(signatureKey)) {
      continue
    }

    seenIds.add(idKey)
    if (signatureKey !== '||') {
      seenNameConfig.add(signatureKey)
    }

    deduped.push(env)
  }

  return deduped
}

const normalizeAndSanitizeEnvironments = (environments) => {
  if (!Array.isArray(environments)) {
    return []
  }

  return sanitizeEnvironments(environments)
}

const getEnvironmentStore = (event) => {
  connectLambda(event)
  return getStore(ENVIRONMENT_STORE_NAME)
}

const decodeEnvironmentId = (encodedId) => {
  try {
    return Buffer.from(String(encodedId || ''), 'base64url').toString('utf8').trim()
  } catch {
    return ''
  }
}

const parseShardedEnvironmentMap = (metadata = {}) => {
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

export const stripShardedEnvironmentMetadata = (metadata = {}) => {
  return Object.fromEntries(
    Object.entries(metadata || {}).filter(([key]) => !key.startsWith(ENV_METADATA_PREFIX)),
  )
}

export const loadBlobEnvironments = async (event) => {
  const store = getEnvironmentStore(event)
  const stored = await store.get(ENVIRONMENT_STORE_KEY, { type: 'json' })

  const rawEnvironments = Array.isArray(stored)
    ? stored
    : Array.isArray(stored?.environments)
      ? stored.environments
      : []

  const sanitized = normalizeAndSanitizeEnvironments(rawEnvironments)

  const storedJson = JSON.stringify(rawEnvironments || [])
  const sanitizedJson = JSON.stringify(sanitized)

  // Self-heal malformed entries and migrate legacy IDs to canonical slug IDs on read.
  if (Array.isArray(rawEnvironments) && storedJson !== sanitizedJson) {
    await store.setJSON(ENVIRONMENT_STORE_KEY, {
      environments: sanitized,
      updatedAt: new Date().toISOString(),
    })
  }

  return sanitized
}

export const saveBlobEnvironments = async (event, environments) => {
  const store = getEnvironmentStore(event)
  const normalized = normalizeAndSanitizeEnvironments(environments)
  await store.setJSON(ENVIRONMENT_STORE_KEY, {
    environments: normalized,
    updatedAt: new Date().toISOString(),
  })
  return normalized
}

export const getMergedEnvironments = async ({ event, metadata = {}, getOptionalEnv }) => {
  let blobEnvironments = []

  try {
    blobEnvironments = await loadBlobEnvironments(event)
  } catch (error) {
    console.warn(
      '[ENV STORAGE] Blob read failed:',
      error instanceof Error ? error.message : error,
    )
  }

  if (blobEnvironments.length > 0) {
    return {
      environments: sanitizeEnvironments(blobEnvironments),
      source: 'blob',
    }
  }

  const metadataEnvironments = mapMetadataEnvironments(metadata)
  const legacyEnvironments = mapLegacyHaEnvironments(metadata)
  const shardedMetadataEnvironments = parseShardedEnvironmentMap(metadata)
  const fallbackEnvironments = getFallbackEnvironments(getOptionalEnv)

  const environments = sanitizeEnvironments(mergeEnvironments(
    blobEnvironments,
    metadataEnvironments,
    shardedMetadataEnvironments,
    legacyEnvironments,
    fallbackEnvironments,
  ))

  const source = blobEnvironments.length > 0
    ? 'blob'
    : metadataEnvironments.length > 0 || shardedMetadataEnvironments.length > 0 || legacyEnvironments.length > 0
      ? 'metadata'
      : 'fallback'

  return {
    environments,
    source,
  }
}

export const resolveEnvironmentConfig = async ({ event, metadata = {}, environmentId, getOptionalEnv }) => {
  const requestedId = normalizeText(environmentId)
  if (!requestedId) {
    throw new Error('Missing environmentId')
  }

  const { environments } = await getMergedEnvironments({ event, metadata, getOptionalEnv })
  const lowerRequestedId = requestedId.toLowerCase()
  const matched = environments.find((env) => env.id === requestedId)
    || environments.find((env) => env.id.toLowerCase() === lowerRequestedId)
    || environments.find((env) => normalizeText(env.name).toLowerCase() === lowerRequestedId)
    || environments.find((env) => Array.isArray(env.legacyIds) && env.legacyIds.some((id) => normalizeKey(id) === lowerRequestedId))

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

export const resolveEnvironmentReference = async ({ event, metadata = {}, environmentId, getOptionalEnv }) => {
  const requestedId = normalizeText(environmentId)
  if (!requestedId) {
    throw new Error('Missing environmentId')
  }

  const { environments } = await getMergedEnvironments({ event, metadata, getOptionalEnv })
  const lowerRequestedId = requestedId.toLowerCase()
  const matched = environments.find((env) => env.id === requestedId)
    || environments.find((env) => env.id.toLowerCase() === lowerRequestedId)
    || environments.find((env) => normalizeText(env.name).toLowerCase() === lowerRequestedId)
    || environments.find((env) => Array.isArray(env.legacyIds) && env.legacyIds.some((id) => normalizeKey(id) === lowerRequestedId))

  if (!matched) {
    throw new Error(`Unknown environment: ${environmentId}`)
  }

  return {
    environmentId: matched.id,
    environment: matched,
    aliases: Array.from(new Set([matched.id, ...(matched.legacyIds || [])])),
  }
}