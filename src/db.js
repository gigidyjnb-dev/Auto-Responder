const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const explicitDbFile = process.env.APP_DB_FILE ? path.resolve(process.env.APP_DB_FILE) : null;
const DATA_DIR = explicitDbFile ? path.dirname(explicitDbFile) : path.join(__dirname, '..', 'data');
const DB_FILE = explicitDbFile || path.join(DATA_DIR, 'app.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db;
try {
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  console.error(`Failed to initialize database at ${DB_FILE}:`, err.message);
  // In Railway or other environments, the db might not be writable, so exit
  process.exit(1);
}

db.exec(`
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  title TEXT,
  price TEXT,
  condition TEXT,
  uploaded_at TEXT,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  username TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  session_cookie_encrypted TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  last_sync_at TEXT,
  sync_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cred_platform ON platform_credentials(platform);

CREATE TABLE IF NOT EXISTS queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  channel TEXT,
  sender_id TEXT,
  customer_name TEXT,
  question TEXT,
  proposed_answer TEXT,
  confidence REAL,
  reasons_json TEXT,
  review_note TEXT,
  listing_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_items(status);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_sender ON conversation_turns(sender_id, id);

CREATE TABLE IF NOT EXISTS sender_listing_map (
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, sender_id)
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  subscription_status TEXT DEFAULT 'free',
  subscription_expires_at TEXT,
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_listings_user_id ON user_listings(user_id);
`);

// Migrate: add buyer intent columns if they don't exist yet
for (const col of [
  'ALTER TABLE queue_items ADD COLUMN buyer_intent_score REAL',
  'ALTER TABLE queue_items ADD COLUMN buyer_intent_label TEXT',
  'ALTER TABLE queue_items ADD COLUMN buyer_intent_signals TEXT',
]) {
  try { db.exec(col); } catch { /* column already exists */ }
}

function safeParseJson(input, fallback) {
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

function rowToQueueItem(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    channel: row.channel,
    senderId: row.sender_id,
    customerName: row.customer_name,
    question: row.question,
    proposedAnswer: row.proposed_answer,
    confidence: row.confidence,
    reasons: safeParseJson(row.reasons_json || '[]', []),
    reviewNote: row.review_note,
    listingId: row.listing_id,
    buyerIntentScore: row.buyer_intent_score != null ? row.buyer_intent_score : null,
    buyerIntentLabel: row.buyer_intent_label || null,
    buyerIntentSignals: safeParseJson(row.buyer_intent_signals || '[]', []),
  };
}

function getSenderListing(channel, senderId) {
  const row = db
    .prepare('SELECT listing_id FROM sender_listing_map WHERE channel = ? AND sender_id = ?')
    .get(channel, senderId);
  return row ? row.listing_id : null;
}

function setSenderListing(channel, senderId, listingId) {
  db.prepare(
    `INSERT INTO sender_listing_map (channel, sender_id, listing_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel, sender_id)
     DO UPDATE SET listing_id = excluded.listing_id, updated_at = excluded.updated_at`
  ).run(channel, senderId, listingId, new Date().toISOString());
}

function registerEventIfNew(eventKey) {
  if (!eventKey) return true;

  // Keep table from growing indefinitely.
  db.prepare("DELETE FROM processed_events WHERE datetime(created_at) < datetime('now', '-7 days')").run();

  const result = db
    .prepare('INSERT OR IGNORE INTO processed_events (event_key, created_at) VALUES (?, ?)')
    .run(String(eventKey), new Date().toISOString());

  return result.changes > 0;
}

// Platform credentials management (encrypted storage)
function saveCredentials(platform, username, password, sessionCookie = null) {
  const now = new Date().toISOString();
  
  // Check if exists
  const existing = db.prepare('SELECT id FROM platform_credentials WHERE platform = ?').get(platform);
  
  if (existing) {
    db.prepare(`
      UPDATE platform_credentials 
      SET username = ?, password_encrypted = ?, session_cookie_encrypted = ?, 
          updated_at = ?, last_used_at = ?
      WHERE platform = ?
    `).run(username, password, sessionCookie, now, now, platform);
    return existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO platform_credentials 
      (platform, username, password_encrypted, session_cookie_encrypted, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(platform, username, password, sessionCookie, now, now, now);
    return result.lastInsertRowid;
  }
}

function getCredentials(platform) {
  const row = db.prepare('SELECT * FROM platform_credentials WHERE platform = ?').get(platform);
  return row || null;
}

function clearCredentials(platform) {
  db.prepare('DELETE FROM platform_credentials WHERE platform = ?').run(platform);
}

function markCredentialsUsed(platform) {
  db.prepare('UPDATE platform_credentials SET last_used_at = ? WHERE platform = ?')
    .run(new Date().toISOString(), platform);
}

function recordSyncSuccess(platform) {
  db.prepare('UPDATE platform_credentials SET last_sync_at = ?, sync_count = sync_count + 1 WHERE platform = ?')
    .run(new Date().toISOString(), platform);
}

// User authentication functions
function createUser(email, passwordHash) {
  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      INSERT INTO users (email, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(email, passwordHash, now, now);
    return result.lastInsertRowid;
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      throw new Error('Email already registered');
    }
    throw err;
  }
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO user_sessions (user_id, session_token, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, token, expiresAt, now);

  return token;
}

function getSession(token) {
  const row = db.prepare(`
    SELECT s.*, u.email, u.subscription_status, u.subscription_expires_at
    FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.session_token = ? AND s.expires_at > ?
  `).get(token, new Date().toISOString());

  return row || null;
}

function deleteSession(token) {
  db.prepare('DELETE FROM user_sessions WHERE session_token = ?').run(token);
}

function updateSubscription(userId, status, expiresAt, stripeCustomerId = null) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users
    SET subscription_status = ?, subscription_expires_at = ?, stripe_customer_id = ?, updated_at = ?
    WHERE id = ?
  `).run(status, expiresAt, stripeCustomerId, now, userId);
}

function addUserListing(userId, listingId) {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO user_listings (user_id, listing_id, created_at)
      VALUES (?, ?, ?)
    `).run(userId, listingId, now);
  } catch (err) {
    // Ignore duplicate entries
  }
}

function getUserListings(userId) {
  return db.prepare(`
    SELECT l.* FROM listings l
    JOIN user_listings ul ON l.id = ul.listing_id
    WHERE ul.user_id = ?
    ORDER BY l.uploaded_at DESC
  `).all(userId);
}

function isUserSubscribed(user) {
  if (!user) return false;

  if (user.subscription_status === 'active') {
    if (user.subscription_expires_at) {
      return new Date(user.subscription_expires_at) > new Date();
    }
    return true;
  }

  return false;
}

module.exports = {
  db,
  safeParseJson,
  rowToQueueItem,
  getSenderListing,
  setSenderListing,
  registerEventIfNew,
  saveCredentials,
  getCredentials,
  clearCredentials,
  markCredentialsUsed,
  recordSyncSuccess,
  // User functions
  createUser,
  getUserByEmail,
  getUserById,
  createSession,
  getSession,
  deleteSession,
  updateSubscription,
  addUserListing,
  getUserListings,
  isUserSubscribed,
};