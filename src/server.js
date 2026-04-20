require('dotenv').config();

function isProductionLike() {
  return (
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.RAILWAY_SERVICE_NAME)
  );
}

function assertProductionConfig() {
  if (!isProductionLike()) {
    return;
  }

  const pwd = process.env.ADMIN_PASSWORD;
  const pwdOk = typeof pwd === 'string' && pwd.trim().length >= 8;
  const strict =
    process.env.FAIL_WITHOUT_ADMIN_PASSWORD === '1' ||
    process.env.FAIL_WITHOUT_ADMIN_PASSWORD === 'true';

  if (!pwdOk) {
    const msg =
      '[marketplace-auto-responder] Set ADMIN_PASSWORD (8+ chars) in Railway Variables to lock /admin. ' +
      'Until then, admin routes are not password-protected.';
    if (strict) {
      console.error(msg);
      process.exit(1);
    }
    console.error(`WARNING: ${msg}`);
  }

  if (!process.env.ADMIN_SESSION_SECRET?.trim() && !process.env.INTEGRATION_API_KEY?.trim()) {
    console.warn(
      '[marketplace-auto-responder] Set ADMIN_SESSION_SECRET (recommended) or INTEGRATION_API_KEY ' +
        'so admin sessions stay valid across server restarts.'
    );
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn(
      '[marketplace-auto-responder] OPENAI_API_KEY is unset; replies use built-in FAQ/fallback text only.'
    );
  }

  if (!process.env.INTEGRATION_API_KEY?.trim()) {
    console.warn(
      '[marketplace-auto-responder] INTEGRATION_API_KEY is unset; /api/inbound and /api/integrations/* will reject requests.'
    );
  }

  // Credential encryption key (for one-click import)
  const credKey = process.env.CRED_ENCRYPTION_KEY;
  if (!credKey || credKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(credKey)) {
    console.warn(
      '[marketplace-auto-responder] CRED_ENCRYPTION_KEY is missing or invalid (must be 64 hex chars). ' +
        'One-click Facebook import will be disabled. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  } else {
    console.log('[marketplace-auto-responder] Credential encryption configured.');
  }
}

assertProductionConfig();

const cors = require('cors');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');

const { handleWebhookEvent, isConfigured, verifyWebhook } = require('./facebook');
const { parseCraigslistEmail } = require('./emailParser');
const { processInboundInquiry } = require('./inboundProcessor');
const { dispatchOutboundReply } = require('./outboundBridge');
const { getById, getPending, markApproved, markRejected, markSent } = require('./leadQueue');
const { getPlatforms } = require('./platforms');
const { parseProductDescription } = require('./productParser');
const { generateResponse } = require('./responseEngine');
const { routeMessage } = require('./intentRouter');
const { getSenderListing, registerEventIfNew, setSenderListing, saveCredentials, getCredentials, clearCredentials, markCredentialsUsed, recordSyncSuccess } = require('./db');
const { deleteProfile, listProfiles, loadProfile, saveProfile } = require('./storage');
const { encrypt, decrypt, getKeyConfigError } = require('./credentialManager');

const app = express();
const port = Number(process.env.PORT || 3000);
const runtimeCommit =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.RENDER_GIT_COMMIT ||
  process.env.SOURCE_VERSION ||
  'local-dev';
const runtimeTag = 'fb-sync-hardening-v3';

// CRITICAL FIX: Static file serving MUST be first in middleware chain
app.use(express.static(path.join(__dirname, '..', 'public')));

// Add explicit root route - this ensures index.html is served at /
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Other middleware after static file serving
app.use(cors({
  origin: ['http://localhost:3000', 'chrome-extension://*', 'http://localhost:3001'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

const ADMIN_SESSION_COOKIE = 'admin_session';
const ADMIN_CSRF_COOKIE = 'admin_csrf';
const adminSessionSecret =
  process.env.ADMIN_SESSION_SECRET || process.env.INTEGRATION_API_KEY || crypto.randomBytes(32).toString('hex');
const adminSessionTtlMs = Number(process.env.ADMIN_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

const adminLoginLimiter = rateLimit({
  windowMs: Number(process.env.ADMIN_LOGIN_RATE_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.ADMIN_LOGIN_RATE_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait and try again.' },
});

const integrationLimiter = rateLimit({
  windowMs: Number(process.env.INTEGRATION_RATE_WINDOW_MS || 60 * 1000),
  max: Number(process.env.INTEGRATION_RATE_MAX || 180),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.header('x-integration-key') || 'no-key'}`,
  message: { error: 'Too many inbound integration requests. Slow down and retry.' },
});

const setupLimiter = rateLimit({
  windowMs: Number(process.env.SETUP_RATE_WINDOW_MS || 60 * 1000),
  max: Number(process.env.SETUP_RATE_MAX || 12),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.path}`,
  message: { error: 'Too many setup attempts. Please wait and try again.', code: 'SETUP_RATE_LIMITED' },
});

const MAX_SYNC_LISTINGS = Number(process.env.MAX_SYNC_LISTINGS || 250);
const SYNC_METRICS_WINDOW_MS = Number(process.env.SYNC_METRICS_WINDOW_MS || 60 * 60 * 1000);
const SYNC_METRICS_BUCKET_MS = Number(process.env.SYNC_METRICS_BUCKET_MS || 60 * 1000);
const SYNC_METRIC_GROUPS = ['uploadSync', 'uploadSyncBulk', 'listingsBulk', 'parsePage'];
const SYNC_METRIC_FIELDS = ['requests', 'succeeded', 'failed', 'listingsReceived', 'listingsSaved'];

const syncMetrics = {
  startedAt: new Date().toISOString(),
  lastResetAt: null,
  resetCount: 0,
  uploadSync: { requests: 0, succeeded: 0, failed: 0, listingsReceived: 0, listingsSaved: 0 },
  uploadSyncBulk: { requests: 0, succeeded: 0, failed: 0, listingsReceived: 0, listingsSaved: 0 },
  listingsBulk: { requests: 0, succeeded: 0, failed: 0, listingsReceived: 0, listingsSaved: 0 },
  parsePage: { requests: 0, succeeded: 0, failed: 0, listingsReceived: 0, listingsSaved: 0 },
};

const syncMetricBuckets = SYNC_METRIC_GROUPS.reduce((groups, group) => {
  groups[group] = SYNC_METRIC_FIELDS.reduce((fields, field) => {
    fields[field] = {};
    return fields;
  }, {});
  return groups;
}, {});

function metricBucketStartMs(atMs = Date.now()) {
  return Math.floor(atMs / SYNC_METRICS_BUCKET_MS) * SYNC_METRICS_BUCKET_MS;
}

function pruneMetricBuckets(nowMs = Date.now()) {
  const cutoffMs = nowMs - SYNC_METRICS_WINDOW_MS;
  for (const group of SYNC_METRIC_GROUPS) {
    for (const field of SYNC_METRIC_FIELDS) {
      const buckets = syncMetricBuckets[group][field];
      for (const key of Object.keys(buckets)) {
        if (Number(key) < cutoffMs) {
          delete buckets[key];
        }
      }
    }
  }
}

function getRollingMetricsSnapshot(nowMs = Date.now()) {
  pruneMetricBuckets(nowMs);
  const counts = {};
  for (const group of SYNC_METRIC_GROUPS) {
    counts[group] = {};
    for (const field of SYNC_METRIC_FIELDS) {
      const buckets = syncMetricBuckets[group][field];
      counts[group][field] = Object.values(buckets).reduce((sum, value) => sum + Number(value || 0), 0);
    }
  }
  return {
    windowMs: SYNC_METRICS_WINDOW_MS,
    bucketMs: SYNC_METRICS_BUCKET_MS,
    counts,
  };
}

function metricAdd(group, field, value = 1) {
  if (!syncMetrics[group]) return;
  if (syncMetrics[group][field] == null) return;

  const delta = Number(value || 0);
  syncMetrics[group][field] = Number(syncMetrics[group][field] || 0) + delta;

  const bucketsByField = syncMetricBuckets[group] && syncMetricBuckets[group][field];
  if (!bucketsByField) return;

  const nowMs = Date.now();
  pruneMetricBuckets(nowMs);
  const bucketKey = String(metricBucketStartMs(nowMs));
  bucketsByField[bucketKey] = Number(bucketsByField[bucketKey] || 0) + delta;
}

function logSync(level, event, fields = {}) {
  const payload = {
    at: new Date().toISOString(),
    event,
    ...fields,
  };
  const line = `[sync] ${JSON.stringify(payload)}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

function resetSyncMetrics() {
  for (const group of SYNC_METRIC_GROUPS) {
    const current = syncMetrics[group] || {};
    for (const key of Object.keys(current)) {
      current[key] = 0;
    }
  }
  for (const group of SYNC_METRIC_GROUPS) {
    for (const field of SYNC_METRIC_FIELDS) {
      syncMetricBuckets[group][field] = {};
    }
  }
  syncMetrics.lastResetAt = new Date().toISOString();
  syncMetrics.resetCount = Number(syncMetrics.resetCount || 0) + 1;
}

function integrationAuthOk(req) {
  const expected = process.env.INTEGRATION_API_KEY;
  if (!expected) return false;

  const provided = req.header('x-integration-key');
  return provided === expected;
}

function parseCookies(req) {
  const input = req.headers.cookie || '';
  const out = {};

  for (const part of input.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    out[rawKey] = decodeURIComponent(rest.join('='));
  }

  return out;
}

function signAdminSession(expiresAt) {
  const payload = String(expiresAt);
  const sig = crypto.createHmac('sha256', adminSessionSecret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAdminSession(value) {
  if (!value || !value.includes('.')) return false;
  const [payload, sig] = value.split('.');
  const expected = crypto.createHmac('sha256', adminSessionSecret).update(payload).digest('hex');
  if (sig !== expected) return false;
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt)) return false;
  return Date.now() < expiresAt;
}

function clearAdminCookie(res) {
  res.append('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`);
}

function setAdminCookie(res) {
  const expiresAt = Date.now() + adminSessionTtlMs;
  const token = signAdminSession(expiresAt);
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const maxAgeSeconds = Math.floor(adminSessionTtlMs / 1000);
  res.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
  res.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=${csrfToken}; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
  return csrfToken;
}

function isAdminAuthenticated(req) {
  const cookieValue = parseCookies(req)[ADMIN_SESSION_COOKIE];
  return verifyAdminSession(cookieValue);
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) {
    return next();
  }

  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Admin login required.' });
  }

  return next();
}

function requireAdminCsrf(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) {
    return next();
  }

  const cookies = parseCookies(req);
  const cookieToken = cookies[ADMIN_CSRF_COOKIE];
  const headerToken = req.header('x-csrf-token');

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF validation failed.' });
  }

  return next();
}

function requireSetupAccess(req, res, next) {
  const enabled = process.env.SETUP_REQUIRE_AUTH === '1' || process.env.SETUP_REQUIRE_AUTH === 'true';
  if (!enabled) {
    return next();
  }

  if (integrationAuthOk(req) || isAdminAuthenticated(req)) {
    return next();
  }

  return res.status(401).json({
    error: 'Setup endpoint requires admin session or x-integration-key.',
    code: 'SETUP_AUTH_REQUIRED',
  });
}

function getCredentialKeyErrorResponse() {
  const keyError = getKeyConfigError();
  if (!keyError) {
    return null;
  }

  return {
    status: 503,
    body: {
      error: 'Credential encryption is not configured. Set CRED_ENCRYPTION_KEY to a 64-character hex value in Railway Variables.',
      code: keyError,
    },
  };
}

function normalizeSyncListing(input) {
  const listing = input && typeof input === 'object' ? input : {};
  const title = String(listing.title ?? listing.name ?? '').trim().slice(0, 200);
  const price = String(listing.price || '').trim().slice(0, 100);
  const condition = String(listing.condition || '').trim().slice(0, 80);
  const description = String(listing.description || '').trim().slice(0, 5000);
  const url = String(listing.url || '').trim().slice(0, 1000);
  const seller = String(listing.seller || '').trim().slice(0, 200);
  const location = String(listing.location || '').trim().slice(0, 200);
  const originalId = listing.originalId != null ? String(listing.originalId).slice(0, 100) : null;
  const images = Array.isArray(listing.images)
    ? listing.images
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0)
        .slice(0, 20)
    : [];

  return {
    title,
    price,
    condition,
    description,
    url,
    seller,
    location,
    originalId,
    images,
  };
}

