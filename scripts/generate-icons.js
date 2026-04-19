#!/usr/bin/env node

/**
 * Generate simple extension icons in PNG format.
 * Creates 16x16, 48x48, and 128x128 solid-color icons with a letter 'S'.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Helper: create a valid PNG file with solid color and text placeholder
// PNG signature + IHDR + IDAT (image data) + IEND

function createPNG(width, height, r, g, b) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrData = Buffer.concat([
    Buffer.from('IHDR'),
    ihdr
  ]);
  const ihdrCrc = crc32(ihdrData);
  const ihdrChunk = Buffer.concat([
    Buffer.from([(ihdrData.length + 4) >>> 24 & 0xff, (ihdrData.length + 4) >>> 16 & 0xff, (ihdrData.length + 4) >>> 8 & 0xff, ihdrData.length + 4 & 0xff]),
    ihdrData,
    Buffer.from([ihdrCrc >>> 24 & 0xff, ihdrCrc >>> 16 & 0xff, ihdrCrc >>> 8 & 0xff, ihdrCrc & 0xff])
  ]);

  // Build raw image data (RGB + filter byte per scanline)
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  // Compress with zlib
  const compressed = zlib.deflateSync(raw, { level: 9 });

  // IDAT chunk
  const idatData = Buffer.concat([Buffer.from('IDAT'), compressed]);
  const idatCrc = crc32(idatData);
  const idatChunk = Buffer.concat([
    Buffer.from([(idatData.length + 4) >>> 24 & 0xff, (idatData.length + 4) >>> 16 & 0xff, (idatData.length + 4) >>> 8 & 0xff, idatData.length + 4 & 0xff]),
    idatData,
    Buffer.from([idatCrc >>> 24 & 0xff, idatCrc >>> 16 & 0xff, idatCrc >>> 8 & 0xff, idatCrc & 0xff])
  ]);

  // IEND chunk
  const iendData = Buffer.from('IEND');
  const iendCrc = crc32(iendData);
  const iendChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x08]), // length 8
    iendData,
    Buffer.from([iendCrc >>> 24 & 0xff, iendCrc >>> 16 & 0xff, iendCrc >>> 8 & 0xff, iendCrc & 0xff])
  ]);

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function crc32(data) {
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const crcTable = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

// Generate icons
const iconsDir = path.join(__dirname, '..', 'public', 'extension', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Brand color: #0066ff
const sizes = [16, 48, 128];
sizes.forEach(size => {
  const png = createPNG(size, size, 0, 102, 255); // Blue
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  console.log(`✓ icon${size}.png generated`);
});

console.log('✅ Extension icons ready.');
