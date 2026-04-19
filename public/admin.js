const queueList = document.getElementById('queueList');
const adminStatus = document.getElementById('adminStatus');
const refreshBtn = document.getElementById('refreshBtn');
const logoutBtn = document.getElementById('logoutBtn');

const loginCard = document.getElementById('adminLoginCard');
const queueCard = document.getElementById('adminQueueCard');
const loginForm = document.getElementById('adminLoginForm');
const adminPassword = document.getElementById('adminPassword');

let csrfToken = null;

function withCsrfHeaders(headers = {}) {
  if (!csrfToken) return headers;
  return {
    ...headers,
    'x-csrf-token': csrfToken,
  };
}

function setStatus(text, isError = false) {
  adminStatus.textContent = text;
  adminStatus.style.color = isError ? '#b3261e' : '';
}

// Map label -> which bucket (0 = Pay Attention, 1 = Worth Nurturing, 2 = Skip For Now)
const BUCKET_MAP = {
  HIGH_INTENT:  0,
  LIKELY_BUYER: 1,
  NEGOTIATING:  1,
  LOWBALLER:    2,
  TIME_WASTER:  2,
};

const BUCKETS = [
  {
    id: 'bucket-hot',
    title: '🔥 Pay Attention — Act Now',
    subtitle: 'These buyers are ready. Reply fast before they move on.',
    borderColor: '#2d6a2d',
    headerBg: '#d4edda',
    headerColor: '#155724',
  },
  {
    id: 'bucket-warm',
    title: '🤝 Worth Your Time — Nurture These',
    subtitle: 'Interested but haven\'t committed. A short reply could close the deal.',
    borderColor: '#0c5460',
    headerBg: '#d1ecf1',
    headerColor: '#0c5460',
  },
  {
    id: 'bucket-cold',
    title: '❄️ Skip Unless Slow — Low Priority',
    subtitle: 'Likely lowballers or window-shoppers. Only worth replying if you need a sale badly.',
    borderColor: '#888',
    headerBg: '#e8e8e8',
    headerColor: '#444',
  },
];

function intentBadge(item) {
  const label = item.buyerIntentLabel;
  const score = item.buyerIntentScore;
  if (!label) return '';

  const map = {
    HIGH_INTENT:  { text: '🟢 Sure Sale',    bg: '#d4edda', color: '#155724' },
    LIKELY_BUYER: { text: '🔵 Likely Buyer', bg: '#d1ecf1', color: '#0c5460' },
    NEGOTIATING:  { text: '🟡 Negotiating',  bg: '#fff3cd', color: '#856404' },
    LOWBALLER:    { text: '🔴 Lowballer',    bg: '#fde8e8', color: '#7b1c1c' },
    TIME_WASTER:  { text: '⛔ Time Waster',  bg: '#e8e8e8', color: '#444'    },
  };
  const style = map[label] || { text: label, bg: '#f5f5f5', color: '#333' };
  const scoreText = score != null ? ` (${score}/100)` : '';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.8em;font-weight:600;background:${style.bg};color:${style.color}">${style.text}${scoreText}</span>`;
}

function cardHtml(item) {
  const reasons = (item.reasons || []).length ? item.reasons.join(' | ') : 'No explicit risk reasons';
  const listing = item.listingId || 'not_set';
  const signals = (item.buyerIntentSignals || []).length ? item.buyerIntentSignals.join(', ') : null;

  return `
    <div class="summary" data-id="${item.id}">
      <strong>${item.customerName || 'Buyer'}</strong> via ${item.channel} | ${intentBadge(item)}<br />
      <strong>Listing:</strong> ${listing}<br />
      <strong>Question:</strong> ${item.question}<br />
      <strong>Proposed reply:</strong> ${item.proposedAnswer}<br />
      <strong>Risk flags:</strong> ${reasons}<br />
      ${signals ? `<strong>Why this score:</strong> ${signals}<br />` : ''}
      <br />
      <button data-action="approve" data-id="${item.id}">Approve &amp; Send</button>
      <button data-action="reject" data-id="${item.id}" style="margin-left:8px;background:#a94442;">Reject</button>
    </div>
  `;
}