function resolveListingId({ requestedListingId, platform, senderId }) {
  if (requestedListingId) {
    const selected = loadProfile(requestedListingId);
    if (selected) {
      if (platform && senderId) {
        setSenderListing(platform, senderId, requestedListingId);
      }
      return requestedListingId;
    }
    return null;
  }

  if (platform && senderId) {
    const mappedId = getSenderListing(platform, senderId);
    if (mappedId && loadProfile(mappedId)) {
      return mappedId;
    }
  }

  const all = listProfiles();
  if (all.length === 1) {
    return all[0].id;
  }

  return null;
}

function sendHealth(_req, res) {
  res.status(200).json({ ok: true, runtimeCommit, runtimeTag });
}

app.get('/api/runtime', (_req, res) => {
  res.status(200).json({
    ok: true,
    runtimeCommit,
    runtimeTag,
    node: process.version,
  });
});

app.get('/api/config/webhook', (req, res) => {
  const webhookKey = process.env.WEBHOOK_API_KEY || 'demo123';
  const webhookUrl = `https://your-domain.com/api/webhook/listings`; // Placeholder
  res.json({
    webhookUrl,
    apiKey: webhookKey,
  });
});

app.get('/health', sendHealth);
app.get('/api/health', sendHealth);

app.get('/listings', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'listings.html'));
});

