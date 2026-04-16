const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

async function createEvolutionTables() {
  console.log('🚀 Criando tabelas Evolution...');

  // Como não podemos executar DDL via API, vamos testar se conseguimos inserir
  // Se não conseguir, significa que a tabela não existe

  try {
    // Testar inserção em evolution_clients
    await supabase.from('evolution_clients').insert([{
      name: 'test',
      email: 'test@test.com',
      password_hash: 'test'
    }]);
    console.log('✅ Tabela evolution_clients existe e é funcional');

    // Limpar teste
    await supabase.from('evolution_clients').delete().eq('email', 'test@test.com');

  } catch (error) {
    console.log('⚠️ Tabela evolution_clients não existe ou não é acessível');
    console.log('📋 EXECUTE NO SUPABASE SQL EDITOR:');
    console.log('🔗 https://supabase.com/dashboard/project/uznrpziouttnncozxpvf/sql');
    console.log('');
    console.log('-- 1. COPIE E EXECUTE ESTE SCRIPT:');
    console.log(`
-- Tabela de Clientes Evolution
CREATE TABLE evolution_clients (
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

-- Tabela de Contatos Evolution
CREATE TABLE evolution_contacts (
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

-- Tabela de Conversas Evolution
CREATE TABLE evolution_conversations (
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

-- Tabela de Mensagens Evolution
CREATE TABLE evolution_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES evolution_conversations(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES evolution_clients(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES evolution_contacts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text',
    direction VARCHAR(10) NOT NULL,
    status VARCHAR(20) DEFAULT 'sent',
    is_from_ai BOOLEAN DEFAULT FALSE,
    whatsapp_message_id VARCHAR(255),
    media_url TEXT,
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices
CREATE INDEX idx_evolution_contacts_client_id ON evolution_contacts(client_id);
CREATE INDEX idx_evolution_contacts_phone ON evolution_contacts(phone);
CREATE INDEX idx_evolution_conversations_client_id ON evolution_conversations(client_id);
CREATE INDEX idx_evolution_messages_conversation_id ON evolution_messages(conversation_id);

-- RLS (Row Level Security)
ALTER TABLE evolution_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_messages ENABLE ROW LEVEL SECURITY;

-- Políticas RLS
CREATE POLICY "Clientes podem ver apenas seus dados" ON evolution_contacts
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas suas conversas" ON evolution_conversations
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);

CREATE POLICY "Clientes podem ver apenas suas mensagens" ON evolution_messages
    FOR ALL USING (auth.jwt() ->> 'client_id' = client_id::text);
`);
  }
}

createEvolutionTables();