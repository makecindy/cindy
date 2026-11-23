// Integration: the login bridge must not report ready without a durable
// runtime receipt. Exercise the actual local transport (synthetic credentials)
// to cover identity rejection, concurrent writes, lost replies and stale sockets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { startAuthRecoveryControl, type AuthRecoveryRequest } from '../auth-recovery.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
function fixture() {
  // Short Unix paths also work with macOS's 104-byte socket limit.
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ar-'));
  fs.chmodSync(directory, 0o700);
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 's');
}
const identity = { deviceId: 'device-test', membershipId: 'member-test' };
const request = (): AuthRecoveryRequest => ({ version: 1, requestId: 'synthetic-request-001',
  ...identity, refreshToken: 'synthetic-private-grant', expiresAtMs: Date.now() + 60_000 });
function send(socket: string, input: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: '/v1/recover', method: 'POST' }, res => {
      let body = ''; res.on('data', data => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.end(JSON.stringify(input));
  });
}

it('isolates identities and joins a durable receipt without repeating the write', async () => {
  const socket = fixture(), input = request();
  let committed = false;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const gate = new Promise<void>(r => { release = r; });
  const recover = vi.fn(async () => { enter(); await gate; committed = true; });
  cleanup.push(await startAuthRecoveryControl({ identity, recover,
    recovered: value => committed && value.requestId === input.requestId && value.refreshToken === input.refreshToken }, socket));
  expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
  expect((await send(socket, { ...input, deviceId: 'other' })).status).toBe(409);
  expect((await send(socket, { ...input, expiresAtMs: 1 })).status).toBe(409);
  expect(recover).not.toHaveBeenCalled();
  const first = send(socket, input); await entered;
  expect((await send(socket, input)).body).toContain('INSTANCE_RECOVERY_BUSY');
  release();
  expect((await first).status).toBe(200);
  const replay = await send(socket, input);
  expect(replay.status).toBe(200);
  expect(replay.body).not.toContain(input.refreshToken);
  expect(recover).toHaveBeenCalledTimes(1);
  await expect(startAuthRecoveryControl({ identity, recover, recovered: () => true }, socket))
    .rejects.toThrow('INSTANCE_RECOVERY_ALREADY_LISTENING');
  expect((await send(socket, input)).status).toBe(200);
});

it('does not expose errors or succeed before publication', async () => {
  const socket = fixture(), input = request();
  const recover = vi.fn().mockRejectedValueOnce(new Error(input.refreshToken)).mockResolvedValue(undefined);
  cleanup.push(await startAuthRecoveryControl({ identity, recover, recovered: () => false }, socket));
  for (let i = 0; i < 2; i++) {
    const result = await send(socket, input);
    expect(result.status).toBe(409); expect(result.body).not.toContain(input.refreshToken);
  }
});

it('reclaims only a dead owned socket after a crash', async () => {
  const socket = fixture();
  const child = spawn(process.execPath, ['-e',
    "require('net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))", socket], { stdio: ['ignore', 'pipe', 'ignore'] });
  cleanup.push(() => { child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject); });
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL'); await exit;
  expect(fs.lstatSync(socket).isSocket()).toBe(true);
  cleanup.push(await startAuthRecoveryControl({ identity, recover: async () => {}, recovered: () => true }, socket));
  expect((await send(socket, request())).status).toBe(200);
});

it('replies with only the receipt fields even when identity is the whole instance config', async () => {
  const socket = fixture(), input = request();
  const config = { ...identity, authProtocol: 'resource-v1', userDataDir: '/fixture/user-data',
    keyringPasswordFile: '/fixture/keyring', statusFile: '/fixture/status.json' };
  cleanup.push(await startAuthRecoveryControl({ identity: config, recover: async () => {}, recovered: () => true }, socket));
  const result = await send(socket, input);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ version: 1, requestId: input.requestId, ...identity, status: 'applied' });
});

it('passes the optional explicit-login access token through and still rejects unknown fields', async () => {
  const socket = fixture(), input = { ...request(), accessToken: 'synthetic-explicit-access' };
  let seen: AuthRecoveryRequest | null = null, done = false;
  const recover = vi.fn(async (value: AuthRecoveryRequest) => { seen = { ...value }; done = true; });
  cleanup.push(await startAuthRecoveryControl({ identity, recover, recovered: () => done }, socket));
  expect((await send(socket, { ...input, unexpected: true })).status).toBe(409);
  const result = await send(socket, input);
  expect(result.status).toBe(200);
  expect(result.body).not.toContain(input.accessToken);
  expect(seen!.accessToken).toBe(input.accessToken);
});
