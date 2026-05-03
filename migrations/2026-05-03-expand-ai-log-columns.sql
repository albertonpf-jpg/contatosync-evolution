-- Keep AI logs compatible with the runtime fields used by aiService.

alter table public.evolution_ai_log
  add column if not exists model_used varchar(100),
  add column if not exists prompt_tokens integer default 0,
  add column if not exists completion_tokens integer default 0,
  add column if not exists total_tokens integer default 0,
  add column if not exists confidence_score numeric,
  add column if not exists processing_time_ms integer default 0,
  add column if not exists status varchar(20) default 'success';

alter table public.evolution_ai_log
  alter column input_message drop not null,
  alter column ai_response drop not null;

update public.evolution_ai_log
set
  model_used = coalesce(model_used, model),
  total_tokens = coalesce(total_tokens, tokens_used, 0),
  processing_time_ms = coalesce(processing_time_ms, response_time_ms, 0),
  status = coalesce(status, case when success is false then 'error' else 'success' end);
