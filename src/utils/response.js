/**
 * Utilitários para padronizar respostas da API
 */

/**
 * Resposta de sucesso
 * @param {object} res - Response object
 * @param {*} data - Dados para retornar
 * @param {string} message - Mensagem de sucesso
 * @param {number} status - Status HTTP
 */
const success = (res, data = null, message = 'Sucesso', status = 200) => {
  const response = {
    success: true,
    message,
    timestamp: new Date().toISOString()
  };

  if (data !== null) {
    response.data = data;
  }

  return res.status(status).json(response);
};

/**
 * Resposta de erro
 * @param {object} res - Response object
 * @param {string} message - Mensagem de erro
 * @param {number} status - Status HTTP
 * @param {*} details - Detalhes do erro
 */
const error = (res, message = 'Erro interno', status = 500, details = null) => {
  const response = {
    success: false,
    error: message,
    timestamp: new Date().toISOString()
  };

  if (details) {
    response.details = details;
  }

  return res.status(status).json(response);
};

/**
 * Resposta de erro de validação
 * @param {object} res - Response object
 * @param {Array} errors - Array de erros de validação
 */
const validationError = (res, errors) => {
  return error(res, 'Dados inválidos', 400, errors);
};

/**
 * Resposta de erro de autorização
 * @param {object} res - Response object
 * @param {string} message - Mensagem personalizada
 */
const unauthorized = (res, message = 'Não autorizado') => {
  return error(res, message, 401);
};

/**
 * Resposta de erro de acesso negado
 * @param {object} res - Response object
 * @param {string} message - Mensagem personalizada
 */
const forbidden = (res, message = 'Acesso negado') => {
  return error(res, message, 403);
};

/**
 * Resposta de erro de não encontrado
 * @param {object} res - Response object
 * @param {string} message - Mensagem personalizada
 */
const notFound = (res, message = 'Recurso não encontrado') => {
  return error(res, message, 404);
};

/**
 * Resposta de erro de conflito
 * @param {object} res - Response object
 * @param {string} message - Mensagem personalizada
 */
const conflict = (res, message = 'Conflito de dados') => {
  return error(res, message, 409);
};

/**
 * Resposta paginada
 * @param {object} res - Response object
 * @param {Array} data - Dados da página atual
 * @param {object} pagination - Informações de paginação
 * @param {string} message - Mensagem de sucesso
 */
const paginated = (res, data, pagination, message = 'Dados recuperados com sucesso') => {
  return success(res, {
    items: data,
    pagination
  }, message);
};

/**
 * Wrapper para lidar com erros async
 * @param {function} fn - Função async
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Processa erros do Supabase e retorna resposta adequada
 * @param {object} res - Response object
 * @param {object} error - Erro do Supabase
 * @param {string} defaultMessage - Mensagem padrão
 */
const handleSupabaseError = (res, error, defaultMessage = 'Erro na base de dados') => {
  console.error('Supabase error:', error);

  // Erro de RLS ou permissão
  if (error.code === 'PGRST116' || error.message?.includes('permission denied')) {
    return forbidden(res, 'Acesso negado aos dados');
  }

  // Erro de violação de constraint
  if (error.code === '23505') {
    return conflict(res, 'Dados duplicados');
  }

  // Erro de foreign key
  if (error.code === '23503') {
    return error(res, 'Referência inválida', 400);
  }

  // Erro de dados não encontrados
  if (error.code === 'PGRST116' || error.details?.includes('0 rows')) {
    return notFound(res, 'Recurso não encontrado');
  }

  return res.status(500).json({
    success: false,
    message: defaultMessage,
    timestamp: new Date().toISOString(),
    details: {
      code: error.code,
      message: error.message
    }
  });
};

module.exports = {
  success,
  error,
  validationError,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  paginated,
  asyncHandler,
  handleSupabaseError
};