app.get('/webhook/facebook', (req, res) => {
  if (!isConfigured()) {
    return res.status(503).send('Facebook integration is not configured.');
  }

  return verifyWebhook(req, res);
});

app.post('/webhook/facebook', (req, res) => {
  if (!isConfigured()) {
    return res.status(503).send('Facebook integration is not configured.');
  }

  return handleWebhookEvent(req, res);
});

app.get('/api/products', (_req, res) => {
  return res.json({ listings: listProfiles() });
});

app.get('/api/product/:id', (req, res) => {
  const profile = loadProfile(req.params.id);
  if (!profile) {
    return res.status(404).json({ error: 'Listing not found.' });
  }
  return res.json(profile);
});

app.delete('/api/product/:id', (req, res) => {
  const ok = deleteProfile(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'Listing not found.' });
  }
  return res.json({ ok: true });
});

app.get('/api/product', (_req, res) => {
  const profile = loadProfile();
  if (!profile) {
    return res.status(404).json({ error: 'No product profile uploaded yet.' });
  }
  return res.json(profile);
});

app.get('/api/platforms', (_req, res) => {
  return res.json({
    platforms: getPlatforms(),
  });
});

app.get('/api/admin/session', (req, res) => {
  const csrfToken = parseCookies(req)[ADMIN_CSRF_COOKIE] || null;
  if (!process.env.ADMIN_PASSWORD) {
    return res.json({ enabled: false, authenticated: true, csrfToken });
  }
  return res.json({ enabled: true, authenticated: isAdminAuthenticated(req), csrfToken });
});

app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  const requiredPassword = process.env.ADMIN_PASSWORD;
  if (!requiredPassword) {
    return res.status(400).json({ error: 'ADMIN_PASSWORD is not set on this server.' });
  }

  const input = req.body?.password;
  if (typeof input !== 'string') {
    return res.status(400).json({ error: 'Password must be a string.' });
  }

  if (input !== requiredPassword) {
    return res.status(401).json({ error: 'Invalid password.' });
  }

  const csrfToken = setAdminCookie(res);
  res.json({ ok: true, csrfToken });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

async function approveQueueById(req, res) {
  const id = req.params.id || req.body?.id;
  if (!id) {
    return res.status(400).json({ error: 'Missing lead ID.' });
  }

  const existing = getById(String(id));
  if (!existing || existing.status !== 'pending') {
    return res.status(404).json({ error: 'Lead not found.' });
  }

  const lead = markApproved(String(id));
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found.' });
  }

  const dispatch = await dispatchOutboundReply(lead);
  return res.json({ ok: true, dispatch, item: lead });
}

// Register body-style routes before `/:id/...` so `approve`/`reject` are not captured as IDs.
app.post('/api/admin/queue/approve', requireAdmin, requireAdminCsrf, (req, res) => {
  approveQueueById(req, res).catch((err) => res.status(500).json({ error: err.message }));
});

app.post('/api/admin/queue/reject', requireAdmin, requireAdminCsrf, rejectQueueById);

app.post('/api/admin/queue/:id/approve', requireAdmin, requireAdminCsrf, (req, res) => {
  approveQueueById(req, res).catch((err) => res.status(500).json({ error: err.message }));
});

function rejectQueueById(req, res) {
  const id = req.params.id || req.body?.id;
  if (!id) {
    return res.status(400).json({ error: 'Missing lead ID.' });
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
  const lead = markRejected(String(id), reason);
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found.' });
  }

  return res.json({ ok: true, item: lead });
}

app.post('/api/admin/queue/:id/reject', requireAdmin, requireAdminCsrf, rejectQueueById);

app.post('/api/admin/queue/sent', requireAdmin, requireAdminCsrf, (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing lead ID.' });
  }

  const lead = markSent(id);
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found.' });
  }

  return res.json({ ok: true });
});

app.get('/api/admin/queue', requireAdmin, (req, res) => {
  const pending = getPending();
  return res.json({ pending });
});

app.get('/api/admin/profiles', requireAdmin, (req, res) => {
  const profiles = listProfiles();
  return res.json({ profiles });
});

