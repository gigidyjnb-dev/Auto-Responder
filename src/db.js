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

  let existing;
  try {
    existing = db.prepare('SELECT id FROM platform_credentials WHERE platform = ?').get(platform);
  } catch (err) {
    console.error(`[db.saveCredentials] Failed to query existing credentials for platform "${platform}":`, err.message, err.stack);
    throw err;
  }

  if (existing) {
    try {
      db.prepare(`
        UPDATE platform_credentials 
        SET username = ?, password_encrypted = ?, session_cookie_encrypted = ?, 
            updated_at = ?, last_used_at = ?
        WHERE platform = ?
      `).run(username, password, sessionCookie, now, now, platform);
      console.log(`[db.saveCredentials] Updated credentials for platform "${platform}" (id=${existing.id})`);
      return existing.id;
    } catch (err) {
      console.error(`[db.saveCredentials] UPDATE failed for platform "${platform}":`, err.message, err.stack);
      throw err;
    }
  } else {
    try {
      const result = db.prepare(`
        INSERT INTO platform_credentials 
        (platform, username, password_encrypted, session_cookie_encrypted, created_at, updated_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(platform, username, password, sessionCookie, now, now, now);
      console.log(`[db.saveCredentials] Inserted credentials for platform "${platform}" (id=${result.lastInsertRowid})`);
      return result.lastInsertRowid;
    } catch (err) {
      console.error(`[db.saveCredentials] INSERT failed for platform "${platform}":`, err.message, err.stack);
      throw err;
    }
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
};