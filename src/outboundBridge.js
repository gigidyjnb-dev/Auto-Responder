function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function dispatchOutboundReply(item) {
  const url = process.env.OUTBOUND_BRIDGE_URL;
  if (!url) {
    return { dispatched: false, reason: 'OUTBOUND_BRIDGE_URL is not configured.' };
  }

  const headers = {
    'Content-Type': 'application/json',
  };

  if (process.env.OUTBOUND_BRIDGE_KEY) {
    headers['x-outbound-key'] = process.env.OUTBOUND_BRIDGE_KEY;
  }

  const payload = {
    event: 'approved_reply',
    itemId: item.id,
    channel: item.channel,
    senderId: item.senderId,
    customerName: item.customerName,
    question: item.question,
    answer: item.proposedAnswer,
    approvedAt: new Date().toISOString(),
  };

  const maxAttempts = Math.max(1, Number(process.env.OUTBOUND_RETRY_ATTEMPTS || 3));
  const baseDelayMs = Math.max(0, Number(process.env.OUTBOUND_RETRY_DELAY_MS || 250));

  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const body = await response.text().catch(() => '');
      if (response.ok) {
        return {
          dispatched: true,
          status: response.status,
          responseBody: body,
          attempts: attempt,
        };
      }

      lastResult = {
        dispatched: false,
        reason: `Bridge request failed (${response.status}).`,
        responseBody: body,
        attempts: attempt,
      };
    } catch (error) {
      lastResult = {
        dispatched: false,
        reason: `Bridge request error: ${error.message}`,
        attempts: attempt,
      };
    }

    if (attempt < maxAttempts) {
      await wait(baseDelayMs * attempt);
    }
  }

  return lastResult || { dispatched: false, reason: 'Bridge request failed.' };
}

module.exports = {
  dispatchOutboundReply,
};
