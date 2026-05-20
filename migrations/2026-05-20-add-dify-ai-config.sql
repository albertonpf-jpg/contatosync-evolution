alter table public.evolution_ai_config
  add column if not exists ai_provider text default 'openai',
  add column if not exists dify_enabled boolean default false,
  add column if not exists dify_api_url text default '',
  add column if not exists dify_api_key text default '',
  add column if not exists dify_app_id text default '',
  add column if not exists dify_workspace_id text default '',
  add column if not exists dify_provision_status text default 'pending',
  add column if not exists dify_provision_error text default '',
  add column if not exists dify_model text default '',
  add column if not exists dify_timeout_ms integer default 45000;

comment on column public.evolution_ai_config.ai_provider is 'Per-client LLM provider used by the Dify-backed AI flow: openai, claude, gemini, openrouter, or local.';
comment on column public.evolution_ai_config.dify_enabled is 'Internal ContatoSync flag for Dify routing. Not user-facing.';
comment on column public.evolution_ai_config.dify_api_url is 'Internal Dify base URL selected/provisioned by ContatoSync for this client.';
comment on column public.evolution_ai_config.dify_api_key is 'Internal Dify app API key selected/provisioned by ContatoSync for this client. Not user-facing.';
comment on column public.evolution_ai_config.dify_app_id is 'Internal Dify app id provisioned for this client.';
comment on column public.evolution_ai_config.dify_workspace_id is 'Internal Dify workspace/tenant id provisioned for this client when available.';
comment on column public.evolution_ai_config.dify_provision_status is 'Internal provisioning state: pending, ready, failed.';
comment on column public.evolution_ai_config.dify_provision_error is 'Internal last provisioning error for Dify automation.';
comment on column public.evolution_ai_config.dify_model is 'Internal display/model label returned in AI logs for Dify responses.';
comment on column public.evolution_ai_config.dify_timeout_ms is 'Internal Dify request timeout in milliseconds.';
