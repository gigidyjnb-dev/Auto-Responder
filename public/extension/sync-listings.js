#!/usr/bin/env node

/**
 * Automated Listing Sync Script
 * Scrapes your marketplace listings and uploads them to your auto-responder server.
 *
 * Usage: node sync-listings.js
 *
 * This uses Puppeteer to automate a real Chrome browser, making it look like
 * human activity to avoid bot detection.
 */

const readline = require('readline');
const puppeteer = require('puppeteer');
const fs = require('fs');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('\n🚀 Marketplace Listing Sync Tool\n');
  console.log('This will log into your marketplace account and sync all your active listings.\n');

  const platform = await question('Which platform? (facebook, ebay, etsy, offerup, mercari, poshmark, craigslist): ');
  const serverUrl = await question('Your auto-responder server URL (default: http://localhost:3000): ') || 'http://localhost:3000';
  const email = await question('Email/Phone: ');
  const password = await question('Password (hidden): ');

  rl.close();

  console.log(`\n📡 Starting ${platform} sync...`);

  const browser = await puppeteer.launch({
    headless: false, // Show browser for user visibility
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800'
    ]
  });

  try {
    const page = await browser.newPage();

    // Anti-detection: mask webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });

    // Set realistic viewport and user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    const platformUrl = getLoginUrl(platform);
    console.log(`→ Navigating to ${platformUrl}...`);
    await page.goto(platformUrl, { waitUntil: 'networkidle2' });

    // Login logic per platform
    await login(page, platform, email, password);

    console.log('✓ Logged in. Navigating to listings page...');
    await navigateToListings(page, platform);

    console.log('✓ Loading listings (scroll to load all)...');
    const listings = await scrapeListings(page, platform);

    console.log(`✓ Found ${listings.length} listings.`);

    if (listings.length === 0) {
      console.log('⚠️  No listings found. Make sure you have active listings on your account.');
      return;
    }

    console.log('📤 Uploading to server...');
    const uploaded = await uploadListings(listings, platform, serverUrl);

    console.log(`\n✅ Complete! Synced ${uploaded} listings to your auto-responder.\n`);
    console.log('You can now generate responses for these listings in your web interface.\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await browser.close();
  }
}

function getLoginUrl(platform) {
  const urls = {
    facebook: 'https://www.facebook.com/login',
    ebay: 'https://signin.ebay.com/',
    etsy: 'https://www.etsy.com/signin',
    offerup: 'https://offerup.com/login',
    mercari: 'https://www.mercari.com/login',
    poshmark: 'https://poshmark.com/signin',
    craigslist: 'https://accounts.craigslist.org/login'
  };
  return urls[platform.toLowerCase()] || `https://${platform}.com/login`;
}

async function findFirstSelector(page, selectors, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const selector of selectors) {
      const handle = await page.$(selector);
      if (handle) return selector;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

function asArray(input) {
  return Array.isArray(input) ? input : [input];
}

async function login(page, platform, email, password) {
  console.log(`Logging into ${platform}...`);
  await new Promise(r => setTimeout(r, 2000));

  const selectors = {
    facebook: {
      email: ['#email', 'input[name="email"]', 'input[autocomplete="username"]'],
      pass: ['#pass', 'input[name="pass"]', 'input[type="password"]'],
      submit: ['button[name="login"]', '[data-testid="royal_login_button"]', 'button[type="submit"]']
    },
    ebay: {
      email: '#userid',
      pass: '#pass',
      submit: '#sgnBt'
    },
    etsy: {
      email: '[data-test="login-email-input"]',
      pass: '[data-test="login-password-input"]',
      submit: '[data-test="login-submit-button"]'
    },
    offerup: {
      email: 'input[data-test="email-input"]',
      pass: 'input[data-test="password-input"]',
      submit: 'button[data-test="sign-in-submit-button"]'
    },
    mercari: {
      email: 'input[name="email"]',
      pass: 'input[name="password"]',
      submit: 'button[type="submit"]'
    },
    poshmark: {
      email: 'input[data-test="email-phone-username-input"]',
      pass: 'input[data-test="password-input"]',
      submit: 'button[data-test="sign-in-submit-button"]'
    },
    craigslist: {
      email: '#inputEmailHandle',
      pass: '#inputPassword',
      submit: 'button[type="submit"]'
    }
  };

  const sel = selectors[platform.toLowerCase()];

  if (!sel) {
    console.log(`⚠️  No login automation for ${platform}. Please log in manually in the opened browser, then press ENTER to continue...`);
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
    return;
  }

  try {
    const emailSelector = await findFirstSelector(page, asArray(sel.email), 15000);
    const passSelector = await findFirstSelector(page, asArray(sel.pass), 15000);
    const submitSelector = await findFirstSelector(page, asArray(sel.submit), 15000);

    if (!emailSelector || !passSelector || !submitSelector) {
      throw new Error('Login form fields not found');
    }

    await page.focus(emailSelector);
    await page.click(emailSelector, { clickCount: 3 });
    await page.keyboard.type(email, { delay: 50 });

    await page.focus(passSelector);
    await page.click(passSelector, { clickCount: 3 });
    await page.keyboard.type(password, { delay: 50 });

    await page.click(submitSelector);
    await new Promise(r => setTimeout(r, 3000));

    console.log('✓ Login submitted. If you see 2FA or a captcha, complete it now.');
    await new Promise(resolve => {
      console.log('Press ENTER once you are on your listings page...');
      process.stdin.once('data', resolve);
    });
  } catch (error) {
    console.log('⚠️  Auto-login failed. Please log in manually in the browser, then press ENTER.');
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
  }
}

async function navigateToListings(page, platform) {
  const urlMap = {
    facebook: 'https://www.facebook.com/marketplace/you/',
    ebay: 'https://www.ebay.com/mys/home?iss=1&sort=active',
    etsy: 'https://www.etsy.com/your/shops/me',
    offerup: 'https://offerup.com/feed/',
    mercari: 'https://www.mercari.com/m/items',
    poshmark: 'https://poshmark.com/closet',
    craigslist: 'https://accounts.craigslist.org/login/home'
  };

  const targetUrl = urlMap[platform.toLowerCase()];
  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 3000));
  }
}

