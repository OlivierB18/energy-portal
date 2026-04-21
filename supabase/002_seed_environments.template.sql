-- Replace placeholders and run after 001_energy_schema.sql
insert into environments (
  id,
  name,
  display_name,
  ha_base_url,
  ha_api_token,
  installed_on,
  has_solar,
  has_gas
) values
(
  'tennesseedreef-15b-kantoor',
  'Tennesseedreef 15B',
  'Kantoor',
  '{{KANTOOR_HA_URL}}',
  '{{KANTOOR_HA_TOKEN}}',
  '2026-03-15T03:00:00Z',
  false,
  true
),
(
  'ruurloseweg-38-dhvw',
  'Ruurloseweg 38',
  'DHVW',
  '{{DHVW_HA_URL}}',
  '{{DHVW_HA_TOKEN}}',
  '2026-03-17T03:00:00Z',
  true,
  true
)
on conflict (id) do update set
  name = excluded.name,
  display_name = excluded.display_name,
  ha_base_url = excluded.ha_base_url,
  ha_api_token = excluded.ha_api_token,
  installed_on = excluded.installed_on,
  has_solar = excluded.has_solar,
  has_gas = excluded.has_gas,
  updated_at = now();
