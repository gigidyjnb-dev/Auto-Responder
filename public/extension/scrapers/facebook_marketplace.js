// Facebook Marketplace scraper
// Navigate to: facebook.com/marketplace/you/selling
// Scroll down to load all listings, then click Sync in extension

(function() {
  const listings = [];
  const seen = new Set();

  // Selectors for current FB Marketplace (2025/2026)
  const listingSelectors = [
    '[data-pagelet="MarketplaceSellingFeed"] a[href*="/marketplace/item/"]',
    'a[href*="/marketplace/item/"][role="link"]',
    'div[role="article"][href*="/marketplace/item/"]',
    'div[aria-label*="Listing"] a[href*="/marketplace/item/"]',
    'div[role="main"] a[href*="/marketplace/item/"]',
  ];

  function findListings() {
    let elements = [];
    for (const sel of listingSelectors) {
      elements = [...elements, ...document.querySelectorAll(sel)];
    }
    // Also check parent containers
    const containers = document.querySelectorAll('div[role="article"], li[role="presentation"], div[data-testid]');
    containers.forEach(c => {
      const links = c.querySelectorAll('a[href*="/marketplace/item/"]');
      links.forEach(l => elements.push(l));
    });
    return [...new Set(elements)];
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function scrollToLoadAll() {
    let lastCount = 0;
    let noChange = 0;

    for (let i = 0; i < 20; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await wait(1500);

      const count = findListings().length;
      if (count === lastCount) {
        noChange++;
        if (noChange >= 3) break;
      } else {
        noChange = 0;
      }
      lastCount = count;
    }

    window.scrollTo(0, 0);
    await wait(500);
  }

  function extractListing(linkEl) {
    const card = linkEl.closest('[role="article"]') || linkEl.closest('div') || linkEl.parentElement;
    if (!card) return null;

    const href = linkEl.href || linkEl.closest('a')?.href;
    if (!href || !href.includes('/marketplace/item/')) return null;

    // Extract ID from URL
    const match = href.match(/\/item\/([^\/]+)/);
    const originalId = match ? match[1] : null;
    if (seen.has(originalId)) return null;
    seen.add(originalId);

    // Find title - look in multiple places
    let title = '';
    const titleEl = card.querySelector('[data-testid*="title"] span, span[dir="auto"], div[role="heading"], span[class*="title"]');
    if (titleEl) title = titleEl.textContent?.trim();

    // Fallback: look for text that looks like a title
    if (!title) {
      const textEls = card.querySelectorAll('span, div');
      for (const el of textEls) {
        const txt = el.textContent?.trim();
        if (txt && txt.length > 3 && txt.length < 100 && !txt.match(/^[\$\d]/) && !txt.includes('·')) {
          title = txt;
          break;
        }
      }
    }

    // Find price
    let price = '';
    const priceEl = card.querySelector('span:contains("$"), div:contains("$"), [data-testid*="price"]');
    if (priceEl) {
      const txt = priceEl.textContent?.trim();
      if (txt?.match(/^\$[\d,]+/)) price = txt;
    }
    if (!price) {
      const spans = card.querySelectorAll('span, div');
      for (const el of spans) {
        const txt = el.textContent?.trim();
        if (txt?.match(/^\$\d+[\d,]*\.?\d*$/)) {
          price = txt;
          break;
        }
      }
    }

    // Find image
    let images = [];
    const img = card.querySelector('img');
    if (img && img.src) {
      let src = img.src;
      // Get higher res if possible
      if (src.includes('_n.jpg')) src = src.replace('_n.jpg', '_o.jpg');
      if (src.includes('_n.')) src = src.replace(/_n\./, '_o.');
      images = [src];
    }

    // Find location
    let location = '';
    const locEl = card.querySelector('[data-testid*="location"], span:contains("·")');
    if (locEl) location = locEl.textContent?.trim();

    if (!title) return null;

    return {
      title: title.substring(0, 150),
      price: price || '',
      condition: '',
      location: location || '',
      images,
      url: href,
      originalId,
      platform: 'facebook_marketplace'
    };
  }

  async function scrape() {
    await scrollToLoadAll();
    await wait(1000);

    const links = findListings();
    console.log('Found', links.length, 'listing links');

    for (const link of links) {
      const listing = extractListing(link);
      if (listing) {
        listings.push(listing);
      }
    }

    console.log('Extracted', listings.length, 'valid listings');
    return listings;
  }

  scrape().then(results => {
    console.log('Facebook Marketplace scraper results:', results);
    return results;
  }).catch(err => {
    console.error('Scraper error:', err);
    return [];
  });

})();