app.post('/api/upload', upload.single('productFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const { originalname, path: tempPath } = req.file;
  let content;
  try {
    content = fs.readFileSync(tempPath, 'utf-8');
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read uploaded file.' });
  }

  try {
    const profile = parseProductDescription(content, originalname);
    saveProfile(profile);
    return res.json({ ok: true, id: profile.id, profile });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Sync endpoint for direct JSON listing data from scrapers/extensions
app.post('/api/upload-sync', setupLimiter, requireSetupAccess, (req, res) => {
  const requestId = req.requestId;
  const startedAtMs = Date.now();
  const platform = req.body?.platform || 'unknown';
  const normalized = normalizeSyncListing(req.body);

  metricAdd('uploadSync', 'requests', 1);
  metricAdd('uploadSync', 'listingsReceived', 1);

  if (!normalized.title) {
    metricAdd('uploadSync', 'failed', 1);
    logSync('warn', 'upload-sync.validation_failed', { requestId, platform, reason: 'missing_title' });
    return res.status(400).json({ error: 'Title is required.', requestId });
  }

  const now = new Date().toISOString();
  const id = `${platform || 'sync'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const profile = {
    id,
    title: normalized.title,
    price: normalized.price || 'Contact for price',
    condition: normalized.condition || 'Used - Good',
    uploadedAt: now,
    platform,
    originalListingId: normalized.originalId,
    description: normalized.description,
    images: normalized.images,
    url: normalized.url,
    seller: normalized.seller,
    location: normalized.location,
    scrapedAt: now,
    syncedVia: 'automated-sync',
  };

  try {
    saveProfile(profile);
    metricAdd('uploadSync', 'succeeded', 1);
    metricAdd('uploadSync', 'listingsSaved', 1);
    logSync('info', 'upload-sync.saved', {
      requestId,
      platform,
      listingId: id,
      durationMs: Date.now() - startedAtMs,
    });
    return res.json({ ok: true, id, profile: { id, title: profile.title }, requestId });
  } catch (err) {
    metricAdd('uploadSync', 'failed', 1);
    logSync('error', 'upload-sync.save_failed', {
      requestId,
      platform,
      error: err.message,
      durationMs: Date.now() - startedAtMs,
    });
    return res.status(500).json({ error: err.message, requestId });
  }
});

app.post('/api/upload-sync/bulk', setupLimiter, requireSetupAccess, (req, res) => {
  const requestId = req.requestId;
  const startedAtMs = Date.now();
  const { listings, platform } = req.body;

  metricAdd('uploadSyncBulk', 'requests', 1);

  if (!Array.isArray(listings)) {
    metricAdd('uploadSyncBulk', 'failed', 1);
    logSync('warn', 'upload-sync-bulk.validation_failed', { requestId, reason: 'not_array' });
    return res.status(400).json({ error: 'listings must be an array', requestId });
  }

  metricAdd('uploadSyncBulk', 'listingsReceived', listings.length);

  if (listings.length > MAX_SYNC_LISTINGS) {
    metricAdd('uploadSyncBulk', 'failed', 1);
    logSync('warn', 'upload-sync-bulk.validation_failed', {
      requestId,
      reason: 'batch_too_large',
      size: listings.length,
      max: MAX_SYNC_LISTINGS,
    });
    return res.status(413).json({
      error: `Too many listings in one request. Max is ${MAX_SYNC_LISTINGS}.`,
      code: 'SYNC_BATCH_TOO_LARGE',
      max: MAX_SYNC_LISTINGS,
      requestId,
    });
  }

  const results = [];
  const errors = [];

  listings.forEach((listing, idx) => {
    try {
      const normalized = normalizeSyncListing(listing);
      if (!normalized.title) {
        errors.push(`Listing ${idx}: missing title`);
        return;
      }

      const now = new Date().toISOString();
      const id = `${platform || 'sync'}_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`;

      const profile = {
        id,
        title: normalized.title,
        price: normalized.price || 'Contact for price',
        condition: normalized.condition || 'Used - Good',
        uploadedAt: now,
        platform: platform || 'unknown',
        originalListingId: normalized.originalId || listing.id || null,
        description: normalized.description,
        images: normalized.images,
        url: normalized.url,
        seller: normalized.seller,
        location: normalized.location,
        scrapedAt: now,
        raw: listing.raw || {},
        syncedVia: 'automated-sync-bulk',
      };

      saveProfile(profile);
      results.push({ id, title: profile.title });
    } catch (err) {
      errors.push(`Listing ${idx}: ${err.message}`);
    }
  });

  const failed = errors.length;
  const synced = results.length;
  metricAdd('uploadSyncBulk', 'listingsSaved', synced);
  if (failed > 0) {
    metricAdd('uploadSyncBulk', 'failed', 1);
  }
  if (synced > 0) {
    metricAdd('uploadSyncBulk', 'succeeded', 1);
  }
  logSync(failed > 0 ? 'warn' : 'info', 'upload-sync-bulk.completed', {
    requestId,
    platform: platform || 'unknown',
    total: listings.length,
    synced,
    failed,
    durationMs: Date.now() - startedAtMs,
  });

  return res.json({
    ok: true,
    total: listings.length,
    synced,
    failed,
    results,
    errors: failed > 0 ? errors : undefined,
    requestId,
  });
});

app.post('/api/generate', async (req, res) => {
  const { listingId, channel, question, customerName } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length < 5) {
    return res.status(400).json({ error: 'Question must be at least 5 characters long.' });
  }

  try {
    const listing = loadProfile(listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Product listing not found.' });
    }

    const response = await generateResponse({
      listing,
      channel,
      question,
      customerName,
    });

    return res.json({ response });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/respond', async (req, res) => {
  const { listingId, channel, question, customerName } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length < 5) {
    return res.status(400).json({ error: 'Question must be at least 5 characters long.' });
  }

  const listings = listProfiles();
  if (listings.length > 1 && !listingId) {
    return res.status(400).json({ error: 'listingId is required when multiple listings exist.' });
  }

  try {
    const listing = loadProfile(listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Product listing not found.' });
    }

    const answer = await generateResponse({
      listing,
      channel,
      question,
      customerName,
    });

    return res.json({ answer });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/integrations/inbound', integrationLimiter, async (req, res) => {
  if (!integrationAuthOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key.' });
  }

  const { platform, senderId, customerName, question, listingId, queueOnly, eventId } = req.body || {};
  const headerEventId = req.header('x-event-id');
  const dedupeKey = eventId || headerEventId;

  if (!platform || !senderId || !question) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  if (dedupeKey) {
    const isNew = registerEventIfNew(`inbound:${dedupeKey}`);
    if (!isNew) {
      return res.json({ ok: true, duplicate: true });
    }
  }

  const resolvedListingId = resolveListingId({ requestedListingId: listingId, platform, senderId });
  if (!resolvedListingId) {
    return res.status(400).json({
      error: 'Unable to resolve listing. Pass listingId or map this sender to a listing first.',
    });
  }

  try {
    const result = await processInboundInquiry({
      channel: platform,
      senderId,
      customerName,
      question,
      listingId: resolvedListingId,
      queueOnly: Boolean(queueOnly),
    });

    return res.json({
      ok: true,
      duplicate: false,
      ...result,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/integrations/craigslist/email', integrationLimiter, async (req, res) => {
  if (!integrationAuthOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key.' });
  }

  const { from, subject, text, listingId, queueOnly } = req.body || {};
  const parsed = parseCraigslistEmail({ from, subject, text });

  const resolvedListingId = resolveListingId({
    requestedListingId: listingId,
    platform: 'craigslist',
    senderId: parsed.senderId,
  });

  if (!resolvedListingId) {
    return res.status(400).json({
      error: 'Unable to resolve listing. Pass listingId or map this sender to a listing first.',
    });
  }

  try {
    const result = await processInboundInquiry({
      channel: 'craigslist',
      senderId: parsed.senderId,
      customerName: parsed.customerName,
      question: parsed.question,
      listingId: resolvedListingId,
      queueOnly: Boolean(queueOnly),
    });

    return res.json({
      ok: true,
      platform: 'craigslist',
      parsed,
      ...result,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/inbound', integrationLimiter, async (req, res) => {
  if (!integrationAuthOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key.' });
  }

  const { platform, senderId, message, listingId } = req.body || {};
  if (!platform || !senderId || !message) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const resolvedListingId = resolveListingId({ requestedListingId: listingId, platform, senderId });
  if (!resolvedListingId) {
    return res.status(400).json({
      error: 'Unable to resolve listing. Pass listingId or map this sender to a listing first.',
    });
  }

  try {
    const reply = await processInboundInquiry({
      channel: platform,
      senderId,
      question: message,
      listingId: resolvedListingId,
      queueOnly: false,
    });
    return res.json({ ok: true, reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/outbound', integrationLimiter, (req, res) => {
  if (!integrationAuthOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key.' });
  }

  const { platform, senderId, listingId, message } = req.body;
  if (!platform || !senderId || !listingId || !message) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    void dispatchOutboundReply({
      id: 'manual',
      channel: platform,
      senderId,
      customerName: null,
      question: '(manual outbound)',
      proposedAnswer: message,
    }).catch((err) => console.error('Outbound bridge error:', err.message));
    registerEventIfNew(`outbound:${platform}:${senderId}:${Date.now()}`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// One-Click Setup: Save credentials & sync
// ============================================

app.post('/api/listings/bulk', setupLimiter, requireSetupAccess, (req, res) => {
  const requestId = req.requestId;
  const startedAtMs = Date.now();
  const listings = Array.isArray(req.body?.listings) ? req.body.listings : [];
  const platform = req.body?.platform || 'facebook_marketplace';

  metricAdd('listingsBulk', 'requests', 1);
  metricAdd('listingsBulk', 'listingsReceived', listings.length);

  if (listings.length === 0) {
    metricAdd('listingsBulk', 'failed', 1);
    logSync('warn', 'listings-bulk.validation_failed', { requestId, reason: 'empty_batch', platform });
    return res.status(400).json({ error: 'No listings provided.', requestId });
  }

  if (listings.length > MAX_SYNC_LISTINGS) {
    metricAdd('listingsBulk', 'failed', 1);
    logSync('warn', 'listings-bulk.validation_failed', {
      requestId,
      reason: 'batch_too_large',
      platform,
      size: listings.length,
      max: MAX_SYNC_LISTINGS,
    });
    return res.status(413).json({
      error: `Too many listings in one request. Max is ${MAX_SYNC_LISTINGS}.`,
      code: 'SYNC_BATCH_TOO_LARGE',
      max: MAX_SYNC_LISTINGS,
      requestId,
    });
  }

  let saved = 0;
  const errors = [];
  const now = new Date().toISOString();

  listings.forEach((listing, idx) => {
    try {
      const normalized = normalizeSyncListing(listing);
      if (!normalized.title) {
        errors.push(`Listing ${idx}: missing title`);
        return;
      }

      const id = `bulk_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`;
      const profile = {
        id,
        title: normalized.title,
        price: normalized.price || 'Contact for price',
        condition: normalized.condition || 'Used',
        uploadedAt: now,
        platform,
        description: normalized.description,
        images: normalized.images,
        url: normalized.url,
        seller: normalized.seller,
        location: normalized.location,
        syncedAt: now,
        source: 'bookmarklet',
      };

      saveProfile(profile);
      saved++;
    } catch (err) {
      errors.push(`Listing ${idx}: ${err.message}`);
      console.error('Error saving bulk listing:', err.message);
    }
  });

  metricAdd('listingsBulk', 'listingsSaved', saved);
  if (saved > 0) {
    metricAdd('listingsBulk', 'succeeded', 1);
  }
  if (errors.length > 0) {
    metricAdd('listingsBulk', 'failed', 1);
  }

  if (saved === 0) {
    logSync('warn', 'listings-bulk.completed', {
      requestId,
      platform,
      total: listings.length,
      synced: 0,
      failed: errors.length,
      durationMs: Date.now() - startedAtMs,
    });
    return res.status(400).json({
      error: 'No valid listings were saved. Check that scraped listings contain a title.',
      total: listings.length,
      synced: 0,
      failed: errors.length,
      errors,
      requestId,
    });
  }

  logSync(errors.length > 0 ? 'warn' : 'info', 'listings-bulk.completed', {
    requestId,
    platform,
    total: listings.length,
    synced: saved,
    failed: errors.length,
    durationMs: Date.now() - startedAtMs,
  });

  return res.json({
    ok: true,
    total: listings.length,
    count: saved,
    synced: saved,
    failed: errors.length,
errors: errors.length ? errors : undefined,
    requestId,
  });
});

// ============================================
// Webhook for Automation (Zapier/Make/n8n)
// Simple endpoint to receive listings from any source
// ============================================
app.post('/api/webhook/listings', async (req, res) => {
  const { listings, api_key } = req.body || {};

  // Simple API key check - if they provide correct key, accept
  const validKey = process.env.WEBHOOK_API_KEY || 'demo123';
  if (api_key && api_key !== validKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (!Array.isArray(listings) || listings.length === 0) {
    return res.status(400).json({ error: 'No listings provided' });
  }

  let saved = 0;
  const errors = [];

  for (let i = 0; i < listings.length; i++) {
    try {
      const item = listings[i];
      const id = item.id || `webhook_${Date.now()}_${i}`;
      const title = String(item.title || item.name || '').trim();
      if (!title) continue;

      const profile = {
        id,
        title,
        price: String(item.price || '').trim(),
        condition: String(item.condition || item.description || '').trim().slice(0, 80),
        description: String(item.description || item.details || '').trim(),
        images: item.images || [],
        url: item.url || '',
        source: 'webhook',
      };
      saveProfile(profile);
      saved++;
    } catch (err) {
      errors.push(err.message);
    }
  }

  return res.json({ ok: true, synced: saved, total: listings.length, errors });
});

app.get('/api/webhook/listings', async (req, res) => {
  const { api_key, title, price } = req.query;
  const validKey = process.env.WEBHOOK_API_KEY || 'demo123';

  if (api_key !== validKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const id = `webhook_${Date.now()}`;
  saveProfile({
    id,
    title: String(title),
    price: String(price || ''),
    source: 'webhook',
  });

  return res.json({ ok: true, id, title });
});

// ============================================
// Facebook Marketplace Profile Scraper
// Like GetReplyNow - scrapes from public profile page
// ============================================
app.post('/api/scrape/profile', setupLimiter, requireSetupAccess, async (req, res) => {
  const { profileUrl } = req.body || {};

  if (!profileUrl || !profileUrl.includes('facebook.com/marketplace/profile')) {
    return res.status(400).json({ error: 'Please provide a Facebook Marketplace profile URL' });
  }

  try {
    // Extract profile ID from URL
    const match = profileUrl.match(/\/profile\/(\d+)/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid Facebook Marketplace profile URL format' });
    }

    const profileId = match[1];
    const scrapeUrl = `https://www.facebook.com/marketplace/profile/${profileId}/`;

    console.log('[Profile Scrape] Fetching:', scrapeUrl);

    // Use fetch to get the page (server-side)
    const response = await fetch(scrapeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch profile: ${response.status}`);
    }

    const html = await response.text();
    console.log('[Profile Scrape] Got HTML, length:', html.length);

    // Extract listings from HTML - look for marketplace item data
    const listings = [];

    // Method 1: Look for JSON-LD structured data
    const jsonLdMatches = html.match(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gis);
    if (jsonLdMatches) {
      for (const match of jsonLdMatches) {
        try {
          const jsonContent = match.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
          const data = JSON.parse(jsonContent);
          if (data['@type'] === 'Product' && data.name) {
            listings.push({
              title: data.name,
              price: data.offers?.price || '',
              description: data.description || '',
              images: data.image ? [data.image] : [],
              url: data.url || profileUrl,
            });
          }
        } catch (e) {
          // Skip malformed JSON
        }
      }
    }

    // Method 2: Extract from page text using regex patterns
    if (listings.length === 0) {
      // Look for price patterns: $123, $1,234, etc.
      const priceRegex = /\$[\d,]+(?:\.\d{2})?/g;
      const prices = html.match(priceRegex) || [];

      // Look for title-like text near prices
      const lines = html.split(/\n/).map(l => l.trim()).filter(l => l);

      for (const price of prices) {
        // Find text around this price
        const priceIndex = html.indexOf(price);
        if (priceIndex === -1) continue;

        // Extract ~200 chars around the price
        const start = Math.max(0, priceIndex - 100);
        const end = Math.min(html.length, priceIndex + 100);
        const context = html.substring(start, end);

        // Clean up HTML tags
        const cleanContext = context.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

        // Extract potential title (text before price)
        const pricePos = cleanContext.indexOf(price);
        if (pricePos > 0) {
          const beforePrice = cleanContext.substring(0, pricePos).trim();
          const words = beforePrice.split(' ');
          // Take last 5-15 words as potential title
          const titleWords = words.slice(-12).filter(w => w.length > 2 && !w.match(/^\d+$/));
          const title = titleWords.join(' ');

          if (title.length > 5 && title.length < 100) {
            listings.push({
              title: title,
              price: price,
              url: profileUrl,
            });
          }
        }
      }
    }

    // Method 3: Fallback - extract any text that looks like product names
    if (listings.length === 0) {
      const potentialTitles = [];
      const titleRegex = /[A-Z][a-zA-Z\s]{10,80}(?=\s+\$|\s*[0-9])/g;
      const matches = html.match(titleRegex) || [];

      for (const match of matches) {
        if (match.length > 10 && match.length < 80 && !match.includes('Facebook') && !match.includes('Marketplace')) {
          potentialTitles.push(match.trim());
        }
      }

      // Deduplicate and limit to 20
      const uniqueTitles = [...new Set(potentialTitles)].slice(0, 20);

      for (const title of uniqueTitles) {
        listings.push({
          title: title,
          price: '',
          url: profileUrl,
        });
      }
    }

    // Remove duplicates
    const seen = new Set();
    const uniqueListings = listings.filter(listing => {
      const key = listing.title.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log('[Profile Scrape] Found listings:', uniqueListings.length);

    // If we found listings, save them
    if (uniqueListings.length > 0) {
      let saved = 0;
      const errors = [];

      for (let i = 0; i < uniqueListings.length; i++) {
        try {
          const listing = uniqueListings[i];
          const id = `profile_${Date.now()}_${i}`;

          saveProfile({
            id,
            title: listing.title,
            price: listing.price,
            condition: '',
            description: listing.description || '',
            images: listing.images || [],
            url: listing.url,
            source: 'profile_scrape',
          });
          saved++;
        } catch (err) {
          errors.push(`Listing ${i}: ${err.message}`);
        }
      }

      return res.json({
        ok: true,
        synced: saved,
        total: uniqueListings.length,
        errors: errors.length ? errors : undefined,
        listings: uniqueListings.slice(0, 5), // Return first 5 for preview
      });
    }

    return res.status(404).json({
      error: 'No listings found on this profile. Make sure the profile is public and has active listings.',
      profileUrl,
    });

  } catch (error) {
    console.error('[Profile Scrape] Error:', error);
    return res.status(500).json({
      error: 'Failed to scrape profile: ' + error.message
    });
  }
});

// ============================================
// Scrape individual Facebook Marketplace URLs
// ============================================
app.post('/api/scrape/urls', setupLimiter, requireSetupAccess, async (req, res) => {
  const { urls } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'No URLs provided' });
  }

  if (urls.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 URLs at once' });
  }

  const listings = [];
  let processed = 0;
  let errors = [];

  for (const url of urls) {
    try {
      if (!url || typeof url !== 'string') continue;

      const cleanUrl = url.trim();
      if (!cleanUrl.includes('facebook.com')) continue;

      console.log('[URL Scrape] Fetching:', cleanUrl);

      // Fetch the listing page
      const response = await fetch(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        }
      });

      if (!response.ok) {
        errors.push(`${cleanUrl}: HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();
      console.log('[URL Scrape] Got HTML, length:', html.length);

      // Extract listing data from HTML
      const listing = extractListingFromHtml(html, cleanUrl);
      if (listing) {
        listings.push(listing);
        processed++;
      } else {
        errors.push(`${cleanUrl}: Could not extract listing data`);
      }

      // Small delay to be respectful
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.error('[URL Scrape] Error:', error.message);
      errors.push(`${url}: ${error.message}`);
    }
  }

  // Save successful listings
  let saved = 0;
  const saveErrors = [];

  for (const listing of listings) {
    try {
      const id = `url_${Date.now()}_${saved}`;
      saveProfile({
        id,
        title: listing.title,
        price: listing.price,
        condition: listing.condition || 'Used - Good',
        description: listing.description || '',
        images: listing.images || [],
        url: listing.url,
        source: 'url_scrape',
      });
      saved++;
    } catch (err) {
      saveErrors.push(err.message);
    }
  }

  return res.json({
    ok: true,
    total: urls.length,
    processed,
    synced: saved,
    errors: [...errors, ...saveErrors],
    listings: listings.slice(0, 3), // Return first 3 for preview
  });
});

// Helper function to extract listing data from Facebook HTML
function extractListingFromHtml(html, url) {
  try {
    // Try multiple extraction methods

    // Method 1: Look for JSON-LD structured data
    const jsonLdMatches = html.match(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gis);
    if (jsonLdMatches) {
      for (const match of jsonLdMatches) {
        try {
          const jsonContent = match.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
          const data = JSON.parse(jsonContent);
          if (data['@type'] === 'Product' && data.name) {
            return {
              title: data.name,
              price: data.offers?.price ? `$${data.offers.price}` : '',
              description: data.description || '',
              images: data.image ? [data.image] : [],
              url: url,
              condition: 'Used - Good'
            };
          }
        } catch (e) {
          // Skip malformed JSON
        }
      }
    }

    // Method 2: Extract from meta tags
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(' | Facebook Marketplace', '').trim() : '';

    // Method 3: Look for price patterns in the HTML
    const priceRegex = /\$[\d,]+(?:\.\d{2})?/g;
    const prices = html.match(priceRegex) || [];
    const price = prices.length > 0 ? prices[0] : '';

    // Method 4: Extract description from meta description
    const descMatch = html.match(/<meta name="description" content="([^"]*)"/i);
    let description = descMatch ? descMatch[1] : '';

    // Clean up description
    description = description.replace(' | Facebook Marketplace', '').trim();

    // Method 5: Look for images
    const images = [];
    const imgMatches = html.match(/<img[^>]*src="([^"]*)"[^>]*>/gi);
    if (imgMatches) {
      for (const imgMatch of imgMatches) {
        const srcMatch = imgMatch.match(/src="([^"]*)"/i);
        if (srcMatch && srcMatch[1]) {
          const imgUrl = srcMatch[1];
          // Skip small/thumbnail images
          if (!imgUrl.includes('static.xx.fbcdn.net/rsrc.php') && imgUrl.length > 50) {
            images.push(imgUrl);
          }
        }
      }
    }

    // Only return if we have at least a title
    if (title && title.length > 5) {
      return {
        title: title.substring(0, 100),
        price: price || '',
        description: description || '',
        images: images.slice(0, 5), // Max 5 images
        url: url,
        condition: 'Used - Good'
      };
    }

  } catch (error) {
    console.error('[Extract] Error:', error.message);
  }

  return null;
}

