// Facebook Marketplace Scraper - Ultra Simple Version
// Just finds text elements that look like listings

(function() {
  const listings = [];
  const seen = new Set();

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function scrape() {
    // Scroll to load everything
    for (let i = 0; i < 10; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await wait(800);
    }
    window.scrollTo(0, 0);
    await wait(500);

    // Method 1: Look for links to /marketplace/item/
    const links = document.querySelectorAll('a[href*="/marketplace/item/"]');
    console.log('[FB] Found ' + links.length + ' item links');

    for (const link of links) {
      try {
        const href = link.href;
        if (!href) continue;
        
        const urlParts = href.split('/marketplace/item/');
        if (urlParts.length < 2) continue;
        
        const id = urlParts[1].split('?')[0].split('/')[0];
        if (!id || seen.has(id)) continue;
        seen.add(id);

        // Get text near this link - look up the tree for text
        let text = '';
        let parent = link.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          text = parent.textContent?.trim();
          if (text && text.length > 5 && text.length < 150) break;
          parent = parent.parentElement;
        }
        
        // Clean up the text
        text = text?.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim() || '';
        
        // Skip if too short or looks like UI
        if (text.length < 5) continue;
        if (/^(edit|delete|share|boost|save|post|active|sold)$/i.test(text)) continue;
        if (/^\d+$/.test(text)) continue;
        if (/^\$[\d,]/.test(text)) continue; // Skip just prices

        // Find price in the text
        let price = '';
        const priceMatch = text.match(/\$[\d,]+(?:\.\d{2})?/);
        if (priceMatch) price = priceMatch[0];
        
        // Remove price from title to clean it
        let title = text.replace(/\$[\d,]+(?:\.\d{2})?/g, '').replace(/\s+/g, ' ').trim();
        if (title.length < 5) title = text; // Keep original if cleaning made it empty

        // Get image
        let images = [];
        const img = link.closest('div')?.querySelector('img') || link.querySelector('img');
        if (img && img.src) images = [img.src];

        if (title.length > 5) {
          listings.push({
            title: title.substring(0, 100),
            price: price,
            condition: 'Used',
            images: images,
            url: href,
            originalId: id,
            platform: 'facebook_marketplace'
          });
        }
      } catch(e) {}
    }

    // Method 2: If nothing found, try looking at all spans
    if (listings.length === 0) {
      console.log('[FB] Trying fallback - finding text elements');
      const spans = document.querySelectorAll('span');
      const candidates = [];
      
      for (const span of spans) {
        const txt = span.textContent?.trim();
        if (txt && txt.length > 10 && txt.length < 100) {
          // Filter out obvious non-listings
          if (/^(edit|delete|share|boost|save|post|active|sold|\d+|messenger|facebook|marketplace)/i.test(txt)) continue;
          if (/^\$[\d,]/.test(txt)) continue;
          if (txt.includes('·') && !txt.includes('$'))) continue;
          candidates.push(txt);
        }
      }
      
      console.log('[FB] Found ' + candidates.length + ' candidates');
      
      // Dedupe and add
      [...new Set(candidates)].forEach((title, i) => {
        listings.push({
          title: title.substring(0, 100),
          price: '',
          condition: 'Used',
          images: [],
          url: window.location.href,
          originalId: 'item_' + i,
          platform: 'facebook_marketplace'
        });
      });
    }

    console.log('[FB] Total listings: ' + listings.length);
    return listings;
  }

  return scrape();
})();