function compactText(text) {
  return text
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function detectPrice(text) {
  const match = text.match(/(\$\s?\d+[\d,]*(?:\.\d{2})?)/i);
  return match ? match[1].replace(/\s+/g, '') : null;
}

function detectCondition(text) {
  const keywords = [
    'new',
    'like new',
    'excellent',
    'good',
    'fair',
    'used',
    'refurbished',
  ];

  const lower = text.toLowerCase();
  const found = keywords.find((k) => lower.includes(k));
  return found || null;
}

function pickTitle(text) {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0);
  if (!firstLine) return 'Marketplace Item';
  return firstLine.trim().slice(0, 80);
}

function extractHighlights(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const bulletLines = lines.filter((line) => /^[-*•]/.test(line));
  if (bulletLines.length > 0) {
    return bulletLines.slice(0, 8).map((line) => line.replace(/^[-*•]\s*/, ''));
  }

  return lines.slice(1, 7);
}

function parseProductDescription(rawText) {
  const source = compactText(rawText);

  return {
    title: pickTitle(source),
    price: detectPrice(source),
    condition: detectCondition(source),
    highlights: extractHighlights(source),
    fullDescription: source,
    uploadedAt: new Date().toISOString(),
  };
}

module.exports = {
  parseProductDescription,
};
