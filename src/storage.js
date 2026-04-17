const fs = require('fs');
const path = require('path');

const { db, safeParseJson } = require('./db');

const LISTINGS_DIR = path.join(__dirname, '..', 'data', 'listings');
const OLD_FILE = path.join(__dirname, '..', 'data', 'product-profile.json');

function makeId(title) {
  const slug = String(title || 'listing')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const suffix = Date.now().toString(36);
  return `${slug}-${suffix}`;
}

function migrateLegacyFilesToDb() {
  const hasRows = db.prepare('SELECT COUNT(*) AS count FROM listings').get().count > 0;

  if (hasRows) {
    return;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO listings (id, title, price, condition, uploaded_at, data_json)
    VALUES (@id, @title, @price, @condition, @uploaded_at, @data_json)
  `);

  const insertListing = (profile) => {
    if (!profile || typeof profile !== 'object') return;
    if (!profile.id) profile.id = makeId(profile.title);
    if (!profile.uploadedAt) profile.uploadedAt = new Date().toISOString();
    insert.run({
      id: profile.id,
      title: profile.title || 'Marketplace Item',
      price: profile.price || null,
      condition: profile.condition || null,
      uploaded_at: profile.uploadedAt,
      data_json: JSON.stringify(profile),
    });
  };

  if (fs.existsSync(OLD_FILE)) {
    try {
      const raw = fs.readFileSync(OLD_FILE, 'utf-8');
      insertListing(JSON.parse(raw));
      fs.unlinkSync(OLD_FILE);
    } catch {
      // Best-effort migration.
    }
  }

  if (fs.existsSync(LISTINGS_DIR)) {
    const files = fs.readdirSync(LISTINGS_DIR).filter((f) => f.endsWith('.json'));
    for (const fileName of files) {
      try {
        const raw = fs.readFileSync(path.join(LISTINGS_DIR, fileName), 'utf-8');
        insertListing(JSON.parse(raw));
      } catch {
        // Ignore unreadable listing files during migration.
      }
    }
  }
}

migrateLegacyFilesToDb();

function saveProfile(profile) {
  if (!profile.id) {
    profile.id = makeId(profile.title);
  }

  if (!profile.uploadedAt) {
    profile.uploadedAt = new Date().toISOString();
  }

  db.prepare(
    `INSERT OR REPLACE INTO listings (id, title, price, condition, uploaded_at, data_json)
     VALUES (@id, @title, @price, @condition, @uploaded_at, @data_json)`
  ).run({
    id: profile.id,
    title: profile.title || 'Marketplace Item',
    price: profile.price || null,
    condition: profile.condition || null,
    uploaded_at: profile.uploadedAt,
    data_json: JSON.stringify(profile),
  });

  return profile;
}

function loadProfile(id) {
  if (id) {
    const row = db.prepare('SELECT data_json FROM listings WHERE id = ?').get(id);
    if (!row) return null;
    return safeParseJson(row.data_json, null);
  }

  // No id — return the most recently uploaded listing
  const all = listProfiles();
  if (all.length === 0) return null;
  return loadProfile(all[all.length - 1].id);
}

function listProfiles() {
  return db
    .prepare('SELECT id, title, price, condition, uploaded_at FROM listings ORDER BY datetime(uploaded_at) ASC')
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      price: row.price,
      condition: row.condition,
      uploadedAt: row.uploaded_at,
    }));
}

function deleteProfile(id) {
  const result = db.prepare('DELETE FROM listings WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = {
  saveProfile,
  loadProfile,
  listProfiles,
  deleteProfile,
};
