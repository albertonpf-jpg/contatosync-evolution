-- Agentic RAG multiusuario com pgvector.
-- Vetor recupera candidatos/contexto; APIs vivas continuam confirmando preco, estoque,
-- imagens, URLs, status de pedido e rastreio.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS rag_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  source_type text NOT NULL,
  source_name text,
  source_url text NOT NULL DEFAULT '',
  external_id text NOT NULL DEFAULT '',
  content_hash text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  last_indexed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  source_id uuid REFERENCES rag_sources(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  topic text,
  content text NOT NULL,
  content_hash text NOT NULL DEFAULT '',
  chunk_index int NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',
  embedding vector(1536),
  embedding_model text,
  token_count int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_sources_unique_source_idx
  ON rag_sources (client_id, source_type, source_url, external_id, content_hash);

CREATE UNIQUE INDEX IF NOT EXISTS rag_chunks_unique_chunk_idx
  ON rag_chunks (client_id, source_id, content_hash, chunk_index);

CREATE INDEX IF NOT EXISTS rag_sources_client_id_idx ON rag_sources (client_id);
CREATE INDEX IF NOT EXISTS rag_sources_status_idx ON rag_sources (status);
CREATE INDEX IF NOT EXISTS rag_chunks_client_id_idx ON rag_chunks (client_id);
CREATE INDEX IF NOT EXISTS rag_chunks_source_id_idx ON rag_chunks (source_id);
CREATE INDEX IF NOT EXISTS rag_chunks_source_type_idx ON rag_chunks (source_type);
CREATE INDEX IF NOT EXISTS rag_chunks_entity_type_idx ON rag_chunks (entity_type);
CREATE INDEX IF NOT EXISTS rag_chunks_entity_id_idx ON rag_chunks (entity_id);
CREATE INDEX IF NOT EXISTS rag_chunks_topic_idx ON rag_chunks (topic);

DO $$
BEGIN
  BEGIN
    CREATE INDEX IF NOT EXISTS rag_chunks_embedding_hnsw_idx
      ON rag_chunks USING hnsw (embedding vector_cosine_ops);
  EXCEPTION WHEN OTHERS THEN
    CREATE INDEX IF NOT EXISTS rag_chunks_embedding_ivfflat_idx
      ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  END;
END $$;

CREATE OR REPLACE FUNCTION set_rag_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rag_sources_set_updated_at ON rag_sources;
CREATE TRIGGER rag_sources_set_updated_at
BEFORE UPDATE ON rag_sources
FOR EACH ROW EXECUTE FUNCTION set_rag_updated_at();

DROP TRIGGER IF EXISTS rag_chunks_set_updated_at ON rag_chunks;
CREATE TRIGGER rag_chunks_set_updated_at
BEFORE UPDATE ON rag_chunks
FOR EACH ROW EXECUTE FUNCTION set_rag_updated_at();

CREATE OR REPLACE FUNCTION match_rag_chunks(
  query_embedding vector(1536),
  match_client_id uuid,
  match_count int DEFAULT 5,
  match_threshold float DEFAULT 0.72,
  filter_entity_type text DEFAULT NULL,
  filter_source_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  client_id uuid,
  source_id uuid,
  source_type text,
  source_name text,
  source_url text,
  entity_type text,
  entity_id text,
  topic text,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.client_id,
    c.source_id,
    c.source_type,
    s.source_name,
    s.source_url,
    c.entity_type,
    c.entity_id,
    c.topic,
    c.content,
    c.metadata,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM rag_chunks c
  LEFT JOIN rag_sources s ON s.id = c.source_id
  WHERE c.client_id = match_client_id
    AND c.embedding IS NOT NULL
    AND (filter_entity_type IS NULL OR c.entity_type = filter_entity_type)
    AND (filter_source_type IS NULL OR c.source_type = filter_source_type)
    AND (1 - (c.embedding <=> query_embedding)) >= match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 50);
$$;
