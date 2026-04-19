const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');

const TEST_DB_FILE = path.join(__dirname, '..', 'data', 'test-listing-parser.db');
if (fs.existsSync(TEST_DB_FILE)) {
  fs.unlinkSync(TEST_DB_FILE);
}

process.env.APP_DB_FILE = TEST_DB_FILE;
process.env.OPENAI_API_KEY = ''; // Force fallback
process.env.ADMIN_PASSWORD = 'test-pass';

const { app } = require('../src/server');

test('/api/listings/parse-page fallback logic works with images and links', async () => {
  const pageText = `
Marketplace
Blue Sofa
$150
Used - Like New
Coffee Table
$45
Used - Fair
  `;
  const links = ['https://www.facebook.com/marketplace/item/12345/'];
  const images = ['https://scontent.xx.fbcdn.net/v/t39.30808-6/test.jpg'];

  const res = await request(app)
    .post('/api/listings/parse-page')
    .send({ pageText, links, images });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  
  const productsRes = await request(app).get('/api/products');
  assert.equal(productsRes.status, 200);
  const listings = productsRes.body.listings;
  
  const sofa = listings.find(l => l.title === 'Blue Sofa');
  assert.ok(sofa);
  assert.equal(sofa.price, '$150');
  
  // Verify it picked up the link and images from storage
  const { loadProfile } = require('../src/storage');
  const profile = loadProfile(sofa.id);
  assert.equal(profile.url, links[0]);
  assert.ok(profile.images.length > 0);
  assert.equal(profile.images[0], images[0]);
});

test('/api/listings/parse-page handles empty or invalid input', async () => {
  const resEmpty = await request(app)
    .post('/api/listings/parse-page')
    .send({ pageText: '' });
  assert.equal(resEmpty.status, 400);

  const resShort = await request(app)
    .post('/api/listings/parse-page')
    .send({ pageText: 'too short' });
  assert.equal(resShort.status, 400);
});
