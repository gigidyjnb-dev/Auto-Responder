/* popup.js — Marketplace Auto-Responder Extension v3 (Simplified) */

const $ = (id) => document.getElementById(id);

let serverUrl = '';
let autoReplyEnabled = false;
let autoSendEnabled = false;

/* ── Load settings ─────────────────────────────────────── */
chrome.storage.local.get(
  ['serverUrl', 'autoReplyEnabled', 'autoSendEnabled', 'statListings'],
  (r) => {
    serverUrl = (r.serverUrl || '').replace(/\/$/, '');
    autoReplyEnabled = Boolean(r.autoReplyEnabled);
    autoSendEnabled = Boolean(r.autoSendEnabled);
    
    if (serverUrl) {
      showMainSection();
      updateStats();
    }
  }
);

function showMainSection() {
  $('setupSection').style.display = 'none';
  $('mainSection').style.display = 'block';
  $('autoReplyToggle').checked = autoReplyEnabled;
  $('autoSendToggle').checked = autoSendEnabled;
  $('arStatus').textContent = autoReplyEnabled ? 'ON' : 'OFF';
  $('arStatus').style.color = autoReplyEnabled ? '#4caf50' : '#999';
}

function showSetupSection() {
  $('setupSection').style.display = 'block';
  $('mainSection').style.display = 'none';
}

function updateStats() {
  if (!serverUrl) return;
  
  fetch(`${serverUrl}/api/stats`).then(r => r.json()).then(d => {
    if (d.listingsCount !== undefined) {
      $('statListings').textContent = d.listingsCount;
    }
  }).catch(() => {});
}

/* ── Progress helpers ─────────────────────────────────────── */
function setStatus(elId, msg, type) {
  const el = $(elId);
  el.className = `status ${type}`;
  el.textContent = msg;
  el.style.display = 'block';
}

function showProgress(pct) {
  $('progressBar').style.display = 'block';
  $('progressFill').style.width = `${pct}%`;
}

/* ── Scraper function ─────────────────────────────────── */
async function scrapeListings(tab) {
  const tabUrl = tab.url || '';
  
  if (!tabUrl.includes('facebook.com') && !tabUrl.includes('ebay.com') && !tabUrl.includes('etsy.com')) {
    throw new Error('Please open your Facebook Marketplace page first: facebook.com/marketplace/you/selling');
  }

  let scraperFile = 'scrapers/universal.js';
  if (tabUrl.includes('facebook.com/marketplace')) {
    scraperFile = 'scrapers/facebook_marketplace.js';
  }

  console.log('[Scrape] Using scraper:', scraperFile, 'on tab:', tabUrl);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: [scraperFile],
  });

  const rawListings = results[0]?.result;
  console.log('[Scrape] Raw results:', rawListings?.length || 0);
  
  if (!Array.isArray(rawListings) || rawListings.length === 0) {
    throw new Error('No listings found. Make sure you are on your Selling page and have scrolled down to load ALL listings.');
  }

  // Normalize
  const listings = rawListings
    .map(l => ({ ...l, title: String(l?.title ?? l?.name ?? 'Untitled').trim() }))
    .filter(l => l.title.length > 3);
    
  console.log('[Scrape] Valid listings:', listings.length);
  
  if (listings.length === 0) {
    throw new Error('Found 0 valid listings. Try scrolling more on your Facebook page.');
  }

  return listings;
}

/* ── ONE-CLICK SETUP ─────────────────────────────────────── */
$('quickSetupBtn').addEventListener('click', async () => {
  const urlInput = ($('serverUrl') && $('serverUrl').value) ? $('serverUrl').value.trim() : '';
  
  if (!urlInput) {
    setStatus('setupStatus', 'Enter your app URL in the box above.', 'error');
    return;
  }
  
  // Validate URL format
  let url = urlInput.trim();
  if (!url.includes('.') || url.includes(' ')) {
    setStatus('setupStatus', 'Invalid URL. Use format: https://your-app.up.railway.app', 'error');
    return;
  }
  
  if (!url.startsWith('http')) url = 'https://' + url;
  url = url.replace(/\/$/, '');

  $('quickSetupBtn').disabled = true;
  setStatus('setupStatus', 'Setting up...', 'info');
  showProgress(10);

  try {
    // Test connection first
    showProgress(20);
    console.log('[Setup] Testing URL:', url);
    const testRes = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) });
    if (!testRes.ok) throw new Error('Cannot connect to server at ' + url);

    // Get current tab
    showProgress(30);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    // Scrape listings
    showProgress(50);
    setStatus('setupStatus', 'Syncing listings...', 'info');
    const listings = await scrapeListings(tab);
    
    if (listings.length === 0) {
      throw new Error('No listings found. Scroll down to load them first.');
    }

    // Upload to server
    showProgress(70);
    setStatus('setupStatus', `Uploading ${listings.length} listings...`, 'info');
    const uploadRes = await fetch(`${url}/api/listings/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings, platform: 'facebook_marketplace' })
    });

    const uploadData = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');

    // Turn on auto-reply and auto-send
    showProgress(90);
    chrome.storage.local.set({
      serverUrl: url,
      autoReplyEnabled: true,
      autoSendEnabled: true,
    });

    showProgress(100);
    setStatus('setupStatus', `✅ Done! ${listings.length} listings synced. Auto-reply is ON!`, 'success');

    // Show main section
    setTimeout(() => {
      serverUrl = url;
      autoReplyEnabled = true;
      autoSendEnabled = true;
      showMainSection();
      updateStats();
    }, 1500);

  } catch (err) {
    setStatus('setupStatus', 'Error: ' + err.message, 'error');
    $('quickSetupBtn').disabled = false;
  }
});

/* ── Toggle handlers ───────────────────────────────────── */
$('autoReplyToggle').addEventListener('change', (e) => {
  autoReplyEnabled = e.target.checked;
  chrome.storage.local.set({ autoReplyEnabled });
  $('arStatus').textContent = autoReplyEnabled ? 'ON' : 'OFF';
  $('arStatus').style.color = autoReplyEnabled ? '#4caf50' : '#999';
  setStatus('syncStatus', autoReplyEnabled ? 'Auto-reply enabled' : 'Auto-reply disabled', 'info');
});

$('autoSendToggle').addEventListener('change', (e) => {
  autoSendEnabled = e.target.checked;
  chrome.storage.local.set({ autoSendEnabled });
  setStatus('syncStatus', autoSendEnabled ? 'Auto-send enabled' : 'Auto-send disabled', 'info');
});

/* ── Re-sync button ───────────────────────────────────── */
$('resyncBtn').addEventListener('click', async () => {
  if (!serverUrl) {
    showSetupSection();
    return;
  }

  $('resyncBtn').disabled = true;
  setStatus('syncStatus', 'Syncing...', 'info');
  showProgress(10);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const listings = await scrapeListings(tab);
    
    showProgress(60);
    const res = await fetch(`${serverUrl}/api/listings/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings, platform: 'facebook_marketplace' })
    });

    const data = await res.json().catch(() => ({}));
    const count = data.synced || data.count || 0;

    showProgress(100);
    setStatus('syncStatus', `Synced ${count} listings!`, 'success');
    updateStats();

  } catch (err) {
    setStatus('syncStatus', 'Error: ' + err.message, 'error');
  } finally {
    $('resyncBtn').disabled = false;
  }
});