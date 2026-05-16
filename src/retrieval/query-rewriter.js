function lastCustomerTopic(history = []) {
  const items = Array.isArray(history) ? history.slice().reverse() : [];
  const found = items.find(item => {
    const content = String(item.content || '').trim();
    return content && !(item.direction === 'out' || item.is_from_ai);
  });
  return found ? String(found.content || '').trim() : '';
}

async function rewrite({ message = {}, route = {}, retrievalPlan = {} } = {}) {
  const text = String(message.text || '').trim();
  const historyTopic = lastCustomerTopic(message.conversationHistory || []);
  const missing = Array.isArray(retrievalPlan.needsClarifyingData) ? retrievalPlan.needsClarifyingData : [];

  if (!text) return '';
  if (missing.length > 0) return text;

  if (/^(quanto custa|quanto fica|e esse|esse|essa|tem disponivel|tem disponível|mais opcoes|mais opções)$/i.test(text) && historyTopic) {
    return `${historyTopic}\n${text}`;
  }

  if (route.intent === 'order_status') {
    return `${text} status pedido rastreio entrega`.trim();
  }

  if (route.intent === 'product') {
    return text.replace(/\b(roupa da|roupa do|voce tem|voc[eê]s tem|tem)\b/gi, '').trim() || text;
  }

  return text;
}

module.exports = {
  rewrite
};
