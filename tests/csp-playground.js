const http = require('http');
const express = require('express');
const app = express();

// 1. Simulate "The Target" (Facebook-like page with strict CSP)
app.get('/facebook-sim', (req, res) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 20px;">
        <h1>Facebook Simulator (CSP Blocked)</h1>
        <p>This page blocks <code>fetch()</code> to external sites.</p>
        <button id="bookmarkletBtn">🚀 Drag Me (Simulated Bookmarklet)</button>
        <script>
          // The "Atomic Bomb" Theory: Window-to-Window Bridge
          const origin = 'http://localhost:3001'; 
          
          window.runSync = function() {
            const listings = [{ title: 'Simulated Item', price: '$100' }];
            console.log('Opening bridge window...');
            
            // Step 1: Open a small window to OUR app
            const bridge = window.open(origin + '/bridge.html', 'sync_bridge', 'width=100,height=100');
            
            // Step 2: Wait for bridge to be ready and send data
            const listener = (event) => {
              if (event.origin !== origin) return;
              if (event.data === 'bridge_ready') {
                console.log('Bridge ready, sending data...');
                bridge.postMessage({ type: 'SYNC_LISTINGS', data: listings }, origin);
                window.removeEventListener('message', listener);
              }
            };
            window.addEventListener('message', listener);
          };
          
          document.getElementById('bookmarkletBtn').onclick = window.runSync;
        </script>
      </body>
    </html>
  `);
});

// 2. Simulate "The Bridge" (Our app page that receives the message)
app.get('/bridge.html', (req, res) => {
  res.send(`
    <html>
      <body style="background: #e6f0ff; display:flex; align-items:center; justify-content:center;">
        <p id="status">⏳ Syncing...</p>
        <script>
          // Tell the parent we are ready
          window.opener.postMessage('bridge_ready', '*');
          
          // Listen for the data
          window.addEventListener('message', (event) => {
             // Validate origin normally here
             if (event.data && event.data.type === 'SYNC_LISTINGS') {
               document.getElementById('status').innerText = '✅ Saved!';
               console.log('RECEIVED DATA:', event.data.data);
               // In real life, we fetch to our API from HERE (this origin is 'self')
               setTimeout(() => window.close(), 1000);
             }
          });
        </script>
      </body>
    </html>
  `);
});

const server = app.listen(3001, () => {
  console.log('Playground running at http://localhost:3001/facebook-sim');
});