function normalizeScraperPlatform(platform) {
  if (platform === 'facebook') return 'facebook_marketplace';
  return platform;
}

async function scrapeListings(page, platform) {
  // Scroll to load all listings
  let lastHeight = 0;
  let sameCount = 0;

  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise(r => setTimeout(r, 1500));

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === lastHeight) {
      sameCount++;
      if (sameCount > 5) break;
    } else {
      sameCount = 0;
      lastHeight = newHeight;
    }
  }

  // Extract listings via DOM
  const scraperPlatform = normalizeScraperPlatform(platform);

  return await page.evaluate((p) => {
    const scrapers = {
      facebook_marketplace: () => {
        const items = document.querySelectorAll('[data-testid="marketplace_listing_item"], a[href*="/marketplace/item/"]');
        return Array.from(items).map(el => {
          const link = el.closest('a')?.href || el.href;
          const title = el.querySelector('[data-testid="marketplace_listing_title"]')?.textContent?.trim()
                     || el.querySelector('span[dir="auto"]')?.textContent?.trim()
                     || 'Untitled';
          const price = el.querySelector('[data-testid="marketplace_listing_price"]')?.textContent?.trim()
                     || Array.from(el.querySelectorAll('span')).map((s) => s.textContent?.trim() || '').find((txt) => /^\$\d/.test(txt))
                     || '';
          const img = el.querySelector('img');
          const images = img ? [img.src] : [];
          return { title, price, images, url: link };
        }).filter(l => l.title && l.title !== 'Untitled');
      },
      ebay: () => {
        const items = document.querySelectorAll('[data-testid="item-card"]');
        return Array.from(items).map(el => ({
          title: el.querySelector('.s-item__title')?.textContent?.trim() || 'Untitled',
          price: el.querySelector('.s-item__price')?.textContent?.trim() || '',
          images: [el.querySelector('.s-item__image-img')?.src],
          url: el.querySelector('a.s-item__link')?.href
        })).filter(l => l.title && l.title !== 'Untitled' && !l.title.includes('Shop on eBay'));
      },
      etsy: () => {
        const items = document.querySelectorAll('[data-testid="listing-card"]');
        return Array.from(items).map(el => ({
          title: el.querySelector('h3')?.textContent?.trim() || 'Untitled',
          price: el.querySelector('.currency-value')?.textContent?.trim() || '',
          images: [el.querySelector('img')?.src],
          url: el.querySelector('a')?.href
        })).filter(l => l.title);
      },
      craigslist: () => {
        const items = document.querySelectorAll('.cl-static-search-result');
        return Array.from(items).map(el => ({
          title: el.querySelector('.title')?.textContent?.trim() || 'Untitled',
          price: el.querySelector('.price')?.textContent?.trim() || '',
          images: [],
          url: el.querySelector('a')?.href
        })).filter(l => l.title);
      },
      default: () => {
        // Generic scraper - look for common listing patterns
        const items = document.querySelectorAll('li, div[class*="item"], div[class*="card"], a[href*="item"]');
        return Array.from(items).map(el => ({
          title: el.querySelector('h1, h2, h3, .title, [class*="title"]')?.textContent?.trim() || 'Untitled',
          price: el.querySelector('[class*="price"], .amount, [class*="Price"]')?.textContent?.trim() || '',
          images: [el.querySelector('img')?.src],
          url: el.querySelector('a')?.href || window.location.href
        })).filter(l => l.title && l.title.length > 3 && l.title.length < 200);
      }
    };

    const scraper = scrapers[p] || scrapers.default;
    return scraper();
  }, scraperPlatform);
}

async function uploadListings(listings, platform, serverUrl) {
  const now = new Date().toISOString();
  const payload = listings.map((listing) => ({
    title: String(listing.title || '').substring(0, 100),
    price: listing.price || '',
    condition: listing.condition || 'Used - Good',
    description: listing.description || '',
    images: Array.isArray(listing.images) ? listing.images : [],
    url: listing.url || '',
    seller: listing.seller || '',
    location: listing.location || '',
    originalId: listing.originalId || null,
    scrapedAt: now,
    raw: listing,
  })).filter((listing) => listing.title);

  try {
    const response = await fetch(`${serverUrl}/api/upload-sync/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings: payload, platform: normalizeScraperPlatform(platform) })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Upload failed (${response.status})`);
    }

    const synced = Number(result.synced || result.count || 0);
    console.log(`  ✓ Uploaded ${synced}/${payload.length} listing(s)`);
    if (Array.isArray(result.errors) && result.errors.length) {
      result.errors.slice(0, 5).forEach((err) => console.log(`  ✗ ${err}`));
    }
    return synced;
  } catch (err) {
    console.log(`  ✗ Error uploading: ${err.message}`);
    return 0;
  }
}

main().catch(console.error);
