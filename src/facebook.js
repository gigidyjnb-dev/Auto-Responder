const { processInboundInquiry } = require('./inboundProcessor');

function isConfigured() {
  return Boolean(process.env.FB_PAGE_ACCESS_TOKEN && process.env.FB_VERIFY_TOKEN);
}

function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
}

async function graphApi(path, options = {}) {
  const base = `https://graph.facebook.com/${process.env.FB_GRAPH_VERSION || 'v22.0'}`;
  const url = `${base}${path}`;

  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || 'Unknown Graph API error';
    throw new Error(message);
  }

  return data;
}

async function fetchSenderName(senderId) {
  try {
    const token = encodeURIComponent(process.env.FB_PAGE_ACCESS_TOKEN);
    const path = `/${senderId}?fields=first_name&access_token=${token}`;
    const data = await graphApi(path, { method: 'GET' });
    return data.first_name || 'there';
  } catch (_error) {
    return 'there';
  }
}

async function sendTextMessage(recipientId, text) {
  const payload = {
    recipient: { id: recipientId },
    message: { text },
    messaging_type: 'RESPONSE',
  };

  const token = encodeURIComponent(process.env.FB_PAGE_ACCESS_TOKEN);
  await graphApi(`/me/messages?access_token=${token}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function sendReplyToSender(recipientId, text) {
  return sendTextMessage(recipientId, text);
}

async function handleIncomingText(senderId, text) {
  const customerName = await fetchSenderName(senderId);
  await processInboundInquiry({
    question: text,
    senderId,
    customerName,
    channel: 'facebook_messenger',
    sendReply: async (message) => {
      await sendTextMessage(senderId, message);
    },
  });
}

function handleWebhookEvent(req, res) {
  const body = req.body;

  if (body.object !== 'page') {
    return res.sendStatus(404);
  }

  res.status(200).send('EVENT_RECEIVED');

  const tasks = [];
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const text = event.message?.text;
      const isEcho = event.message?.is_echo;

      if (!senderId || !text || isEcho) {
        continue;
      }

      tasks.push(handleIncomingText(senderId, text));
    }
  }

  Promise.allSettled(tasks).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.error(`Facebook processing failed for ${failed.length} event(s).`);
    }
  });

  return undefined;
}

module.exports = {
  isConfigured,
  verifyWebhook,
  handleWebhookEvent,
  sendReplyToSender,
};
