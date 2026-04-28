/* background.js — Service Worker for Marketplace Auto-Responder */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['serverUrl', 'autoReplyEnabled', 'autoSendEnabled'], (r) => {
    if (!r.serverUrl) {
      chrome.storage.local.set({
        serverUrl: '',
        autoReplyEnabled: false,
        autoSendEnabled: false,
      });
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ status: 'ok' });
    return false;
  }

  if (request.action === 'getTabInfo') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        sendResponse({ url: tabs[0].url, id: tabs[0].id });
      } else {
        sendResponse({ error: 'No active tab' });
      }
    });
    return true;
  }

  if (request.action === 'getReply') {
    chrome.storage.local.get(['userToken'], (storage) => {
      const { serverUrl, message, listingTitle, senderName } = request;
      const headers = { 'Content-Type': 'application/json' };

      if (storage.userToken) {
        headers['Authorization'] = `Bearer ${storage.userToken}`;
      }

      fetch(`${serverUrl}/api/extension/reply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, listingTitle, senderName }),
      })
        .then((r) => r.json())
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }

  if (request.action === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Auto-Responder',
      message: request.message || 'Reply sent.',
    });
    return false;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('facebook.com/marketplace')) {
    chrome.storage.local.get(['autoReplyEnabled'], (r) => {
      if (r.autoReplyEnabled) {
        chrome.action.setBadgeText({ text: 'ON', tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#0066ff', tabId });
      } else {
        chrome.action.setBadgeText({ text: '', tabId });
      }
    });
  }
});
