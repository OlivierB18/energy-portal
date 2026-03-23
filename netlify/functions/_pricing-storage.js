import { connectLambda, getStore } from '@netlify/blobs'

const PRICING_STORE_NAME = 'ha-pricing'
const PRICING_STORE_KEY = 'environment-pricing'

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

const parsePricingMap = (input) => {
  if (!input) {
    return {}
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

const normalizePricingConfig = (input) => {
  if (!input || typeof input !== 'object') {
    return null
  }

  const type = input.type === 'dynamic' ? 'dynamic' : 'fixed'
  const parseNumber = (raw, fallback) => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const updatedAtRaw = normalizeText(input.updatedAt || input.updated_at)

  return {
    type,
    consumerPrice: parseNumber(input.consumerPrice, 0.30),
    producerPrice: parseNumber(input.producerPrice, 0.10),
    consumerMargin: parseNumber(input.consumerMargin, 0.05),
    producerMargin: parseNumber(input.producerMargin, 0.02),
    gasPrice: parseNumber(input.gasPrice, 1.35),
    gasMargin: parseNumber(input.gasMargin, 0),
    gasProxyKwhPerM3: parseNumber(input.gasProxyKwhPerM3, 10.55),
    updatedAt: updatedAtRaw || new Date().toISOString(),
  }
}

const normalizePricingMap = (input) => {
  const parsed = parsePricingMap(input)

  return Object.entries(parsed).reduce((acc, [rawEnvironmentId, rawConfig]) => {
    const environmentId = normalizeText(rawEnvironmentId)
    if (!environmentId) {
      return acc
    }

    const config = normalizePricingConfig(rawConfig)
    if (!config) {
      return acc
    }

    acc[environmentId] = config
    return acc
  }, {})
}

const getPricingStore = (event) => {
  connectLambda(event)
  return getStore(PRICING_STORE_NAME)
}

export const loadBlobPricingMap = async (event) => {
  const store = getPricingStore(event)
  const stored = await store.get(PRICING_STORE_KEY, { type: 'json' })

  const rawMap = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored.pricingMap || stored)
    : {}

  return normalizePricingMap(rawMap)
}

export const saveBlobPricingMap = async (event, pricingMap) => {
  const store = getPricingStore(event)
  const normalized = normalizePricingMap(pricingMap)

  await store.setJSON(PRICING_STORE_KEY, {
    pricingMap: normalized,
    updatedAt: new Date().toISOString(),
  })

  return normalized
}

export const getMergedPricingMap = async ({ event, metadata = {} }) => {
  let blobMap = {}

  try {
    blobMap = await loadBlobPricingMap(event)
  } catch (error) {
    console.warn('[PRICING STORAGE] Blob read failed:', error instanceof Error ? error.message : error)
  }

  if (Object.keys(blobMap).length > 0) {
    return {
      pricingMap: blobMap,
      source: 'blob',
    }
  }

  const metadataMap = normalizePricingMap(metadata?.energy_pricing)

  if (Object.keys(metadataMap).length > 0) {
    // Migrate legacy metadata pricing to blob on read.
    try {
      await saveBlobPricingMap(event, metadataMap)
    } catch (error) {
      console.warn('[PRICING STORAGE] Blob migration failed:', error instanceof Error ? error.message : error)
    }

    return {
      pricingMap: metadataMap,
      source: 'metadata',
    }
  }

  return {
    pricingMap: {},
    source: 'none',
  }
}

export const resolvePricingConfig = ({ pricingMap = {}, environmentId }) => {
  const requestedId = normalizeText(environmentId)
  if (!requestedId) {
    return null
  }

  if (pricingMap[requestedId]) {
    return pricingMap[requestedId]
  }

  const requestedLower = requestedId.toLowerCase()
  const matchedEntry = Object.entries(pricingMap).find(([id]) => normalizeText(id).toLowerCase() === requestedLower)
  return matchedEntry ? matchedEntry[1] : null
}
