alter table public.evolution_ai_config
  add column if not exists semantic_intent_enabled boolean default true,
  add column if not exists require_semantic_intent_classifier boolean default true,
  add column if not exists intent_classifier_model text default 'gpt-4o-mini',
  add column if not exists intent_confidence_threshold numeric default 0.68,
  add column if not exists site_url text default '',
  add column if not exists store_url text default '',
  add column if not exists knowledge_base_url text default '',
  add column if not exists site_urls jsonb default '[]'::jsonb,
  add column if not exists knowledge_source_urls jsonb default '[]'::jsonb,
  add column if not exists source_urls jsonb default '[]'::jsonb;

update public.evolution_ai_config
set semantic_intent_enabled = coalesce(semantic_intent_enabled, true),
    require_semantic_intent_classifier = coalesce(require_semantic_intent_classifier, true),
    intent_classifier_model = coalesce(nullif(intent_classifier_model, ''), coalesce(nullif(model, ''), 'gpt-4o-mini')),
    intent_confidence_threshold = coalesce(intent_confidence_threshold, 0.68),
    site_url = coalesce(site_url, ''),
    store_url = coalesce(store_url, ''),
    knowledge_base_url = coalesce(knowledge_base_url, ''),
    site_urls = coalesce(site_urls, '[]'::jsonb),
    knowledge_source_urls = coalesce(knowledge_source_urls, '[]'::jsonb),
    source_urls = coalesce(source_urls, '[]'::jsonb)
where semantic_intent_enabled is null
   or require_semantic_intent_classifier is null
   or intent_classifier_model is null
   or intent_classifier_model = ''
   or intent_confidence_threshold is null
   or site_url is null
   or store_url is null
   or knowledge_base_url is null
   or site_urls is null
   or knowledge_source_urls is null
   or source_urls is null;

comment on column public.evolution_ai_config.semantic_intent_enabled is 'Enables semantic LLM intent routing instead of keyword-only routing.';
comment on column public.evolution_ai_config.require_semantic_intent_classifier is 'When true, ambiguous or unavailable semantic classification must clarify instead of falling back to token routing.';
comment on column public.evolution_ai_config.intent_classifier_model is 'Model used by the semantic intent classifier.';
comment on column public.evolution_ai_config.intent_confidence_threshold is 'Minimum confidence accepted from the semantic intent classifier.';
comment on column public.evolution_ai_config.site_urls is 'Configured site URLs available as AI knowledge sources.';
comment on column public.evolution_ai_config.knowledge_source_urls is 'Configured knowledge URLs available to grounded AI retrieval.';
comment on column public.evolution_ai_config.source_urls is 'Generic URLs available to AI source readiness and retrieval.';
