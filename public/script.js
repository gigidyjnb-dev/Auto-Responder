// ── State ─────────────────────────────────────────────
let activeListingId = null;

// ── Element refs ──────────────────────────────────────
const listingSelect    = document.getElementById('listingSelect');
const loadListingBtn   = document.getElementById('loadListingBtn');
const deleteListingBtn = document.getElementById('deleteListingBtn');
const deleteAllBtn    = document.getElementById('deleteAllBtn');
const listingStatus    = document.getElementById('listingStatus');

const uploadForm    = document.getElementById('uploadForm');
const uploadStatus  = document.getElementById('uploadStatus');
const productSummary = document.getElementById('productSummary');

const respondForm    = document.getElementById('respondForm');
const responseStatus = document.getElementById('responseStatus');
const responseBox    = document.getElementById('responseBox');

const activeListingBadge = document.getElementById('activeListingBadge');
const activeListingTitle = document.getElementById('activeListingTitle');

const statsCard = document.getElementById('statsCard');

const manualEntryForm = document.getElementById('manualEntryForm');
const manualStatus = document.getElementById('manualStatus');

const pasteEntryForm = document.getElementById('pasteEntryForm');
const pasteStatus = document.getElementById('pasteStatus');

const csvEntryForm = document.getElementById('csvEntryForm');
const csvStatus = document.getElementById('csvStatus');

const profileSyncForm = document.getElementById('profileSyncForm');
const profileSyncStatus = document.getElementById('profileSyncStatus');

const onboardingCard = document.getElementById('onboardingCard');
const quickStartForm = document.getElementById('quickStartForm');
const quickStartStatus = document.getElementById('quickStartStatus');

const demoSection = document.getElementById('demoSection');
const demoForm = document.getElementById('demoForm');
const demoResponse = document.getElementById('demoResponse');

const statHotEl = document.getElementById('statHot');
const statWarmEl = document.getElementById('statWarm');
const statListingsEl = document.getElementById('statListings');

// ── Helpers ───────────────────────────────────────────
function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.style.color = isError ? '#b3261e' : '';
}

function showSummary(el, payload) {
  el.textContent = JSON.stringify(payload, null, 2);
  el.classList.remove('hidden');
}

function setActiveListing(id, title) {
  activeListingId = id;
  if (id && title) {
    activeListingBadge.classList.remove('hidden');
    activeListingTitle.textContent = title;
  } else {
    activeListingBadge.classList.add('hidden');
  }
}

// ── Listings manager ──────────────────────────────────
async function loadListings() {
  try {
    const res = await fetch('/api/products');
    const data = await res.json();
    const listings = data.listings || [];

    listingSelect.innerHTML = listings.length === 0
      ? '<option value="">-- No listings yet --</option>'
      : listings.map((l) =>
          `<option value="${l.id}">${l.title}${l.price ? ' · ' + l.price : ''}</option>`
        ).join('');

    // Show/hide onboarding and demo
    if (listings.length === 0) {
      onboardingCard.style.display = 'block';
      statsCard.style.display = 'none';
      demoSection.classList.add('hidden');
    } else {
      onboardingCard.style.display = 'none';
      statsCard.style.display = 'block';
      demoSection.classList.remove('hidden');
    }

    // Auto-select most recent
    if (listings.length > 0 && !activeListingId) {
      const last = listings[listings.length - 1];
      listingSelect.value = last.id;
      setActiveListing(last.id, last.title);
    } else if (activeListingId) {
      listingSelect.value = activeListingId;
    }
  } catch {
    setStatus(listingStatus, 'Could not load listings.', true);
  }
}

loadListingBtn.addEventListener('click', async () => {
  const id = listingSelect.value;
  if (!id) {
    setStatus(listingStatus, 'Select a listing first.', true);
    return;
  }

  try {
    const res = await fetch(`/api/product/${id}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus(listingStatus, data.error || 'Failed to load listing.', true);
      return;
    }

    setActiveListing(data.id, data.title);
    setStatus(listingStatus, `Loaded: ${data.title}`);
    showSummary(productSummary, data);
  } catch {
    setStatus(listingStatus, 'Failed to load listing.', true);
  }
});

deleteListingBtn.addEventListener('click', async () => {
  const id = listingSelect.value;
  if (!id) {
    setStatus(listingStatus, 'Select a listing first.', true);
    return;
  }

  const label = listingSelect.options[listingSelect.selectedIndex]?.text || id;
  if (!confirm(`Delete listing "${label}"?`)) return;

  try {
    const res = await fetch(`/api/product/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      setStatus(listingStatus, data.error || 'Delete failed.', true);
      return;
    }

    if (activeListingId === id) {
      setActiveListing(null, null);
      productSummary.classList.add('hidden');
    }

    setStatus(listingStatus, 'Listing deleted.');
    await loadListings();
  } catch {
    setStatus(listingStatus, 'Delete failed.', true);
  }
});

