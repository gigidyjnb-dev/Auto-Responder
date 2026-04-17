# Starter Connectors

Use these templates as quick-start mappings for external automations.

Files:

- `zapier-ebay-starter.json`
- `make-etsy-starter.json`
- `n8n-generic-starter.json`
- `zapier-outbound-approved-reply.json`
- `make-outbound-approved-reply.json`

## Common Target Endpoint

All templates post to:

- `POST /api/integrations/inbound`

Required header:

- `x-integration-key: <INTEGRATION_API_KEY>`

## Craigslist Email Relay

For Craigslist-style inquiries that arrive via email relay providers, use:

- `POST /api/integrations/craigslist/email`

Payload example:

```json
{
  "from": "Buyer Name <buyer@example.com>",
  "subject": "Re: your listing",
  "text": "Hi, is this still available?"
}
```

This endpoint extracts sender identity and first-question text, then runs the same moderation/AI pipeline.

## Outbound Approved Reply Dispatch

When a queue item is approved (non-Facebook channels), the server can POST the approved reply to your automation bridge.

Set:

- `OUTBOUND_BRIDGE_URL`
- `OUTBOUND_BRIDGE_KEY` (optional, sent as `x-outbound-key`)

Dispatch payload example:

```json
{
  "event": "approved_reply",
  "itemId": "123",
  "channel": "ebay",
  "senderId": "buyer-123",
  "customerName": "Sam",
  "question": "Can you ship this by Tuesday?",
  "answer": "Hi Sam, yes this can ship this week.",
  "approvedAt": "2026-04-10T08:00:00.000Z"
}
```
