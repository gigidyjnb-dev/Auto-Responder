// Universal Marketplace Scraper
// Auto-detects platform and extracts listings

(function() {
  const url = window.location.href;
  let platform = 'unknown';
  let listings = [];

  // Platform detection
  if (url.includes('facebook.com/marketplace')) platform = 'facebook_marketplace';
  else if (url.includes('ebay.com')) platform = 'ebay';
  else if (url.includes('etsy.com')) platform = 'etsy';
  else if (url.includes('offerup.com')) platform = 'offerup';
  else if (url.includes('mercari.com')) platform = 'mercari';
  else if (url.includes('poshmark.com')) platform = 'poshmark';
  else if (url.includes('craigslist.org')) platform = 'craigslist';

  console.log('Detected platform:', platform);

  // Platform-specific extraction
  switch (platform) {
    case 'facebook_marketplace':
      listings = scrapeFacebook();
      break;
    case 'ebay':
      listings = scrapeEbay();
      break;
    case 'etsy':
      listings = scrapeEtsy();
      break;
    case 'offerup':
      listings = scrapeOfferUp();
      break;
    case 'mercari':
      listings = scrapeMercari();
      break;
    case 'poshmark':
      listings = scrapePoshmark();
      break;
    case 'craigslist':
      listings = scrapeCraigslist();
      break;
    default:
      listings = scrapeGeneric();
  }

  // Wait a moment for lazy-loaded images, then return
  setTimeout(() => {
    // Update image URLs to highest resolution if lazy-loaded
    listings.forEach(item => {
      if (item.images && item.images[0] && item.images[0].includes('_n.jpg')) {
        item.images[0] = item.images[0].replace('_n.jpg', '_o.jpg');
      }
    });
    console.log('Scrape complete:', listings.length, 'listings');
    return listings;
  }, 1000);

  // Facebook Marketplace
  function scrapeFacebook() {
    const items = [];
    const cards = document.querySelectorAll('[data-testid="marketplace_listing_item"], a[href*="/marketplace/item/"]');
    cards.forEach(card => {
      const linkEl = card.closest('a');
      const title = card.querySelector('[data-testid="marketplace_listing_title"]')?.textContent?.trim()
                 || card.querySelector('span[dir="auto"]')?.textContent?.trim();
      const price = card.querySelector('[data-testid="marketplace_listing_price"]')?.textContent?.trim();
      const img = card.querySelector('img');
      const images = img ? [img.src] : [];
      if (title) {
        items.push({
          title,
          price: price || '',
          images,
          url: linkEl?.href || window.location.href,
          originalId: linkEl?.href?.split('/item/')[1]?.split('/')[0]
        });
      }
    });
    return items;
  }

  // eBay
  function scrapeEbay() {
    const items = [];
    document.querySelectorAll('[data-testid="item-card"], li.s-item').forEach(card => {
      const title = card.querySelector('.s-item__title')?.textContent?.trim();
      if (!title || title.toLowerCase().includes('shop on ebay')) return;
      const price = card.querySelector('.s-item__price')?.textContent?.trim();
      const img = card.querySelector('.s-item__image-img');
      const images = img ? [img.src] : [];
      const url = card.querySelector('a.s-item__link')?.href;
      items.push({ title, price, images, url });
    });
    return items;
  }

  // Etsy
  function scrapeEtsy() {
    const items = [];
    document.querySelectorAll('[data-testid="listing-card"], .wt-list-unstyled li').forEach(card => {
      const title = card.querySelector('h3')?.textContent?.trim();
      const price = card.querySelector('.currency-value, .price')?.textContent?.trim();
      const img = card.querySelector('img');
      const images = img ? [img.src] : [];
      const url = card.querySelector('a')?.href;
      if (title) items.push({ title, price, images, url });
    });
    return items;
  }

  // Craigslist
  function scrapeCraigslist() {
    const items = [];
    document.querySelectorAll('.cl-static-search-result, .result-row').forEach(card => {
      const title = card.querySelector('.title, .result-title')?.textContent?.trim();
      const price = card.querySelector('.price')?.textContent?.trim();
      const url = card.querySelector('a')?.href;
      if (title) items.push({ title, price, images: [], url });
    });
    return items;
  }

  // OfferUp (generic)
  function scrapeOfferUp() {
    return scrapeGeneric();
  }

  // Mercari (generic)
  function scrapeMercari() {
    return scrapeGeneric();
  }

  // Poshmark (generic)
  function scrapePoshmark() {
    return scrapeGeneric();
  }

  // Generic fallback - works on any page with listing-like elements
  function scrapeGeneric() {
    const items = [];
    const selectors = [
      'li[class*="product"]',
      'div[class*="product"]',
      'div[class*="item"]',
      'div[class*="card"]',
      'div[class*="listing"]',
      'article',
      'a[href*="item"]',
      'a[href*="product"]'
    ];

    let elements = [];
    for (const sel of selectors) {
      elements = [...elements, ...document.querySelectorAll(sel)];
    }
    // Deduplicate
    const uniqueElements = [...new Set(elements)];

    uniqueElements.forEach(el => {
      try {
        const title = el.querySelector('h1, h2, h3, h4, .title, [class*="title"]')?.textContent?.trim();
        const price = el.querySelector('[class*="price"], .amount, [class*="Price"]')?.textContent?.trim();
        const img = el.querySelector('img');
        const images = img ? [img.src] : [];
        const url = el.closest('a')?.href || el.querySelector('a')?.href;

        if (title && title.length > 3 && title.length < 200 && !title.includes('http')) {
          items.push({
            title: title.substring(0, 150),
            price: price || '',
            images,
            url: url || window.location.href
          });
        }
      } catch (e) {}
    });

    return items;
  }

  // Return results after brief delay to allow network/rendering
  return listings;
})();
