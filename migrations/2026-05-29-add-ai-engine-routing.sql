alter table public.evolution_ai_config
  add column if not exists ai_engine text default 'local_multi_agent',
  add column if not exists department_agents_enabled boolean default true;

update public.evolution_ai_config
set ai_engine = 'local_multi_agent',
    department_agents_enabled = true
where coalesce(ai_engine, '') in ('', 'local_multi_agent', 'dify', 'hybrid');

comment on column public.evolution_ai_config.ai_engine is 'Internal ContatoSync routing engine: local_multi_agent, dify, or hybrid. Not user-facing.';
comment on column public.evolution_ai_config.department_agents_enabled is 'Internal flag for department multi-agent routing. Not user-facing.';
