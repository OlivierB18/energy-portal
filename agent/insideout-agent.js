import 'dotenv/config'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

// --- SQLite local buffer ---

const DB_PATH = process.env.BUFFER_DB_PATH || path.join(__dirname, 'buffer.db')
const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS buffer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    payload TEXT NOT NULL,
    retries INTEGER DEFAULT 0,
    next_retry_at INTEGER DEFAULT 0
  )
`)

const saveToBuffer = (payload) => {
  db.prepare('INSERT INTO buffer (timestamp, payload) VALUES (?, ?)').run(
    new Date().toISOString(),
    JSON.stringify(payload),
  )
}

const pruneOldRecords = () => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString()
  const result = db.prepare('DELETE FROM buffer WHERE timestamp < ?').run(cutoff)
  if (result.changes > 0) {
    console.log(`[insideout-agent] pruned ${result.changes} stale buffer records`)
  }
}

let pushInProgress = false

const pushBuffer = async (ingestUrl, deviceToken) => {
  if (pushInProgress) return
  pushInProgress = true

  try {
    pruneOldRecords()

    const now = Date.now()
    const batch = db
      .prepare('SELECT * FROM buffer WHERE next_retry_at <= ? ORDER BY id ASC LIMIT 50')
      .all(now)

    if (batch.length === 0) return

    let successCount = 0
    let failCount = 0

    for (const record of batch) {
      try {
        const payload = JSON.parse(record.payload)
        await fetchJson(ingestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Token': deviceToken,
          },
          body: JSON.stringify(payload),
        })
        db.prepare('DELETE FROM buffer WHERE id = ?').run(record.id)
        successCount += 1
      } catch {
        const newRetries = record.retries + 1
        const backoffMs = Math.min(1000 * 2 ** newRetries, 300_000)
        db.prepare(
          'UPDATE buffer SET retries = retries + 1, next_retry_at = ? WHERE id = ?',
        ).run(Date.now() + backoffMs, record.id)
        failCount += 1
      }
    }

    if (successCount > 0 || failCount > 0) {
      console.log(
        `[insideout-agent] pushed ${successCount} records (${failCount} failed, will retry with backoff)`,
      )
    }
  } finally {
    pushInProgress = false
  }
}

// --- Auth0 management token cache ---

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

const main = async () => {
  const auth0Domain = getEnv('AUTH0_DOMAIN')
  const environmentId = getEnv('ENVIRONMENT_ID')
  const ingestUrl = getEnv('INGEST_URL')
  const deviceToken = getEnv('DEVICE_TOKEN')
  const intervalMs = Number(process.env.POLL_INTERVAL_MS || 10_000)
  const directHaUrl = String(process.env.HA_URL || '').trim()
  const directHaToken = String(process.env.HA_TOKEN || '').trim()

  // Plan Foxtrot gateway: use direct HA credentials when provided,
  // otherwise resolve HA config from Auth0 metadata (same as dashboard).
  let haConfig
  if (directHaUrl && directHaToken) {
    haConfig = { baseUrl: directHaUrl, token: directHaToken }
    console.log('[insideout-agent] using direct HA_URL/HA_TOKEN configuration')
  } else {
    console.log('[insideout-agent] fetching HA configuration from Auth0...')
    const managementToken = await getManagementToken(auth0Domain)
    haConfig = await getHaConfig(auth0Domain, managementToken, environmentId)
  }

  console.log(`[insideout-agent] connected to HA at ${haConfig.baseUrl}`)
  console.log(`[insideout-agent] poll interval: ${intervalMs}ms | push interval: 30000ms`)
  console.log(`[insideout-agent] buffer DB: ${DB_PATH}`)

  // Push any records left in the buffer from a previous run
  void pushBuffer(ingestUrl, deviceToken)

  // Push buffer to server every 30 seconds
  const pushInterval = setInterval(() => {
    void pushBuffer(ingestUrl, deviceToken)
  }, 30_000)

  // Poll HA and save each reading to the local buffer
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const reading = await getP1DataFromHA({ haUrl: haConfig.baseUrl, haToken: haConfig.token })
      saveToBuffer({ environment_id: environmentId, ...reading })
      console.log(`[insideout-agent] buffered reading for ${environmentId} (${reading.device_id})`)
    } catch (error) {
      console.error('[insideout-agent] error reading from HA:', error instanceof Error ? error.message : error)
    }

    await sleep(intervalMs)
  }

  // Unreachable — satisfies static analysis
  clearInterval(pushInterval)
}

main().catch((error) => {
  console.error('[insideout-agent] fatal', error)
  process.exit(1)
})
