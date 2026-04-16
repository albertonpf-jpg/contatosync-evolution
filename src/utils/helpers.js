const moment = require('moment-timezone');
const bcrypt = require('bcryptjs');

/**
 * Utilitários gerais do sistema
 */

/**
 * Gera hash seguro para senha
 * @param {string} password - Senha a ser hashada
 * @returns {Promise<string>} Hash da senha
 */
const hashPassword = async (password) => {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
};

/**
 * Compara senha com hash
 * @param {string} password - Senha em texto
 * @param {string} hash - Hash armazenado
 * @returns {Promise<boolean>} Verdadeiro se coincide
 */
const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

/**
 * Formatar número de telefone
 * @param {string} phone - Número de telefone
 * @returns {string} Número formatado
 */
const formatPhone = (phone) => {
  if (!phone) return '';

  // Remove tudo que não é número
  let cleaned = phone.replace(/\D/g, '');

  // Adiciona código do país se não tiver
  if (cleaned.length === 11 && cleaned.startsWith('0')) {
    cleaned = '55' + cleaned.substring(1);
  } else if (cleaned.length === 10) {
    cleaned = '559' + cleaned;
  } else if (cleaned.length === 11 && !cleaned.startsWith('55')) {
    cleaned = '55' + cleaned;
  }

  return cleaned;
};

/**
 * Verificar se está dentro do horário de funcionamento
 * @param {object} config - Configurações de horário
 * @param {string} timezone - Timezone
 * @returns {boolean} Verdadeiro se dentro do horário
 */
const isWithinWorkingHours = (config, timezone = 'America/Sao_Paulo') => {
  if (!config?.working_hours_enabled) {
    return true;
  }

  const now = moment().tz(timezone);
  const currentDay = now.isoWeekday(); // 1-7 (segunda-domingo)
  const currentHour = now.hour();

  // Verificar se é dia de trabalho
  if (!config.working_days?.includes(currentDay)) {
    return false;
  }

  // Verificar horário
  const startHour = config.hour_start || 0;
  const endHour = config.hour_end || 23;

  if (startHour <= endHour) {
    return currentHour >= startHour && currentHour < endHour;
  } else {
    // Horário que passa da meia-noite
    return currentHour >= startHour || currentHour < endHour;
  }
};

/**
 * Calcular próximo horário de funcionamento
 * @param {object} config - Configurações de horário
 * @param {string} timezone - Timezone
 * @returns {Date} Próximo horário de funcionamento
 */
const getNextWorkingHour = (config, timezone = 'America/Sao_Paulo') => {
  if (!config?.working_hours_enabled) {
    return new Date();
  }

  const now = moment().tz(timezone);
  let next = now.clone();

  const startHour = config.hour_start || 0;
  const workingDays = config.working_days || [1, 2, 3, 4, 5];

  // Se já passou do horário hoje, vai para o próximo dia
  if (next.hour() >= (config.hour_end || 23)) {
    next.add(1, 'day').hour(startHour).minute(0).second(0);
  }

  // Encontrar próximo dia útil
  let attempts = 0;
  while (!workingDays.includes(next.isoWeekday()) && attempts < 7) {
    next.add(1, 'day');
    attempts++;
  }

  // Ajustar para horário de início
  if (next.hour() < startHour) {
    next.hour(startHour).minute(0).second(0);
  }

  return next.toDate();
};

/**
 * Gerar delay aleatório entre min e max segundos
 * @param {number} minSeconds - Mínimo em segundos
 * @param {number} maxSeconds - Máximo em segundos
 * @returns {number} Delay em milissegundos
 */
const randomDelay = (minSeconds = 30, maxSeconds = 90) => {
  const min = minSeconds * 1000;
  const max = maxSeconds * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

/**
 * Sanitizar dados sensíveis antes de retornar
 * @param {object} data - Dados a sanitizar
 * @returns {object} Dados sanitizados
 */
const sanitizeSensitiveData = (data) => {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const sensitive = [
    'password_hash',
    'google_refresh_token',
    'icloud_password',
    'openai_api_key',
    'claude_api_key',
    'api_key',
    'api_secret'
  ];

  const sanitized = { ...data };

  sensitive.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '***';
    }
  });

  return sanitized;
};

/**
 * Formatar dados para log de atividade
 * @param {string} type - Tipo da atividade
 * @param {string} description - Descrição
 * @param {object} metadata - Dados extras
 * @returns {object} Dados formatados
 */
const formatActivity = (type, description, metadata = {}) => {
  return {
    activity_type: type,
    description,
    metadata,
    created_at: new Date().toISOString()
  };
};

/**
 * Validar e limpar JID do WhatsApp
 * @param {string} jid - JID a validar
 * @returns {string} JID limpo
 */
const cleanJid = (jid) => {
  if (!jid) return '';

  // Remover sufixos desnecessários
  return jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
};

/**
 * Calcular paginação
 * @param {number} page - Página atual
 * @param {number} limit - Limite por página
 * @returns {object} Dados de paginação
 */
const getPagination = (page = 1, limit = 20) => {
  const offset = (page - 1) * limit;

  return {
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)), // Max 100, min 1
    offset
  };
};

/**
 * Formatar dados de paginação para resposta
 * @param {number} total - Total de registros
 * @param {number} page - Página atual
 * @param {number} limit - Limite por página
 * @returns {object} Metadados de paginação
 */
const formatPaginationMeta = (total, page, limit) => {
  const totalPages = Math.ceil(total / limit);

  return {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1
  };
};

module.exports = {
  hashPassword,
  comparePassword,
  formatPhone,
  isWithinWorkingHours,
  getNextWorkingHour,
  randomDelay,
  sanitizeSensitiveData,
  formatActivity,
  cleanJid,
  getPagination,
  formatPaginationMeta
};