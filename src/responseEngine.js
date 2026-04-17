const OpenAI = require('openai');

function buildFaqAnswer(question, profile) {
  const q = question.toLowerCase();

  if (/price|lowest|negotiable|firm/.test(q)) {
    if (profile.price) {
      return `The current listed price is ${profile.price}. If you want, I can let you know how flexible the seller is.`;
    }
    return 'The listing has not set a specific price in the uploaded description yet, but I can ask the seller for the best offer range.';
  }

  if (/condition|scratch|damage|works|working|issue/.test(q)) {
    if (profile.condition) {
      return `Condition is listed as ${profile.condition}. It is described in the listing notes, and I can share specific details if you want a closer inspection summary.`;
    }
    return 'The uploaded listing does not specify a formal condition rating, but I can summarize all quality-related notes from the description for you.';
  }

  if (/available|still have|in stock/.test(q)) {
    return 'Yes, this item is still being tracked as available right now. I can also help schedule pickup timing if you are ready.';
  }

  if (/pickup|pick up|delivery|ship|location/.test(q)) {
    return 'Pickup and delivery details are handled by the seller directly. If you share your preferred area and time, I can draft a message to coordinate quickly.';
  }

  if (/size|dimension|measure/.test(q)) {
    return 'Size and measurements are not clearly structured in the uploaded listing. I can prepare a concise message asking the seller for exact dimensions.';
  }

  return null;
}

function channelStyleHint(channel) {
  if (channel === 'facebook_messenger') {
    return 'Keep it short, chat-like, and friendly for Messenger.';
  }

  if (channel === 'facebook_marketplace') {
    return 'Keep it practical and buyer-focused for Marketplace chat.';
  }

  if (channel === 'ebay') {
    return 'Use a professional tone suitable for eBay buyers.';
  }

  if (channel === 'etsy') {
    return 'Use a warm and detail-oriented tone suitable for handmade listings.';
  }

  if (channel === 'offerup') {
    return 'Keep it brief and practical, optimized for quick mobile chat.';
  }

  if (channel === 'mercari') {
    return 'Use a concise buyer-assist tone with clear next steps.';
  }

  if (channel === 'poshmark') {
    return 'Use a friendly fashion-commerce tone with confidence and clarity.';
  }

  if (channel === 'craigslist') {
    return 'Use direct and safety-conscious wording suitable for local transactions.';
  }

  return 'Use a clear and concise marketplace-sales tone.';
}

function fallbackAnswer(question, customerName, profile, history = [], channel = 'facebook_marketplace') {
  const faqAnswer = buildFaqAnswer(question, profile);
  const style = channelStyleHint(channel);
  if (faqAnswer) {
    return `Hi ${customerName}, thanks for your question. ${faqAnswer} ${style}`;
  }

  const highlights = profile.highlights.length
    ? profile.highlights.slice(0, 3).join('; ')
    : 'the full listing details';

  const continuity = history.length > 0 ? ' I also remember your earlier questions, so I can keep replies consistent.' : '';
  return `Hi ${customerName}, thanks for reaching out. Based on the listing, this item includes: ${highlights}.${continuity} ${style} If you tell me what matters most to you, I can give a more specific answer.`;
}

async function llmAnswer(question, customerName, profile, history = [], channel = 'facebook_marketplace') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.MODEL_NAME || 'gpt-4o-mini';

  const prompt = [
    'You are an auto-responder assistant for marketplace sellers.',
    'Write a short personalized message to a buyer.',
    'Keep tone friendly, clear, and sales-supportive.',
    channelStyleHint(channel),
    'Never invent facts not present in product data.',
    'If data is missing, say that clearly and offer next step.',
    '',
    `Customer name: ${customerName}`,
    `Customer question: ${question}`,
    `Channel: ${channel}`,
    '',
    'Recent conversation history JSON (oldest to newest):',
    JSON.stringify(history, null, 2),
    '',
    'Product profile JSON:',
    JSON.stringify(profile, null, 2),
  ].join('\n');

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You generate high-quality marketplace inquiry responses.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.4,
    max_tokens: 220,
  });

  return response.choices?.[0]?.message?.content?.trim() || null;
}

async function generateResponse({ question, customerName, profile, history = [], channel = 'facebook_marketplace' }) {
  const aiAnswer = await llmAnswer(question, customerName, profile, history, channel).catch(() => null);
  if (aiAnswer) {
    return aiAnswer;
  }

  return fallbackAnswer(question, customerName, profile, history, channel);
}

module.exports = {
  generateResponse,
};
