export interface HAEntityValue {
  entityId: string
  state: string
  unit: string
  lastUpdated: string
  available: boolean
}

export async function fetchAllSensorValues(
  entityIds: string[],
  environmentId: string,
  getAuthToken: () => Promise<string>,
): Promise<HAEntityValue[]> {
  if (entityIds.length === 0 || !environmentId) {
    return []
  }

  const token = await getAuthToken()
  const params = new URLSearchParams({
    environmentId,
    entityIds: entityIds.join(','),
  })

  const response = await fetch(`/.netlify/functions/ha-entities?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error || 'Unable to fetch sensor values')
  }

  const data = await response.json()
  const entities: Array<{
    entity_id: string
    state: string
    unit_of_measurement?: string
    last_updated?: string
  }> = Array.isArray(data?.entities) ? data.entities : []

  const requestedSet = new Set(entityIds)

  return entities
    .filter((entity) => requestedSet.has(entity.entity_id))
    .map((entity) => ({
      entityId: entity.entity_id,
      state: String(entity.state ?? ''),
      unit: String(entity.unit_of_measurement ?? ''),
      lastUpdated: entity.last_updated ?? new Date().toISOString(),
      available: entity.state !== 'unavailable' && entity.state !== 'unknown',
    }))
}
