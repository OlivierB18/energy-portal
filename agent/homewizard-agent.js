import 'dotenv/config'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Request failed ${response.status}: ${text}`)
  }
  return response.json()
}

let managementTokenCache = { token: null, expiresAt: 0 }

const getManagementToken = async (domain) => {
  const now = Date.now()
  if (managementTokenCache.token && now < managementTokenCache.expiresAt - 60000) {
    return managementTokenCache.token
  }

  const data = await fetchJson(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: getEnv('AUTH0_M2M_CLIENT_ID'),
      client_secret: getEnv('AUTH0_M2M_CLIENT_SECRET'),
      audience: `https://${domain}/api/v2/`,
      grant_type: 'client_credentials',
    }),
  })

  const expiresIn = Number(data.expires_in) || 600
  managementTokenCache.token = data.access_token
  managementTokenCache.expiresAt = Date.now() + expiresIn * 1000
  return managementTokenCache.token
}

const getHaConfig = async (domain, managementToken, environmentId) => {
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const client = await fetchJson(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    headers: { Authorization: `Bearer ${managementToken}` },
  })

  const metadata = client.client_metadata || {}
  const envMap = metadata.environments || {}
  const envConfig = envMap[environmentId]

  if (!envConfig) {
    throw new Error(`Environment ${environmentId} not found in Auth0 metadata`)
  }

  const config = envConfig.config || {}
  const baseUrl = config.base_url || config.baseUrl || envConfig.base_url || envConfig.url
  const token = config.api_key || config.apiKey || envConfig.token

  if (!baseUrl || !token) {
    throw new Error(`Missing HA configuration for environment ${environmentId}`)
  }

  return { baseUrl, token }
}

const getP1DataFromHA = async ({ haUrl, haToken }) => {
  const baseUrl = haUrl.endsWith('/') ? haUrl.slice(0, -1) : haUrl
  const headers = {
    Authorization: `Bearer ${haToken}`,
    'Content-Type': 'application/json',
  }

  // Get all states to find P1 meter entities
  const states = await fetchJson(`${baseUrl}/api/states`, { headers })

  // Helper to find sensor value
  const findSensorValue = (pattern) => {
    const sensor = states.find((s) => s.entity_id.toLowerCase().includes(pattern.toLowerCase()))
    if (sensor && !Number.isNaN(parseFloat(sensor.state))) {
      return parseFloat(sensor.state)
    }
    return null
  }

  // Find relevant sensor values
  const currentPower = findSensorValue('power') || null
  const energyImportT1 = findSensorValue('energy_import_t1') || findSensorValue('energy') || null
  const energyImportT2 = findSensorValue('energy_import_t2') || null
  const energyExportT1 = findSensorValue('energy_export_t1') || null
  const energyExportT2 = findSensorValue('energy_export_t2') || null
  const gasMeter = findSensorValue('gas_total') || findSensorValue('gas') || null

  return {
    device_id: 'home-assistant',
    current_power: currentPower,
    energy_import_t1_kwh: energyImportT1,
    energy_import_t2_kwh: energyImportT2,
    energy_export_t1_kwh: energyExportT1,
    energy_export_t2_kwh: energyExportT2,
    gas_total_m3: gasMeter,
  }
}

const sendToIngest = async ({ environmentId, payload }) => {
  const ingestUrl = getEnv('INGEST_URL')
  const ingestKey = getEnv('INGEST_API_KEY')

  await fetchJson(ingestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ingest-Key': ingestKey,
    },
    body: JSON.stringify({
      environment_id: environmentId,
      ...payload,
    }),
  })
}

const main = async () => {
  const auth0Domain = getEnv('AUTH0_DOMAIN')
  const environmentId = getEnv('ENVIRONMENT_ID')
  const intervalMs = Number(process.env.POLL_INTERVAL_MS || 10000)

  // Get HA config from Auth0 metadata (same as dashboard uses)
  console.log('[agent] fetching HA configuration from Auth0...')
  const managementToken = await getManagementToken(auth0Domain)
  const haConfig = await getHaConfig(auth0Domain, managementToken, environmentId)
  console.log(`[agent] connected to HA at ${haConfig.baseUrl}`)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const payload = await getP1DataFromHA({ haUrl: haConfig.baseUrl, haToken: haConfig.token })
      await sendToIngest({ environmentId, payload })
      console.log(`[agent] sent data for ${environmentId} (${payload.device_id})`)
    } catch (error) {
      console.error('[agent] error', error)
    }

    await sleep(intervalMs)
  }
}

main().catch((error) => {
  console.error('[agent] fatal', error)
  process.exit(1)
})
