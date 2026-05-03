-- Product source fields for AI Config and the current integration schema used by the API.

alter table public.evolution_ai_config
  add column if not exists product_catalog_url text default '',
  add column if not exists product_search_enabled boolean default true;

update public.evolution_ai_config
set
  product_catalog_url = coalesce(product_catalog_url, ''),
  product_search_enabled = coalesce(product_search_enabled, true);

alter table public.evolution_integrations
  add column if not exists api_endpoint text default '',
  add column if not exists api_key text default '',
  add column if not exists api_secret text default '',
  add column if not exists enabled boolean default true,
  add column if not exists status varchar(50) default 'active',
  add column if not exists error_count integer default 0,
  add column if not exists last_error text;

update public.evolution_integrations
set
  api_endpoint = coalesce(api_endpoint, ''),
  api_key = coalesce(api_key, ''),
  api_secret = coalesce(api_secret, ''),
  enabled = coalesce(enabled, is_active, true),
  status = coalesce(status, 'active'),
  error_count = coalesce(error_count, 0);
