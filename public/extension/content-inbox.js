/* content-inbox.js — Marketplace Auto-Responder Content Script v2
 *
 * Primary:  XHR/fetch GraphQL interception (survives Facebook UI updates)
 * Fallback: MutationObserver DOM scanning
 */
(function () {
  'use strict';

  if (window.__arInit) return;
  window.__arInit = true;

  /* ── Settings ─────────────────────────────────────────── */
  let cfg = {
    serverUrl: '',
    autoReplyEnabled: false,
    autoSendEnabled: false,
    awayEnabled: false,
    awayStart: '22:00',
    awayEnd: '07:00',
    awayMessage: "Thanks for your message! I'm away right now but will get back to you first thing in the morning.",
    replyCount: 0,
  };

  const processedIds = new Set();

  function loadCfg(cb) {
    chrome.storage.local.get(
      ['serverUrl', 'autoReplyEnabled', 'autoSendEnabled',
       'awayEnabled', 'awayStart', 'awayEnd', 'awayMessage', 'replyCount'],
      (r) => {
        cfg = {
          serverUrl: (r.serverUrl || '').replace(/\/$/, ''),
          autoReplyEnabled: Boolean(r.autoReplyEnabled),
          autoSendEnabled: Boolean(r.autoSendEnabled),
          awayEnabled: Boolean(r.awayEnabled),
          awayStart: r.awayStart || '22:00',
          awayEnd: r.awayEnd || '07:00',
          awayMessage: r.awayMessage || "Thanks for your message! I'm away right now but will get back to you first thing in the morning.",
          replyCount: Number(r.replyCount) || 0,
        };
        cb && cb();
      }
    );
  }

  chrome.storage.onChanged.addListener(() => loadCfg());
  loadCfg(init);

  /* ── Away mode check ──────────────────────────────────── */
  function isAwayTime() {
    if (!cfg.awayEnabled) return false;
    const now = new Date();
    const [sh, sm] = cfg.awayStart.split(':').map(Number);
    const [eh, em] = cfg.awayEnd.split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start > end
      ? cur >= start || cur < end
      : cur >= start && cur < end;
  }

  /* ── Stat tracking ────────────────────────────────────── */
  function bumpReplyCount() {
    cfg.replyCount++;
    const today = new Date().toDateString();
    chrome.storage.local.get(['replyDate', 'statReplies'], (r) => {
      if (r.replyDate !== today) {
        chrome.storage.local.set({ replyDate: today, statReplies: 1, replyCount: 1 });
      } else {
        const next = (Number(r.statReplies) || 0) + 1;
        chrome.storage.local.set({ statReplies: next, replyCount: next });
      }
    });
  }

  /* ── Message dedup ────────────────────────────────────── */
  function msgId(text, sender) {
    return `${sender}::${text.substring(0, 80)}`;
  }

  /* ── Get reply from server ────────────────────────────── */
  async function fetchReply(messageText, senderName, listingTitle) {
    const resp = await fetch(`${cfg.serverUrl}/api/extension/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageText, listingTitle, senderName }),
    });
    return resp.json();
  }

  /* ── Handle a detected buyer message ─────────────────── */
  async function handleMessage(messageText, senderName, listingTitle) {
    if (!cfg.autoReplyEnabled || !cfg.serverUrl) return;

    const id = msgId(messageText, senderName);
    if (processedIds.has(id)) return;
    processedIds.add(id);

    if (isAwayTime()) {
      await dispatchReply(cfg.awayMessage);
      bumpReplyCount();
      return;
    }

    let data;
    try {
      data = await fetchReply(messageText, senderName, listingTitle);
    } catch (err) {
      console.error('[AR] API error:', err.message);
      processedIds.delete(id);
      return;
    }

    if (!data?.reply || data.skipped) return;

    bumpReplyCount();

    if (cfg.autoSendEnabled) {
      await dispatchReply(data.reply);
    } else {
      showSuggestion(data.reply, data.intent, () => dispatchReply(data.reply));
    }
  }

  /* ── Chat input / send ────────────────────────────────── */
  function findChatInput() {
    const sel = [
      'div[aria-label="Message"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[aria-label*="message" i][contenteditable="true"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function findSendBtn() {
    const sel = [
      'div[aria-label="Send"][role="button"]',
      'button[aria-label="Send"]',
      '[data-testid="send-button"]',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  async function dispatchReply(text) {
    const input = findChatInput();
    if (!input) { console.warn('[AR] Input not found'); return; }

    input.focus();
    input.click();
    await sleep(150);

    input.innerHTML = '';
    document.execCommand('insertText', false, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));

    await sleep(500);

    const btn = findSendBtn();
    if (btn) {
      btn.click();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
    await sleep(200);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Suggestion overlay ───────────────────────────────── */
  const INTENT_LABELS = {
    availability_check: '✅ Availability',
    price_offer:        '💰 Price Offer',
    shipping_question:  '📦 Shipping',
    meetup_question:    '📍 Meetup',
    item_question:      '❓ Item Question',
    greeting:           '👋 Greeting',
    general:            '💬 General',
  };

  let suggestionEl = null;

  function showSuggestion(reply, intent, onSend) {
    if (suggestionEl) suggestionEl.remove();

    const label = INTENT_LABELS[intent] || '💬 Reply';

    suggestionEl = document.createElement('div');
    suggestionEl.id = '__ar-suggestion';
    Object.assign(suggestionEl.style, {
      position: 'fixed', bottom: '88px', right: '16px', zIndex: '999999',
      background: '#fff', border: '2px solid #0066ff', borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,102,255,0.18)', padding: '14px 16px',
      maxWidth: '340px', fontFamily: 'system-ui,sans-serif', fontSize: '13px',
      animation: 'arSlideIn .25s ease',
    });

    const style = document.createElement('style');
    style.textContent = `@keyframes arSlideIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`;
    document.head.appendChild(style);

    suggestionEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-weight:700;color:#0066ff;font-size:11px;text-transform:uppercase;letter-spacing:.5px">🤖 Auto-Reply · ${label}</span>
        <span id="__ar-close" style="cursor:pointer;color:#aaa;font-size:16px;line-height:1">×</span>
      </div>
      <div style="color:#222;line-height:1.5;margin-bottom:12px;white-space:pre-wrap;max-height:120px;overflow-y:auto">${escHtml(reply)}</div>
      <div style="display:flex;gap:8px">
        <button id="__ar-send" style="flex:1;padding:8px;background:#0066ff;color:#fff;border:none;border-radius:7px;cursor:pointer;font-size:13px;font-weight:700">✓ Send</button>
        <button id="__ar-edit" style="flex:1;padding:8px;background:#f0f4ff;color:#0066ff;border:1px solid #d0e0ff;border-radius:7px;cursor:pointer;font-size:13px">Edit</button>
        <button id="__ar-skip" style="padding:8px 12px;background:#f5f5f5;color:#666;border:none;border-radius:7px;cursor:pointer;font-size:13px">Skip</button>
      </div>
    `;

    document.body.appendChild(suggestionEl);

    suggestionEl.querySelector('#__ar-close').onclick = () => suggestionEl?.remove();
    suggestionEl.querySelector('#__ar-skip').onclick = () => suggestionEl?.remove();
    suggestionEl.querySelector('#__ar-send').onclick = () => { suggestionEl?.remove(); onSend(); };
    suggestionEl.querySelector('#__ar-edit').onclick = () => {
      const input = findChatInput();
      if (input) {
        input.focus();
        document.execCommand('insertText', false, reply);
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      suggestionEl?.remove();
    };
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── PRIMARY: XHR / fetch interception ───────────────── */
  function installNetworkInterceptor() {
    const _fetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await _fetch.apply(this, args);
      const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
      if (url.includes('/api/graphql') || url.includes('graph.facebook.com')) {
        try {
          const clone = res.clone();
          clone.text().then(parseGraphQLPayload).catch(() => {});
        } catch {}
      }
      return res;
    };

    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__arUrl = url;
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.__arUrl?.includes('/api/graphql')) {
        this.addEventListener('load', function () {
          try { parseGraphQLPayload(this.responseText); } catch {}
        });
      }
      return _send.apply(this, arguments);
    };
  }

  const seenGraphQLMsgIds = new Set();

  function parseGraphQLPayload(text) {
    if (!cfg.autoReplyEnabled || !cfg.serverUrl) return;
    if (!text || !text.includes('message_body')) return;

    const listingTitle = getListingTitle();

    let chunks;
    try {
      chunks = text.split('\n').map(l => JSON.parse(l));
    } catch {
      try { chunks = [JSON.parse(text)]; } catch { return; }
    }

    for (const chunk of chunks) {
      extractMessages(chunk, listingTitle);
    }
  }

  function extractMessages(obj, listingTitle, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;

    if (obj.message_body && obj.sender && obj.message_id) {
      const msgId2 = obj.message_id;
      const isMe = obj.sender?.is_viewer_sender === true;
      if (!isMe && !seenGraphQLMsgIds.has(msgId2)) {
        seenGraphQLMsgIds.add(msgId2);
        const text = obj.message_body.text || obj.message_body;
        const sender = obj.sender?.name || 'Buyer';
        if (typeof text === 'string' && text.trim()) {
          handleMessage(text.trim(), sender, listingTitle);
        }
      }
      return;
    }

    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        extractMessages(val, listingTitle, depth + 1);
      }
    }
  }

  /* ── FALLBACK: MutationObserver DOM scan ─────────────── */
  function getListingTitle() {
    const candidates = [
      document.querySelector('[data-testid="marketplace-conversation-listing-title"]'),
      document.querySelector('h2[dir="auto"]'),
      document.querySelector('[role="main"] h1'),
      document.querySelector('[role="main"] h2'),
    ];
    for (const el of candidates) {
      const t = el?.textContent?.trim();
      if (t && t.length > 2 && t.length < 150) return t;
    }
    return document.title.replace(/\s*[\|\-–].*$/, '').trim() || '';
  }

  function isOutgoing(el) {
    const container = el.closest('[role="row"], [role="listitem"], li') || el;
    const mainRect = document.querySelector('[role="main"]')?.getBoundingClientRect();
    const rect = container.getBoundingClientRect();
    if (mainRect && rect.width > 0) {
      const center = rect.left + rect.width / 2;
      if (center > mainRect.left + mainRect.width * 0.55) return true;
    }
    return false;
  }

  function domScan() {
    if (!cfg.autoReplyEnabled || !cfg.serverUrl) return;

    const listingTitle = getListingTitle();
    const msgEls = document.querySelectorAll('div[dir="auto"]');
    const candidates = [];

    msgEls.forEach(el => {
      const text = el.textContent?.trim();
      if (!text || text.length < 2 || text.length > 800) return;
      if (isOutgoing(el)) return;
      candidates.push({ el, text });
    });

    if (!candidates.length) return;

    const last = candidates[candidates.length - 1];
    const id = msgId(last.text, 'dom');
    if (!processedIds.has(id)) {
      handleMessage(last.text, 'Buyer', listingTitle);
    }
  }

  let domObserver = null;

  function startDomFallback() {
    if (domObserver) domObserver.disconnect();
    domObserver = new MutationObserver(() => {
      if (!cfg.autoReplyEnabled) return;
      clearTimeout(window.__arScanTimer);
      window.__arScanTimer = setTimeout(domScan, 900);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
    domScan();
  }

  /* ── Bootstrap ────────────────────────────────────────── */
  function init() {
    installNetworkInterceptor();
    startDomFallback();
  }
})();
