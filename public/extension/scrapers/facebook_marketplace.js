// Facebook Marketplace Scraper
// Navigate to: facebook.com/marketplace/you/selling
// Scroll down to load all listings, then click Sync in extension

(function() {
  const listings = [];
  const seen = new Set();

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function scrollToLoadAll() {
    for (let i = 0; i < 15; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await wait(1200);
    }
    window.scrollTo(0, 0);
    await wait(500);
  }

  function extractListings() {
    // Broad approach: get ALL links that contain /marketplace/item/
    const allLinks = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
    
    console.log('[FB Scraper] Found ' + allLinks.length + ' marketplace item links');

    for (const link of allLinks) {
      try {
        const url = link.href;
        if (!url || !url.includes('/marketplace/item/')) continue;

        const id = url.split('/item/')[1]?.split('/')[0];
        if (!id || seen.has(id)) continue;
        seen.add(id);

        // Get the card/container this link belongs to
        let card = link.closest('div') || link.parentElement;
        if (!card) card = link;

        // Get title - try multiple ways
        let title = '';
        
        // Method 1: Look for any text that looks like a title near this link
        const parentText = card.textContent || '';
        const lines = parentText.split(/\n/).map(l => l.trim()).filter(l => l);
        
        // Find a line that isn't just a price or short UI text
        for (const line of lines) {
          if (line.length > 5 && line.length < 120 && 
              !line.match(/^\$[\d,]/) && 
              !line.match(/^(edit|delete|share|boost|active|sold|pending)$/i)) {
            title = line;
            break;
          }
        }

        // Method 2: Try getting text content directly from nearby elements
        if (!title) {
          const siblings = card.querySelectorAll('span, div, p');
          for (const el of siblings) {
            const txt = el.textContent?.trim();
            if (txt && txt.length > 5 && txt.length < 120 && !txt.match(/^\$/)) {
              title = txt;
              break;
            }
          }
        }

        // Method 3: Fallback to link's own text
        if (!title && link.textContent) {
          title = link.textContent.trim();
        }

        if (!title || title.length < 5) continue;

        // Get price
        let price = '';
        const cardText = card.textContent || '';
        const priceMatch = cardText.match(/\$[\d,]+(?:\.\d{2})?/);
        if (priceMatch) price = priceMatch[0];

        // Get image
        let images = [];
        const img = card.querySelector('img');
        if (img && img.src && !img.src.includes('blank')) {
          images = [img.src];
        }

        listings.push({
          title: title.substring(0, 150),
          price: price || '',
          condition: '',
          location: '',
          images,
          url: url,
          originalId: id,
          platform: 'facebook_marketplace'
        });

      } catch (e) {
        // Skip broken elements
      }
    }

    return listings;
  }

  async function scrape() {
    await scrollToLoadAll();
    await wait(1000);
    return extractListings();
  }

  // Run and return results
  return scrape().then(results => {
    console.log('[FB Scraper] Extracted ' + results.length + ' listings');
    return results;
  }).catch(err => {
    console.error('[FB Scraper] Error:', err);
    return [];
  });
})();