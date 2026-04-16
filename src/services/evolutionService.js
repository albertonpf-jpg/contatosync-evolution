const axios = require('axios');

/**
 * Serviço para integração com Evolution API
 */
class EvolutionService {
  constructor() {
    this.baseURL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
    this.apiKey = process.env.EVOLUTION_API_KEY || 'B6D711FCDE4D4FD5936544120E713976';

    this.api = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Content-Type': 'application/json',
        'apikey': this.apiKey
      },
      timeout: 30000
    });
  }

  /**
   * Criar nova instância/sessão WhatsApp
   */
  async createInstance(instanceName, webhookUrl = null) {
    try {
      const payload = {
        instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      };

      if (webhookUrl) {
        payload.webhook = {
          url: webhookUrl,
          events: [
            'APPLICATION_STARTUP',
            'QRCODE_UPDATED',
            'CONNECTION_UPDATE',
            'MESSAGES_UPSERT',
            'MESSAGES_UPDATE',
            'SEND_MESSAGE'
          ]
        };
      }

      const response = await this.api.post('/instance/create', payload);
      return response.data;
    } catch (error) {
      console.error('Erro ao criar instância:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Obter QR Code da instância
   */
  async getQRCode(instanceName) {
    try {
      const response = await this.api.get(`/instance/connect/${instanceName}`);

      console.log('Evolution API QR Response:', JSON.stringify(response.data, null, 2));

      // Diferentes formatos possíveis de resposta da Evolution API
      let qrData = response.data;

      // Se a resposta tem um campo qrcode/base64/qr
      if (qrData.qrcode) {
        qrData.base64 = qrData.qrcode;
      } else if (qrData.qr) {
        qrData.base64 = qrData.qr;
      }

      return qrData;
    } catch (error) {
      console.error('Erro ao obter QR Code:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Verificar status da conexão
   */
  async getConnectionStatus(instanceName) {
    try {
      const response = await this.api.get(`/instance/connectionState/${instanceName}`);
      return response.data;
    } catch (error) {
      console.error('Erro ao verificar status:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Enviar mensagem de texto
   */
  async sendTextMessage(instanceName, phone, message) {
    try {
      const payload = {
        number: phone,
        textMessage: {
          text: message
        }
      };

      const response = await this.api.post(`/message/sendText/${instanceName}`, payload);
      return response.data;
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Listar todas as instâncias
   */
  async getAllInstances() {
    try {
      const response = await this.api.get('/instance/fetchInstances');
      return response.data;
    } catch (error) {
      console.error('Erro ao listar instâncias:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Deletar instância
   */
  async deleteInstance(instanceName) {
    try {
      const response = await this.api.delete(`/instance/delete/${instanceName}`);
      return response.data;
    } catch (error) {
      console.error('Erro ao deletar instância:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Desconectar instância (logout)
   */
  async logoutInstance(instanceName) {
    try {
      const response = await this.api.delete(`/instance/logout/${instanceName}`);
      return response.data;
    } catch (error) {
      console.error('Erro ao fazer logout:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Obter informações do perfil conectado
   */
  async getProfileInfo(instanceName) {
    try {
      const response = await this.api.get(`/chat/whatsappProfile/${instanceName}`);
      return response.data;
    } catch (error) {
      console.error('Erro ao obter perfil:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = new EvolutionService();