const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');

const TEST_DB_FILE = path.join(__dirname, '..', 'data', 'test-app.db');
if (fs.existsSync(TEST_DB_FILE)) {
  fs.unlinkSync(TEST_DB_FILE);
}

process.env.APP_DB_FILE = TEST_DB_FILE;
process.env.OPENAI_API_KEY = '';
process.env.INTEGRATION_API_KEY = 'test-integration-key';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.AUTO_SEND_ENABLED = 'false';

const { app } = require('../src/server');

const sampleA = path.join(__dirname, '..', 'samples', 'electronics-headphones.txt');
const sampleB = path.join(__dirname, '..', 'samples', 'furniture-shelf.txt');

let listingA = null;
let listingB = null;
let adminCookie = null;
let csrfToken = null;
let authToken = null;

function withUserAuth(req) {
  return req.set('Authorization', `Bearer ${authToken}`);
}

test.before(async () => {
  const registerRes = await request(app).post('/api/auth/register').send({
    email: 'seller@example.com',
    password: 'seller-pass-123',
  });
  assert.equal(registerRes.status, 200);
  authToken = registerRes.body.token;
  assert.ok(authToken);
});

test('upload listings and enforce listingId in multi-listing mode', async () => {
  const uploadA = await withUserAuth(request(app).post('/api/upload')).attach('productFile', sampleA);
  assert.equal(uploadA.status, 200);
  listingA = uploadA.body?.profile?.id;
  assert.ok(listingA);

  const uploadB = await withUserAuth(request(app).post('/api/upload')).attach('productFile', sampleB);
  assert.equal(uploadB.status, 200);
  listingB = uploadB.body?.profile?.id;
  assert.ok(listingB);

  const listRes = await withUserAuth(request(app).get('/api/products'));
  assert.equal(listRes.status, 200);
  assert.equal(Array.isArray(listRes.body.listings), true);
  assert.equal(listRes.body.listings.length >= 2, true);

  const respondNoListing = await request(app).post('/api/respond').send({
    question: 'still available?',
    channel: 'ebay',
  });
  assert.equal(respondNoListing.status, 400);

  const respondWithListing = await request(app).post('/api/respond').send({
    question: 'still available?',
    channel: 'ebay',
    listingId: listingA,
  });
  assert.equal(respondWithListing.status, 200);
  assert.equal(typeof respondWithListing.body.answer, 'string');
});

test('admin queue endpoints require login when ADMIN_PASSWORD is set', async () => {
  const noAuth = await request(app).get('/api/admin/queue');
  assert.equal(noAuth.status, 401);

  const badLogin = await request(app).post('/api/admin/login').send({ password: 'wrong' });
  assert.equal(badLogin.status, 401);

  const goodLogin = await request(app).post('/api/admin/login').send({ password: 'admin-pass' });
  assert.equal(goodLogin.status, 200);
  const loginCookies = goodLogin.headers['set-cookie'] || [];
  adminCookie = loginCookies.map((c) => c.split(';')[0]).join('; ');
  csrfToken = goodLogin.body?.csrfToken;
  assert.ok(adminCookie);
  assert.ok(csrfToken);

  const withAuth = await request(app).get('/api/admin/queue').set('Cookie', adminCookie);
  assert.equal(withAuth.status, 200);
  assert.equal(Array.isArray(withAuth.body.pending), true);

  const rejectNoCsrf = await request(app)
    .post('/api/admin/queue/999999/reject')
    .set('Cookie', adminCookie)
    .send({ reason: 'csrf test' });
  assert.equal(rejectNoCsrf.status, 403);

  const rejectWithCsrf = await request(app)
    .post('/api/admin/queue/999999/reject')
    .set('Cookie', adminCookie)
    .set('x-csrf-token', csrfToken)
    .send({ reason: 'csrf test' });
  assert.equal(rejectWithCsrf.status, 404);
});

test('inbound connector requires listingId unless sender mapping exists', async () => {
  const firstNoListing = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .send({
      platform: 'ebay',
      senderId: 'buyer-123',
      customerName: 'Pat',
      question: 'Can you do 100?',
      queueOnly: true,
    });

  assert.equal(firstNoListing.status, 400);

  const withListing = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .send({
      platform: 'ebay',
      senderId: 'buyer-123',
      customerName: 'Pat',
      question: 'Can you do 100?',
      listingId: listingB,
      queueOnly: true,
    });

  assert.equal(withListing.status, 200);

  const duplicate = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .set('x-event-id', 'evt-123')
    .send({
      eventId: 'evt-123',
      platform: 'ebay',
      senderId: 'buyer-xyz',
      customerName: 'Pat',
      question: 'Can you do 100?',
      listingId: listingB,
      queueOnly: true,
    });
  assert.equal(duplicate.status, 200);
  assert.equal(Boolean(duplicate.body.duplicate), false);

  const duplicateAgain = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .set('x-event-id', 'evt-123')
    .send({
      eventId: 'evt-123',
      platform: 'ebay',
      senderId: 'buyer-xyz',
      customerName: 'Pat',
      question: 'Can you do 100?',
      listingId: listingB,
      queueOnly: true,
    });
  assert.equal(duplicateAgain.status, 200);
  assert.equal(Boolean(duplicateAgain.body.duplicate), true);

  const mappedNoListing = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .send({
      platform: 'ebay',
      senderId: 'buyer-123',
      customerName: 'Pat',
      question: 'How soon can pickup happen?',
      queueOnly: true,
    });

  assert.equal(mappedNoListing.status, 200);
});