deleteAllBtn.addEventListener('click', async () => {
  if (!confirm('⚠️ Delete ALL listings? This cannot be undone. Are you sure?')) return;
  if (!confirm('Really delete EVERYTHING? All listings will be gone forever.')) return;
  
  setStatus(listingStatus, 'Deleting all listings...');
  
  try {
    const res = await fetch('/api/products');
    const data = await res.json();
    const listings = data.listings || [];
    
    for (const listing of listings) {
      await fetch(`/api/product/${listing.id}`, { method: 'DELETE' });
    }
    
    setActiveListing(null, null);
    productSummary.classList.add('hidden');
    setStatus(listingStatus, 'All listings deleted.');
    await loadListings();
    await loadStats();
  } catch {
    setStatus(listingStatus, 'Delete failed.', true);
  }
});

// ── Upload new listing ────────────────────────────────
uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(uploadStatus, 'Uploading and parsing product file...');

  const fileInput = document.getElementById('productFile');
  if (!fileInput.files || !fileInput.files[0]) {
    setStatus(uploadStatus, 'Select a file first.', true);
    return;
  }

  const formData = new FormData();
  formData.append('productFile', fileInput.files[0]);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      setStatus(uploadStatus, data.error || 'Upload failed.', true);
      return;
    }

    setStatus(uploadStatus, `"${data.profile.title}" uploaded successfully.`);
    showSummary(productSummary, data.profile);
    setActiveListing(data.profile.id, data.profile.title);
    await loadListings();
    listingSelect.value = data.profile.id;
    uploadForm.reset();
  } catch {
    setStatus(uploadStatus, 'Upload failed. Check server status.', true);
  }
});

// ── Manual listing entry ────────────────────────────────
manualEntryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(manualStatus, 'Adding listing...');

  const title = document.getElementById('manualTitle').value.trim();
  const price = document.getElementById('manualPrice').value.trim();
  const description = document.getElementById('manualDescription').value.trim();

  if (!title) {
    setStatus(manualStatus, 'Title is required.', true);
    return;
  }

  try {
    const res = await fetch('/api/listings/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listings: [{
          title,
          price,
          description,
          condition: 'Used - Good',
        }]
      })
    });

    const data = await res.json();
    if (!res.ok) {
      setStatus(manualStatus, data.error || 'Failed to add listing.', true);
      return;
    }

    setStatus(manualStatus, `"${title}" added successfully!`);
    manualEntryForm.reset();
    await loadListings();
  } catch {
    setStatus(manualStatus, 'Failed to add listing. Check server.', true);
  }
});

// ── Paste multiple listings ────────────────────────────
pasteEntryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(pasteStatus, 'Parsing listings...');

  const text = document.getElementById('pasteListings').value.trim();
  if (!text) {
    setStatus(pasteStatus, 'Paste some listings first.', true);
    return;
  }

  // Parse each line: "Title - $Price" or just "Title"
  const lines = text.split('\n').filter(l => l.trim());
  const listings = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try to split by " - " or ", $" for price
    let title = trimmed;
    let price = '';

    if (trimmed.includes(' - ')) {
      const parts = trimmed.split(' - ');
      title = parts[0].trim();
      price = parts.slice(1).join(' - ').trim();
    } else if (trimmed.match(/,\s*\$/) || trimmed.match(/\s\$\d/)) {
      const match = trimmed.match(/^(.+?)[\s,]+(\$\d[\d,]*(?:\.\d{2})?)\s*$/);
      if (match) {
        title = match[1].trim();
        price = match[2];
      }
    }

    if (title.length > 0) {
      listings.push({ title, price: price || '', condition: 'Used - Good' });
    }
  }

  if (listings.length === 0) {
    setStatus(pasteStatus, 'Could not parse any listings. Use format: Title - $Price', true);
    return;
  }

  setStatus(pasteStatus, `Adding ${listings.length} listings...`);

  try {
    const res = await fetch('/api/listings/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings })
    });

    const data = await res.json();
    if (!res.ok) {
      setStatus(pasteStatus, data.error || 'Failed to add listings.', true);
      return;
    }

    const count = data.synced || data.count || 0;
    setStatus(pasteStatus, `Added ${count} listing(s) successfully!`);
    pasteEntryForm.reset();
    await loadListings();
  } catch {
    setStatus(pasteStatus, 'Failed. Check server.', true);
  }
});

