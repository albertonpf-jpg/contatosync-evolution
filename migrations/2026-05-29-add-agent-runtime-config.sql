alter table public.evolution_ai_config
  add column if not exists department_agent_config jsonb default '{}'::jsonb,
  add column if not exists queue_settings jsonb default '{}'::jsonb,
  add column if not exists isolation_settings jsonb default '{}'::jsonb;

update public.evolution_ai_config
set department_agents_enabled = true,
    department_agent_config = coalesce(department_agent_config, '{}'::jsonb),
    queue_settings = coalesce(queue_settings, '{}'::jsonb),
    isolation_settings = coalesce(isolation_settings, '{}'::jsonb)
where department_agents_enabled is null
   or department_agent_config is null
   or queue_settings is null
   or isolation_settings is null;

comment on column public.evolution_ai_config.department_agent_config is 'Internal and user-safe department agent settings for local multi-agent routing.';
comment on column public.evolution_ai_config.queue_settings is 'Internal queue settings for per-client and per-session WhatsApp AI processing.';
comment on column public.evolution_ai_config.isolation_settings is 'Internal infrastructure plan for per-connection isolation such as worker and egress assignment.';
