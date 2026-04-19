const checklist = document.getElementById('checklist');
const platformGrid = document.getElementById('platformGrid');

function checkIcon(state) {
  if (state === 'ok') return `<span class="check-icon check-ok">✓</span>`;
  if (state === 'warn') return `<span class="check-icon check-warn">!</span>`;
  return `<span class="check-icon check-fail">✗</span>`;
}

function badgeClass(status) {
  if (status === 'configured') return 'badge-ready';
  if (status === 'ready_via_webhook_bridge') return 'badge-bridge';
  if (status === 'limited') return 'badge-partial';
  return 'badge-missing';
}

function badgeLabel(status) {
  if (status === 'configured') return 'Native';
  if (status === 'ready_via_webhook_bridge') return 'Bridge ready';
  if (status === 'limited') return 'Partial';
  if (status === 'needs_config') return 'Missing config';
  return status;
}

async function loadStatus() {
  const urlParams = new URLSearchParams(window.location.search);
  const count = urlParams.get('count');
  const error = urlParams.get('error');

  if (count !== null || error) {
    const banner = document.createElement('div');
    banner.style.padding = '20px';
    banner.style.borderRadius = '16px';
    banner.style.marginBottom = '24px';
    banner.style.textAlign = 'center';
    banner.style.fontWeight = '700';
    
    if (error) {
      banner.style.background = '#fee2e2';
      banner.style.color = '#9b1c1c';
      banner.innerText = '❌ Import Failed: ' + (error === 'no_text' ? 'Could not read listings text.' : error);
    } else {
      banner.style.background = '#d1faeb';
      banner.style.color = '#076644';
      banner.innerText = `🎉 Successfully imported ${count} listings from Facebook!`;
    }
    document.querySelector('.hero').after(banner);
  }

  let product = null;
  let platforms = [];

  try {
    const [productRes, platformRes] = await Promise.all([
      fetch('/api/product'),
      fetch('/api/platforms'),
    ]);

    if (productRes.ok) {
      product = await productRes.json();
    }

    if (platformRes.ok) {
      const data = await platformRes.json();
      platforms = data.platforms || [];
    }
  } catch (_err) {
    checklist.innerHTML = `<li>${checkIcon('fail')}<span>Could not reach server. Make sure it is running.</span></li>`;
    return;
  }

  const fbPlatform = platforms.find((p) => p.name === 'facebook_messenger');
  const webhookPlatform = platforms.find((p) => p.name === 'generic_webhook');

  const checks = [
    {
      label: 'Server is running',
      state: 'ok',
      detail: 'Server responded successfully.',
    },
    {
      label: 'Product listing uploaded',
      state: product ? 'ok' : 'fail',
      detail: product
        ? `Loaded: "${product.title}" — price ${product.price || 'not set'}`
        : 'No product file uploaded yet. Go to the main page and upload one.',
    },
    {
      label: 'OpenAI API key',
      state: 'warn',
      detail: 'Cannot verify key here — if set, AI replies are active. If blank, built-in logic is used instead.',
    },
    {
      label: 'Integration API key (for bridges)',
      state: webhookPlatform?.status === 'configured' ? 'ok' : 'warn',
      detail: webhookPlatform?.status === 'configured'
        ? 'INTEGRATION_API_KEY is configured. Bridge endpoints are protected.'
        : 'INTEGRATION_API_KEY not set. Bridge endpoints will reject all requests.',
    },
    {
      label: 'Facebook Messenger',
      state: fbPlatform?.status === 'configured' ? 'ok' : 'warn',
      detail: fbPlatform?.status === 'configured'
        ? 'FB credentials are set. Connect your Meta webhook to go live.'
        : 'Optional — set FB_PAGE_ACCESS_TOKEN and FB_VERIFY_TOKEN in .env to enable.',
    },
  ];

  checklist.innerHTML = checks
    .map(
      (c) => `
    <li>
      ${checkIcon(c.state)}
      <span>
        <strong>${c.label}</strong><br />
        <span style="color:var(--muted);font-size:0.82rem;">${c.detail}</span>
      </span>
    </li>`,
    )
    .join('');

  platformGrid.innerHTML = platforms
    .map(
      (p) => `
    <div class="platform-card">
      <span class="badge ${badgeClass(p.status)}">${badgeLabel(p.status)}</span>
      <span class="name">${p.label}</span>
      <span class="note">${p.notes}</span>
    </div>`,
    )
    .join('');
}

loadStatus();
