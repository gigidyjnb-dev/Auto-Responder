const puppeteer = require('puppeteer');

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
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
        '--user-agent=' + this.userAgent,
      ],
    });
  }

  async findFirstSelector(page, selectors, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const selector of selectors) {
        const handle = await page.$(selector);
        if (handle) return selector;
      }
      await page.waitForTimeout(200);
    }
    return null;
  }

  async gotoWithRetry(page, url, options, attempts = 2) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        await page.goto(url, options);
        return;
      } catch (err) {
        lastErr = err;
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

  async performLogin(page, email, password) {
    const emailSelectors = [
      '#email',
      'input[name="email"]',
      'input[autocomplete="username"]',
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

    const emailSelector = await this.findFirstSelector(page, emailSelectors, 20000);
    const passwordSelector = await this.findFirstSelector(page, passwordSelectors, 20000);
    const loginSelector = await this.findFirstSelector(page, loginSelectors, 20000);

    if (!emailSelector || !passwordSelector || !loginSelector) {
      const currentUrl = page.url();
      throw new Error(`FACEBOOK_LOGIN_FORM_NOT_FOUND: Could not locate Facebook login fields. url=${currentUrl}`);
    }

    await page.click(emailSelector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(emailSelector, email, { delay: 30 });

    await page.click(passwordSelector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(passwordSelector, password, { delay: 30 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
      page.click(loginSelector),
    ]);

    await page.waitForTimeout(1400);

    const currentUrl = page.url();
    if (currentUrl.includes('checkpoint') || currentUrl.includes('twofactor') || currentUrl.includes('confirm')) {
      throw new Error('FACEBOOK_2FA_REQUIRED: Facebook requires two-factor authentication or security check. Please complete this in your browser first, then try again.');
    }

    const loginFieldStillVisible = await this.findFirstSelector(page, emailSelectors, 1500);
    if (currentUrl.includes('/login') || loginFieldStillVisible) {
      throw new Error('FACEBOOK_LOGIN_FAILED: Facebook rejected the login credentials.');
    }
  }

  async loginAndScrape({ email, password }) {
    const browser = await this.launchBrowser();

    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(45000);
      await page.setUserAgent(this.userAgent);
      await page.setViewport(this.viewport);

      const loginUrls = [
        'https://www.facebook.com/login',
        'https://www.facebook.com/',
      ];

      let loginError = null;
      for (const loginUrl of loginUrls) {
        try {
          await this.gotoWithRetry(page, loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }, 2);
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
