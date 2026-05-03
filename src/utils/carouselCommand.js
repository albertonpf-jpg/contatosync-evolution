function cleanPart(value) {
  return String(value || '').trim();
}

function parseButton(rawButton) {
  const [type, label, value] = String(rawButton || '').split('^').map(cleanPart);
  if (!type || !label) return null;

  if (type === 'reply') {
    return {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: label,
        id: value || label
      })
    };
  }

  if (type === 'url' || type === 'cta_url') {
    return {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: label,
        url: value,
        merchant_url: value
      })
    };
  }

  return null;
}

function parseCarouselCard(rawCard) {
  const [title, imageUrl, footer, rawButtons] = String(rawCard || '').split('*').map(cleanPart);
  if (!title || !/^https?:\/\//i.test(imageUrl)) return null;

  const buttons = String(rawButtons || '')
    .split('~')
    .map(parseButton)
    .filter(Boolean);

  return {
    title,
    description: title,
    footer,
    imageUrl,
    buttons
  };
}

function parseCarouselCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.toLowerCase().startsWith('#carousel|')) return null;

  const [headerPart, ...cardParts] = raw.split('||');
  const [, title, body, footer] = headerPart.split('|').map(cleanPart);
  const cards = cardParts.map(parseCarouselCard).filter(Boolean);

  if (cards.length === 0) {
    throw new Error('Comando de carrossel sem cards validos');
  }

  return {
    title: title || 'Carrossel',
    body: body || title || 'Carrossel',
    footer: footer || '',
    cards
  };
}

module.exports = {
  parseCarouselCommand
};
