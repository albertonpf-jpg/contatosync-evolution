function lastCustomerTopic(history = []) {
  const items = Array.isArray(history) ? history.slice().reverse() : [];
  const found = items.find(item => {
    const content = String(item.content || '').trim();
    return content && !(item.direction === 'out' || item.is_from_ai);
  });
  return found ? String(found.content || '').trim() : '';
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function isProductFollowUp(text = '') {
  const normalized = normalizeText(text);
  return /\b(mais modelos?|modelos? diferentes?|outras? opcoes|outros? modelos?|mais opcoes|mais fotos?|fotos? diferentes?|sao os mesmos|sao iguais|mesmos modelos?|diferentes?|e esse|esse|essa|tem disponivel)\b/i.test(normalized);
}

function isProductTopic(text = '') {
  const normalized = normalizeText(text);
  return /\b(produto|produtos|catalogo|opcao|opcoes|modelo|modelos|foto|fotos|roupa|roupas|vestido|vestidos|conjunto|conjuntos|blusa|blusas|camiseta|camisetas|moletom|moletons|tenis|calcado|calcados|sapato|sapatos|tamanho|cor|preco|estoque|disponivel)\b/i.test(normalized);
}

function lastCustomerProductTopic(history = [], currentText = '') {
  const current = normalizeText(currentText);
  const items = Array.isArray(history) ? history.slice().reverse() : [];
  const found = items.find(item => {
    const content = String(item.content || '').trim();
    if (!content || normalizeText(content) === current) return false;
    if (item.direction === 'out' || item.is_from_ai) return false;
    return isProductTopic(content);
  });
  return found ? String(found.content || '').trim() : '';
}

async function rewrite({ message = {}, route = {}, retrievalPlan = {} } = {}) {
  const text = String(message.text || '').trim();
  const historyTopic = lastCustomerTopic(message.conversationHistory || []);
  const productHistoryTopic = lastCustomerProductTopic(message.conversationHistory || [], text);
  const missing = Array.isArray(retrievalPlan.needsClarifyingData) ? retrievalPlan.needsClarifyingData : [];

  if (!text) return '';
  if (missing.length > 0) return text;

  if (route.routerMode === 'semantic' && String(route.semantic?.searchQuery || '').trim()) {
    return String(route.semantic.searchQuery || '').trim();
  }

  if ((isProductFollowUp(text) || (route.intent === 'product' && !isProductTopic(text))) && productHistoryTopic) {
    return `${productHistoryTopic}\n${text}`;
  }

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
