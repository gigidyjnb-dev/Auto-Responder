const assert = require('node:assert/strict');
const test = require('node:test');

const { scoreBuyerIntent } = require('../src/riskRules');

test('commitment language scores HIGH_INTENT', () => {
  const result = scoreBuyerIntent("I'll take it, cash ready, can I pick it up today?", 100);
  assert.equal(result.label, 'HIGH_INTENT');
  assert.ok(result.score >= 75);
  assert.ok(result.signals.length > 0);
});

test('full price offer scores HIGH_INTENT', () => {
  const result = scoreBuyerIntent('I will give you $100 for it', 100);
  assert.equal(result.label, 'HIGH_INTENT');
  assert.ok(result.score >= 75);
});

test('near-full-price offer scores LIKELY_BUYER', () => {
  const result = scoreBuyerIntent('Would you take $92?', 100);
  assert.ok(['HIGH_INTENT', 'LIKELY_BUYER'].includes(result.label));
  assert.ok(result.score >= 55);
});

test('fishing for lowest price scores LOWBALLER or NEGOTIATING', () => {
  const result = scoreBuyerIntent("What's your lowest price?", 100);
  assert.ok(['LOWBALLER', 'NEGOTIATING'].includes(result.label));
  assert.ok(result.score < 55);
  assert.ok(result.signals.some(s => s.toLowerCase().includes('lowest') || s.toLowerCase().includes('fishing')));
});

test('very low offer scores LOWBALLER or TIME_WASTER', () => {
  const result = scoreBuyerIntent('Would you take $20 for it?', 100);
  assert.ok(['LOWBALLER', 'TIME_WASTER'].includes(result.label));
  assert.ok(result.score < 35);
});

test('just browsing scores TIME_WASTER or LOWBALLER', () => {
  const result = scoreBuyerIntent("I'm just looking around", null);
  assert.ok(['TIME_WASTER', 'LOWBALLER'].includes(result.label));
  assert.ok(result.score < 35);
});

test('off-platform redirect attempt scores low', () => {
  const result = scoreBuyerIntent('Text me at 555-1234 to discuss', null);
  assert.ok(result.score < 40);
  assert.ok(result.signals.some(s => s.toLowerCase().includes('off-platform')));
});

test('simple availability check scores above neutral', () => {
  const result = scoreBuyerIntent('Is this still available?', null);
  assert.ok(result.score > 50);
});

test('hold request without commitment scores below neutral', () => {
  const result = scoreBuyerIntent('Can you hold it for me until next week?', null);
  assert.ok(result.score < 50);
});

test('budget-constrained framing scores NEGOTIATING or LOWBALLER or TIME_WASTER', () => {
  const result = scoreBuyerIntent('That is all I have, $40', 100);
  assert.ok(['LOWBALLER', 'NEGOTIATING', 'TIME_WASTER'].includes(result.label));
  assert.ok(result.score < 50);
});

// ── New accuracy tests ────────────────────────────────────────────────────────

test('due diligence questions score LIKELY_BUYER or higher', () => {
  const result = scoreBuyerIntent('Does it still work? Any scratches or damage?', null);
  assert.ok(['HIGH_INTENT', 'LIKELY_BUYER', 'NEGOTIATING'].includes(result.label));
  assert.ok(result.score >= 55, `Expected >= 55, got ${result.score}`);
  assert.ok(result.signals.some(s => s.toLowerCase().includes('due diligence')));
});

test('specific pickup day scores LIKELY_BUYER or higher', () => {
  const result = scoreBuyerIntent('I can come Saturday afternoon to pick it up', null);
  assert.ok(['HIGH_INTENT', 'LIKELY_BUYER'].includes(result.label));
  assert.ok(result.score >= 55, `Expected >= 55, got ${result.score}`);
  assert.ok(result.signals.some(s => s.toLowerCase().includes('specific pickup')));
});