function bucketHtml(bucket, items) {
  const count = items.length;
  const itemsHtml = count > 0
    ? items.map(cardHtml).join('')
    : `<div style="color:#888;font-style:italic;padding:8px 0;">Nothing here right now.</div>`;

  return `
    <div style="border:2px solid ${bucket.borderColor};border-radius:8px;margin-bottom:24px;overflow:hidden;">
      <div style="background:${bucket.headerBg};color:${bucket.headerColor};padding:12px 16px;">
        <strong style="font-size:1.05em;">${bucket.title}</strong>
        <span style="margin-left:10px;font-size:0.85em;background:${bucket.borderColor};color:#fff;border-radius:12px;padding:1px 8px;">${count}</span><br />
        <span style="font-size:0.85em;opacity:0.85;">${bucket.subtitle}</span>
      </div>
      <div style="padding:12px 16px;" id="${bucket.id}">${itemsHtml}</div>
    </div>
  `;
}

async function loadQueue() {
  setStatus('Loading queue...');
  try {
    const res = await fetch('/api/admin/queue');
    const data = await res.json();
    if (res.status === 401) {
      showLoggedOut();
      setStatus('Admin login required.', true);
      return;
    }

    if (!res.ok) {
      setStatus(data.error || 'Failed to load queue.', true);
      return;
    }

    const pending = data.pending || [];
    if (pending.length === 0) {
      queueList.innerHTML = '<div class="summary">No pending items.</div>';
      setStatus('Queue is empty.');
      return;
    }

    // Split into 3 buckets
    const groups = [[], [], []];
    for (const item of pending) {
      const bucketIdx = item.buyerIntentLabel != null ? (BUCKET_MAP[item.buyerIntentLabel] ?? 2) : 2;
      groups[bucketIdx].push(item);
    }

    queueList.innerHTML = BUCKETS.map((b, i) => bucketHtml(b, groups[i])).join('');
    setStatus(`${pending.length} pending item(s) — ${groups[0].length} hot, ${groups[1].length} warm, ${groups[2].length} low priority.`);
  } catch (_error) {
    setStatus('Queue request failed.', true);
  }
}

function showLoggedIn() {
  loginCard.classList.add('hidden');
  queueCard.classList.remove('hidden');
}

function showLoggedOut() {
  queueCard.classList.add('hidden');
  loginCard.classList.remove('hidden');
}

async function checkSession() {
  try {
    const res = await fetch('/api/admin/session');
    const data = await res.json();

    if (!res.ok) {
      showLoggedOut();
      return;
    }

    csrfToken = data.csrfToken || null;

    if (!data.enabled || data.authenticated) {
      showLoggedIn();
      await loadQueue();
      return;
    }

    showLoggedOut();
  } catch {
    setStatus('Could not verify admin session.', true);
  }
}

async function approve(id) {
  const res = await fetch(`/api/admin/queue/${id}/approve`, {
    method: 'POST',
    headers: withCsrfHeaders(),
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Approve failed.', true);
    return;
  }

  setStatus(`Approved queue item ${id}.`);
  await loadQueue();
}

async function reject(id) {
  const reason = window.prompt('Optional reject reason:', 'Manual reject by reviewer');
  const res = await fetch(`/api/admin/queue/${id}/reject`, {
    method: 'POST',
    headers: withCsrfHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ reason }),
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Reject failed.', true);
    return;
  }

  setStatus(`Rejected queue item ${id}.`);
  await loadQueue();
}

queueList.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const action = target.dataset.action;
  const id = target.dataset.id;
  if (!action || !id) return;

  if (action === 'approve') {
    await approve(id);
  }

  if (action === 'reject') {
    await reject(id);
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const password = adminPassword.value;
  if (!password) {
    setStatus('Enter a password.', true);
    return;
  }

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || 'Login failed.', true);
      return;
    }

    csrfToken = data.csrfToken || null;

    adminPassword.value = '';
    showLoggedIn();
    setStatus('Logged in.');
    await loadQueue();
  } catch {
    setStatus('Login failed.', true);
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/admin/logout', {
      method: 'POST',
      headers: withCsrfHeaders(),
    });
  } finally {
    csrfToken = null;
    showLoggedOut();
    setStatus('Logged out.');
  }
});

refreshBtn.addEventListener('click', loadQueue);
checkSession();
