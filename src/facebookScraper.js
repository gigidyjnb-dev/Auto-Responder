const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

// Directory for failure screenshots — written to /tmp so it works in read-only containers.
const SCREENSHOT_DIR = process.env.SCRAPER_SCREENSHOT_DIR || path.join('/tmp', 'fb-scraper-screenshots');

function ensureScreenshotDir() {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    return true;
  } catch (err) {
    console.warn('[facebookScraper] Could not create screenshot directory:', err.message);
    return false;
  }
}

/** Returns a random integer between min and max (inclusive). */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class FacebookScraper {
  constructor(options = {}) {
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    this.viewport = options.viewport || { width: 1280, height: 800 };
  }

  async launchBrowser() {
    return await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // Suppress the navigator.webdriver flag that headless Chrome exposes.
        '--disable-blink-features=AutomationControlled',
        // Prevent the "Chrome is being controlled by automated software" banner.
        '--disable-infobars',
        // Use a realistic window size so viewport fingerprinting looks normal.
        '--window-size=1280,800',
        '--user-agent=' + this.userAgent,
        // Disable GPU rendering — not needed in headless and can cause crashes.
        '--disable-gpu',
        // Reduce memory pressure in constrained environments.
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
      ],
    });
  }

  /**
   * Applies anti-detection patches to a newly opened page:
   * - Removes navigator.webdriver
   * - Spoofs navigator.plugins and navigator.languages
   * - Overrides the Chrome runtime object so it looks like a real browser
   */
  async applyStealthPatches(page) {
    await page.evaluateOnNewDocument(() => {
      // Remove the webdriver flag.
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

      // Spoof a realistic plugin list.
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ],
      });

      // Spoof realistic language settings.
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

      // Ensure the chrome runtime object exists (absent in headless).
      if (!window.chrome) {
        window.chrome = { runtime: {} };
      }

      // Spoof screen dimensions to match the viewport.
      Object.defineProperty(screen, 'availWidth', { get: () => 1280 });
      Object.defineProperty(screen, 'availHeight', { get: () => 800 });
    });
  }

  /**
   * Polls the page for the first matching selector from the provided list.
   * Logs each selector it tries so we can see exactly what was checked.
   *
   * @param {import('puppeteer').Page} page
   * @param {string[]} selectors
   * @param {number} timeoutMs
   * @returns {Promise<string|null>} The first matching selector, or null on timeout.
   */
  async findFirstSelector(page, selectors, timeoutMs = 15000) {
    console.log(`[facebookScraper] Polling for selectors (timeout ${timeoutMs}ms):`, selectors);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const selector of selectors) {
        const handle = await page.$(selector);
        if (handle) {
          console.log(`[facebookScraper] Found selector: "${selector}" after ${Date.now() - started}ms`);
          return selector;
        }
      }
      await page.waitForTimeout(300);
    }
    console.warn(`[facebookScraper] None of the selectors found within ${timeoutMs}ms:`, selectors);
    return null;
  }

  async gotoWithRetry(page, url, options, attempts = 2) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        console.log(`[facebookScraper] Navigating to ${url} (attempt ${i}/${attempts})`);
        await page.goto(url, options);
        console.log(`[facebookScraper] Navigation complete. Current URL: ${page.url()}`);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[facebookScraper] Navigation attempt ${i} failed: ${err.message}`);
        if (i < attempts) {
          await page.waitForTimeout(1200 * i);
        }
      }
    }
    throw lastErr;
  }

  async clickConsentIfPresent(page) {
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const target = candidates.find((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        return (
          text.includes('allow all cookies') ||
          text.includes('accept all') ||
          text.includes('allow essential and optional cookies')
        );
      });
      if (target) target.click();
    });
  }

  /**
   * Captures a screenshot and a short HTML snippet of the current page state.
   * Used on login failure so we can see exactly what Facebook is showing.
   *
   * @param {import('puppeteer').Page} page
   * @param {string} label  Short label used in the filename, e.g. "login-failure".
   * @returns {Promise<string|null>} Absolute path to the saved screenshot, or null on error.
   */
  async captureFailureState(page, label = 'failure') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `fb-${label}-${timestamp}.png`;

    // Log the current URL and page title.
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => '(could not read title)');
    console.error(`[facebookScraper] Failure state — URL: ${currentUrl}`);
    console.error(`[facebookScraper] Failure state — Title: "${pageTitle}"`);

    // Log a snippet of the page HTML to help identify what Facebook is showing.
    try {
      const htmlSnippet = await page.evaluate(() => {
        const body = document.body;
        if (!body) return '(no body)';
        // Grab the first 2000 characters of visible text content as a proxy for page content.
        return (body.innerText || body.textContent || '').substring(0, 2000).replace(/\s+/g, ' ').trim();
      });
      console.error(`[facebookScraper] Failure state — Page text snippet:\n${htmlSnippet}`);
    } catch (snippetErr) {
      console.warn('[facebookScraper] Could not read page text:', snippetErr.message);
    }

    // Save a screenshot.
    if (ensureScreenshotDir()) {
      const screenshotPath = path.join(SCREENSHOT_DIR, filename);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`[facebookScraper] Screenshot saved: ${screenshotPath}`);
        return screenshotPath;
      } catch (ssErr) {
        console.warn('[facebookScraper] Could not save screenshot:', ssErr.message);
      }
    }

    return null;
  }

  /**
   * Types a string into a field character-by-character with a randomised delay
   * between keystrokes to mimic human typing patterns.
   *
   * @param {import('puppeteer').Page} page
   * @param {string} selector
   * @param {string} text
   * @param {{ minDelay?: number, maxDelay?: number }} opts
   */
  async typeHuman(page, selector, text, { minDelay = 40, maxDelay = 140 } = {}) {
    for (const char of text) {
      await page.type(selector, char, { delay: randInt(minDelay, maxDelay) });
    }
  }

  async performLogin(page, email, password) {
    const emailSelectors = [
      '#email',
      'input[name="email"]',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[type="text"][name="login"]',
    ];

    const passwordSelectors = [
      '#pass',
      'input[name="pass"]',
      'input[type="password"]',
    ];

    const loginSelectors = [
      'button[name="login"]',
      '[data-testid="royal_login_button"]',
      'button[type="submit"]',
    ];

    console.log('[facebookScraper] Searching for email field…');
    const emailSelector = await this.findFirstSelector(page, emailSelectors, 20000);

    console.log('[facebookScraper] Searching for password field…');
    const passwordSelector = await this.findFirstSelector(page, passwordSelectors, 20000);

    console.log('[facebookScraper] Searching for login button…');
    const loginSelector = await this.findFirstSelector(page, loginSelectors, 20000);

    if (!emailSelector || !passwordSelector || !loginSelector) {
      const missing = [
        !emailSelector && 'email',
        !passwordSelector && 'password',
        !loginSelector && 'submit button',
      ].filter(Boolean).join(', ');

      console.error(`[facebookScraper] Login form incomplete — missing: ${missing}`);
      await this.captureFailureState(page, 'login-form-not-found');

      const currentUrl = page.url();
      throw new Error(`FACEBOOK_LOGIN_FORM_NOT_FOUND: Could not locate Facebook login fields (missing: ${missing}). url=${currentUrl}`);
    }

    // Small pre-fill pause — humans don't start typing the instant a page loads.
    await page.waitForTimeout(randInt(600, 1200));

    await page.click(emailSelector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await this.typeHuman(page, emailSelector, email);

    // Brief pause between fields, as a human would.
    await page.waitForTimeout(randInt(300, 700));

    await page.click(passwordSelector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await this.typeHuman(page, passwordSelector, password);

    // Brief pause before clicking submit.
    await page.waitForTimeout(randInt(400, 900));

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
      page.click(loginSelector),
    ]);

    await page.waitForTimeout(randInt(1500, 2500));

    const currentUrl = page.url();
    console.log(`[facebookScraper] Post-login URL: ${currentUrl}`);

    if (currentUrl.includes('checkpoint') || currentUrl.includes('twofactor') || currentUrl.includes('confirm')) {
      await this.captureFailureState(page, 'checkpoint');
      throw new Error('FACEBOOK_2FA_REQUIRED: Facebook requires two-factor authentication or security check. Please complete this in your browser first, then try again.');
    }

    const loginFieldStillVisible = await this.findFirstSelector(page, emailSelectors, 2000);
    if (currentUrl.includes('/login') || loginFieldStillVisible) {
      await this.captureFailureState(page, 'login-rejected');
      throw new Error('FACEBOOK_LOGIN_FAILED: Facebook rejected the login credentials. Double-check your email and password.');
    }

    console.log('[facebookScraper] Login appears successful.');
  }

  async loginAndScrape({ email, password }) {
    const browser = await this.launchBrowser();

    // Attach a listener to log any page-level network errors.
    browser.on('targetcreated', async (target) => {
      const p = await target.page().catch(() => null);
      if (!p) return;
      p.on('requestfailed', (req) => {
        console.warn(`[facebookScraper] Network request failed: ${req.failure()?.errorText} — ${req.url()}`);
      });
    });

    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(45000);
      await page.setUserAgent(this.userAgent);
      await page.setViewport(this.viewport);

      // Apply stealth patches before any navigation.
      await this.applyStealthPatches(page);

      // Log failed requests on the main page.
      page.on('requestfailed', (req) => {
        console.warn(`[facebookScraper] Request failed: ${req.failure()?.errorText} — ${req.url()}`);
      });

      const loginUrls = [
        'https://www.facebook.com/login',
        'https://www.facebook.com/',
      ];

      let loginError = null;
      for (const loginUrl of loginUrls) {
        try {
          await this.gotoWithRetry(page, loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }, 2);
          // Give the page a moment to settle and render dynamic content.
          await page.waitForTimeout(randInt(800, 1400));
          await this.clickConsentIfPresent(page);
          await this.performLogin(page, email, password);
          loginError = null;
          break;
        } catch (err) {
          loginError = err;
          const msg = err?.message || '';
          if (msg.includes('FACEBOOK_LOGIN_FAILED') || msg.includes('FACEBOOK_2FA_REQUIRED')) {
            break;
          }
          console.warn(`[facebookScraper] Login attempt with ${loginUrl} failed: ${msg}. Trying next URL…`);
          await page.waitForTimeout(1000);
        }
      }

      if (loginError) {
        throw loginError;
      }

      await this.gotoWithRetry(
        page,
        'https://www.facebook.com/marketplace/you/',
        { waitUntil: 'domcontentloaded', timeout: 45000 },
        3
      );

      await page.waitForTimeout(3500);

      const listItemSelector = await this.findFirstSelector(
        page,
        ['[data-testid="marketplace_listing_item"]', 'a[href*="/marketplace/item/"]'],
        25000
      );

      if (!listItemSelector) {
        throw new Error(`FACEBOOK_LISTINGS_NOT_FOUND: Marketplace listings did not load. url=${page.url()}`);
      }

      let lastHeight = 0;
      let sameCount = 0;
      const maxScrolls = 50;

      for (let i = 0; i < maxScrolls; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
        await page.waitForTimeout(1500);

        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === lastHeight) {
          sameCount++;
          if (sameCount >= 3) break;
        } else {
          sameCount = 0;
          lastHeight = newHeight;
        }
      }

      const listings = await page.evaluate(() => {
        const results = [];
        const seenTitles = new Set();
        const cards = document.querySelectorAll('[data-testid="marketplace_listing_item"], a[href*="/marketplace/item/"]');

        cards.forEach((card) => {
          try {
            const linkEl = card.closest('a');
            const href = linkEl?.href || card.href || '';

            const title =
              card.querySelector('[data-testid="marketplace_listing_title"]')?.textContent?.trim() ||
              card.querySelector('span[dir="auto"]')?.textContent?.trim() ||
              '';

            const priceEl = card.querySelector('[data-testid="marketplace_listing_price"]');
            const price = priceEl?.textContent?.trim() || '';

            const img = card.querySelector('img');
            let imageUrl = img?.src || '';
            if (imageUrl.includes('_n.jpg')) {
              imageUrl = imageUrl.replace('_n.jpg', '_o.jpg');
            } else if (imageUrl.includes('_s.jpg')) {
              imageUrl = imageUrl.replace('_s.jpg', '_o.jpg');
            }

            if (title && title.length > 2 && title.length < 200 && !title.includes('http')) {
              const key = `${title}|${price}`;
              if (!seenTitles.has(key)) {
                seenTitles.add(key);
                results.push({
                  title: title.substring(0, 150),
                  price,
                  description: '',
                  images: imageUrl ? [imageUrl] : [],
                  url: href,
                  platform: 'facebook_marketplace',
                  scrapedAt: new Date().toISOString(),
                });
              }
            }
          } catch (_e) {
          }
        });

        return results;
      });

      await browser.close();
      return listings;
    } catch (err) {
      await browser.close();
      throw err;
    }
  }
}

module.exports = { FacebookScraper };
