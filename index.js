// Legacy entry for `node index.js`. Prefer `npm start` (runs `src/server.js` directly).
const { app } = require('./src/server');
const port = Number(process.env.PORT || 3000);

if (require.main === module) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });
}
