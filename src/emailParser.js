function extractEmail(from) {
  if (!from || typeof from !== 'string') return null;

  const bracketMatch = from.match(/<([^>]+)>/);
  if (bracketMatch) {
    return bracketMatch[1].trim().toLowerCase();
  }

  const plainMatch = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plainMatch ? plainMatch[0].trim().toLowerCase() : null;
}

function extractName(from) {
  if (!from || typeof from !== 'string') return null;

  const cleaned = from.replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
  if (!cleaned) return null;
  return cleaned;
}

function stripQuotedReply(text) {
  if (!text || typeof text !== 'string') return '';

  const separators = [
    '\nOn ',
    '\nFrom:',
    '\nSent from my',
    '\n---',
    '\n________________________________',
  ];

  let output = text;
  for (const sep of separators) {
    const index = output.indexOf(sep);
    if (index > 0) {
      output = output.slice(0, index);
    }
  }

  return output.trim();
}

function toQuestion(subject, text) {
  const body = stripQuotedReply(text);
  const firstLine = body
    .split('\n')
    .map((x) => x.trim())
    .find(Boolean);

  if (firstLine) return firstLine;
  if (subject && subject.trim()) return subject.trim();
  return 'Is this item still available?';
}

function parseCraigslistEmail(payload) {
  const from = payload?.from || '';
  const subject = payload?.subject || '';
  const text = payload?.text || '';

  const senderEmail = extractEmail(from) || 'craigslist:unknown';
  const senderName = extractName(from) || 'there';
  const question = toQuestion(subject, text);

  return {
    senderId: `craigslist:${senderEmail}`,
    customerName: senderName,
    question,
  };
}

module.exports = {
  parseCraigslistEmail,
};
