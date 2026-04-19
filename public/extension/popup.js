/* popup.js — Marketplace Auto-Responder Extension */

const $ = (id) => document.getElementById(id);

/* ── Tab switching ─────────────────────────────────────── */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

/* ── Status helpers ────────────────────────────────────── */
function setStatus(elId, msg, type) {
  const el = $(elId);
  el.className = `status ${type}`;
  el.textContent = msg;
}

function clearStatus(elId) {
  const el = $(elId);
  el.className = '';
  el.textContent = '';
}

function showProgress(pct) {
  $('progressBar').style.display = 'block';
  $('progressFill').style.width = `${pct}%`;
}

function hideProgress() {
  setTimeout(() => { $('progressBar').style.display = 'none'; }, 1000);
}

/* ── Load settings ─────────────────────────────────────── */
let serverUrl = '';

chrome.storage.local.get(
  ['serverUrl', 'autoReplyEnabled', 'autoSendEnabled', 'statReplies', 'statListings',
   'awayEnabled', 'awayStart', 'awayEnd', 'awayMessage'],
  (r) => {
    serverUrl = (r.serverUrl || '').replace(/\/$/, '');
    $('serverUrl').value = serverUrl;
    $('autoReplyToggle').checked = Boolean(r.autoReplyEnabled);
    $('autoSendToggle').checked = Boolean(r.autoSendEnabled);
    updateArBadge(Boolean(r.autoReplyEnabled));
    $('statReplies').textContent = r.statReplies || '0';
    $('statListings').textContent = r.statListings || '0';

    const awayOn = Boolean(r.awayEnabled);
    $('awayToggle').checked = awayOn;
    $('awaySettings').style.display = awayOn ? 'block' : 'none';
    if (r.awayStart) $('awayStart').value = r.awayStart;
    if (r.awayEnd)   $('awayEnd').value   = r.awayEnd;
    if (r.awayMessage) $('awayMessage').value = r.awayMessage;

    if (!serverUrl) setStatus('arStatus', 'Set your Server URL in Settings first.', 'info');

    if (serverUrl) {
      fetch(`${serverUrl}/api/stats`).then(r => r.json()).then(d => {
        if (d.listingsCount !== undefined) $('statListings').textContent = d.listingsCount;
        if (d.pendingReplies !== undefined && d.pendingReplies > 0) {
          setStatus('arStatus', `${d.pendingReplies} replies waiting in admin queue.`, 'info');
        }
      }).catch(() => {});
    }
  }
);

function updateArBadge(on) {
  const badge = $('arBadge');
  badge.textContent = on ? 'ON' : 'OFF';
  badge.className = `badge ${on ? 'on' : 'off'}`;
}

/* ── Auto-reply toggles ────────────────────────────────── */
$('autoReplyToggle').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  chrome.storage.local.set({ autoReplyEnabled: enabled });
  updateArBadge(enabled);
  if (enabled && !serverUrl) {
    setStatus('arStatus', 'Please set your Server URL in Settings first.', 'error');
    e.target.checked = false;
    updateArBadge(false);
    chrome.storage.local.set({ autoReplyEnabled: false });
    return;
  }
  setStatus('arStatus', enabled ? 'Auto-reply is ON. Open FB Marketplace inbox.' : 'Auto-reply disabled.', enabled ? 'success' : 'info');
});

$('autoSendToggle').addEventListener('change', (e) => {
  chrome.storage.local.set({ autoSendEnabled: e.target.checked });
});

/* ── Away mode ─────────────────────────────────────────── */
$('awayToggle').addEventListener('change', (e) => {
  const on = e.target.checked;
  chrome.storage.local.set({ awayEnabled: on });
  $('awaySettings').style.display = on ? 'block' : 'none';
});

$('saveAway').addEventListener('click', () => {
  chrome.storage.local.set({
    awayStart: $('awayStart').value,
    awayEnd: $('awayEnd').value,
    awayMessage: $('awayMessage').value.trim() || "Thanks for your message! I'm away right now but will get back to you shortly.",
  });
  setStatus('arStatus', 'Away settings saved!', 'success');
  setTimeout(() => clearStatus('arStatus'), 2500);
});

/* ── Open inbox ────────────────────────────────────────── */
$('openInboxBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/inbox/' });
});

/* ── Settings tab ──────────────────────────────────────── */
$('saveSettings').addEventListener('click', () => {
  const url = $('serverUrl').value.trim().replace(/\/$/, '');
  if (!url) {
    setStatus('settingsStatus', 'Please enter a valid server URL.', 'error');
    return;
  }
  serverUrl = url;
  chrome.storage.local.set({ serverUrl: url }, () => {
    setStatus('settingsStatus', 'Settings saved!', 'success');
  });
});

$('testConnection').addEventListener('click', async () => {
  const url = $('serverUrl').value.trim().replace(/\/$/, '');
  if (!url) {
    setStatus('settingsStatus', 'Enter a Server URL first.', 'error');
    return;
  }
  setStatus('settingsStatus', 'Testing connection…', 'info');
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      setStatus('settingsStatus', `Connected! Server is healthy.`, 'success');
    } else {
      setStatus('settingsStatus', `Server returned ${resp.status}.`, 'error');
    }
  } catch (err) {
    setStatus('settingsStatus', `Connection failed: ${err.message}`, 'error');
  }
});

/* ── Sync listings tab ─────────────────────────────────── */
async function scrapeCurrentPage(platform) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const knownHosts = ['facebook.com', 'ebay.com', 'etsy.com', 'offerup.com', 'mercari.com', 'poshmark.com', 'craigslist.org'];
  const isKnown = knownHosts.some((h) => tab.url?.includes(h));
  if (!isKnown) {
    throw new Error('Navigate to your listings page on a supported marketplace first.');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['scrapers/universal.js'],
  });

  const listings = results[0]?.result;
  if (!Array.isArray(listings)) throw new Error('Scraper returned no data. Try refreshing the page.');
  return listings;
}

$('syncBtn').addEventListener('click', async () => {
  const platform = $('platform').value;
  if (!platform) { setStatus('syncStatus', 'Select a platform first.', 'error'); return; }
  if (!serverUrl) { setStatus('syncStatus', 'Set your Server URL in Settings first.', 'error'); return; }

  $('syncBtn').disabled = true;
  clearStatus('syncStatus');
  showProgress(10);

  try {
    const listings = await scrapeCurrentPage(platform);
    if (!listings.length) {
      setStatus('syncStatus', 'No listings found. Make sure you are on your listings page.', 'error');
      return;
    }

    $('listingCount').textContent = `Found ${listings.length} listing(s)…`;
    showProgress(40);

    const resp = await fetch(`${serverUrl}/api/listings/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings, platform }),
    });

    showProgress(85);

    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(result.error || `Server error ${resp.status}`);

    const count = result.count || result.synced || listings.length;
    setStatus('syncStatus', `✅ Synced ${count} listing(s)!`, 'success');
    $('listingCount').textContent = `${count} listings on server`;

    chrome.storage.local.set({ statListings: count });
    $('statListings').textContent = count;

  } catch (err) {
    setStatus('syncStatus', `Error: ${err.message}`, 'error');
  } finally {
    $('syncBtn').disabled = false;
    showProgress(100);
    hideProgress();
  }
});
