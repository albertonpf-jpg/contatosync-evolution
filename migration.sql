-- ContatoSync Evolution - Migration Script
-- Execute este script no Supabase SQL Editor

-- 1. Tabela de Clientes
CREATE TABLE IF NOT EXISTS evolution_clients (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    phone VARCHAR(50),
    company_name VARCHAR(255),
    plan VARCHAR(50) DEFAULT 'basic',
    status VARCHAR(20) DEFAULT 'active',
    total_contacts_saved INTEGER DEFAULT 0,
    total_messages_sent INTEGER DEFAULT 0,
    total_ai_responses INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Tabela de Contatos
CREATE TABLE IF NOT EXISTS evolution_contacts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255),
    whatsapp_number VARCHAR(50),
    notes TEXT,
    status VARCHAR(20) DEFAULT 'active',
    tags TEXT[],
    last_message_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(client_id, phone)
);

-- 3. Tabela de Conversas
CREATE TABLE IF NOT EXISTS evolution_conversations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES evolution_contacts(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'active',
    last_message_at TIMESTAMP WITH TIME ZONE,
    unread_count INTEGER DEFAULT 0,
    is_pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(client_id, contact_id)
);

-- 4. Tabela de Mensagens
CREATE TABLE IF NOT EXISTS evolution_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES evolution_conversations(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES evolution_contacts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text',
    direction VARCHAR(10) NOT NULL, -- 'in' ou 'out'
    status VARCHAR(20) DEFAULT 'sent',
    is_from_ai BOOLEAN DEFAULT FALSE,
    whatsapp_message_id VARCHAR(255),
    media_url TEXT,
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Tabela de Configuração IA
CREATE TABLE IF NOT EXISTS evolution_ai_config (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    provider VARCHAR(20) DEFAULT 'openai', -- 'openai', 'claude', etc
    api_key_encrypted TEXT,
    model VARCHAR(100) DEFAULT 'gpt-3.5-turbo',
    temperature DECIMAL(2,1) DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 1000,
    system_prompt TEXT,
    auto_reply_enabled BOOLEAN DEFAULT FALSE,
    reply_delay_seconds INTEGER DEFAULT 5,
    business_hours_only BOOLEAN DEFAULT FALSE,
    business_hours_start TIME DEFAULT '09:00:00',
    business_hours_end TIME DEFAULT '18:00:00',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(client_id)
);

-- 6. Tabela de Logs IA
CREATE TABLE IF NOT EXISTS evolution_ai_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES evolution_conversations(id) ON DELETE CASCADE,
    input_message TEXT NOT NULL,
    ai_response TEXT NOT NULL,
    tokens_used INTEGER,
    cost_usd DECIMAL(10,6),
    response_time_ms INTEGER,
    provider VARCHAR(20),
    model VARCHAR(100),
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Tabela de Atividades
CREATE TABLE IF NOT EXISTS evolution_activities (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    activity_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    metadata JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Tabela de Sessões
CREATE TABLE IF NOT EXISTS evolution_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    session_name VARCHAR(255) NOT NULL,
    whatsapp_phone VARCHAR(50),
    qr_code TEXT,
    status VARCHAR(20) DEFAULT 'disconnected', -- 'connected', 'disconnected', 'qr_pending'
    last_seen TIMESTAMP WITH TIME ZONE,
    device_info JSONB,
    webhook_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Tabela de Integrações
CREATE TABLE IF NOT EXISTS evolution_integrations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    integration_type VARCHAR(50) NOT NULL,
    integration_name VARCHAR(255) NOT NULL,
    config JSONB NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_sync TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_evolution_contacts_client_id ON evolution_contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_evolution_contacts_phone ON evolution_contacts(phone);
CREATE INDEX IF NOT EXISTS idx_evolution_conversations_client_id ON evolution_conversations(client_id);
CREATE INDEX IF NOT EXISTS idx_evolution_messages_conversation_id ON evolution_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_evolution_messages_created_at ON evolution_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_evolution_activities_client_id ON evolution_activities(client_id);
CREATE INDEX IF NOT EXISTS idx_evolution_activities_created_at ON evolution_activities(created_at);

-- Row Level Security (RLS)
ALTER TABLE evolution_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_ai_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_ai_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_integrations ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para isolamento por cliente
CREATE POLICY "Clientes podem ver apenas seus dados" ON evolution_contacts
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas suas conversas" ON evolution_conversations
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas suas mensagens" ON evolution_messages
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas sua config IA" ON evolution_ai_config
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas seus logs IA" ON evolution_ai_log
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas suas atividades" ON evolution_activities
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas suas sessões" ON evolution_sessions
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas suas integrações" ON evolution_integrations
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

-- Função para update automático do timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para updated_at
CREATE TRIGGER update_evolution_clients_updated_at BEFORE UPDATE ON evolution_clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_evolution_contacts_updated_at BEFORE UPDATE ON evolution_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_evolution_conversations_updated_at BEFORE UPDATE ON evolution_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_evolution_ai_config_updated_at BEFORE UPDATE ON evolution_ai_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_evolution_sessions_updated_at BEFORE UPDATE ON evolution_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_evolution_integrations_updated_at BEFORE UPDATE ON evolution_integrations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();