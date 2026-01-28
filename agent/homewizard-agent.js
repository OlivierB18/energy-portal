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

const getP1Data = async ({ ip, token }) => {
  const baseUrl = ip.startsWith('http') ? ip : `http://${ip}`
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Api-Version': '2',
  }

  const data = await fetchJson(`${baseUrl}/api`, { headers })
  const measurements = await fetchJson(`${baseUrl}/api/measurement`, { headers })

  return {
    device_id: data.serial ?? 'unknown',
    current_power: measurements.power_w ?? null,
    energy_import_t1_kwh: measurements.energy_import_t1_kwh ?? null,
    energy_import_t2_kwh: measurements.energy_import_t2_kwh ?? null,
    energy_export_t1_kwh: measurements.energy_export_t1_kwh ?? null,
    energy_export_t2_kwh: measurements.energy_export_t2_kwh ?? null,
    gas_total_m3: measurements.gas_m3 ?? null,
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
  const ip = getEnv('HOMEWIZARD_IP')
  const token = getEnv('HOMEWIZARD_TOKEN')
  const environmentId = getEnv('HOMEWIZARD_ENVIRONMENT_ID')
  const intervalMs = Number(process.env.HOMEWIZARD_POLL_MS || 10000)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const payload = await getP1Data({ ip, token })
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
