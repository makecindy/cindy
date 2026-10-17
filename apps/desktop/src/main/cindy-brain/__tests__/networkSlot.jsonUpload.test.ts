import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GhostNetworkSlot, type NetworkSlotDeps } from '../networkSlot';
import { DirDepositVault } from '../dirDeposit';
import {
  buildJsonFileUpload,
  prepareJsonFileUpload,
  JSON_FILE_UPLOAD_LIMITS,
} from '../jsonFileUpload';
import type { InstalledGhost } from '../../../shared/ghost';
const TOKEN = '11111111-2222-4333-8444-555555555555';
const upload = () => ({
  token: TOKEN,
  json: '{"message":{"attachments":[{"contentBytes":null}]}}',
  files: [{ path: 'a.bin', target: ['message', 'attachments', 0, 'contentBytes'] }],
});
const request = () => ({
  url: 'https://api.example.test/mail',
  method: 'POST',
  callId: 'live',
  authAccount: 'account-2',
  uploadJson: upload(),
});
function harness(overrides: Partial<NetworkSlotDeps> = {}) {
  const read = vi.fn(async () => new Uint8Array([0, 255, 128, 10]));
  const takeDirDeposit = vi.fn(() => ({
    files: [{ relPath: 'a.bin', size: 4, read }],
    totalBytes: 4,
  }));
  const fetchImpl = vi.fn(
    async (_url: string, _init: Parameters<NetworkSlotDeps['fetchImpl']>[1]) =>
      new Response(null, { status: 202 }),
  );
  const getFreshAccessToken = vi.fn(async () => ({
    ok: true as const,
    accessToken: 'test-token',
    accountId: 'account-2',
  }));
  const invalidateAccessToken = vi.fn();
  const ghost = {
    enabled: true,
    dir: '/fake/brain/g',
    manifest: {
      schemaVersion: 3,
      id: 'g',
      name: 'test',
      version: '1.0.0',
      entry: 'main.js',
      tools: [],
      network: {
        hosts: ['api.example.test'],
        secrets: [
          {
            key: 'mail',
            source: 'oauth',
            label: 'mail',
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['api.example.test'],
            },
            oauth: {
              authorizeUrl: 'https://login.example.test',
              tokenUrl: 'https://login.example.test/token',
              scopes: ['mail'],
            },
          },
        ],
      },
    },
  } as unknown as InstalledGhost;
  const deps: NetworkSlotDeps = {
    getGhost: () => ghost,
    readSecret: () => null,
    getLoginEmail: () => null,
    fetchImpl,
    fetchPublicImpl: async () => ({ response: new Response('{}'), release: async () => {} }),
    readGhostMedia: async () => null,
    saveGhostMedia: async () => ({ url: '', hash: '', ext: '' }),
    isSupportedMediaMime: () => false,
    takeDirDeposit,
    writeSaveDeposit: async () => null,
    inFlightCallInfo: (id) =>
      id === 'live'
        ? { ghostId: 'g', sessionId: 's', remoteHostId: null, channel: 'session' }
        : null,
    oauthTokens: { getFreshAccessToken, invalidateAccessToken },
    ...overrides,
  };
  return {
    slot: new GhostNetworkSlot(deps),
    read,
    takeDirDeposit,
    fetchImpl,
    getFreshAccessToken,
    invalidateAccessToken,
  };
}
describe('authorized JSON file upload', () => {
  it('probes capabilities without network, credentials or tickets', async () => {
    const h = harness();
    expect(await h.slot.handleFetchRequest('g', { op: 'capabilities' })).toEqual({
      ok: true,
      capabilities: { version: 1, uploadJson: JSON_FILE_UPLOAD_LIMITS },
    });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.takeDirDeposit).not.toHaveBeenCalled();
    expect(h.getFreshAccessToken).not.toHaveBeenCalled();
    expect(
      (await h.slot.handleFetchRequest('g', { op: 'capabilities', url: 'https://example.test' }))
        .ok,
    ).toBe(false);
  });
  it('assembles exact binary internally, keeps selected OAuth account, returns no bytes', async () => {
    const h = harness();
    const r = await h.slot.handleFetchRequest('g', request());
    expect(r).toMatchObject({ ok: true, status: 202 });
    expect(h.takeDirDeposit).toHaveBeenCalledWith('g', TOKEN);
    expect(h.read).toHaveBeenCalledWith(2 * 1024 * 1024);
    const init = h.fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init.body)).message.attachments[0].contentBytes).toBe('AP+ACg==');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    });
    expect(JSON.stringify(h.getFreshAccessToken.mock.calls)).toContain('account-2');
    expect(JSON.stringify(r)).not.toMatch(/AP\+ACg|test-token/);
  });
  it.each([301, 302, 307, 308, 401, 503])(
    'does not redirect or replay side effects for HTTP %i',
    async (status) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response('{}', { status, headers: { location: 'https://api.example.test/other' } }),
      );
      const h = harness({ fetchImpl });
      expect(await h.slot.handleFetchRequest('g', request())).toMatchObject({ ok: true, status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(h.invalidateAccessToken).not.toHaveBeenCalled();
    },
  );
  it('transport loss after dispatch is unknown; invalid ticket is not executed', async () => {
    const h = harness({
      fetchImpl: async () => {
        throw new Error('private detail');
      },
    });
    expect(await h.slot.handleFetchRequest('g', request())).toMatchObject({
      ok: false,
      executionStatus: 'unknown',
    });
    const h2 = harness({ takeDirDeposit: () => null });
    expect(await h2.slot.handleFetchRequest('g', request())).toMatchObject({
      ok: false,
      executionStatus: 'not_executed',
    });
    expect(h2.fetchImpl).not.toHaveBeenCalled();
  });
  it('requires current local authorization; canceled reads never send', async () => {
    for (const info of [
      null,
      { ghostId: 'other', sessionId: 's', remoteHostId: null, channel: 'session' as const },
      { ghostId: 'g', sessionId: 's', remoteHostId: 'remote', channel: 'session' as const },
    ]) {
      const h = harness({ inFlightCallInfo: () => info });
      expect((await h.slot.handleFetchRequest('g', request())).ok).toBe(false);
      expect(h.read).not.toHaveBeenCalled();
      expect(h.fetchImpl).not.toHaveBeenCalled();
    }
    let live = true;
    const h = harness({
      inFlightCallInfo: () =>
        live ? { ghostId: 'g', sessionId: 's', remoteHostId: null, channel: 'session' } : null,
      takeDirDeposit: () => ({
        files: [
          {
            relPath: 'a.bin',
            size: 4,
            read: async () => {
              live = false;
              return new Uint8Array(4);
            },
          },
        ],
        totalBytes: 4,
      }),
    });
    expect(await h.slot.handleFetchRequest('g', request())).toMatchObject({
      ok: false,
      executionStatus: 'not_executed',
    });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects mixed bodies, unsafe targets, unknown files, oversized and changed files before network', async () => {
    for (const patch of [
      { body: '{}' },
      { uploadDir: { token: TOKEN } },
      { method: 'PUT' },
      { as: 'file' },
      { uploadJson: { ...upload(), files: [{ path: '../a', target: ['message'] }] } },
    ]) {
      const h = harness();
      expect((await h.slot.handleFetchRequest('g', { ...request(), ...patch })).ok).toBe(false);
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(h.read).not.toHaveBeenCalled();
    }
    for (const [size, bytes] of [
      [2097153, 4],
      [5, 4],
      [3, 4],
    ]) {
      const read = vi.fn(async () => new Uint8Array(bytes));
      const h = harness({
        takeDirDeposit: () => ({ totalBytes: size, files: [{ relPath: 'a.bin', size, read }] }),
      });
      expect(await h.slot.handleFetchRequest('g', request())).toMatchObject({
        ok: false,
        executionStatus: 'not_executed',
      });
      expect(h.fetchImpl).not.toHaveBeenCalled();
      if (size > 2097152) expect(read).not.toHaveBeenCalled();
    }
    const h = harness({ takeDirDeposit: () => ({ totalBytes: 0, files: [] }) });
    expect((await h.slot.handleFetchRequest('g', request())).ok).toBe(false);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
it('real ticket binary roundtrip, replay isolation, bounded read and symlink replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'json-upload-'));
  dirs.push(root);
  const file = path.join(root, 'a.bin');
  await fs.writeFile(file, Buffer.from([0, 255, 128, 10]));
  const vault = new DirDepositVault();
  const ticket = () => {
    const r = vault.deposit({ ghostId: 'g', dirAbs: root, workdirAbs: root });
    if (!r.ok) throw new Error(r.message);
    return r.receipt.token;
  };
  const token = ticket();
  expect(vault.take('other', token)).toBeNull();
  const prepared = prepareJsonFileUpload({ ...upload(), token })!;
  const body = await buildJsonFileUpload(prepared, vault.take('g', token), () => {});
  expect(Buffer.from(JSON.parse(body).message.attachments[0].contentBytes, 'base64')).toEqual(
    Buffer.from([0, 255, 128, 10]),
  );
  expect(vault.take('g', token)).toBeNull();
  const bounded = vault.take('g', ticket())!;
  await expect(bounded.files[0].read(3)).rejects.toThrow();
  const switched = vault.take('g', ticket())!;
  const moved = root + '-moved',
    replacement = root + '-replacement';
  dirs.push(moved, replacement);
  await fs.rename(root, moved);
  await fs.mkdir(replacement);
  await fs.writeFile(path.join(replacement, 'a.bin'), 'replacement');
  // Directory junctions exercise the same boundary on Windows without admin privileges.
  await fs.symlink(replacement, root, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(switched.files[0].read(100)).rejects.toThrow();
});
it('JSON placeholders reject prototype keys, duplicate destinations, invalid template and non-null values', () => {
  for (const json of ['null', '[]', '{"message":5}', '{"__proto__":null}'])
    expect(prepareJsonFileUpload({ ...upload(), json })).toBeNull();
  for (const target of [
    ['__proto__'],
    ['constructor'],
    ['message', 'attachments', '0', 'contentBytes'],
    ['message', 'attachments', 0, 'missing'],
  ])
    expect(prepareJsonFileUpload({ ...upload(), files: [{ path: 'a.bin', target }] })).toBeNull();
  expect(
    prepareJsonFileUpload({ ...upload(), files: [...upload().files, ...upload().files] }),
  ).toBeNull();
});
