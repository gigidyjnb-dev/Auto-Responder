# Marketplace Auto-Responder

Automatically answer buyer questions on Facebook Marketplace, Messenger, eBay, Etsy, OfferUp, Mercari, Poshmark, and Craigslist.

You upload one product description file. The tool reads it and writes a personalized, channel-appropriate reply to every buyer question — automatically or with one-click approval.

## How It Works

1. You paste or upload a plain-text description of your listing.
2. When a buyer sends a question, the tool generates a tailored reply using your listing details.
3. High-confidence replies are sent automatically. Risky or low-confidence ones go to a review queue first.
4. You approve, edit, or reject queued replies from a simple web panel.

No coding required for basic use. Optional integrations add live automation for each platform.

## Features

- Personalized replies per buyer question using your product file
- Channel-aware tone (casual for Messenger, professional for eBay, warm for Etsy)
- Works without OpenAI — built-in fallback logic handles common buyer questions
- Optional OpenAI integration for richer, more natural responses
- Facebook Messenger native webhook (auto-send replies to Messenger conversations)
- Universal inbound API for eBay, Etsy, OfferUp, Mercari, Poshmark, Craigslist via automation bridges
- Built-in risk detection — scam keywords, low-ball offers, and policy questions get flagged for review
- Admin web panel to approve or reject any queued reply before it sends
- Outbound bridge dispatch — approved replies automatically POST to your Zapier/Make/n8n webhook
- Starter connector templates included for Zapier, Make, and n8n

---

## Requirements