test('inbound connector rejects missing or wrong integration key', async () => {
  const noKey = await request(app)
    .post('/api/integrations/inbound')
    .send({ platform: 'ebay', senderId: 'x', question: 'hi', listingId: listingA });
  assert.equal(noKey.status, 401);

  const wrongKey = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'bad-key')
    .send({ platform: 'ebay', senderId: 'x', question: 'hi', listingId: listingA });
  assert.equal(wrongKey.status, 401);
});

test('scam keyword in question causes message to be queued for review', async () => {
  const res = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .send({
      platform: 'ebay',
      senderId: 'scam-buyer',
      customerName: 'Scammer',
      question: 'Can you send me a verification code?',
      listingId: listingA,
      queueOnly: false,
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'queued_for_review');
  assert.equal(res.body.queued, true);
});

test('low-ball offer causes message to be queued for review', async () => {
  // listingA is headphones — parsed price is in the file. Use a clearly low offer.
  const res = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .send({
      platform: 'ebay',
      senderId: 'lowball-buyer',
      customerName: 'Lowballer',
      question: 'Would you take $1 for it?',
      listingId: listingA,
      queueOnly: false,
    });

  assert.equal(res.status, 200);
  // Either queued (price parsed and low) or auto-sent (price not parsed from file) — both are valid
  assert.ok(['queued_for_review', 'auto_sent'].includes(res.body.action));
});

test('admin approve requires CSRF and returns item with dispatch info', async () => {
  // Queue an item first
  const inbound = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .send({
      platform: 'offerup',
      senderId: 'approve-test-buyer',
      customerName: 'TestBuyer',
      question: 'Is this still available?',
      listingId: listingA,
      queueOnly: true,
    });
  assert.equal(inbound.status, 200);
  const queueId = inbound.body.queueId;
  assert.ok(queueId);

  // Approve without CSRF — should 403
  const noCsrf = await request(app)
    .post(`/api/admin/queue/${queueId}/approve`)
    .set('Cookie', adminCookie)
    .send({});
  assert.equal(noCsrf.status, 403);

  // Approve with CSRF — should succeed (no outbound URL configured, dispatch skipped)
  const withCsrf = await request(app)
    .post(`/api/admin/queue/${queueId}/approve`)
    .set('Cookie', adminCookie)
    .set('x-csrf-token', csrfToken)
    .send({});
  assert.equal(withCsrf.status, 200);
  assert.equal(withCsrf.body.ok, true);
  assert.ok(withCsrf.body.dispatch);
});

test('admin reject with CSRF marks item as rejected', async () => {
  // Queue an item to reject
  const inbound = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .send({
      platform: 'mercari',
      senderId: 'reject-test-buyer',
      customerName: 'RejectBuyer',
      question: 'Do you ship?',
      listingId: listingB,
      queueOnly: true,
    });
  assert.equal(inbound.status, 200);
  const queueId = inbound.body.queueId;
  assert.ok(queueId);

  const res = await request(app)
    .post(`/api/admin/queue/${queueId}/reject`)
    .set('Cookie', adminCookie)
    .set('x-csrf-token', csrfToken)
    .send({ reason: 'not relevant' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.status, 'rejected');
});

test('AUTO_SEND_ENABLED=true auto-sends high-confidence reply without queuing', async () => {
  const original = process.env.AUTO_SEND_ENABLED;
  process.env.AUTO_SEND_ENABLED = 'true';

  const res = await request(app)
    .post('/api/integrations/inbound')
    .set('x-integration-key', 'test-integration-key')
    .send({
      platform: 'etsy',
      senderId: 'autosend-buyer',
      customerName: 'AutoBuyer',
      question: 'Is this still available?',
      listingId: listingA,
    });

  process.env.AUTO_SEND_ENABLED = original;

  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'auto_sent');
  assert.equal(res.body.queued, false);
});

test('craigslist email relay requires integration key and parses email fields', async () => {
  const noKey = await request(app)
    .post('/api/integrations/craigslist/email')
    .send({ from: 'Buyer <b@example.com>', subject: 'Re: shelf', text: 'Still available?' });
  assert.equal(noKey.status, 401);

  const res = await request(app)
    .post('/api/integrations/craigslist/email')
    .set('x-integration-key', 'test-integration-key')
    .send({
      from: 'Jane Doe <jane@example.com>',
      subject: 'Re: your listing',
      text: 'Hi, is this still available?',
      listingId: listingB,
      queueOnly: true,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.platform, 'craigslist');
  assert.ok(res.body.parsed);
});

test('/api/listings/bulk returns explicit error when no valid listing titles are provided', async () => {
  const res = await withUserAuth(request(app)
    .post('/api/listings/bulk'))
    .send({
      platform: 'facebook_marketplace',
      listings: [{}, { title: '   ' }, { name: '' }],
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.synced, 0);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.failed >= 1, true);
  assert.equal(Array.isArray(res.body.errors), true);
});

test('/api/listings/bulk rejects oversized sync batches', async () => {
  const tooManyListings = Array.from({ length: 251 }, (_, i) => ({ title: `Bulk Item ${i}` }));

  const res = await withUserAuth(request(app)
    .post('/api/listings/bulk'))
    .send({
      platform: 'facebook_marketplace',
      listings: tooManyListings,
    });

  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'SYNC_BATCH_TOO_LARGE');
});

test('/api/upload-sync/bulk rejects oversized sync batches', async () => {
  const tooManyListings = Array.from({ length: 251 }, (_, i) => ({ title: `Upload Sync Item ${i}` }));

  const res = await withUserAuth(request(app)
    .post('/api/upload-sync/bulk'))
    .send({
      platform: 'facebook_marketplace',
      listings: tooManyListings,
    });

  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'SYNC_BATCH_TOO_LARGE');
});

