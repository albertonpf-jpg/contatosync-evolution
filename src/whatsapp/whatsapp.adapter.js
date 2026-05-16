function createWhatsAppAdapter({ sendTextMessage, sendCarouselMessage } = {}) {
  return {
    async sendMessage({ sessionName, to, text }) {
      if (typeof sendTextMessage !== 'function') return { skipped: true, text };
      return sendTextMessage(sessionName, to, text);
    },
    async sendCards({ sessionName, to, body, cards }) {
      if (typeof sendCarouselMessage !== 'function') return { skipped: true, cards };
      return sendCarouselMessage(sessionName, to, { body, cards });
    }
  };
}

module.exports = {
  createWhatsAppAdapter
};
