#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const dbFile = process.env.APP_DB_FILE
  ? path.resolve(process.env.APP_DB_FILE)
  : path.join(dataDir, 'app.db');

if (!fs.existsSync(dbFile)) {
  console.error(`Database file not found: ${dbFile}`);
  process.exit(1);
}

const backupsDir = path.join(dataDir, 'backups');
if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir, { recursive: true });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupsDir, `app-${stamp}.db`);

fs.copyFileSync(dbFile, target);
console.log(`Backup created: ${target}`);
