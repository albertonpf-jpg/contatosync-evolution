alter table public.evolution_ai_config
  add column if not exists product_source_urls jsonb default '[]'::jsonb,
  add column if not exists knowledge_files jsonb default '[]'::jsonb;

update public.evolution_ai_config
set product_source_urls = '[]'::jsonb
where product_source_urls is null;

update public.evolution_ai_config
set knowledge_files = '[]'::jsonb
where knowledge_files is null;
