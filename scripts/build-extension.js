#!/usr/bin/env node

/**
 * Prepares extension for distribution.
 * Option 1: Creates installable zip (requires archiver, fallback: manual minimal zip)
 * Option 2: Outputs instructions for loading unpacked extension (recommended for dev)
 */

const fs = require('fs');
const path = require('path');

const EXTENSION_DIR = path.join(__dirname, '..', 'public', 'extension');
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'extension', 'marketplace-sync-extension.zip');

// Extension source files (relative to extension directory)
const SOURCE_FILES = [
  'manifest.json',
  'popup.html',
  'popup.js',
  'background.js',
  'content-inbox.js',
  'scrapers/universal.js',
  'scrapers/facebook_marketplace.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

function getExtensionPath(rel) {
  return path.join(EXTENSION_DIR, rel);
}

console.log('📦 Listing Sync Extension Builder\n');
console.log(`Extension source: ${EXTENSION_DIR}`);
console.log(`Output: ${OUTPUT_PATH}\n`);

// Verify all source files exist
let allExist = true;
for (const file of SOURCE_FILES) {
  const full = getExtensionPath(file);
  if (!fs.existsSync(full)) {
    console.error(`❌ Missing: ${file}`);
    allExist = false;
  } else {
    const size = fs.statSync(full).size;
    console.log(`✓ ${file} (${size} bytes)`);
  }
}

if (!allExist) {
  console.error('\nBuild aborted: missing files.');
  process.exit(1);
}

// Option 1: Try to use archiver if available
try {
  const archiver = require('archiver');
  
  const output = fs.createWriteStream(OUTPUT_PATH);
  const archive = archiver('zip', { zlib: { level: 9 } });
  
  output.on('close', () => {
    console.log(`\n✅ Extension zip created: ${OUTPUT_PATH}`);
    console.log(`   Size: ${archive.pointer()} bytes`);
    console.log('\n📋 User instructions:');
    console.log('1. Download the zip file');
    console.log('2. Go to chrome://extensions/');
    console.log('3. Enable "Developer mode"');
    console.log('4. Drag the zip onto the page to install');
  });
  
  archive.on('error', (err) => { throw err; });
  
  archive.pipe(output);
  
  for (const file of SOURCE_FILES) {
    archive.file(getExtensionPath(file), { name: file });
  }
  
  archive.finalize();
  
} catch (err) {
  if (err.code === 'MODULE_NOT_FOUND') {
    console.log('\n⚠️  archiver package not installed.');
    console.log('To create proper zip files, run: npm install -D archiver');
    console.log('\nAlternatively, users can load the unpacked extension:');
    console.log('1. Clone the repository');
    console.log('2. Open chrome://extensions/');
    console.log('3. Enable "Developer mode"');
    console.log('4. Click "Load unpacked" and select:');
    console.log(`   ${EXTENSION_DIR}`);
  } else {
    console.error('Build error:', err);
    process.exit(1);
  }
}
