'use strict';

const INTENTS = {
  AVAILABILITY_CHECK: 'availability_check',
  PRICE_OFFER:        'price_offer',
  SHIPPING_QUESTION:  'shipping_question',
  MEETUP_QUESTION:    'meetup_question',
  ITEM_QUESTION:      'item_question',
  GREETING:           'greeting',
  SPAM:               'spam',
  GENERAL:            'general',
};

const SPAM_PATTERNS = [
  /bit\.ly|tinyurl|goo\.gl/i,
  /click here|free money|congratulations you (won|have been selected)/i,
  /send me your (number|phone|email|address) first/i,
  /paypal\.me\//i,
  /i can pay (via|with) (zelle|cashapp|venmo) only/i,
  /shipping only\s*,?\s*no local/i,
  /already sold|item not available/i,
];

const AVAILABILITY_PATTERNS = [
  /still\s+available/i,
  /is\s+(it|this)\s+available/i,
  /available\s*\?/i,
  /do\s+you\s+still\s+have/i,
  /have\s+you\s+sold/i,
  /is\s+(it|this)\s+taken/i,
  /still\s+for\s+sale/i,
  /can\s+i\s+(buy|get|have)\s+(it|this)/i,
];

const PRICE_PATTERNS = [
  /would\s+you\s+take/i,
  /can\s+you\s+do/i,
  /how\s+(about|does)\s+\$?\d/i,
  /best\s+(price|offer)/i,
  /lowest\s+(price|you.ll take)/i,
  /\bobo\b/i,
  /make\s+(me\s+)?(an?\s+)?offer/i,
  /negotiate|negotiable/i,
  /firm\s+on\s+price/i,
  /\$\d+/,
  /\d+\s+dollars/i,
  /offer(ing)?\s+\$?\d/i,
  /accept\s+\$?\d/i,
  /pay\s+\$?\d+/i,
  /settle\s+for/i,
];

const SHIPPING_PATTERNS = [
  /\bship(ping|ped)?\b/i,
  /\bdeliver(y|ing)?\b/i,
  /\bmail\b/i,
  /\bfedex\b|\bups\b|\busps\b/i,
  /\bpostage\b/i,
  /can\s+you\s+(ship|send|mail)/i,
  /do\s+you\s+(ship|deliver)/i,
];

const MEETUP_PATTERNS = [
  /pick\s*(up|ing)/i,
  /\bmeet(up)?\b/i,
  /\blocation\b/i,
  /where\s+(are\s+you|do\s+you)/i,
  /\blocal\s+only\b/i,
  /\bpickup\s+only\b/i,
  /what\s+(city|area|zip)/i,
  /\bnearby\b|\bclose\s+to\b/i,
  /can\s+i\s+come/i,
  /\baddress\b/i,
];

const GREETING_PATTERNS = [
  /^(hi|hey|hello|howdy|sup|yo|hiya)[\s!.]*$/i,
  /^(good\s+(morning|afternoon|evening))[\s!.]*$/i,
  /^(interested|i.m\s+interested)[\s!.]*$/i,
];

function classifyIntent(text) {
  const t = (text || '').trim();

  for (const p of SPAM_PATTERNS) {
    if (p.test(t)) return INTENTS.SPAM;
  }

  for (const p of GREETING_PATTERNS) {
    if (p.test(t)) return INTENTS.GREETING;
  }

  for (const p of AVAILABILITY_PATTERNS) {
    if (p.test(t)) return INTENTS.AVAILABILITY_CHECK;
  }

  for (const p of PRICE_PATTERNS) {
    if (p.test(t)) return INTENTS.PRICE_OFFER;
  }

  for (const p of SHIPPING_PATTERNS) {
    if (p.test(t)) return INTENTS.SHIPPING_QUESTION;
  }

  for (const p of MEETUP_PATTERNS) {
    if (p.test(t)) return INTENTS.MEETUP_QUESTION;
  }

  return INTENTS.ITEM_QUESTION;
}

function extractOfferedPrice(text) {
  const patterns = [
    /(?:take|accept|do|go|want|offer(?:ing)?|pay(?:ing)?|settle\s+for)\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)/i,
    /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/,
    /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?|bucks?)/i,
    /how\s+about\s+\$?\s*(\d[\d,]*)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val > 0 && val < 100000) return val;
    }
  }
  return null;
}

function parseListingPrice(priceStr) {
  if (!priceStr) return null;
  const m = String(priceStr).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

function buildNegotiationReply({ offeredPrice, listingPrice, floorPrice, counterPrice, customerName }) {
  const name = customerName || 'there';

  if (offeredPrice < floorPrice * 0.5) {
    return `Hi ${name}! Thanks for the offer — unfortunately $${offeredPrice} is a bit too far from what I'm looking for. I have it listed at $${listingPrice} and the lowest I can go is $${floorPrice}. Let me know if that works!`;
  }

  if (offeredPrice < floorPrice) {
    const counter = counterPrice || Math.round((offeredPrice + listingPrice) / 2);
    return `Hi ${name}! Thanks for reaching out. I can't quite go that low, but I could do $${counter} — that's the best I can do. Interested?`;
  }

  return null;
}

function buildAvailabilityReply(customerName, profile) {
  const name = customerName || 'there';
  const price = profile?.price ? ` — still listed at ${profile.price}` : '';
  return `Hi ${name}! Yes, it's still available${price}. Are you interested in it?`;
}

function buildGreetingReply(customerName, profile) {
  const name = customerName || 'there';
  const item = profile?.title ? `the ${profile.title}` : 'this item';
  const price = profile?.price ? ` at ${profile.price}` : '';
  return `Hi ${name}! Thanks for your interest in ${item}${price}. It's still available — do you have any questions or would you like to set up a pickup time?`;
}

function routeMessage({ message, profile, customerName }) {
  const intent = classifyIntent(message);

  if (intent === INTENTS.SPAM) {
    return { intent, skip: true, fastReply: null };
  }

  if (intent === INTENTS.AVAILABILITY_CHECK) {
    return { intent, fastReply: buildAvailabilityReply(customerName, profile), skip: false };
  }

  if (intent === INTENTS.GREETING) {
    return { intent, fastReply: buildGreetingReply(customerName, profile), skip: false };
  }

  if (intent === INTENTS.PRICE_OFFER) {
    const offeredPrice = extractOfferedPrice(message);
    const listingPrice = parseListingPrice(profile?.price);
    const floorPrice = profile?.minPrice
      ? parseFloat(profile.minPrice)
      : listingPrice
        ? Math.round(listingPrice * 0.75)
        : null;

    if (offeredPrice && listingPrice && floorPrice && offeredPrice < floorPrice) {
      const counterPrice = Math.round((offeredPrice + listingPrice) / 2);
      const fastReply = buildNegotiationReply({
        offeredPrice,
        listingPrice,
        floorPrice,
        counterPrice,
        customerName,
      });
      return {
        intent,
        fastReply,
        skip: false,
        meta: { offeredPrice, listingPrice, floorPrice, counterPrice },
      };
    }

    return { intent, fastReply: null, skip: false };
  }

  return { intent, fastReply: null, skip: false };
}

module.exports = {
  INTENTS,
  classifyIntent,
  extractOfferedPrice,
  routeMessage,
};
