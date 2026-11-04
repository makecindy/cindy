/**
 * Test value: verifyAgentRelayEndpoint must not disclose owner credentials to a copied-info
 * HTTPS endpoint or to a different certificate on the later admin request (#8779 security review).
 * Runtime tests replace this network boundary; this unit file uses real loopback TLS and a
 * test-only trusted CA set, never rejectUnauthorized:false on the public HTTPS request.
 * SSH is an in-memory host; the exact trusted probe script runs in a VM with a fake TLS socket.
 * No external network, subprocess, filesystem, account data or platform-specific executable.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { generate as generateSelfSignedCert } from 'selfsigned';
import { EventEmitter } from 'node:events';
import { createServer, type RequestOptions, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ready: vi.fn(), exec: vi.fn(), publicRequest: vi.fn(), available: true,
  ca: [] as string[], requestStarted: false,
}));
vi.mock('../../remote-ssh/index.js', () => ({
  ensureRemoteHostReady: h.ready,
  getRemoteSshPool: () => ({ get: () => h.available ? { exec: h.exec } : undefined }),
}));
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    h.publicRequest(url, options);
    h.requestStarted = true;
    return actual.request(url, {
      ...options, ca: h.ca, family: 4,
      // Resolve only this test's .invalid name to the ephemeral loopback listener.
      lookup: ((_name, _options, done) => done(null, '127.0.0.1', 4)) as RequestOptions['lookup'],
    }, callback);
  } };
});
import { verifyAgentRelayEndpoint } from '../selfHostedRelayEndpoint';

// Fresh .invalid test identities are generated once per test file, kept only in memory,
// and trusted only by this file's HTTPS wrapper. No key bytes are stored in fixtures.
let tlsA: Awaited<ReturnType<typeof generateSelfSignedCert>>;
let tlsB: Awaited<ReturnType<typeof generateSelfSignedCert>>;

const digest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
let rawA: Buffer;
const received: { path: string; authorization?: string }[] = [];
const sockets = new Set<Socket>();
const copiedInfo = { relayId: 'public-test-relay', ownerPublicKey: 'public-test-key' };
let server: Server;
let port: number;
let status: number;
let body: string;
let holdResponse = false;
let onRequest: (() => void) | undefined;

beforeAll(async () => {
  [tlsA, tlsB] = await Promise.all([0, 1].map(() => generateSelfSignedCert(
    [{ name: 'commonName', value: 'relay.invalid' }], {
      keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyCertSign: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'relay.invalid' }] },
      ],
    },
  )));
  rawA = new X509Certificate(tlsA.cert).raw;
  server = createServer({ cert: tlsA.cert, key: tlsA.private }, (request, response) => {
    received.push({ path: request.url!, authorization: request.headers.authorization });
    onRequest?.();
    if (holdResponse) return;
    response.writeHead(status, { 'content-type': 'application/json', ...(status === 302 ? { location: '/redirected' } : {}) });
    response.end(body);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as { port: number }).port;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.available = true;
  h.ca = [tlsA.cert, tlsB.cert];
  h.requestStarted = false;
  h.ready.mockResolvedValue(undefined);
  h.exec.mockResolvedValue({ exitCode: 0, stdout: `${digest(rawA)}\n`, stderr: '' });
  server.setSecureContext({ cert: tlsA.cert, key: tlsA.private });
  received.length = 0;
  status = 200;
  body = JSON.stringify(copiedInfo);
  holdResponse = false;
  onRequest = undefined;
});
afterEach(() => { vi.useRealTimers(); for (const socket of sockets) socket.destroy(); });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

const input = () => ({
  sshHostId: 'test-ssh', baseUrl: `https://relay.invalid:${port}/custom/prefix/`, tlsPort: 8443,
  nodePath: 'node', assertCurrent: vi.fn(async () => {}),
});

it('uses the SSH-observed certificate, preserves the URL prefix, and sends credentials only after validation', async () => {
  const request = await verifyAgentRelayEndpoint(input());
  expect(await request('info')).toEqual(copiedInfo);
  expect(await request('admin/status', 'invalid-test-credential')).toEqual(copiedInfo);
  expect(received).toEqual([
    { path: '/custom/prefix/api/device-link/relay/info', authorization: undefined },
    { path: '/custom/prefix/api/device-link/relay/admin/status', authorization: 'CindyRelay invalid-test-credential' },
  ]);
  expect(h.publicRequest.mock.calls.every(([, options]) => options.agent === false && options.rejectUnauthorized === true)).toBe(true);
  expect(JSON.stringify(h.exec.mock.calls)).not.toContain('invalid-test-credential');
});

it('does not send HTTP or Authorization to a CA-valid copied-info endpoint with another certificate', async () => {
  server.setSecureContext({ cert: tlsB.cert, key: tlsB.private });
  const request = await verifyAgentRelayEndpoint(input());
  expect(await request('info')).toBeNull();
  expect(await request('admin/status', 'invalid-test-credential')).toBeNull();
  expect(received).toEqual([]);
});

it('revalidates the actual admin TLS handshake after a successful info request instead of reusing a preflight or TLS session', async () => {
  const request = await verifyAgentRelayEndpoint(input());
  expect(await request('info')).toEqual(copiedInfo);
  server.setSecureContext({ cert: tlsB.cert, key: tlsB.private });
  expect(await request('admin/status', 'invalid-test-credential')).toBeNull();
  expect(received).toEqual([{ path: '/custom/prefix/api/device-link/relay/info', authorization: undefined }]);
});

it.each(['untrusted-ca', 'wrong-hostname'])('requires WebPKI in addition to the pin: %s sends no credentials', async reason => {
  const data = input();
  if (reason === 'untrusted-ca') h.ca = [];
  else data.baseUrl = `https://different.invalid:${port}`;
  const request = await verifyAgentRelayEndpoint(data);
  expect(await request('admin/status', 'invalid-test-credential')).toBeNull();
  expect(received).toEqual([]);
});

it.each(['unavailable', 'failed', 'malformed', 'truncated', 'exception'])('does not connect publicly after an invalid SSH probe: %s', async reason => {
  if (reason === 'unavailable') h.available = false;
  else if (reason === 'exception') h.exec.mockRejectedValue(new Error('private remote details'));
  else h.exec.mockResolvedValue({
    exitCode: reason === 'failed' ? 1 : 0,
    stdout: reason === 'malformed' ? 'not a certificate hash' : digest(rawA),
    stderr: 'private remote details', truncated: reason === 'truncated',
  });
  await expect(verifyAgentRelayEndpoint(input())).rejects.toThrow('RELAY_ENDPOINT_VERIFICATION_FAILED');
  expect(h.publicRequest).not.toHaveBeenCalled();
});

it.each(['connect', 'probe', 'handshake'])('does not disclose credentials when authority is revoked during %s', async phase => {
  const data = input();
  let revoked = false;
  data.assertCurrent.mockImplementation(async () => {
    if (revoked || (phase === 'handshake' && h.requestStarted)) throw new Error('revoked');
  });
  if (phase === 'connect') h.ready.mockImplementation(async () => { revoked = true; });
  if (phase === 'probe') h.exec.mockImplementation(async () => {
    revoked = true;
    return { exitCode: 0, stdout: digest(rawA), stderr: '' };
  });
  if (phase === 'handshake') {
    const request = await verifyAgentRelayEndpoint(data);
    await expect(request('admin/status', 'invalid-test-credential')).rejects.toThrow('revoked');
  } else {
    await expect(verifyAgentRelayEndpoint(data)).rejects.toThrow('revoked');
    expect(h.publicRequest).not.toHaveBeenCalled();
  }
  expect(received).toEqual([]);
});

it('checks authority again before returning the authenticated response', async () => {
  const data = input();
  onRequest = () => { data.assertCurrent.mockRejectedValue(new Error('revoked')); };
  const request = await verifyAgentRelayEndpoint(data);
  await expect(request('admin/status', 'invalid-test-credential')).rejects.toThrow('revoked');
});

it('executes only a bounded loopback TLS probe with safely quoted executable and SNI arguments', async () => {
  const data = { ...input(), nodePath: "/opt/node's $(not-a-command)/node" };
  const connect = vi.fn();
  h.exec.mockImplementation(async (command: string, options: { timeoutMs: number; maxOutputBytes: number }) => {
    expect(command.startsWith("'/opt/node'\\''s $(not-a-command)/node' -e '")).toBe(true);
    expect(command.endsWith(" -- '8443' 'relay.invalid'")).toBe(true);
    expect(options).toMatchObject({ timeoutMs: 10_000, maxOutputBytes: 1024 });
    const quoted = command.slice(command.indexOf(' -e ') + 4, command.lastIndexOf(' -- '));
    const script = quoted.slice(1, -1).replace(/'\\''/g, "'");
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), getPeerCertificate: () => ({ raw: rawA }) });
    connect.mockImplementation(() => { queueMicrotask(() => socket.emit('secureConnect')); return socket; });
    let stdout = '';
    const process = { argv: ['node', '8443', 'relay.invalid'], exitCode: undefined as number | undefined,
      stdout: { write: (text: string) => { stdout += text; } } };
    runInNewContext(script, {
      require: (name: string) => name === 'node:tls' ? { connect } : { createHash }, Buffer, process,
      setTimeout: (_callback: () => void, ms: number) => { expect(ms).toBeLessThanOrEqual(10_000); return 1; },
      clearTimeout: vi.fn(),
    });
    await Promise.resolve();
    expect(connect).toHaveBeenCalledExactlyOnceWith({ host: '127.0.0.1', port: 8443, servername: 'relay.invalid', rejectUnauthorized: false });
    return { exitCode: process.exitCode, stdout, stderr: '' };
  });
  await verifyAgentRelayEndpoint(data);
  expect(h.publicRequest).not.toHaveBeenCalled();
});

it.each([
  { tlsPort: 0 }, { tlsPort: 65536 }, { tlsPort: 1.5 }, { sshHostId: '' },
  { nodePath: 'node; unexpected-command' }, { nodePath: '/node\ncommand' },
  { baseUrl: 'http://relay.invalid' }, { baseUrl: 'https://user:password@relay.invalid' },
])('rejects invalid verification input before connecting: %j', async patch => {
  await expect(verifyAgentRelayEndpoint({ ...input(), ...patch })).rejects.toThrow('RELAY_ENDPOINT_VERIFICATION_FAILED');
  expect(h.ready).not.toHaveBeenCalled();
  expect(h.publicRequest).not.toHaveBeenCalled();
});

it.each(['redirect', 'oversized', 'array'])('rejects non-object or unsafe responses without following them: %s', async kind => {
  if (kind === 'redirect') status = 302;
  if (kind === 'oversized') body = JSON.stringify({ data: 'x'.repeat(128 * 1024) });
  if (kind === 'array') body = '[]';
  const request = await verifyAgentRelayEndpoint(input());
  expect(await request('info')).toBeNull();
  expect(h.publicRequest).toHaveBeenCalledTimes(1);
});

it('bounds the full HTTPS request without waiting in real time', async () => {
  const request = await verifyAgentRelayEndpoint(input());
  holdResponse = true;
  const seen = new Promise<void>(resolve => { onRequest = resolve; });
  vi.useFakeTimers();
  const pending = request('info');
  await seen;
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await pending).toBeNull();
});
