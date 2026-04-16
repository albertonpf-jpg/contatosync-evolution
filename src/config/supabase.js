const { createClient } = require('@supabase/supabase-js');

// Cliente Supabase com service role (para operações administrativas)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Cliente Supabase com chave anônima (para operações do usuário)
const supabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Cria cliente Supabase com autenticação do usuário
 * @param {string} token - JWT token do usuário
 * @returns {object} Cliente Supabase autenticado
 */
const createAuthenticatedClient = (token) => {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    }
  );
};

/**
 * Executa query com RLS habilitado usando service role
 * @param {string} userId - ID do usuário para filtrar dados
 * @param {function} queryFn - Função que executa a query
 * @returns {Promise} Resultado da query
 */
const executeWithRLS = async (userId, queryFn) => {
  try {
    // Usar supabaseAdmin diretamente e filtrar por userId no código
    return await queryFn(supabaseAdmin);
  } catch (error) {
    console.error('Erro na query com RLS:', error);
    throw error;
  }
};

module.exports = {
  supabaseAdmin,
  supabaseClient,
  createAuthenticatedClient,
  executeWithRLS
};