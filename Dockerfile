# ContatoSync Evolution API - Dockerfile

FROM node:20-alpine

# Instalar dependências do sistema
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev

# Criar diretório da aplicação
WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar dependências - usar npm install com legacy-peer-deps
RUN npm install --only=production --legacy-peer-deps

# Copiar TUDO (exceto o que está no .dockerignore)
COPY . .

# Criar usuário não-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001

# Alterar ownership dos arquivos
RUN chown -R nodeuser:nodejs /app
USER nodeuser

# Expor porta
EXPOSE 3003

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node healthcheck.js

# Comando de início
CMD ["node", "server-baileys.js"]