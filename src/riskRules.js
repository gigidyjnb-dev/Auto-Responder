function parsePriceValue(value) {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseOffer(question) {
  if (!question) return null;
  // Match "$100", "$ 100", and bare numbers in offer context ("can do 80", "offer 75")
  const dollarMatch = String(question).match(/\$\s?(\d+[\d,]*(?:\.\d{1,2})?)/);
  if (dollarMatch) {
    const n = Number(dollarMatch[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const offerContextMatch = String(question).match(
    /(?:can do|i'?ll? (?:do|give|pay|offer)|offer(?:ing)?|go up to|take)\s+(\d+)(?:\s+(?:dollars?|bucks?))?/i
  );
  if (offerContextMatch) {
    const n = Number(offerContextMatch[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function hasScamSignals(question) {
  const custom = process.env.SCAM_KEYWORDS || 'code,verification,zelle only,wire transfer,cashier check,ship to my cousin';
  const words = custom
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const q = String(question || '').toLowerCase();
  return words.filter((w) => q.includes(w));
}

function scoreBuyerIntent(question, listingPrice) {
  const q = String(question || '').toLowerCase();
  // Start conservative — unknown buyer earns their score
  let score = 40;
  const signals = [];
  let positiveCount = 0;

  // ── Strong commitment ──────────────────────────────────────────────────────
  if (/\bi('?ll| will) (take|buy|get) it\b|i('?m| am) ready|\bsold\b|\bdeal\b/.test(q)) {
    score += 40;
    signals.push('Commitment language detected');
    positiveCount++;
  }
  // Short standalone affirmatives ("Perfect!", "Sounds good", "Deal")
  if (/^(perfect|sounds good|deal|sold|i('?ll?| will) take it|i want it)[.!]?\s*$/i.test(q.trim())) {
    score += 35;
    signals.push('Strong standalone affirmative');
    positiveCount++;
  }

  // ── Cash signals ───────────────────────────────────────────────────────────
  if (/\bcash (ready|in hand|available)\b|\bpaying cash\b/.test(q)) {
    score += 18;
    signals.push('Cash ready — highest commitment signal');
    positiveCount++;
  } else if (/\bcash\b/.test(q) && !/cashier|cash app/.test(q)) {
    score += 8;
    signals.push('Cash mentioned');
    positiveCount++;
  }

  // ── Pickup signals ─────────────────────────────────────────────────────────
  // Specific day/time = very strong
  if (/\b(i can (come|be there|stop by|swing by)|available (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow))|(monday|tuesday|wednesday|thursday|friday|saturday|sunday) (morning|afternoon|evening|night)\b/.test(q)) {
    score += 18;
    signals.push('Specific pickup day/time offered');
    positiveCount++;
  }
  // General pickup logistics
  if (/\bwhen can (i|we) (pick up|come|stop by|swing by)\b|\bpickup (today|tomorrow|this week|this weekend)\b/.test(q)) {
    score += 12;
    signals.push('Asking about pickup logistics');
    positiveCount++;
  }
  if (/\bcan (i|we) pick (it )?up\b/.test(q)) {
    score += 8;
    signals.push('Pickup intent');
    positiveCount++;
  }
  if (/\b(today|tonight|this afternoon|right now|asap)\b/.test(q) && !/hold.*today/.test(q)) {
    score += 8;
    signals.push('Urgency to buy today');
    positiveCount++;
  }

  // ── Due diligence = real buyer doing research before committing ────────────
  if (/\b(what'?s? the condition|any (scratches|damage|dents|issues|cracks|defects|flaws)|does it (work|charge|turn on|function|power)|is it (in good|in great|in working)|still (works?|functions?)|include[sd]? (original|box|cable|charger|accessories|manual)|comes? with|fully (functional|working)|been tested|test(ed)? it)\b/.test(q)) {
    score += 15;
    signals.push('Due diligence — researching before buying');
    positiveCount++;
  }
  // Asking specific product specs = genuinely interested
  if (/\b(what (size|color|model|brand|year|dimensions|weight|capacity)|how (old|tall|wide|deep|long|big|much does it weigh)|which (model|version|generation))\b/.test(q)) {
    score += 10;
    signals.push('Asking specific product specs');
    positiveCount++;
  }

  // ── Basic availability check ───────────────────────────────────────────────
  if (/^is (this|it) still available\??$/.test(q.trim()) || /^still available\??$/.test(q.trim())) {
    score += 12;
    signals.push('Direct availability check');
    positiveCount++;
  }

  // ── Multi-signal bonus: buyer stacking signals = significantly surer ───────
  if (positiveCount >= 3) {
    score += 15;
    signals.push('Multiple buyer signals — high confidence');
  } else if (positiveCount >= 2) {
    score += 6;
    signals.push('Two buyer signals — moderate confidence boost');
  }

  // ── Offer evaluation ───────────────────────────────────────────────────────
  const offer = parseOffer(question);
  if (listingPrice && offer) {
    const ratio = offer / listingPrice;
    if (ratio >= 1.0) {
      score += 38; // Full ask or above = very strong buy signal
      signals.push('Offering full price or above');
    } else if (ratio >= 0.9) {
      score += 22;
      signals.push('Near-full-price offer');
    } else if (ratio >= 0.75) {
      score += 6;
      signals.push('Reasonable offer');
    } else if (ratio >= 0.6) {
      score -= 15;
      signals.push('Below-floor offer');
    } else {
      score -= 30;
      signals.push('Very low offer — likely a lowballer');
    }
  }

  // ── Time waster / lowballer signals ───────────────────────────────────────
  if (/\b(what'?s? your (best|lowest|bottom) (price|offer)|lowest (you'?ll? take|price|offer)|best (price|offer) (you can do|possible))\b/.test(q)) {
    score -= 22;
    signals.push('Fishing for lowest price — classic lowballer opener');
  }
  if (/\bwould you (consider|take|accept)\b|\bany (flexibility|wiggle room|room to negotiate)\b/.test(q) && !offer) {
    score -= 10;
    signals.push('Vague negotiation without making an offer');
  }
  if (/\b(my budget is|all i have|all i can (do|afford)|that'?s? all i have)\b/.test(q)) {
    score -= 18;
    signals.push('Budget-constrained framing — often precedes a lowball');
  }
  if (/\bjust (looking|browsing|checking)\b/.test(q)) {
    score -= 28;
    signals.push('Non-committal browsing language');
  }
  if (/\b(text me|whatsapp|email me|reach me at|contact me (at|on)|move (off|away from))\b/.test(q)) {
    score -= 22;
    signals.push('Attempting to move off-platform — red flag');
  }
  if (/\b(can you hold|will you hold|hold it for)\b/.test(q) && !/\bi('?ll| will) (take|buy|get)\b/.test(q)) {
    score -= 12;
    signals.push('Requesting hold without commitment');
  }
  if (/\b(can you (ship|deliver|send)|do you (ship|deliver)|shipping available)\b/.test(q)) {
    score -= 10;
    signals.push('Shipping/delivery ask — lower pickup commitment');
  }
  if (/\bwhy (are you|r u) selling\b/.test(q) && positiveCount === 0) {
    score -= 6;
    signals.push('Curiosity question with no commitment signals');
  }
  const questionMarkCount = (question.match(/\?/g) || []).length;
  if (questionMarkCount >= 3 && positiveCount === 0) {
    score -= 10;
    signals.push('Many questions with no commitment signals');
  }

  const bounded = Math.max(0, Math.min(100, score));

  let label;
  if (bounded >= 75) label = 'HIGH_INTENT';
  else if (bounded >= 55) label = 'LIKELY_BUYER';
  else if (bounded >= 35) label = 'NEGOTIATING';
  else if (bounded >= 15) label = 'LOWBALLER';
  else label = 'TIME_WASTER';

  return { score: bounded, label, signals };
}

function evaluateInquiry({ question, profile }) {
  const listingPrice = parsePriceValue(profile?.price || '');
  const offer = parseOffer(question);
  const floorRatio = Number(process.env.OFFER_FLOOR_RATIO || 0.75);

  const reasons = [];
  let confidence = 0.9;

  if (!profile || !profile.fullDescription) {
    reasons.push('No product profile loaded');
    confidence -= 0.45;
  }

  const scamFlags = hasScamSignals(question);
  if (scamFlags.length > 0) {
    reasons.push(`Potential scam keywords: ${scamFlags.join(', ')}`);
    confidence -= 0.5;
  }

  if (listingPrice && offer && offer < listingPrice * floorRatio) {
    reasons.push(`Low offer (${offer}) below configured floor`);
    confidence -= 0.25;
  }

  if (/refund|return policy|guarantee|warranty|legal/.test(String(question).toLowerCase())) {
    reasons.push('Policy-sensitive question');
    confidence -= 0.2;
  }

  const bounded = Math.max(0, Math.min(1, confidence));
  const shouldHandoff = reasons.length > 0;
  const buyerIntent = scoreBuyerIntent(question, listingPrice);

  return {
    shouldHandoff,
    reasons,
    confidence: Number(bounded.toFixed(2)),
    listingPrice,
    offer,
    buyerIntent,
  };
}

module.exports = {
  evaluateInquiry,
  scoreBuyerIntent,
};