app.post("/api/sync/facebook", setupLimiter, requireSetupAccess, async (req, res) => {
  return res.status(501).json({ 
    error: "Cloud Sync is disabled for stability. Please use the Magic Bookmarklet on the setup page for foolproof syncing.",
    code: "CLOUD_SYNC_DISABLED"
  });
});

app.post('/api/extension/reply', setupLimiter, async (req, res) => {
  const { message, listingTitle, senderName } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const allListings = listProfiles();
  let bestProfile = null;

  if (listingTitle && allListings.length > 0) {
    const needle = listingTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let bestScore = 0;
    for (const row of allListings) {
      const hay = (row.title || '').toLowerCase().split(/\s+/);
      const overlap = needle.filter(w => hay.includes(w)).length;
      const score = needle.length > 0 ? overlap / needle.length : 0;
      if (score > bestScore) { bestScore = score; bestProfile = loadProfile(row.id); }
    }
  }

  if (!bestProfile) bestProfile = loadProfile(null);

  if (!bestProfile) {
    return res.status(404).json({
      error: 'No listings synced yet. Go to your Facebook Marketplace listings page and click Sync.',
    });
  }

  const routed = routeMessage({ message: message.trim(), profile: bestProfile, customerName: senderName || 'there' });

  if (routed.skip) {
    return res.json({ ok: true, reply: null, intent: routed.intent, skipped: true });
  }

  if (routed.fastReply) {
    return res.json({
      ok: true,
      reply: routed.fastReply,
      intent: routed.intent,
      fastPath: true,
      meta: routed.meta || null,
      listingId: bestProfile.id,
      listingTitle: bestProfile.title,
    });
  }

  try {
    const reply = await generateResponse({
      question: message.trim(),
      customerName: senderName || 'there',
      profile: bestProfile,
      history: [],
      channel: 'facebook_marketplace',
    });

    return res.json({
      ok: true,
      reply,
      intent: routed.intent,
      fastPath: false,
      listingId: bestProfile.id,
      listingTitle: bestProfile.title,
    });
  } catch (err) {
    console.error('extension/reply error:', err.message);
    return res.status(500).json({ error: 'Failed to generate reply.' });
  }
});

