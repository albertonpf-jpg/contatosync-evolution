-- Delay used to group consecutive customer messages before the AI answers.

alter table public.evolution_ai_config
  add column if not exists reply_delay_seconds integer default 8;

update public.evolution_ai_config
set reply_delay_seconds = coalesce(reply_delay_seconds, 8);
