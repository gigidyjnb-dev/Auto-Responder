// Facebook Marketplace scraper
// Injects into marketplace/you/ page and extracts all loaded listings

(function() {
  const listings = [];

  // Wait for listings to load
  function waitForListings() {
    return new Promise(resolve => {
      const check = () => {
        const items = document.querySelectorAll('[data-testid="marketplace_listing_item"], [data-testid*="marketplace_item_"], a[href*="/marketplace/item/"]');
        if (items.length > 0) {
          resolve(items);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  async function scrape() {
    const items = await waitForListings();
    console.log(`Found ${items.length} listing elements`);

    for (const item of items) {
      try {
        // Extract from card
        const linkEl = item.closest('a');
        const href = linkEl?.href || item.href;

        const title = item.querySelector('[data-testid="marketplace_listing_title"]')?.textContent?.trim()
                 || item.querySelector('span[dir="auto"]')?.textContent?.trim()
                 || 'Untitled';

        const priceText = item.querySelector('[data-testid="marketplace_listing_price"]')?.textContent?.trim()
                      || item.querySelector('span:has-text("$")')?.textContent?.trim()
                      || '';

        const img = item.querySelector('img');
        const images = img ? [img.src.replace(/\/\d+n\/|\/rs\d+n\//, '/')] : []; // High-res version

        // Optional extra info
        const location = item.querySelector('[data-testid="marketplace_listing_location"]')?.textContent?.trim() || '';
        const condition = item.querySelector('[data-testid^="condition_"]')?.textContent?.trim() || '';

        if (title && title !== 'Untitled') {
          listings.push({
            title,
            price: priceText,
            condition,
            location,
            images,
            url: href,
            originalId: href?.split('/item/')[1]?.split('/')[0] || null,
            platform: 'facebook_marketplace'
          });
        }
      } catch (e) {
        console.error('Scrape error:', e.message);
      }
    }

    return listings;
  }

  // Run scraper
  scrape().then(results => {
    console.log('Scraped listings:', results);
    return results;
  });

})();
