import { createClient } from '@supabase/supabase-js'

const requireEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_KEY'))

const environments = [
  {
    id: 'tennesseedreef-15b-kantoor',
    name: 'Tennesseedreef 15B',
    display_name: 'Kantoor',
    ha_base_url: requireEnv('KANTOOR_HA_URL'),
    ha_api_token: requireEnv('KANTOOR_HA_TOKEN'),
    installed_on: '2026-03-15T03:00:00Z',
    has_solar: false,
    has_gas: true,
  },
  {
    id: 'ruurloseweg-38-dhvw',
    name: 'Ruurloseweg 38',
    display_name: 'DHVW',
    ha_base_url: requireEnv('DHVW_HA_URL'),
    ha_api_token: requireEnv('DHVW_HA_TOKEN'),
    installed_on: '2026-03-17T03:00:00Z',
    has_solar: true,
    has_gas: true,
  },
]

const run = async () => {
  const { data, error } = await supabase
    .from('environments')
    .upsert(
      environments.map((environment) => ({
        ...environment,
        timezone: 'Europe/Amsterdam',
        is_active: true,
        updated_at: new Date().toISOString(),
      })),
    )
    .select('id,name,display_name,is_active')

  if (error) {
    throw error
  }

  console.log('Seeded environments:', data)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
