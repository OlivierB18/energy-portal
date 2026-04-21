export interface OverviewLiveSnapshot {
  environmentId: string
  status: 'online' | 'offline' | 'connecting'
  currentPower?: number
  dailyUsage?: number
  lastUpdate?: string
  lastSeenAt?: number
}

export interface DashboardResponseCacheEntry<T = unknown> {
  value: T
  expiresAt: number
}

const overviewSnapshotMap = new Map<string, OverviewLiveSnapshot>()
const responseCacheMap = new Map<string, DashboardResponseCacheEntry>()

export const setOverviewLiveSnapshot = (snapshot: OverviewLiveSnapshot) => {
  if (!snapshot.environmentId) return
  overviewSnapshotMap.set(snapshot.environmentId, snapshot)
}

export const getOverviewLiveSnapshot = (environmentId: string): OverviewLiveSnapshot | null => {
  if (!environmentId) return null
  return overviewSnapshotMap.get(environmentId) || null
}

export const setDashboardResponseCache = <T>(key: string, value: T, ttlMs: number) => {
  if (!key || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return
  }

  responseCacheMap.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  })
}

export const getDashboardResponseCache = <T>(key: string): T | null => {
  if (!key) return null

  const hit = responseCacheMap.get(key)
  if (!hit) return null
  if (Date.now() > hit.expiresAt) {
    responseCacheMap.delete(key)
    return null
  }

  return hit.value as T
}

export const makeDashboardCacheKey = (parts: Array<string | number | null | undefined>) => {
  return parts
    .map((part) => String(part ?? ''))
    .join('::')
}
