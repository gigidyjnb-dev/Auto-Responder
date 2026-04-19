// Generic scraper - works on any marketplace listings page
// Extracts common patterns: title, price, images, URL

(function() {
  const results = [];

  // Wait for page to load listings
  setTimeout(() => {
    // Find all potential listing elements
    const candidates = document.querySelectorAll('li, div[class*="item"], div[class*="card"], div[class*="listing"], a[href*="item"], article');

    console.log(`Scanning ${candidates.length} potential listing elements`);

    candidates.forEach(el => {
      try {
        // Extract title
        const titleEl = el.querySelector('h1, h2, h3, h4, .title, [class*="title"], [data-testid*="title"], span[dir="auto"]');
        const title = titleEl?.textContent?.trim();

        // Extract price (look for $ symbol or price keywords)
        const priceEl = el.querySelector('[class*="price"], .amount, [data-testid*="price"]');
        const fallbackPrice = Array.from(el.querySelectorAll('span')).map((s) => s.textContent?.trim() || '').find((txt) => /^\$\d/.test(txt));
        const price = priceEl?.textContent?.trim() || fallbackPrice || '';

        // Extract image
        const img = el.querySelector('img');
        const imageUrl = img?.src || img?.data-src || img?.data-lazy-src || '';

        // Extract link
        const link = el.closest('a')?.href || el.querySelector('a')?.href || window.location.href;

        // Filter: must have title and be reasonable length
        if (title && title.length > 3 && title.length < 200 && !title.includes('http')) {
          results.push({
            title: title.substring(0, 150),
            price: price || '',
            description: '',
            images: imageUrl ? [imageUrl] : [],
            url: link,
            platform: 'generic',
            scrapedAt: new Date().toISOString()
          });
        }
      } catch (e) {
        // Ignore single element failures
      }
    });

    // Remove duplicates by title+price combination
    const seen = new Set();
    const unique = results.filter(item => {
      const key = `${item.title}|${item.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Extracted ${unique.length} unique listings`);
    return unique;
  }, 1500);
})();
