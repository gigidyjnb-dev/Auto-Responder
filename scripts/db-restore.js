#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const dbFile = process.env.APP_DB_FILE
  ? path.resolve(process.env.APP_DB_FILE)
  : path.join(dataDir, 'app.db');

const source = process.argv[2];
if (!source) {
  console.error('Usage: npm run db:restore -- <path-to-backup.db>');
  process.exit(1);
}

const resolvedSource = path.resolve(source);
if (!fs.existsSync(resolvedSource)) {
  console.error(`Backup file not found: ${resolvedSource}`);
  process.exit(1);
}

if (!fs.existsSync(path.dirname(dbFile))) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
}

fs.copyFileSync(resolvedSource, dbFile);
console.log(`Database restored from ${resolvedSource} -> ${dbFile}`);
console.log('Important: restart the server if it is running.');
