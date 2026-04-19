/* content-inbox.js — FB Marketplace Auto-Reply Content Script */
(function () {
  'use strict';

  if (window.__arInit) return;
  window.__arInit = true;

  let settings = { serverUrl: '', autoReplyEnabled: false, autoSendEnabled: false };
  let processedIds = new Set();
  let observer = null;
  let suggestionEl = null;

  function loadSettings(cb) {
    chrome.storage.local.get(['serverUrl', 'autoReplyEnabled', 'autoSendEnabled'], (r) => {
      settings = {
        serverUrl: (r.serverUrl || '').replace(/\/$/, ''),
        autoReplyEnabled: Boolean(r.autoReplyEnabled),
        autoSendEnabled: Boolean(r.autoSendEnabled),
      };
      cb && cb();
    });
  }

  chrome.storage.onChanged.addListener(() => {
    loadSettings(() => {
      if (!settings.autoReplyEnabled) removeSuggestion();
    });
  });

  loadSettings(startWatching);

  /* ── DOM helpers ─────────────────────────────────────── */

  function getListingTitle() {
    const candidates = [
      document.querySelector('[data-testid="marketplace-conversation-listing-title"]'),
      document.querySelector('h2[dir="auto"]'),
      document.querySelector('[aria-label*="listing" i] span'),
      document.querySelector('[role="main"] h1'),
      document.querySelector('[role="main"] h2'),
    ];
    for (const el of candidates) {
      const t = el?.textContent?.trim();
      if (t && t.length > 2 && t.length < 150) return t;
    }
    return '';
  }

  function getSenderName(msgEl) {
    const row = msgEl.closest('[role="row"], [role="listitem"], li') || msgEl.parentElement;
    if (!row) return 'Buyer';
    const nameEl = row.querySelector('[data-testid*="author"], [class*="author"], span[dir="auto"]:first-child');
    const name = nameEl?.textContent?.trim();
    return name && name.length < 60 ? name : 'Buyer';
  }

  function isOutgoing(msgEl) {
    const container = msgEl.closest('[role="row"], [role="listitem"], li') || msgEl;
    const rect = container.getBoundingClientRect();
    const chatRect = document.querySelector('[role="main"]')?.getBoundingClientRect();
    if (chatRect && rect.width > 0) {
      const center = rect.left + rect.width / 2;
      if (center > chatRect.left + chatRect.width * 0.55) return true;
    }
    const html = container.innerHTML || '';
    if (/seen|delivered|check.*mark/i.test(html)) return true;
    const styles = window.getComputedStyle(container);
    if (styles.textAlign === 'right') return true;
    return false;
  }

  function getMessageText(el) {
    return el?.textContent?.trim() || '';
  }

  function messageId(text, sender) {
    return `${sender}::${text.substring(0, 80)}`;
  }

  /* ── Chat input helpers ───────────────────────────────── */

  function findChatInput() {
    const selectors = [
      'div[aria-label="Message"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[aria-label*="message" i][contenteditable="true"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[contenteditable="true"]',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'div[aria-label="Send"][role="button"]',
      'button[aria-label="Send"]',
      '[data-testid="send-button"]',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  async function typeAndSend(text) {
    const input = findChatInput();
    if (!input) {
      console.warn('[AR] Chat input not found');
      return false;
    }

    input.focus();
    input.click();

    await sleep(200);

    input.innerHTML = '';
    document.execCommand('insertText', false, text);

    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));

    await sleep(600);

    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    await sleep(300);
    return true;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ── Suggestion overlay (suggest mode) ───────────────── */

  function showSuggestion(reply, onSend, onDismiss) {
    removeSuggestion();

    suggestionEl = document.createElement('div');
    suggestionEl.id = '__ar-suggestion';
    suggestionEl.style.cssText = [
      'position:fixed;bottom:80px;right:16px;z-index:99999',
      'background:#fff;border:1px solid #0066ff;border-radius:10px',
      'box-shadow:0 4px 20px rgba(0,0,0,0.18);padding:14px 16px',
      'max-width:340px;font-family:system-ui,sans-serif;font-size:13px',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'font-weight:700;color:#0066ff;margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:.5px';
    header.textContent = '🤖 Auto-Reply Suggestion';

    const body = document.createElement('div');
    body.style.cssText = 'color:#222;line-height:1.5;margin-bottom:12px;white-space:pre-wrap';
    body.textContent = reply;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px';

    const sendBtn = document.createElement('button');
    sendBtn.textContent = '✓ Send';
    sendBtn.style.cssText = 'flex:1;padding:7px;background:#0066ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600';
    sendBtn.onclick = () => { removeSuggestion(); onSend && onSend(); };

    const skipBtn = document.createElement('button');
    skipBtn.textContent = 'Skip';
    skipBtn.style.cssText = 'flex:1;padding:7px;background:#f0f0f0;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:13px';
    skipBtn.onclick = () => { removeSuggestion(); onDismiss && onDismiss(); };

    btnRow.appendChild(sendBtn);
    btnRow.appendChild(skipBtn);
    suggestionEl.appendChild(header);
    suggestionEl.appendChild(body);
    suggestionEl.appendChild(btnRow);
    document.body.appendChild(suggestionEl);
  }

  function removeSuggestion() {
    if (suggestionEl) {
      suggestionEl.remove();
      suggestionEl = null;
    }
  }

  /* ── Core message processor ───────────────────────────── */

  async function processMessage(text, sender, listingTitle) {
    if (!settings.serverUrl || !settings.autoReplyEnabled) return;

    const id = messageId(text, sender);
    if (processedIds.has(id)) return;
    processedIds.add(id);

    let data;
    try {
      const resp = await fetch(`${settings.serverUrl}/api/extension/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, listingTitle, senderName: sender }),
      });
      data = await resp.json();
    } catch (err) {
      console.error('[AR] API error:', err);
      return;
    }

    if (!data?.reply) return;

    if (settings.autoSendEnabled) {
      await typeAndSend(data.reply);
    } else {
      showSuggestion(data.reply, () => typeAndSend(data.reply), () => {});
    }
  }

  /* ── Message scanner ──────────────────────────────────── */

  function scanMessages() {
    if (!settings.autoReplyEnabled || !settings.serverUrl) return;

    const listingTitle = getListingTitle();

    const msgEls = document.querySelectorAll(
      'div[dir="auto"][class*="x1iorvi4"], div[dir="auto"][class*="x193iq5w"], div[dir="auto"][data-ad-preview="message"], div[dir="auto"]'
    );

    const candidates = [];
    msgEls.forEach((el) => {
      const text = getMessageText(el);
      if (!text || text.length < 2 || text.length > 1000) return;
      if (isOutgoing(el)) return;
      candidates.push({ el, text });
    });

    if (candidates.length === 0) return;

    const last = candidates[candidates.length - 1];
    const sender = getSenderName(last.el);
    const id = messageId(last.text, sender);

    if (!processedIds.has(id)) {
      processMessage(last.text, sender, listingTitle);
    }
  }

  /* ── MutationObserver ─────────────────────────────────── */

  function startWatching() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      if (settings.autoReplyEnabled) {
        clearTimeout(window.__arScanTimer);
        window.__arScanTimer = setTimeout(scanMessages, 800);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    scanMessages();
  }
})();
