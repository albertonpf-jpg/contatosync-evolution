-- Add AI provider settings used by the Settings and IA Config screens.
-- Run in Supabase SQL Editor when preparing a fresh database.

alter table public.evolution_clients
  add column if not exists openai_api_key text,
  add column if not exists claude_api_key text,
  add column if not exists ai_model varchar(100) default 'gpt-4o-mini',
  add column if not exists ai_enabled boolean default false,
  add column if not exists daily_ai_limit integer default 50,
  add column if not exists auto_reply_enabled boolean default true,
  add column if not exists working_hours_start integer default 9,
  add column if not exists working_hours_end integer default 18;

alter table public.evolution_clients
  alter column openai_api_key type text,
  alter column claude_api_key type text;
