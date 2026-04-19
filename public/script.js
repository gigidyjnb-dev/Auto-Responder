// ── State ─────────────────────────────────────────────
let activeListingId = null;

// ── Element refs ──────────────────────────────────────
const listingSelect    = document.getElementById('listingSelect');
const loadListingBtn   = document.getElementById('loadListingBtn');
const deleteListingBtn = document.getElementById('deleteListingBtn');
const listingStatus    = document.getElementById('listingStatus');

const uploadForm    = document.getElementById('uploadForm');
const uploadStatus  = document.getElementById('uploadStatus');
const productSummary = document.getElementById('productSummary');

const respondForm    = document.getElementById('respondForm');
const responseStatus = document.getElementById('responseStatus');
const responseBox    = document.getElementById('responseBox');

const activeListingBadge = document.getElementById('activeListingBadge');
const activeListingTitle = document.getElementById('activeListingTitle');

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

// ── Init ──────────────────────────────────────────────
loadListings();

