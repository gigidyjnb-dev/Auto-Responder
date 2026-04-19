const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('--- TEST START: Atomic Sync Theory ---');

  // Go to the simulated Facebook page
  await page.goto('http://localhost:3001/facebook-sim');

  let success = false;
  
  // Handle the popup (bridge)
  page.on('popup', async (popup) => {
    console.log('Popup (bridge) opened!');
    popup.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('RECEIVED DATA:')) {
        console.log('SUCCESS: Bridge received data through postMessage!');
        success = true;
      }
    });
  });

  // Click the simulated bookmarklet button
  console.log('Clicking 🚀 button...');
  await page.click('#bookmarkletBtn');

  // Wait for the async process to complete
  await new Promise(r => setTimeout(r, 3000));

  if (success) {
    console.log('--- TEST PASSED: THE ATOMIC BOMB WORKS ---');
  } else {
    console.log('--- TEST FAILED ---');
  }

  await browser.close();
  process.exit(success ? 0 : 1);
})();
