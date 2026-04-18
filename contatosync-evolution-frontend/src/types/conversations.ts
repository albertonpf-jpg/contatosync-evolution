export interface Contact {
  id: string;
  name: string;
  phone: string;
  email?: string;
  whatsapp_number?: string;
  notes?: string;
  status: 'active' | 'inactive' | 'blocked';
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  client_id: string;
  contact_id: string;
  status: 'active' | 'inactive' | 'archived';
  priority: 'low' | 'medium' | 'high';
  lead_stage: 'lead' | 'qualified' | 'opportunity' | 'customer';
  assigned_to?: string;
  tags?: string[];
  notes?: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  evolution_contacts: Contact;
  unread_count?: number;
  last_message?: Message;
}

export interface Message {
  id: string;
  conversation_id: string;
  client_id: string;
  contact_id: string;
  content: string;
  message_type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'sticker';
  direction: 'in' | 'out';
  status: 'sent' | 'delivered' | 'read' | 'failed';
  whatsapp_message_id?: string;
  media_url?: string;
  thumbnail_url?: string;
  is_ai_response?: boolean;
  ai_context?: any;
  created_at: string;
  from_name?: string;
  from_phone?: string;
}

export interface ConversationListResponse {
  data: Conversation[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export interface MessageListResponse {
  data: Message[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export interface SendMessageData {
  conversation_id: string;
  content: string;
  message_type?: 'text' | 'image' | 'audio' | 'video' | 'document';
}