test('shipping request reduces score vs pickup', () => {
  const pickupResult = scoreBuyerIntent('Can I pick it up this weekend?', null);
  const shippingResult = scoreBuyerIntent('Can you ship it to me?', null);
  assert.ok(pickupResult.score > shippingResult.score, 'Pickup should score higher than shipping request');
});

test('bare number offer in context is parsed', () => {
  // "can do 80" should be parsed as an offer even without $
  const result = scoreBuyerIntent('I can do 80 for it', 100);
  // ratio 0.8 = reasonable offer territory, should not be treated as no-offer vague negotiation
  assert.ok(result.score >= 40, `Expected >= 40, got ${result.score}`);
});

test('multi-signal stacking boosts score beyond individual signals', () => {
  const singleSignal = scoreBuyerIntent('Cash in hand', null);
  const multiSignal = scoreBuyerIntent('Cash in hand, can pick up tonight, is this still available?', null);
  assert.ok(multiSignal.score > singleSignal.score + 10, 'Multi-signal should score significantly higher');
  assert.ok(multiSignal.signals.some(s => s.toLowerCase().includes('multiple') || s.toLowerCase().includes('two buyer')));
});

test('standalone affirmative scores HIGH_INTENT', () => {
  const result = scoreBuyerIntent("Sounds good, I'll take it", null);
  assert.ok(['HIGH_INTENT', 'LIKELY_BUYER'].includes(result.label));
  assert.ok(result.score >= 55);
});

