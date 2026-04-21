-- Energy portal Supabase schema

create table if not exists environments (
  id text primary key,
  name text not null,
  display_name text,
  ha_base_url text not null,
  ha_api_token text not null,
  installed_on timestamptz,
  timezone text default 'Europe/Amsterdam',
  is_active boolean default true,
  has_solar boolean default false,
  has_gas boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists environment_sensors (
  environment_id text references environments(id) on delete cascade,
  sensor_type text not null,
  entity_id text not null,
  is_primary boolean default false,
  detected_at timestamptz default now(),
  primary key (environment_id, sensor_type, entity_id)
);

create table if not exists energy_readings (
  id bigserial primary key,
  environment_id text not null references environments(id) on delete cascade,
  timestamp timestamptz not null,
  power_consumption_w real,
  power_production_w real,
  energy_import_kwh real,
  energy_export_kwh real,
  solar_energy_kwh real,
  gas_total_m3 real,
  net_power_w real,
  unique (environment_id, timestamp)
);

create index if not exists idx_readings_env_time on energy_readings(environment_id, timestamp desc);

create table if not exists energy_hourly (
  environment_id text not null references environments(id) on delete cascade,
  hour timestamptz not null,
  avg_power_w real,
  max_power_w real,
  min_power_w real,
  avg_production_w real,
  kwh_imported real,
  kwh_exported real,
  solar_kwh real,
  gas_m3 real,
  sample_count integer default 0,
  primary key (environment_id, hour)
);

create table if not exists energy_daily (
  environment_id text not null references environments(id) on delete cascade,
  day date not null,
  avg_power_w real,
  max_power_w real,
  min_power_w real,
  avg_production_w real,
  kwh_imported real,
  kwh_exported real,
  solar_kwh real,
  gas_m3 real,
  sample_count integer default 0,
  primary key (environment_id, day)
);

create table if not exists ha_commands (
  id bigserial primary key,
  environment_id text not null references environments(id) on delete cascade,
  command_type text not null,
  entity_id text not null,
  service text,
  service_data jsonb,
  status text default 'pending',
  requested_by text,
  requested_at timestamptz default now(),
  executed_at timestamptz,
  response jsonb,
  error text
);

alter table environments enable row level security;
alter table environment_sensors enable row level security;
alter table energy_readings enable row level security;
alter table energy_hourly enable row level security;
alter table energy_daily enable row level security;
alter table ha_commands enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'environments' and policyname = 'authenticated_all_environments'
  ) then
    create policy authenticated_all_environments on environments
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'environment_sensors' and policyname = 'authenticated_all_environment_sensors'
  ) then
    create policy authenticated_all_environment_sensors on environment_sensors
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'energy_readings' and policyname = 'authenticated_all_energy_readings'
  ) then
    create policy authenticated_all_energy_readings on energy_readings
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'energy_hourly' and policyname = 'authenticated_all_energy_hourly'
  ) then
    create policy authenticated_all_energy_hourly on energy_hourly
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'energy_daily' and policyname = 'authenticated_all_energy_daily'
  ) then
    create policy authenticated_all_energy_daily on energy_daily
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ha_commands' and policyname = 'authenticated_all_ha_commands'
  ) then
    create policy authenticated_all_ha_commands on ha_commands
      for all to authenticated using (true) with check (true);
  end if;
end $$;

create or replace function aggregate_hourly(hours_back integer default 3)
returns void as $$
insert into energy_hourly (
  environment_id,
  hour,
  avg_power_w,
  max_power_w,
  min_power_w,
  avg_production_w,
  kwh_imported,
  kwh_exported,
  solar_kwh,
  gas_m3,
  sample_count
)
select
  environment_id,
  date_trunc('hour', timestamp) as hour,
  avg(power_consumption_w),
  max(power_consumption_w),
  min(power_consumption_w),
  avg(power_production_w),
  greatest(max(energy_import_kwh) - min(energy_import_kwh), 0),
  greatest(max(energy_export_kwh) - min(energy_export_kwh), 0),
  greatest(max(solar_energy_kwh) - min(solar_energy_kwh), 0),
  greatest(max(gas_total_m3) - min(gas_total_m3), 0),
  count(*)::integer
from energy_readings
where timestamp >= now() - (hours_back || ' hours')::interval
group by environment_id, date_trunc('hour', timestamp)
on conflict (environment_id, hour) do update set
  avg_power_w = excluded.avg_power_w,
  max_power_w = excluded.max_power_w,
  min_power_w = excluded.min_power_w,
  avg_production_w = excluded.avg_production_w,
  kwh_imported = excluded.kwh_imported,
  kwh_exported = excluded.kwh_exported,
  solar_kwh = excluded.solar_kwh,
  gas_m3 = excluded.gas_m3,
  sample_count = excluded.sample_count;
$$ language sql;

-- Devices: agents authenticeren via device token
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  environment_id text references environments(id) on delete cascade not null,
  token text unique not null,
  device_type text default 'home-assistant',
  last_seen timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_devices_token on devices(token);
create index if not exists idx_devices_environment on devices(environment_id);

alter table devices enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'devices' and policyname = 'authenticated_all_devices'
  ) then
    create policy authenticated_all_devices on devices
      for all to authenticated using (true) with check (true);
  end if;
end $$;

create or replace function aggregate_daily(days_back integer default 2)
returns void as $$
insert into energy_daily (
  environment_id,
  day,
  avg_power_w,
  max_power_w,
  min_power_w,
  avg_production_w,
  kwh_imported,
  kwh_exported,
  solar_kwh,
  gas_m3,
  sample_count
)
select
  environment_id,
  (date_trunc('day', timestamp at time zone 'Europe/Amsterdam') at time zone 'Europe/Amsterdam')::date as day,
  avg(power_consumption_w),
  max(power_consumption_w),
  min(power_consumption_w),
  avg(power_production_w),
  greatest(max(energy_import_kwh) - min(energy_import_kwh), 0),
  greatest(max(energy_export_kwh) - min(energy_export_kwh), 0),
  greatest(max(solar_energy_kwh) - min(solar_energy_kwh), 0),
  greatest(max(gas_total_m3) - min(gas_total_m3), 0),
  count(*)::integer
from energy_readings
where timestamp >= now() - (days_back || ' days')::interval
group by environment_id, (date_trunc('day', timestamp at time zone 'Europe/Amsterdam') at time zone 'Europe/Amsterdam')::date
on conflict (environment_id, day) do update set
  avg_power_w = excluded.avg_power_w,
  max_power_w = excluded.max_power_w,
  min_power_w = excluded.min_power_w,
  avg_production_w = excluded.avg_production_w,
  kwh_imported = excluded.kwh_imported,
  kwh_exported = excluded.kwh_exported,
  solar_kwh = excluded.solar_kwh,
  gas_m3 = excluded.gas_m3,
  sample_count = excluded.sample_count;
$$ language sql;
