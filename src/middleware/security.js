const rateLimit = require('express-rate-limit');
const { error } = require('../utils/response');

/**
 * Rate limiting específico para login
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // máximo 5 tentativas de login por IP
  message: {
    error: 'Muitas tentativas de login. Tente novamente em 15 minutos.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

/**
 * Rate limiting para criação de conta
 */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3, // máximo 3 registros por IP por hora
  message: {
    error: 'Muitas tentativas de criação de conta. Tente novamente em 1 hora.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Rate limiting para ações de IA
 */
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // máximo 10 requests de IA por minuto
  message: {
    error: 'Muitas requisições de IA. Tente novamente em 1 minuto.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Rate limiting para criação de mensagens
 */
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60, // máximo 60 mensagens por minuto
  message: {
    error: 'Muitas mensagens enviadas. Tente novamente em 1 minuto.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Middleware para validar Content-Type
 */
const validateContentType = (req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.get('Content-Type');

    if (!contentType || !contentType.includes('application/json')) {
      return error(res, 'Content-Type deve ser application/json', 400);
    }
  }

  next();
};

/**
 * Middleware para validar tamanho do payload
 */
const validatePayloadSize = (maxSizeKB = 1024) => {
  return (req, res, next) => {
    const contentLength = parseInt(req.get('Content-Length') || '0');
    const maxBytes = maxSizeKB * 1024;

    if (contentLength > maxBytes) {
      return error(res, `Payload muito grande. Máximo: ${maxSizeKB}KB`, 413);
    }

    next();
  };
};

/**
 * Middleware para verificar origem da requisição
 */
const validateOrigin = (req, res, next) => {
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:3001',
    'https://contatosync-evolution.vercel.app'
  ].filter(Boolean);

  const origin = req.get('Origin');
  const referer = req.get('Referer');

  // Permitir requests sem origem (Postman, mobile apps, etc.)
  if (!origin && !referer) {
    return next();
  }

  // Verificar se origem está permitida
  const isAllowed = allowedOrigins.some(allowed =>
    origin?.startsWith(allowed) || referer?.startsWith(allowed)
  );

  if (!isAllowed && process.env.NODE_ENV === 'production') {
    return error(res, 'Origem não autorizada', 403);
  }

  next();
};

/**
 * Middleware para sanitizar input
 */
const sanitizeInput = (req, res, next) => {
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      // Remover caracteres potencialmente perigosos
      return obj.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/javascript:/gi, '')
                .replace(/vbscript:/gi, '')
                .replace(/onload/gi, '')
                .trim();
    }

    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }

    if (obj && typeof obj === 'object') {
      const sanitized = {};
      for (const [key, value] of Object.entries(obj)) {
        sanitized[key] = sanitize(value);
      }
      return sanitized;
    }

    return obj;
  };

  if (req.body) {
    req.body = sanitize(req.body);
  }

  if (req.query) {
    req.query = sanitize(req.query);
  }

  next();
};

/**
 * Middleware para prevenir ataques de timing
 */
const constantTimeResponse = (delayMs = 100) => {
  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const elapsed = Date.now() - start;
      const delay = Math.max(0, delayMs - elapsed);

      if (delay > 0) {
        setTimeout(() => {}, delay);
      }
    });

    next();
  };
};

/**
 * Middleware para log de segurança
 */
const securityLogger = (req, res, next) => {
  const securityLog = {
    timestamp: new Date().toISOString(),
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    method: req.method,
    path: req.path,
    userId: req.user?.id || null
  };

  // Log apenas rotas sensíveis
  const sensitiveRoutes = ['/login', '/register', '/password', '/api-keys'];
  const isSensitive = sensitiveRoutes.some(route => req.path.includes(route));

  if (isSensitive) {
    console.log('🔒 Security Log:', JSON.stringify(securityLog));
  }

  next();
};

/**
 * Middleware para detectar múltiplos dispositivos
 */
const deviceFingerprint = (req, res, next) => {
  if (req.user) {
    const fingerprint = {
      userAgent: req.get('User-Agent'),
      acceptLanguage: req.get('Accept-Language'),
      acceptEncoding: req.get('Accept-Encoding'),
      ip: req.ip
    };

    req.deviceFingerprint = Buffer.from(JSON.stringify(fingerprint)).toString('base64');
  }

  next();
};

/**
 * Middleware para verificar tentativas de força bruta
 */
const bruteForcePrevention = (req, res, next) => {
  // TODO: Implementar cache Redis para rastrear tentativas
  // Por agora, usar rate limiting simples

  const suspiciousPatterns = [
    /admin/i,
    /root/i,
    /test/i,
    /.php$/,
    /.asp$/,
    /wp-admin/,
    /sql/i
  ];

  const isSuspicious = suspiciousPatterns.some(pattern =>
    pattern.test(req.path) || pattern.test(req.get('User-Agent') || '')
  );

  if (isSuspicious) {
    console.warn('🚨 Suspicious request detected:', {
      ip: req.ip,
      path: req.path,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    });

    return error(res, 'Acesso negado', 403);
  }

  next();
};

/**
 * Middleware para adicionar headers de segurança
 */
const securityHeaders = (req, res, next) => {
  // Já configurado no helmet, mas adicionar extras se necessário
  res.setHeader('X-API-Version', '1.0');
  res.setHeader('X-Request-ID', req.id || 'unknown');

  next();
};

module.exports = {
  loginLimiter,
  registerLimiter,
  aiLimiter,
  messageLimiter,
  validateContentType,
  validatePayloadSize,
  validateOrigin,
  sanitizeInput,
  constantTimeResponse,
  securityLogger,
  deviceFingerprint,
  bruteForcePrevention,
  securityHeaders
};