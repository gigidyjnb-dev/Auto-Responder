const puppeteer = require('puppeteer');

class FacebookScraper {
  constructor(options = {}) {
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    this.viewport = options.viewport || { width: 1280, height: 800 };
  }

  async launchBrowser() {
    return await puppeteer.launch({
      headless: true,
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
        try {
          const handle = await page.$(selector);
          if (handle) return selector;
        } catch (err) {
          // ignore selector errors during search
        }
      }
      await new Promise(r => setTimeout(r, 400));
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
          await new Promise(r => setTimeout(r, 2000 * i));
        }
      }
    }
    throw lastErr;
  }

  async clickConsentIfPresent(page) {
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span'));
      const target = candidates.find((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        return (
          text === 'allow all cookies' ||
          text === 'accept all' ||
          text === 'allow essential and optional cookies' ||
          text === 'yes, allow' ||
          text.includes('accept cookies')
        );
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    // Brief wait for modal to fade out
    await new Promise(r => setTimeout(r, 1000));
  }

  async performLogin(page, email, password) {
    const emailSelectors = [
      '#m_login_email',
      '#email',
      'input[name="email"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[type="text"][name="login"]',
    ];

    const passwordSelectors = [
      '#m_login_password',
      '#pass',
      'input[name="pass"]',
      'input[type="password"]',
    ];

    const loginSelectors = [
      'button[name="login"]',
      'button[value="Log In"]',
      'button[type="submit"]',
      '[data-testid="royal_login_button"]',
    ];

    const emailSelector = await this.findFirstSelector(page, emailSelectors, 20000);
    const passwordSelector = await this.findFirstSelector(page, passwordSelectors, 20000);
    const loginSelector = await this.findFirstSelector(page, loginSelectors, 20000);

    if (!emailSelector || !passwordSelector || !loginSelector) {
      const currentUrl = page.url();
      const pageTitle = await page.title().catch(() => 'unknown');
      const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
      
      console.error(`[facebook-scraper] UI Discovery Failed. URL: ${currentUrl}, Title: ${pageTitle}`);
      console.error(`[facebook-scraper] Page Content Snippet: ${bodySnippet.replace(/\n/g, ' ')}`);

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

    await new Promise(r => setTimeout(r, 1400));

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

      // Mask automation signatures
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      });

      page.setDefaultNavigationTimeout(45000);
      await page.setUserAgent(this.userAgent);
      await page.setViewport(this.viewport);

      const loginUrls = [
        { url: 'https://m.facebook.com/login', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
        { url: 'https://www.facebook.com/login', ua: this.userAgent },
      ];

      let loginError = null;
      for (const config of loginUrls) {
        try {
          if (config.ua) {
            await page.setUserAgent(config.ua);
          }
          await this.gotoWithRetry(page, config.url, { waitUntil: 'networkidle2', timeout: 35000 }, 2);
          await this.clickConsentIfPresent(page);
          await new Promise(r => setTimeout(r, 1000));
          await this.performLogin(page, email, password);
          loginError = null;
          break;
        } catch (err) {
          loginError = err;
          const msg = err?.message || '';
          if (msg.includes('FACEBOOK_LOGIN_FAILED') || msg.includes('FACEBOOK_2FA_REQUIRED')) {
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
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

      await new Promise(r => setTimeout(r, 3500));

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
        await new Promise(r => setTimeout(r, 1500));

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
