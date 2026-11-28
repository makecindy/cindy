// Integration tier. The deployed listener shares one TLS port between TURN,
// large HTTP transfers and WSS. Plain HTTP relay tests cannot detect dropped
// first bytes, a stuck shutdown, broken upgrades or stale TLS material.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { createServer as createLocalServer } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createTurnIngress } from '../src/turnIngress';

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-turn-'));
  const socket = path.join(dir, 't');
  const backend = createLocalServer(s => s.pipe(s));
  const web = createServer({ headersTimeout: 200, connectionsCheckingInterval: 50 }, async (req, res) => {
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    res.end(String(bytes));
  });
  const ws = new WebSocketServer({ server: web });
  ws.on('connection', client => client.on('message', bytes => client.send(bytes)));
  async function cert(name: string) {
    const key = path.join(dir, name + '.key'), crt = path.join(dir, name + '.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', key, '-out', crt], { stdio: 'ignore' });
    return { key: await readFile(key), cert: await readFile(crt) };
  }
  let ingress: ReturnType<typeof createTurnIngress> | undefined;
  try {
    const initial = await cert('initial'), renewed = await cert('renewed');
    backend.listen(socket); await once(backend, 'listening');
    ingress = createTurnIngress(initial, web, socket);
    ingress.server.listen(0, '127.0.0.1'); await once(ingress.server, 'listening');
    const port = (ingress.server.address() as { port: number }).port;
    const tls = { host: '127.0.0.1', port, servername: 'localhost', ca: initial.cert };
    // Forwarding the socket must also start Node's HTTP header deadline.
    const partial = tlsConnect(tls);
    try {
      await once(partial, 'secureConnect');
      const response = once(partial, 'data', { signal: AbortSignal.timeout(3_000) });
      partial.write('GET / HTTP/1.1\r\n');
      assert.match(String((await response)[0]), /^HTTP\/1\.1 408 /);
    } finally { partial.destroy(); }
    const media = tlsConnect(tls);
    await once(media, 'secureConnect');
    const message = Buffer.alloc(20); message.writeUInt32BE(0x2112a442, 4);
    const echo = once(media, 'data');
    media.write(message);
    assert.deepEqual((await echo)[0], message);
    media.end(); await once(media, 'close');
    await new Promise<void>(resolve => backend.close(() => resolve()));
    // Losing only the media service cannot prevent renewed HTTPS or WSS.
    ingress.server.setSecureContext(renewed);
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { ...tls, ca: renewed.cert });
    await once(client, 'open');
    const pushed = once(client, 'message'); client.send('echo');
    assert.equal((await pushed)[0].toString(), 'echo');
    const body = Buffer.alloc(2 * 1024 * 1024);
    const req = request({ ...tls, ca: renewed.cert, method: 'POST', agent: false });
    const response = once(req, 'response');
    req.end(body);
    const [res] = await response;
    let bytes = '';
    for await (const chunk of res) bytes += chunk;
    assert.equal(bytes, String(body.length));
    const disconnected = once(client, 'close');
    ingress.closeConnections();
    await disconnected;
    console.log('PASS verified TLS, HTTP header deadline, TURN stream, WSS, HTTP 2 MiB, renewal and shutdown');
  } finally {
    ws.close(); backend.close();
    ingress?.closeConnections(); ingress?.server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
