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
  const url = tab.url || '';
  
  if (!url.includes('facebook.com') && !url.includes('ebay.com') && !url.includes('etsy.com')) {
    throw new Error('Open your marketplace listings page first.');
  }

  let scraperFile = 'scrapers/universal.js';
  if (url.includes('facebook.com/marketplace')) {
    scraperFile = 'scrapers/facebook_marketplace.js';
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: [scraperFile],
  });

  const listings = results[0]?.result;
  if (!Array.isArray(listings) || listings.length === 0) {
    throw new Error('No listings found. Scroll down to load all listings first.');
  }

  // Normalize
  return listings
    .map(l => ({ ...l, title: String(l?.title ?? l?.name ?? '').trim() }))
    .filter(l => l.title.length > 0);
}

/* ── ONE-CLICK SETUP ─────────────────────────────────────── */
$('quickSetupBtn').addEventListener('click', async () => {
  const urlInput = $('serverUrl').value.trim();
  if (!urlInput) {
    setStatus('setupStatus', 'Enter your app URL first.', 'error');
    return;
  }
  
  // Validate URL
  let url = urlInput;
  if (!url.startsWith('http')) url = 'https://' + url;
  url = url.replace(/\/$/, '');

  $('quickSetupBtn').disabled = true;
  setStatus('setupStatus', 'Setting up...', 'info');
  showProgress(10);

  try {
    // Test connection first
    showProgress(20);
    const testRes = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) });
    if (!testRes.ok) throw new Error('Cannot connect to server');

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