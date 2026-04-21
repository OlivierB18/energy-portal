-- User roles and invite system
-- NOTE: environments.id is type TEXT, so all FKs here use text, not uuid

create table if not exists environment_users (
  id uuid primary key default gen_random_uuid(),
  environment_id text references environments(id) on delete cascade,
  user_id text not null,
  user_email text not null,
  role text default 'viewer' check (role in ('admin', 'viewer')),
  invited_by text not null,
  created_at timestamptz default now(),
  accepted_at timestamptz,
  unique (environment_id, user_id)
);

create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  token text unique not null default gen_random_uuid()::text,
  environment_id text references environments(id) on delete cascade,
  email text not null,
  role text default 'viewer' check (role in ('admin', 'viewer')),
  invited_by text not null,
  expires_at timestamptz default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_invites_token on invites(token);
create index if not exists idx_invites_email on invites(email);
create index if not exists idx_invites_expires on invites(expires_at) where accepted_at is null;
create index if not exists idx_environment_users_user_id on environment_users(user_id);
create index if not exists idx_environment_users_user_email on environment_users(user_email);
create index if not exists idx_environment_users_env on environment_users(environment_id);
-- Composite index: primary access-control lookup (user_email + environment_id)
create index if not exists idx_environment_users_email_env on environment_users(user_email, environment_id);

alter table environment_users enable row level security;
alter table invites enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'environment_users' and policyname = 'authenticated_all_environment_users'
  ) then
    create policy authenticated_all_environment_users on environment_users
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'invites' and policyname = 'authenticated_all_invites'
  ) then
    create policy authenticated_all_invites on invites
      for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ─── Seed: koppel olivier@inside-out.tech als admin aan alle bestaande omgevingen ───
-- Gebruik INSERT ... ON CONFLICT DO NOTHING zodat dit idempotent is.
insert into environment_users (environment_id, user_id, user_email, role, invited_by, accepted_at)
select
  e.id                          as environment_id,
  'seed-owner'                  as user_id,
  'olivier@inside-out.tech'     as user_email,
  'admin'                       as role,
  'system'                      as invited_by,
  now()                         as accepted_at
from environments e
on conflict (environment_id, user_id) do nothing;