- [Node.js](https://nodejs.org) v18 or later
- npm (comes with Node.js)
- An OpenAI API key (optional — built-in responses work without it)
- A publicly accessible URL if using Facebook Messenger live webhook (e.g. via [ngrok](https://ngrok.com) or a cloud host)

---

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure with the setup wizard

```bash
npm run setup
```

This walks you through creating your `.env` file step by step — no manual editing. You can skip any optional section (OpenAI, Facebook, etc.) and add it later.

Alternatively, copy the template and edit manually:

```bash
cp .env.example .env
```

### 3. Start

```bash
npm run dev
```

### 4. Open the app

| Page | URL |
|---|---|
| Main app (upload listing, test replies) | http://localhost:3000 |
| Admin review queue | http://localhost:3000/admin.html |
| Setup status / platform check | http://localhost:3000/setup-status.html |

---

## One-Click Deploy

Deploy to the cloud so your webhook URLs are publicly reachable:

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

After deploying, run `npm run setup` on the server or set environment variables in your host's dashboard.

---

## Step-by-Step Usage

### Step 1 — Upload your product description

Create a plain text file (`.txt`) describing your listing. Example:

```text
IKEA Kallax Shelf Unit — White
Price: $85
Condition: Good
- 4-cube shelf, no major scratches
- Smoke-free home
- Pickup near Downtown
```

Open http://localhost:3000 and upload the file using the upload form.

The tool parses your title, price, condition, and highlights automatically.

### Step 2 — Generate a personalized reply

Below the upload section, type a buyer question and your buyer's name (optional), then choose the platform. Click **Generate Response**.

Example buyer questions to try:
- `Is this still available?`
- `Can you do $60 cash today?`
- `Any damage or issues I should know about?`
- `Can you hold it until Saturday?`

The response is tailored to the question and styled for the selected channel.

### Step 3 — Review flagged messages

Open http://localhost:3000/admin.html to see any messages in the queue.

Items are queued when:
- The offer is below your floor price ratio
- A scam-risk keyword is detected in the buyer's message
- The message contains a policy-sensitive phrase (refunds, warranties)
- `AUTO_SEND_ENABLED` is set to `false`

From the admin panel you can:
- **Approve & Send** — sends the proposed reply through the active channel
- **Reject** — closes the item without sending

---

## Platform Setup

### Facebook Messenger (native)

The app connects directly to Messenger via Meta's webhook API. Replies are delivered automatically without any third-party automation tool.

1. Add these to your `.env`:

```bash
FB_PAGE_ACCESS_TOKEN=your_page_access_token
FB_VERIFY_TOKEN=pick-any-string
FB_GRAPH_VERSION=v22.0
```

2. In [Meta for Developers](https://developers.facebook.com):
   - Create a Meta app and add the **Messenger** product
   - Connect your Facebook Page
   - Set callback URL to: `https://your-domain.com/webhook/facebook`
   - Set verify token to match your `FB_VERIFY_TOKEN`
   - Subscribe to **messages** and **messaging_postbacks**

3. Make sure your server is publicly reachable before Meta sends the verification request.

4. Upload your product file — the app will now auto-answer incoming Messenger questions.

> **Note:** Personal Facebook Marketplace profile chats are not accessible via Meta's open API. For best results route Marketplace leads into a business Page inbox.

---

### eBay, Etsy, OfferUp, Mercari, Poshmark (via automation bridge)

These platforms don't currently expose direct reply APIs, but you can connect them in minutes with a free automation tool like [Zapier](https://zapier.com), [Make](https://make.com), or [n8n](https://n8n.io).

**Inbound (buyer question → auto-responder):**

1. In your automation tool, add a trigger for a new buyer message on your platform.
2. Add an HTTP action that POSTs to:

```
POST https://your-domain.com/api/integrations/inbound
Headers:
  Content-Type: application/json
  x-integration-key: <INTEGRATION_API_KEY>
Body:
  {
    "platform": "ebay",
    "senderId": "{{buyer_id}}",
    "customerName": "{{buyer_name}}",
    "question": "{{message_text}}",
    "queueOnly": false
  }
```

Change `platform` to match the source: `ebay`, `etsy`, `offerup`, `mercari`, `poshmark`.

**Outbound (approved reply → back to buyer):**

When you approve a queued item, the server posts the approved reply to your outbound webhook URL.

```bash
OUTBOUND_BRIDGE_URL=https://hooks.zapier.com/hooks/catch/XXXX/YYYY
OUTBOUND_BRIDGE_KEY=optional-shared-secret
```

Use the included starter templates in [`connectors/`](connectors/) as your starting point:

| File | Purpose |
|---|---|
| `zapier-ebay-starter.json` | Inbound eBay messages via Zapier |
| `make-etsy-starter.json` | Inbound Etsy messages via Make |
| `n8n-generic-starter.json` | Generic inbound for any platform via n8n |
| `zapier-outbound-approved-reply.json` | Receive approved replies in Zapier |
| `make-outbound-approved-reply.json` | Receive approved replies in Make |

---

### Craigslist (email relay)

Craigslist routes buyer messages as email. Use an email-parsing service (e.g. [Zapier Email Parser](https://parser.zapier.com), [Mailparser.io](https://mailparser.io)) to extract the raw email fields, then POST to:

```
POST https://your-domain.com/api/integrations/craigslist/email
Headers:
  Content-Type: application/json
  x-integration-key: <INTEGRATION_API_KEY>
Body:
  {
    "from": "Buyer Name <buyer@example.com>",
    "subject": "Re: your listing",
    "text": "Hi, is this still available?"
  }
```

The app extracts the sender's name, email, and first question automatically.

---

## Configuration Reference

All settings go in your `.env` file. Copy `.env.example` to `.env` to get started.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Local server port |
| `OPENAI_API_KEY` | _(none)_ | Enables AI-generated replies. Leave blank to use built-in logic |
| `MODEL_NAME` | `gpt-4o-mini` | OpenAI model to use |
| `INTEGRATION_API_KEY` | _(none)_ | Required for all inbound/outbound bridge endpoints |
| `AUTO_SEND_ENABLED` | `true` | Set to `false` to queue every message for manual review |
| `AUTO_SEND_MIN_CONFIDENCE` | `0.72` | Confidence threshold below which messages are queued instead of sent |
| `OFFER_FLOOR_RATIO` | `0.75` | Offers below this ratio of list price are flagged (e.g. `0.75` = 75%) |
| `SCAM_KEYWORDS` | `code,verification,...` | Comma-separated keywords that flag a message for review |
| `FB_PAGE_ACCESS_TOKEN` | _(none)_ | Meta page token for Messenger send API |
| `FB_VERIFY_TOKEN` | _(none)_ | Token Meta uses to verify your webhook |
| `FB_GRAPH_VERSION` | `v22.0` | Meta Graph API version |
| `OUTBOUND_BRIDGE_URL` | _(none)_ | Webhook URL that receives approved replies for non-Facebook channels |
| `OUTBOUND_BRIDGE_KEY` | _(none)_ | Sent as `x-outbound-key` header on outbound dispatch calls |

---

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | None | Server health check |
| GET | `/api/product` | None | Returns current product profile |
| POST | `/api/upload` | None | Upload product description file |
| POST | `/api/respond` | None | Generate reply for a given question and channel |
| GET | `/api/platforms` | None | List all platforms and their integration status |
| POST | `/api/integrations/inbound` | `x-integration-key` | Universal inbound for bridge-connected platforms |
| POST | `/api/integrations/craigslist/email` | `x-integration-key` | Craigslist email relay ingestion |
| GET | `/webhook/facebook` | Token query param | Meta webhook verification |
| POST | `/webhook/facebook` | None (validated by Meta) | Meta incoming Messenger events |
| GET | `/api/admin/queue` | None | List all queue items |
| POST | `/api/admin/queue/:id/approve` | None | Approve and dispatch queued reply |
| POST | `/api/admin/queue/:id/reject` | None | Reject queued reply without sending |

---

## Notes

- Product profile is saved to `data/product-profile.json`. Re-upload any time to update it.
- The admin queue and conversation history are in-memory and reset on server restart. For production use, swap in a database.
- Uploaded raw files are stored in `uploads/` and are not automatically cleaned up.
- Conversation history is tracked per sender to keep multi-message threads consistent.