// ── CSV upload ─────────────────────────────────────
csvEntryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(csvStatus, 'Processing CSV...');

  const fileInput = document.getElementById('csvFile');
  if (!fileInput.files || !fileInput.files[0]) {
    setStatus(csvStatus, 'Select a file first.', true);
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const text = e.target.result;
    const lines = text.split('\n').filter(l => l.trim());
    const listings = [];

    // Skip header row if it contains "title" or "price"
    const startIdx = lines[0]?.toLowerCase().includes('title') ? 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Simple CSV parsing - split by first comma for title, rest for price (simplified)
      const parts = line.split(',');
      const title = parts[0]?.replace(/^"|"$/g, '').trim();
      const price = parts[1]?.replace(/^"|"$/g, '').trim();

      if (title && title.length > 0) {
        listings.push({ title, price: price || '', condition: 'Used - Good' });
      }
    }

    if (listings.length === 0) {
      setStatus(csvStatus, 'No listings found in CSV.', true);
      return;
    }

    setStatus(csvStatus, `Adding ${listings.length} listings...`);

    try {
      const res = await fetch('/api/listings/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listings })
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus(csvStatus, data.error || 'Failed to add listings.', true);
        return;
      }

      const count = data.synced || data.count || 0;
      setStatus(csvStatus, `Added ${count} listing(s) from CSV!`);
      csvEntryForm.reset();
      await loadListings();
    } catch {
      setStatus(csvStatus, 'Failed. Check server.', true);
    }
  };

  reader.readAsText(fileInput.files[0]);
});

// ── Profile sync ────────────────────────────────────
profileSyncForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(profileSyncStatus, 'Fetching listings from profile...', 'info');

  const profileUrl = document.getElementById('profileUrl').value.trim();
  if (!profileUrl) {
    setStatus(profileSyncStatus, 'Please enter a Facebook Marketplace profile URL.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/scrape/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileUrl })
    });

    const data = await res.json();
    if (!res.ok) {
      setStatus(profileSyncStatus, data.error || 'Failed to scrape profile.', 'error');
      return;
    }

    const count = data.synced || 0;
    setStatus(profileSyncStatus, `✅ Synced ${count} listings from your profile!`, 'success');
    await loadListings();
    await loadStats();

  } catch {
    setStatus(profileSyncStatus, 'Failed to sync. Check server connection.', 'error');
  }
});

// ── Quick start onboarding ────────────────────────────
quickStartForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const title = document.getElementById('quickTitle').value.trim();
  const price = document.getElementById('quickPrice').value.trim();

  if (!title) {
    quickStartStatus.textContent = 'Please enter a title for your listing.';
    quickStartStatus.style.color = '#ff6b6b';
    return;
  }

  quickStartStatus.textContent = 'Setting up your auto-responder...';
  quickStartStatus.style.color = '#fff';

  try {
    // Add the listing
    const res = await fetch('/api/listings/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listings: [{
          title,
          price,
          condition: 'Used - Good',
          description: `This is a ${title} available for sale.`
        }]
      })
    });

    const data = await res.json();
    if (!res.ok) {
      quickStartStatus.textContent = data.error || 'Failed to add listing.';
      quickStartStatus.style.color = '#ff6b6b';
      return;
    }

    // Success! Reload everything
    quickStartStatus.textContent = '✅ Success! Your auto-responder is ready. Try generating a response below!';
    quickStartStatus.style.color = '#28a745';

    setTimeout(() => {
      loadListings();
      loadStats();
    }, 500);

  } catch {
    quickStartStatus.textContent = 'Failed to set up. Please try again.';
    quickStartStatus.style.color = '#ff6b6b';
  }
});

// ── Demo response ────────────────────────────────────
demoForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const question = document.getElementById('demoQuestion').value.trim();
  if (!question) return;

  demoResponse.textContent = 'Generating reply...';

  try {
    const res = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Demo Buyer',
        question,
        channel: 'facebook_marketplace',
        listingId: activeListingId
      })
    });

    const data = await res.json();
    if (res.ok) {
      demoResponse.textContent = data.answer;
    } else {
      demoResponse.textContent = 'Error: ' + (data.error || 'Unknown error');
    }
  } catch {
    demoResponse.textContent = 'Failed to generate response';
  }
});

// ── Generate response ─────────────────────────────────
respondForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(responseStatus, 'Generating personalized response...');

  const customerName = document.getElementById('customerName').value.trim();
  const question     = document.getElementById('question').value.trim();
  const channel      = document.getElementById('channel').value;

  if (!question) {
    setStatus(responseStatus, 'Please add a buyer question.', true);
    return;
  }

  if (!activeListingId) {
    setStatus(responseStatus, 'Load a listing first (Section 1).', true);
    return;
  }

  try {
    const res = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName, question, channel, listingId: activeListingId }),
    });

    const data = await res.json();
    if (!res.ok) {
      setStatus(responseStatus, data.error || 'Response generation failed.', true);
      return;
    }

    setStatus(responseStatus, 'Reply generated.');
    responseBox.textContent = data.answer;
    responseBox.classList.remove('hidden');
  } catch {
    setStatus(responseStatus, 'Request failed. Check server status.', true);
  }
});

// ── Stats ────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.ok) {
      statListingsEl.textContent = data.listingsCount || 0;
      statHotEl.textContent = data.hotBuyers || 0;
      statWarmEl.textContent = data.warmBuyers || 0;
    }
  } catch (e) {
    statListingsEl.textContent = '—';
    statHotEl.textContent = '—';
    statWarmEl.textContent = '—';
  }
}

// ── Init ──────────────────────────────────────────────
loadListings();
loadStats();

