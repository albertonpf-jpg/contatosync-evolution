alter table public.evolution_sessions
  add column if not exists isolation_mode text default 'shared',
  add column if not exists isolation_status text default 'ready',
  add column if not exists isolation_metadata jsonb default '{}'::jsonb;

update public.evolution_sessions
set isolation_mode = coalesce(isolation_mode, 'shared'),
    isolation_status = coalesce(isolation_status, 'ready'),
    isolation_metadata = coalesce(isolation_metadata, '{}'::jsonb)
where isolation_mode is null
   or isolation_status is null
   or isolation_metadata is null;

comment on column public.evolution_sessions.isolation_mode is 'Connection isolation mode for WhatsApp session: shared, dedicated, or proxy.';
comment on column public.evolution_sessions.isolation_status is 'Provisioning status for WhatsApp connection isolation.';
comment on column public.evolution_sessions.isolation_metadata is 'Operational metadata for worker, proxy, and egress assignment.';
