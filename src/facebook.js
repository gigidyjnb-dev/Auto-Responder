/**
 * facebook.js
 * Handles Facebook Messenger webhook integration.
 *
 * Environment variables:
 *   FB_PAGE_ACCESS_TOKEN  – Page token from Meta Developer Console (required)
 *   FB_VERIFY_TOKEN       – Any string you choose; must match what you enter in Meta (required)
 *   FB_APP_SECRET         – App secret for signature verification (optional but recommended)
 *   FB_GRAPH_VERSION      – Graph API version, e.g. "v22.0" (default: v22.0)
 */

const crypto = require('crypto');
const { getSenderListing } = require('./db');
const { processInboundInquiry } = require('./inboundProcessor');

function isConfigured() {
  return !!(process.env.FB_PAGE_ACCESS_TOKEN && process.env.FB_VERIFY_TOKEN);
}

function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    console.log('[facebook] Webhook verified by Meta.');
    return res.status(200).send(challenge);
  }
  console.warn('[facebook] Webhook verification failed — token mismatch.');
  return res.status(403).send('Verification failed.');
}

function verifySignature(req) {
  const appSecret = process.env.FB_APP_SECRET;
  if (!appSecret) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(JSON.stringify(req.body)).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

async function sendFacebookReply(recipientId, text) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const version = process.env.FB_GRAPH_VERSION || 'v22.0';
  const url = `https://graph.facebook.com/${version}/me/messages?access_token=${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!res.ok) { const body = await res.text(); throw new Error(`Facebook Graph API error ${res.status}: ${body}`); }
  return res.json();
}

async function handleWebhookEvent(req, res) {
  res.status(200).send('EVENT_RECEIVED');
  if (!verifySignature(req)) { console.error('[facebook] Signature verification failed.'); return; }
  const body = req.body;
  if (body.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const messageText = event.message?.text;
      if (!senderId || !messageText || event.message?.is_echo) continue;
      const listingId = getSenderListing('facebook_messenger', senderId) || null;
      try {
        await processInboundInquiry({
          channel: 'facebook_messenger',
          senderId,
          customerName: null,
          question: messageText,
          listingId,
          sendReply: async (replyText) => { await sendFacebookReply(senderId, replyText); },
        });
      } catch (err) { console.error(`[facebook] Error processing message from ${senderId}:`, err.message); }
    }
  }
}

module.exports = { isConfigured, verifyWebhook, handleWebhookEvent };
