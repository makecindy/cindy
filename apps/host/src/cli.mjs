#!/usr/bin/env node
import { createServer } from 'node:http';

const PORT = 3456;
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({
      status: 'ok',
      service: 'cindy-host',
      runtime: { state: 'not_initialized' },
    }));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: 'not_found' }));
});

server.on('error', (error) => {
  console.error(`cindy-host failed to listen: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cindy-host listening on http://127.0.0.1:${PORT}`);
});

const shutdown = () => {
  server.close((error) => {
    if (error) {
      console.error(`cindy-host shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
