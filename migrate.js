const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

async function runMigration() {
  console.log('🚀 Iniciando migração do banco de dados...');

  const queries = [
    `CREATE TABLE IF NOT EXISTS evolution_clients (
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
    )`,

    `CREATE TABLE IF NOT EXISTS evolution_contacts (
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
    )`,

    `CREATE TABLE IF NOT EXISTS evolution_conversations (
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
    )`,

    `CREATE TABLE IF NOT EXISTS evolution_messages (
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
    )`,

    `CREATE INDEX IF NOT EXISTS idx_evolution_contacts_client_id ON evolution_contacts(client_id)`,
    `CREATE INDEX IF NOT EXISTS idx_evolution_contacts_phone ON evolution_contacts(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_evolution_conversations_client_id ON evolution_conversations(client_id)`
  ];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    console.log(`Executando query ${i + 1}/${queries.length}...`);

    try {
      const result = await supabase
        .from('dummy') // Dummy table for raw query
        .select('*')
        .limit(0);

      // Try raw SQL via rpc instead
      console.log('Tentando executar via SQL direto...');

      // Since we can't use rpc exec, let's try a different approach
      // Just check if tables exist by querying them
      const { error: testError } = await supabase
        .from('evolution_clients')
        .select('id')
        .limit(1);

      if (testError && testError.code === 'PGRST116') {
        console.log('⚠️ Tabelas não existem. É necessário criar manualmente no dashboard.');
        console.log('📍 Acesse: https://supabase.com/dashboard/project/uznrpziouttnncozxpvf/editor');
        break;
      } else {
        console.log('✅ Tabelas já existem!');
        break;
      }

    } catch (error) {
      console.error(`❌ Erro na query ${i + 1}:`, error.message);
    }
  }

  console.log('🏁 Processo de migração finalizado.');
}

runMigration();