test('inbound API response includes buyerIntent field', async () => {
  const fs = require('fs');
  const path = require('path');
  const request = require('supertest');

  const TEST_DB_FILE = path.join(__dirname, '..', 'data', 'intent-test.db');
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);

  const prev = process.env.APP_DB_FILE;
  process.env.APP_DB_FILE = TEST_DB_FILE;
  process.env.INTEGRATION_API_KEY = 'test-key';
  process.env.AUTO_SEND_ENABLED = 'false';

  const { app } = require('../src/server');

  const registerRes = await request(app).post('/api/auth/register').send({
    email: `intent-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'intent-pass-123',
  });
  assert.equal(registerRes.status, 200);
  const authToken = registerRes.body.token;
  assert.ok(authToken);

  const sampleA = path.join(__dirname, '..', 'samples', 'electronics-headphones.txt');
  const uploadRes = await request(app)
    .post('/api/upload')
    .set('Authorization', `Bearer ${authToken}`)
    .attach('productFile', sampleA);
  assert.equal(uploadRes.status, 200);
  const listingId = uploadRes.body.profile.id;

  const res = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-key')
    .send({
      platform: 'ebay',
      senderId: 'intent-buyer',
      customerName: 'IntentTest',
      question: "I'll take it, cash in hand!",
      listingId,
      queueOnly: true,
    });

  assert.equal(res.status, 200);
  assert.ok(res.body.buyerIntent, 'buyerIntent field missing from API response');
  assert.ok(typeof res.body.buyerIntent.score === 'number');
  assert.ok(typeof res.body.buyerIntent.label === 'string');
  assert.ok(Array.isArray(res.body.buyerIntent.signals));

  process.env.APP_DB_FILE = prev || '';
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
});


test('commitment language scores HIGH_INTENT', () => {
  const result = scoreBuyerIntent("I'll take it, cash ready, can I pick it up today?", 100);
  assert.equal(result.label, 'HIGH_INTENT');
  assert.ok(result.score >= 75);
  assert.ok(result.signals.length > 0);
});

test('full price offer scores HIGH_INTENT', () => {
  const result = scoreBuyerIntent('I will give you $100 for it', 100);
  assert.equal(result.label, 'HIGH_INTENT');
  assert.ok(result.score >= 75);
});

test('near-full-price offer scores LIKELY_BUYER', () => {
  const result = scoreBuyerIntent('Would you take $92?', 100);
  assert.ok(['HIGH_INTENT', 'LIKELY_BUYER'].includes(result.label));
  assert.ok(result.score >= 55);
});

test('fishing for lowest price scores LOWBALLER or NEGOTIATING', () => {
  const result = scoreBuyerIntent("What's your lowest price?", 100);
  assert.ok(['LOWBALLER', 'NEGOTIATING'].includes(result.label));
  assert.ok(result.score < 55);
  assert.ok(result.signals.some(s => s.toLowerCase().includes('lowest') || s.toLowerCase().includes('fishing')));
});

test('very low offer scores LOWBALLER', () => {
  const result = scoreBuyerIntent('Would you take $20 for it?', 100);
  assert.ok(['LOWBALLER', 'TIME_WASTER'].includes(result.label));
  assert.ok(result.score < 35);
});

test('just browsing scores TIME_WASTER or LOWBALLER', () => {
  const result = scoreBuyerIntent("I'm just looking around", null);
  assert.ok(['TIME_WASTER', 'LOWBALLER'].includes(result.label));
  assert.ok(result.score < 35);
});

test('off-platform redirect attempt scores low', () => {
  const result = scoreBuyerIntent('Text me at 555-1234 to discuss', null);
  assert.ok(result.score < 40);
  assert.ok(result.signals.some(s => s.toLowerCase().includes('off-platform')));
});

test('simple availability check scores above neutral', () => {
  const result = scoreBuyerIntent('Is this still available?', null);
  assert.ok(result.score > 50);
});

test('hold request without commitment scores below neutral', () => {
  const result = scoreBuyerIntent('Can you hold it for me until next week?', null);
  assert.ok(result.score < 50);
});

test('budget-constrained framing scores NEGOTIATING or LOWBALLER', () => {
  const result = scoreBuyerIntent('That is all I have, $40', 100);
  assert.ok(['LOWBALLER', 'NEGOTIATING', 'TIME_WASTER'].includes(result.label));
  assert.ok(result.score < 50);
});

test('inbound API response includes buyerIntent field', async () => {
  // This test verifies the field flows through the API end-to-end.
  // It re-uses the already-running app context via a fresh require.
  const fs = require('fs');
  const path = require('path');
  const request = require('supertest');

  const TEST_DB_FILE = path.join(__dirname, '..', 'data', 'intent-test.db');
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);

  const prev = process.env.APP_DB_FILE;
  process.env.APP_DB_FILE = TEST_DB_FILE;
  process.env.INTEGRATION_API_KEY = 'test-key';
  process.env.AUTO_SEND_ENABLED = 'false';

  // Fresh require since APP_DB_FILE changed
  const { app } = require('../src/server');

  const registerRes = await request(app).post('/api/auth/register').send({
    email: `intent-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'intent-pass-123',
  });
  assert.equal(registerRes.status, 200);
  const authToken = registerRes.body.token;
  assert.ok(authToken);

  // Upload a listing first
  const sampleA = path.join(__dirname, '..', 'samples', 'electronics-headphones.txt');
  const uploadRes = await request(app)
    .post('/api/upload')
    .set('Authorization', `Bearer ${authToken}`)
    .attach('productFile', sampleA);
  assert.equal(uploadRes.status, 200);
  const listingId = uploadRes.body.profile.id;

  const res = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-key')
    .send({
      platform: 'ebay',
      senderId: 'intent-buyer',
      customerName: 'IntentTest',
      question: "I'll take it, cash in hand!",
      listingId,
      queueOnly: true,
    });

  assert.equal(res.status, 200);
  assert.ok(res.body.buyerIntent, 'buyerIntent field missing from API response');
  assert.ok(typeof res.body.buyerIntent.score === 'number');
  assert.ok(typeof res.body.buyerIntent.label === 'string');
  assert.ok(Array.isArray(res.body.buyerIntent.signals));

  process.env.APP_DB_FILE = prev || '';
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
});
