// Facebook Marketplace Scraper v2 - Uses GraphQL API interception
(function() {
  const listings = [];
  let foundRequest = false;

  // Intercept GraphQL requests to find listing data
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    return originalFetch.apply(this, args).then(response => {
      // Clone response to read without consuming
      response.clone().json().then(data => {
        try {
          const dataObj = data;
          // Facebook uses GraphQL; look for product/marketplace data
          if (dataObj?.data?.marketplace_search?.feed_items) {
            const items = dataObj.data.marketplace_search.feed_items;
            items.forEach(item => {
              if (item?.listing) {
                listings.push({
                  title: item.listing.title || '',
                  price: item.listing.price?.['formatted_amount'] || '',
                  description: item.listing.description || '',
                  images: (item.listing.photo_images || []).map(p => p.uri),
                  url: `https://www.facebook.com/marketplace/item/${item.listing.id}/`,
                  originalId: item.listing.id,
                  platform: 'facebook_marketplace'
                });
                foundRequest = true;
              }
            });
          }
        } catch (e) {
          // Not JSON or not expected format
        }
      }).catch(() => {});
      return response;
    });
  };

  // Also scrape from DOM as fallback after page loads
  setTimeout(() => {
    const cards = document.querySelectorAll('[data-testid="marketplace_listing_item"]');
    cards.forEach(card => {
      const title = card.querySelector('[data-testid="marketplace_listing_title"]')?.textContent?.trim();
      const price = card.querySelector('[data-testid="marketplace_listing_price"]')?.textContent?.trim();
      if (title && !foundRequest) {
        listings.push({
          title,
          price,
          description: '',
          images: [card.querySelector('img')?.src],
          platform: 'facebook_marketplace',
          source: 'dom'
        });
      }
    });
  }, 3000);

  // Return after a delay to allow network interception
  setTimeout(() => {
    console.log('Scrape complete. Listings:', listings.length);
    return listings;
  }, 5000);
})();
