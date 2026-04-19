/**
 * Puppeteer-based Facebook Marketplace scraper
 * Runs headless Chrome on the server to fetch user's listings
 *
 * Setup: Railway needs these env vars:
 * - PUPPETEER_EXECUTABLE_PATH (optional, usually auto-detected)
 * - RAILWAY_SERVICE_NAME enables headless mode
 */

const puppeteer = require('puppeteer');

// Storage for encrypted credentials (integrates with existing DB)
// In a real implementation, store in encrypted DB table

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
        '--user-agent=' + this.userAgent
      ]
    });
  }

  async loginAndScrape({ email, password }) {
    const browser = await this.launchBrowser();
    
    try {
      const page = await browser.newPage();
      await page.setUserAgent(this.userAgent);
      await page.setViewport(this.viewport);

      // Go to Facebook login
      await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

      // Enter credentials
      await page.waitForSelector('#email', { timeout: 10000 });
      await page.type('#email', email, { delay: 50 });
      await page.type('#pass', password, { delay: 50 });

      // Click login
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        page.click('button[name="login"]')
      ]);

      const currentUrl = page.url();
      if (currentUrl.includes('checkpoint') || currentUrl.includes('twofactor') || currentUrl.includes('confirm')) {
        throw new Error('FACEBOOK_2FA_REQUIRED: Facebook requires two-factor authentication or security check. Please complete this in your browser first, then try again.');
      }

      const loginFieldStillVisible = await page.$('#email');
      if (currentUrl.includes('/login') || loginFieldStillVisible) {
        throw new Error('FACEBOOK_LOGIN_FAILED: Facebook rejected the login credentials.');
      }

      // Navigate to Marketplace → Your Listings
      await page.goto('https://www.facebook.com/marketplace/you/', { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Wait for listings to appear
      await page.waitForSelector('[data-testid="marketplace_listing_item"], a[href*="/marketplace/item/"]', { timeout: 15000 });

      // Scroll to load all listings (Facebook uses lazy loading)
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

      // Extract listings
      const listings = await page.evaluate(() => {
        const results = [];
        const seenTitles = new Set();

        const cards = document.querySelectorAll('[data-testid="marketplace_listing_item"], a[href*="/marketplace/item/"]');

        cards.forEach(card => {
          try {
            const linkEl = card.closest('a');
            const href = linkEl?.href || card.href || '';

            const title = card.querySelector('[data-testid="marketplace_listing_title"]')?.textContent?.trim()
                        || card.querySelector('span[dir="auto"]')?.textContent?.trim()
                        || '';

            const priceEl = card.querySelector('[data-testid="marketplace_listing_price"]');
            const price = priceEl?.textContent?.trim() || '';

            // Get highest quality image
            const img = card.querySelector('img');
            let imageUrl = img?.src || '';
            // Replace with higher resolution if available
            if (imageUrl.includes('_n.jpg')) {
              imageUrl = imageUrl.replace('_n.jpg', '_o.jpg');
            } else if (imageUrl.includes('_s.jpg')) {
              imageUrl = imageUrl.replace('_s.jpg', '_o.jpg');
            }

            // Deduplicate by title+price
            if (title && title.length > 2 && title.length < 200 && !title.includes('http')) {
              const key = `${title}|${price}`;
              if (!seenTitles.has(key)) {
                seenTitles.add(key);
                results.push({
                  title: title.substring(0, 150),
                  price: price,
                  description: '',  // Will need to click into each listing for full description
                  images: imageUrl ? [imageUrl] : [],
                  url: href,
                  platform: 'facebook_marketplace',
                  scrapedAt: new Date().toISOString()
                });
              }
            }
          } catch (e) {
            // Skip invalid cards
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
