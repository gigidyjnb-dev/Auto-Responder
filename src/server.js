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
const { getSenderListing, registerEventIfNew, setSenderListing, saveCredentials, getCredentials, clearCredentials, markCredentialsUsed, recordSyncSuccess } = require('./db');
const { deleteProfile, listProfiles, loadProfile, saveProfile } = require('./storage');
const { FacebookScraper } = require('./facebookScraper');
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

app.get('/health', sendHealth);
app.get('/api/health', sendHealth);

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
app.post('/api/upload-sync', (req, res) => {
  const { title, price, condition, description, images, platform, originalId, url, seller, location } = req.body;

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Title is required.' });
  }

  const now = new Date().toISOString();
  const id = `${platform || 'sync'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const profile = {
    id,
    title: title.substring(0, 200),
    price: price || 'Contact for price',
    condition: condition || 'Used - Good',
    uploaded_at: now,
    data_json: JSON.stringify({
      platform: platform || 'unknown',
      originalListingId: originalId,
      description: description || '',
      images: images || [],
      url: url || '',
      seller: seller || '',
      location: location || '',
      scrapedAt: now,
      syncedVia: 'automated-sync',
    }),
  };

  try {
    saveProfile(profile);
    return res.json({ ok: true, id, profile: { id, title: profile.title } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-sync/bulk', (req, res) => {
  const { listings, platform } = req.body;

  if (!Array.isArray(listings)) {
    return res.status(400).json({ error: 'listings must be an array' });
  }

  const results = [];
  const errors = [];

  listings.forEach((listing, idx) => {
    try {
      if (!listing.title) {
        errors.push(`Listing ${idx}: missing title`);
        return;
      }

      const now = new Date().toISOString();
      const id = `${platform || 'sync'}_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`;

      const profile = {
        id,
        title: listing.title.substring(0, 200),
        price: listing.price || 'Contact for price',
        condition: listing.condition || 'Used - Good',
        uploaded_at: now,
        data_json: JSON.stringify({
          platform: platform || 'unknown',
          originalListingId: listing.originalId || listing.id || null,
          description: listing.description || '',
          images: listing.images || [],
          url: listing.url || '',
          seller: listing.seller || '',
          location: listing.location || '',
          scrapedAt: now,
          raw: listing.raw || {},
          syncedVia: 'automated-sync-bulk',
        }),
      };

      saveProfile(profile);
      results.push({ id, title: profile.title });
    } catch (err) {
      errors.push(`Listing ${idx}: ${err.message}`);
    }
  });

  return res.json({
    ok: true,
    total: listings.length,
    synced: results.length,
    failed: errors.length,
    results,
    errors: errors.length > 0 ? errors : undefined
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

app.post('/api/credentials/facebook', setupLimiter, requireSetupAccess, (req, res) => {
  const keyIssue = getCredentialKeyErrorResponse();
  if (keyIssue) {
    return res.status(keyIssue.status).json(keyIssue.body);
  }

  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.', code: 'MISSING_CREDENTIAL_FIELDS' });
  }

  if (password.length < 4 || password.length > 200) {
    return res.status(400).json({ error: 'Password length is invalid.', code: 'INVALID_PASSWORD_LENGTH' });
  }

  try {
    const encryptedPassword = encrypt(password);
    saveCredentials('facebook_marketplace', email, encryptedPassword, null);
    return res.json({ ok: true });
  } catch (err) {
    if (err.message === 'CRED_ENCRYPTION_KEY_INVALID') {
      return res.status(503).json({
        error: 'Credential encryption is not configured. Set CRED_ENCRYPTION_KEY to a 64-character hex value in Railway Variables.',
        code: 'CRED_ENCRYPTION_KEY_INVALID',
      });
    }

    if (err.message === 'CREDENTIAL_ENCRYPTION_FAILED') {
      return res.status(500).json({ error: 'Failed to secure credentials for storage.', code: 'CREDENTIAL_ENCRYPTION_FAILED' });
    }

    return res.status(500).json({ error: 'Failed to save credentials.', code: 'CREDENTIAL_SAVE_FAILED' });
  }
});

app.post('/api/sync/facebook', setupLimiter, requireSetupAccess, async (req, res) => {
  const keyIssue = getCredentialKeyErrorResponse();
  if (keyIssue) {
    return res.status(keyIssue.status).json(keyIssue.body);
  }

  const creds = getCredentials('facebook_marketplace');
  if (!creds) {
    return res.status(400).json({ error: 'No credentials stored. Connect your account first.', code: 'NO_STORED_CREDENTIALS' });
  }

  markCredentialsUsed('facebook_marketplace');

  try {
    const password = decrypt(creds.password_encrypted);
    if (!password) {
      return res.status(500).json({
        error: 'Stored credentials could not be decrypted. Reconnect your Facebook account and try again.',
        code: 'CREDENTIAL_DECRYPT_FAILED',
      });
    }

    const scraper = new FacebookScraper();
    const listings = await scraper.loginAndScrape({
      email: creds.username,
      password,
    });

    let saved = 0;
    for (const listing of listings) {
      try {
        const now = new Date().toISOString();
        const id = `fb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const profile = {
          id,
          title: listing.title.substring(0, 200),
          price: listing.price || 'Contact for price',
          condition: 'Used - Good',
          uploaded_at: now,
          data_json: JSON.stringify({
            platform: 'facebook_marketplace',
            originalListingId: listing.originalId || null,
            description: listing.description || '',
            images: listing.images || [],
            url: listing.url || '',
            scrapedAt: now,
            syncedAt: now,
          }),
        };

        saveProfile(profile);
        saved++;
      } catch (err) {
        console.error('Error saving listing:', err.message);
      }
    }

    recordSyncSuccess('facebook_marketplace');

    return res.json({
      ok: true,
      message: `Imported ${saved} listings`,
      count: saved,
      listings: listings.map((l) => ({ title: l.title, price: l.price })),
    });
  } catch (err) {
    const message = err?.message || '';
    console.error('Sync error:', err);

    if (message.includes('FACEBOOK_LOGIN_FAILED')) {
      return res.status(401).json({
        error: 'Facebook login failed. Re-check your email/password and try again.',
        code: 'FACEBOOK_LOGIN_FAILED',
      });
    }

    if (message.includes('FACEBOOK_LOGIN_FORM_NOT_FOUND')) {
      return res.status(502).json({
        error: 'Facebook login page changed and the form could not be detected. Please retry shortly.',
        code: 'FACEBOOK_LOGIN_FORM_NOT_FOUND',
      });
    }

    if (message.includes('FACEBOOK_LISTINGS_NOT_FOUND')) {
      return res.status(502).json({
        error: 'Logged in but listings did not load from Marketplace. Try again in a moment.',
        code: 'FACEBOOK_LISTINGS_NOT_FOUND',
      });
    }

    if (message.includes('2FA') || message.includes('checkpoint')) {
      return res.status(403).json({
        error: 'Facebook requires two-factor authentication or security verification. Please complete this in your browser first, then try again.',
        code: 'FACEBOOK_2FA_REQUIRED',
      });
    }

    if (message.includes('Navigation timeout') || message.includes('net::ERR')) {
      return res.status(502).json({
        error: 'Could not reach Facebook. Please try again later.',
        code: 'NETWORK_ERROR',
      });
    }

    return res.status(500).json({ error: 'Sync failed.', code: 'FACEBOOK_SYNC_FAILED' });
  }
});

if (require.main === module) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = { app };
