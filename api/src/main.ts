import { buildServer } from './server.js';

// Fail closed: refuse to start without an explicit PORT (handover §4.13).
const port = Number(process.env['PORT']);
if (!Number.isInteger(port) || port <= 0) {
  console.error('PORT is not set or invalid; refusing to start.');
  process.exit(1);
}

const app = buildServer();
await app.listen({ port, host: '0.0.0.0' });