app.patch('/api/listings/:id/floor-price', (req, res) => {
  const { id } = req.params;
  const { minPrice } = req.body || {};

  const profile = loadProfile(id);
  if (!profile) return res.status(404).json({ error: 'Listing not found.' });

  const parsed = parseFloat(String(minPrice).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return res.status(400).json({ error: 'Invalid minPrice.' });
  }

  profile.minPrice = parsed;
  saveProfile(profile);
  return res.json({ ok: true, id, minPrice: parsed });
});

app.get('/api/stats', (req, res) => {
  const listings = listProfiles();
  const pending = getPending();
  
  // Count by buyer intent
  let hot = 0, warm = 0;
  for (const item of pending) {
    const label = item.buyerIntentLabel;
    if (label === 'HIGH_INTENT' || label === 'LIKELY_BUYER') hot++;
    else if (label === 'NEGOTIATING') warm++;
  }
  
  return res.json({
    ok: true,
    listingsCount: listings.length,
    pendingReplies: pending.length,
    hotBuyers: hot,
    warmBuyers: warm,
  });
});

app.get('/api/admin/sync-metrics', requireAdmin, (req, res) => {
  return res.json({
    ok: true,
    requestId: req.requestId,
    metrics: syncMetrics,
    rollingMetrics: getRollingMetricsSnapshot(),
  });
});

