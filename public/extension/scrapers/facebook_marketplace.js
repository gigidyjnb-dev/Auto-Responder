//ureltra minimal Facebook Marketplace scraper
//just finds anything with a dollar sign that's near text

(function() {
  var listings = [];
  var seen = {};
  
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  
  async function run() {
    //scroll to load everything
    for (var i = 0; i < 8; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await wait(600);
    }
    window.scrollTo(0, 0);
    await wait(300);
    
    var pageText = document.body.innerText || '';
    var lines = pageText.split(/\n/);
    
    console.log('[Simple] Checking ' + lines.length + ' lines of text');
    
    //look for lines with prices - $XX or $XXX etc
    var priceRegex = /\$[\d,]+(?:\.\d{2})?/;
    
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.length < 4 || line.length > 100) continue;
      
      //skip common non-listing text
      if (/^(active|sold|edit|delete|share|boost|save|post|pending|marketplace|facebook|messenger|search|browse)/i.test(line)) continue;
      if (/^\d+$/.test(line)) continue; //just numbers
      if (!priceRegex.test(line)) continue; //must have a price
      
      //create a simple ID
      var id = 'listing_' + line.substring(0, 20).replace(/\W/g, '');
      if (seen[id]) continue;
      seen[id] = true;
      
      //extract price
      var priceMatch = line.match(/\$[\d,]+(?:\.\d{2})?/);
      var price = priceMatch ? priceMatch[0] : '';
      
      //title is everything except the price
      var title = line.replace(priceRegex, '').replace(/\s+/g, ' ').trim();
      if (title.length < 3) title = line;
      
      listings.push({
        title: title.substring(0, 100),
        price: price,
        condition: 'Used',
        images: [],
        url: window.location.href,
        originalId: id,
        platform: 'facebook_marketplace'
      });
    }
    
    console.log('[Simple] Found ' + listings.length + ' listings with prices');
    return listings;
  }
  
  return run();
})();