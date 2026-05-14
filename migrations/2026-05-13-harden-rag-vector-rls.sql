-- Hardening multiusuario para tabelas/funcoes do Agentic RAG.
-- O backend deve acessar via service_role; clientes finais nao devem consultar chunks
-- diretamente nem executar busca vetorial informando client_id arbitrario.

ALTER TABLE rag_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rag_sources_service_role_all ON rag_sources;
CREATE POLICY rag_sources_service_role_all
ON rag_sources
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS rag_chunks_service_role_all ON rag_chunks;
CREATE POLICY rag_chunks_service_role_all
ON rag_chunks
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL ON TABLE rag_sources FROM anon, authenticated;
REVOKE ALL ON TABLE rag_chunks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rag_sources TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rag_chunks TO service_role;

REVOKE EXECUTE ON FUNCTION match_rag_chunks(vector, uuid, integer, double precision, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION match_rag_chunks(vector, uuid, integer, double precision, text, text) TO service_role;
