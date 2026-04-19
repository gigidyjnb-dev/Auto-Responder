const platformSelect = document.getElementById('platform');
const syncBtn = document.getElementById('syncBtn');
const statusDiv = document.getElementById('status');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const listingCount = document.getElementById('listingCount');

const DEFAULT_SERVER = window.location.origin; // Use same origin as the web app

let SERVER_URL = DEFAULT_SERVER;

function setStatus(message, type = 'info') {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  statusDiv.style.display = 'block';
}

function showProgress(percent) {
  progressBar.style.display = 'block';
  progressFill.style.width = `${percent}%`;
}

async function scrapeCurrentPage(platform) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url?.includes('marketplace') && !tab.url?.includes('ebay') && !tab.url?.includes('etsy') && !tab.url?.includes('offerup') && !tab.url?.includes('mercari') && !tab.url?.includes('poshmark') && !tab.url?.includes('craigslist')) {
    throw new Error('Please navigate to a marketplace listings page (e.g., Facebook Marketplace → Your Listings).');
  }

  // Use universal scraper that detects platform automatically
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['scrapers/universal.js']
    });

    const listings = results[0]?.result;
    if (!Array.isArray(listings)) {
      throw new Error('Scraper did not return an array.');
    }
    return listings;
  } catch (err) {
    console.error('Scraper error:', err);
    throw new Error(`Scraper failed: ${err.message}. Try refreshing the page and ensure listings are visible.`);
  }
}

async function syncListings() {
  const platform = platformSelect.value;
  if (!platform) {
    setStatus('Please select a platform first.', 'error');
    return;
  }

  syncBtn.disabled = true;
  listingCount.textContent = '';
  showProgress(10);
  setStatus('Scanning page for listings...', 'info');

  try {
    const listings = await scrapeCurrentPage(platform);

    if (!listings || listings.length === 0) {
      setStatus('No listings found. Make sure you are viewing your active listings page.', 'error');
      return;
    }

    listingCount.textContent = `Found ${listings.length} listing(s)`;
    setStatus(`Preparing ${listings.length} listings...`, 'info');
    showProgress(30);

    // Bulk upload
    const response = await fetch(`${SERVER_URL}/api/upload-sync/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings, platform })
    });

    showProgress(80);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    const result = await response.json();

    if (result.failed > 0) {
      setStatus(`⚠️ Synced ${result.synced}/${result.total}. ${result.failed} failed.`, 'error');
    } else {
      setStatus(`✅ Synced ${result.synced} listings successfully!`, 'success');
    }

    listingCount.textContent = `${result.synced} synced${result.failed ? `, ${result.failed} failed` : ''}`;

  } catch (error) {
    setStatus(`Error: ${error.message}`, 'error');
    console.error(error);
  } finally {
    syncBtn.disabled = false;
    showProgress(100);
    setTimeout(() => { progressBar.style.display = 'none'; }, 1500);
  }
}

// Settings page for server URL
async function showSettings() {
  const url = await new Promise(resolve => {
    chrome.storage.local.get(['serverUrl'], (result) => {
      resolve(prompt('Server URL:', result.serverUrl || DEFAULT_SERVER));
    });
  });
  if (url && url !== 'null') {
    SERVER_URL = url;
    chrome.storage.local.set({ serverUrl: url });
    setStatus('Server URL saved.', 'success');
  }
}

// Load saved server URL
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) {
    SERVER_URL = result.serverUrl;
  }
});

syncBtn.addEventListener('click', syncListings);

// Double-click status opens settings
statusDiv.addEventListener('dblclick', showSettings);
