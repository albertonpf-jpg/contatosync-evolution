-- Expand the legacy AI config table to match the IA Config screen.
-- The model is configured only in IA Config; general Settings stores provider keys and basic limits.

alter table public.evolution_ai_config
  add column if not exists enabled boolean default false,
  add column if not exists working_hours_enabled boolean default true,
  add column if not exists timezone varchar(50) default 'America/Sao_Paulo',
  add column if not exists working_days integer[] default array[1,2,3,4,5],
  add column if not exists hour_start integer default 9,
  add column if not exists hour_end integer default 18,
  add column if not exists daily_limit integer default 50,
  add column if not exists monthly_limit integer default 1500,
  add column if not exists greeting_message text,
  add column if not exists fallback_message text,
  add column if not exists trigger_keywords text[] default array[]::text[],
  add column if not exists blacklist_keywords text[] default array[]::text[];

update public.evolution_ai_config
set
  enabled = coalesce(enabled, auto_reply_enabled, false),
  working_hours_enabled = coalesce(working_hours_enabled, business_hours_only, true),
  hour_start = coalesce(hour_start, extract(hour from business_hours_start)::integer, 9),
  hour_end = coalesce(hour_end, extract(hour from business_hours_end)::integer, 18),
  daily_limit = coalesce(daily_limit, 50),
  monthly_limit = coalesce(monthly_limit, 1500),
  timezone = coalesce(timezone, 'America/Sao_Paulo'),
  working_days = coalesce(working_days, array[1,2,3,4,5]),
  greeting_message = coalesce(greeting_message, 'Ola! Como posso ajudar voce hoje?'),
  fallback_message = coalesce(fallback_message, 'Desculpe, nao consegui entender. Um atendente humano entrara em contato em breve.'),
  trigger_keywords = coalesce(trigger_keywords, array[]::text[]),
  blacklist_keywords = coalesce(blacklist_keywords, array[]::text[]);

alter table public.evolution_ai_config
  alter column model set default 'gpt-5-mini';