app.post('/api/admin/sync-metrics/reset', requireAdmin, requireAdminCsrf, (req, res) => {
  const requestId = req.requestId;
  resetSyncMetrics();
  logSync('warn', 'admin.sync-metrics.reset', { requestId });
  return res.json({ ok: true, requestId, metrics: syncMetrics, rollingMetrics: getRollingMetricsSnapshot() });
});

app.post('/api/listings/parse-page', setupLimiter, requireSetupAccess, async (req, res) => {
  // Handle both standard JSON and Form POST (bookmarklet bypass)
  let { pageText, links, images, listings: structuredListings } = req.body || {};
  const isRedirect = req.query.redirect === 'true';
  const requestId = req.requestId;
  const startedAtMs = Date.now();

  metricAdd('parsePage', 'requests', 1);
  logSync('info', 'parse-page.received', {
    requestId,
    textLength: pageText?.length || 0,
    linksCount: links?.length || 0,
    structuredCount: Array.isArray(structuredListings) ? structuredListings.length : 0,
    isRedirect,
  });

  if (typeof links === 'string' && links.startsWith('[')) {
    try { links = JSON.parse(links); } catch { links = []; }
  }
  if (typeof images === 'string' && images.startsWith('[')) {
    try { images = JSON.parse(images); } catch { images = []; }
  }
  if (typeof structuredListings === 'string' && structuredListings.startsWith('[')) {
    try { structuredListings = JSON.parse(structuredListings); } catch { structuredListings = []; }
  }

  const hasStructuredListings = Array.isArray(structuredListings) && structuredListings.length > 0;
  if ((!pageText || pageText.trim().length < 10) && !hasStructuredListings) {
    metricAdd('parsePage', 'failed', 1);
    logSync('warn', 'parse-page.validation_failed', { requestId, reason: 'no_text_or_listings' });
    if (isRedirect) return res.redirect('/setup-status.html?error=no_text');
    return res.status(400).json({ error: 'No page text or structured listings provided.', requestId });
  }

  const text = typeof pageText === 'string' ? pageText.substring(0, 15000) : '';
  const now = new Date().toISOString();
  let listings = [];

  if (hasStructuredListings) {
    const seen = new Set();
    listings = structuredListings
      .map((item) => normalizeSyncListing(item))
      .filter((item) => {
        if (!item.title || item.title.length < 2) return false;
        const key = `${item.url}::${item.title.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    logSync('info', 'parse-page.structured_used', { requestId, count: listings.length });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!listings.length && text.length > 0 && apiKey) {
    try {
      console.log('[Sync] Using AI to extract listings...');
      const { OpenAI } = require('openai');
      const client = new OpenAI({ apiKey });
      const resp = await client.chat.completions.create({
        model: process.env.MODEL_NAME || 'gpt-4o-mini',
        messages: [{
          role: 'system',
          content: 'You are a professional marketplace data extractor. Extract active product listings from the provided text. Return ONLY a JSON array.'
        }, {
          role: 'user',
          content: `The following text is a raw copy-paste from a Facebook Marketplace "Your Listings" page. 
          Extract every active item you find. Skip items marked as "Sold" or "Delisted".
          
          Return ONLY a JSON array of objects. 
          Each object MUST have:
          - "title": (string) The product name.
          - "price": (string) The price (e.g. "$150"). If unknown, use "".
          - "status": (string) "Active", "Sold", or "Pending".

          Raw text:
          ${text}

          JSON Output Format:
          [{"title":"Example Item","price":"$50","status":"Active"}]`
        }],
        temperature: 0,
        max_tokens: 2000,
      });
      const raw = resp.choices[0].message.content.trim().replace(/^```json|^```|```$/gm, '');
      listings = JSON.parse(raw).filter(item => item.status !== 'Sold').map((item) => normalizeSyncListing(item));
      console.log(`[Sync] AI found ${listings.length} listings.`);
    } catch (err) {
      console.error('AI parse error:', err.message);
    }
  }

  if (!listings.length && text.length > 0) {
    console.log('[Sync] Running fallback regex parser...');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const priceMatch = line.match(/^\$[\d,]+/) || (lines[i + 1] || '').match(/^\$[\d,]+/);
      const isTitle = line.length > 3 && line.length < 120
        && !/^(active|sold|pending|edit|delete|boost|share|manage|more|see|view|add|create|your|marketplace|facebook|home|notifications|messages|groups|watch)/i.test(line)
        && !/^\$/.test(line)
        && /[a-zA-Z]/.test(line);
      
      if (isTitle && priceMatch) {
        listings.push(normalizeSyncListing({ title: line, price: priceMatch[0] }));
      } else if (isTitle && line.length > 5 && listings.length < 50) {
        listings.push(normalizeSyncListing({ title: line, price: '' }));
      }
    }
    console.log(`[Sync] Regex found ${listings.length} listings.`);
  }

  metricAdd('parsePage', 'listingsReceived', listings.length);

  const linkMap = Array.isArray(links) ? links : [];
  const imageMap = Array.isArray(images) ? images : [];
  let saved = 0;

  for (const item of listings) {
    const normalized = normalizeSyncListing(item);
    if (!normalized.title || normalized.title.length < 2) continue;
    try {
      const url = normalized.url || linkMap.find((l) => l.includes('/item/')) || '';
      const listingImages = normalized.images.length > 0 ? normalized.images : imageMap.slice(0, 3);
      
      saveProfile({
        id: `sync_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: normalized.title.substring(0, 200),
        price: normalized.price || '',
        condition: normalized.condition || 'Used',
        uploadedAt: now,
        highlights: [normalized.title],
        description: normalized.description || normalized.title,
        url,
        images: listingImages,
        syncedAt: now,
        source: hasStructuredListings ? 'bookmarklet-dom' : 'bookmarklet-ai',
      });
      saved++;
    } catch (e) {
      console.error('Save error:', e.message);
    }
  }

  metricAdd('parsePage', 'listingsSaved', saved);
  if (saved > 0) {
    metricAdd('parsePage', 'succeeded', 1);
  } else {
    metricAdd('parsePage', 'failed', 1);
  }

  logSync(saved > 0 ? 'info' : 'warn', 'parse-page.completed', {
    requestId,
    parsed: listings.length,
    saved,
    durationMs: Date.now() - startedAtMs,
  });

  if (isRedirect) {
    return res.redirect(`/setup-status.html?count=${saved}`);
  }
  return res.json({ ok: true, count: saved, parsed: listings.length, requestId });
});
if (require.main === module) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = { app };
