require('dotenv').config({ quiet: true });
const http = require('node:http');
const { createApp } = require('./app');
const { attachRealtime } = require('./realtime');

const port = Number(process.env.PORT || 3000);
const app = createApp();
const server = http.createServer(app);
const io = attachRealtime(server, app);

server.listen(port, () => {
  console.log(`Emoji Classroom Checker running at http://localhost:${port}`);
  console.log(`API documentation: http://localhost:${port}/api/docs`);
});

function shutdown() {
  io.close();
  server.close(() => {
    app.locals.db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
