const normalizeEntityId = (value) => String(value || '').trim()

const findFirstEntityId = (entityIds, priorities) => {
  for (const pattern of priorities) {
    if (typeof pattern === 'string') {
      if (entityIds.includes(pattern)) {
        return pattern
      }
      continue
    }

    const match = entityIds.find((entityId) => pattern.test(entityId))
    if (match) {
      return match
    }
  }

  return null
}

export const detectEnergyEntities = (entities) => {
  const entityIds = (Array.isArray(entities) ? entities : [])
    .map((entity) => normalizeEntityId(entity?.entity_id))
    .filter(Boolean)

  const consumptionTotal = findFirstEntityId(entityIds, [
    'sensor.p1_meter_energy_import',
    /^sensor\.electricity_meter_energy_consumption$/,
  ])

  let consumptionEntities = []
  if (consumptionTotal) {
    consumptionEntities = [consumptionTotal]
  } else {
    const p1Tariffs = entityIds.filter((entityId) => /^sensor\.p1_meter_energy_import_tariff_\d+$/.test(entityId)).sort()
    const emTariffs = entityIds.filter((entityId) => /^sensor\.electricity_meter_energy_consumption_tarif(f)?_\d+$/.test(entityId)).sort()
    if (p1Tariffs.length >= 2) {
      consumptionEntities = p1Tariffs
    } else if (emTariffs.length >= 2) {
      consumptionEntities = emTariffs
    } else if (p1Tariffs.length === 1) {
      consumptionEntities = p1Tariffs
    } else if (emTariffs.length === 1) {
      consumptionEntities = emTariffs
    }
  }

  const exportTotal = findFirstEntityId(entityIds, [
    'sensor.p1_meter_energy_export',
    /^sensor\.electricity_meter_energy_production$/,
  ])

  let exportEntities = []
  if (exportTotal) {
    exportEntities = [exportTotal]
  } else {
    const p1ExportTariffs = entityIds.filter((entityId) => /^sensor\.p1_meter_energy_export_tariff_\d+$/.test(entityId)).sort()
    const emExportTariffs = entityIds.filter((entityId) => /^sensor\.electricity_meter_energy_production_tarif(f)?_\d+$/.test(entityId)).sort()
    if (p1ExportTariffs.length >= 2) {
      exportEntities = p1ExportTariffs
    } else if (emExportTariffs.length >= 2) {
      exportEntities = emExportTariffs
    } else if (p1ExportTariffs.length === 1) {
      exportEntities = p1ExportTariffs
    } else if (emExportTariffs.length === 1) {
      exportEntities = emExportTariffs
    }
  }

  const currentPower = findFirstEntityId(entityIds, [
    'sensor.p1_meter_power',
    /electricity_meter_power_consumption$/,
    /net_power$/,
  ])

  const currentProduction = findFirstEntityId(entityIds, [
    /solaredge.*ac_power$/,
    /inverter.*power$/,
    'sensor.electricity_meter_power_production',
  ])

  const solarEntity = findFirstEntityId(entityIds, [
    /solaredge.*ac_energy$/,
    /inverter.*energy$/,
    /solar.*energy$/,
  ])

  const gasEntity = findFirstEntityId(entityIds, [
    'sensor.gas_meter_gas_consumption',
    'sensor.gas_meter_gas',
    /gas.*total.*m3$/,
  ])

  return {
    currentPower,
    currentProduction,
    consumptionEntities: Array.from(new Set(consumptionEntities)),
    exportEntities: Array.from(new Set(exportEntities)),
    solarEntity,
    gasEntity,
  }
}
