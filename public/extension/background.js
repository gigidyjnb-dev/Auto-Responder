// Background service worker for the Listing Sync Extension
// Handles installation events, storage, and messaging

chrome.runtime.onInstalled.addListener(() => {
  console.log('Listing Sync Extension installed');
});

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ status: 'ok' });
  }
  if (request.action === 'getTabInfo') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        sendResponse({ url: tabs[0].url, id: tabs[0].id });
      } else {
        sendResponse({ error: 'No active tab' });
      }
    });
    return true; // async response
  }
});

// Optional: Listen for tab updates to auto-detect platform
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Could auto-enable icon based on URL
  }
});
