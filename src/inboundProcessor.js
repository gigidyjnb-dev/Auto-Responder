const { addTurn, getHistory } = require('./conversationStore');
const { enqueuePending } = require('./leadQueue');
const { generateResponse } = require('./responseEngine');
const { evaluateInquiry } = require('./riskRules');
const { loadProfile } = require('./storage');

function autoSendEnabled() {
  return String(process.env.AUTO_SEND_ENABLED || 'true').toLowerCase() === 'true';
}

function minConfidence() {
  const n = Number(process.env.AUTO_SEND_MIN_CONFIDENCE || 0.72);
  return Number.isFinite(n) ? n : 0.72;
}

async function processInboundInquiry({
  channel,
  senderId,
  customerName,
  question,
  sendReply,
  queueOnly = false,
  listingId = null,
}) {
  const profile = loadProfile(listingId);
  if (!profile) {
    const noProfile =
      'Thanks for your message. The seller has not uploaded a product profile yet, so I cannot answer accurately right now.';

    if (sendReply && !queueOnly) {
      await sendReply(noProfile);
    }

    return {
      action: 'blocked_no_profile',
      answer: noProfile,
      queued: false,
      sent: Boolean(sendReply && !queueOnly),
      confidence: 0,
      reasons: ['No product profile loaded'],
    };
  }

  const safeSenderId = senderId || `${channel}:anonymous`;
  const safeName = customerName || 'there';
  const history = getHistory(safeSenderId);

  const answer = await generateResponse({
    question,
    customerName: safeName,
    profile,
    history,
    channel,
  });

  const review = evaluateInquiry({ question, profile });
  const canAutoSend = autoSendEnabled() && review.confidence >= minConfidence() && !review.shouldHandoff;

  if (!canAutoSend || queueOnly) {
    const queued = enqueuePending({
      channel,
      senderId: safeSenderId,
      customerName: safeName,
      question,
      proposedAnswer: answer,
      confidence: review.confidence,
      reasons: review.reasons,
      listingId,
      buyerIntentScore: review.buyerIntent.score,
      buyerIntentLabel: review.buyerIntent.label,
      buyerIntentSignals: review.buyerIntent.signals,
    });

    if (sendReply && !queueOnly) {
      await sendReply('Thanks for your message. A team member is reviewing your request and will reply shortly.');
    }

    return {
      action: 'queued_for_review',
      answer,
      queued: true,
      queueId: queued.id,
      sent: false,
      confidence: review.confidence,
      reasons: review.reasons,
      buyerIntent: review.buyerIntent,
    };
  }

  if (sendReply) {
    await sendReply(answer);
  }

  addTurn(safeSenderId, question, answer);

  return {
    action: 'auto_sent',
    answer,
    queued: false,
    sent: Boolean(sendReply),
    confidence: review.confidence,
    reasons: review.reasons,
    buyerIntent: review.buyerIntent,
  };
}

module.exports = {
  processInboundInquiry,
};
