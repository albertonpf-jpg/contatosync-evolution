export interface WhatsAppSession {
  id: string;
  client_id: string;
  session_name: string;
  whatsapp_phone?: string;
  qr_code?: string;
  status: 'connected' | 'disconnected' | 'qr_pending' | 'error';
  last_seen?: string;
  device_info?: {
    profilePicture?: string;
    profileName?: string;
    phone?: string;
  };
  webhook_url?: string;
  created_at: string;
  updated_at: string;
  evolution_status?: string;
}

export interface QRCodeResponse {
  base64?: string | null;
  qr?: string | null;
  qrcode?: string | null;
  code?: string;
  status?: string;
  sessionName?: string;
  instance?: {
    instanceName: string;
    status: string;
    state: string;
    createdAt: string;
  };
}

export interface ConnectionStatus {
  instance: {
    instanceName: string;
    state: 'open' | 'close' | 'connecting';
  };
}

export interface SendMessageRequest {
  session_name: string;
  phone: string;
  message: string;
  contact_id?: string;
}

export interface SendMessageResponse {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  message: {
    conversation: string;
  };
  messageTimestamp: number;
  status: string;
}