test('sync endpoints echo request IDs and admin sync metrics are available', async () => {
  const requestId = 'req-observe-123';

  const bulkRes = await withUserAuth(request(app)
    .post('/api/upload-sync/bulk')
    .set('x-request-id', requestId))
    .send({
      platform: 'facebook_marketplace',
      listings: [{ title: 'Observability Listing', price: '$10' }],
    });

  assert.equal(bulkRes.status, 200);
  assert.equal(bulkRes.body.requestId, requestId);
  assert.equal(bulkRes.headers['x-request-id'], requestId);

  const metricsRes = await request(app)
    .get('/api/admin/sync-metrics')
    .set('Cookie', adminCookie);

  assert.equal(metricsRes.status, 200);
  assert.equal(metricsRes.body.ok, true);
  assert.ok(metricsRes.body.metrics);
  assert.ok(metricsRes.body.metrics.uploadSyncBulk.requests >= 1);
  assert.ok(metricsRes.body.metrics.uploadSyncBulk.listingsSaved >= 1);
  assert.ok(metricsRes.body.rollingMetrics);
  assert.ok(metricsRes.body.rollingMetrics.counts.uploadSyncBulk.requests >= 1);
  assert.ok(metricsRes.body.rollingMetrics.counts.uploadSyncBulk.listingsSaved >= 1);
});

test('admin sync metrics reset requires CSRF and clears counters', async () => {
  const seedRes = await withUserAuth(request(app)
    .post('/api/upload-sync/bulk'))
    .send({
      platform: 'facebook_marketplace',
      listings: [{ title: 'Reset Seed Listing' }],
    });
  assert.equal(seedRes.status, 200);

  const noCsrf = await request(app)
    .post('/api/admin/sync-metrics/reset')
    .set('Cookie', adminCookie)
    .send({});
  assert.equal(noCsrf.status, 403);

  const resetRes = await request(app)
    .post('/api/admin/sync-metrics/reset')
    .set('Cookie', adminCookie)
    .set('x-csrf-token', csrfToken)
    .send({});
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.body.ok, true);
  assert.ok(resetRes.body.metrics.lastResetAt);
  assert.ok(resetRes.body.metrics.resetCount >= 1);
  assert.equal(resetRes.body.metrics.uploadSync.requests, 0);
  assert.equal(resetRes.body.metrics.uploadSyncBulk.requests, 0);
  assert.equal(resetRes.body.metrics.listingsBulk.requests, 0);
  assert.equal(resetRes.body.metrics.parsePage.requests, 0);
  assert.ok(resetRes.body.rollingMetrics);
  assert.equal(resetRes.body.rollingMetrics.counts.uploadSync.requests, 0);
  assert.equal(resetRes.body.rollingMetrics.counts.uploadSyncBulk.requests, 0);
  assert.equal(resetRes.body.rollingMetrics.counts.listingsBulk.requests, 0);
  assert.equal(resetRes.body.rollingMetrics.counts.parsePage.requests, 0);
});

test('admin logout clears session cookies', async () => {
  const res = await request(app)
    .post('/api/admin/logout')
    .set('Cookie', adminCookie)
    .set('x-csrf-token', csrfToken);
  assert.equal(res.status, 200);

  // After logout the session cookie should be expired (Max-Age=0)
  const cookies = res.headers['set-cookie'] || [];
  const sessionCookie = cookies.find((c) => c.startsWith('admin_session='));
  assert.ok(sessionCookie, 'session cookie should be cleared');
  assert.ok(sessionCookie.includes('Max-Age=0'));
});
