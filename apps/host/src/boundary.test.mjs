import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMediaTransfer, AttachmentIntegrityError } from '../../desktop/src/main/device-link/mediaTransfer.js';
import { createDeviceLinkApi } from '../../desktop/src/main/device-link/deviceLinkApi.js';
import { createServerApiClient } from '../../desktop/src/main/serverApiClient.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(mjs|ts)$/.test(entry.name) && !entry.name.endsWith('.test.mjs') ? [full] : [];
  });
}

test('host sources never import Electron', () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1] ?? match[2];
      if (spec === 'electron' || spec.startsWith('electron/')) {
        offenders.push(`${path.relative(srcDir, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `host must not depend on Electron:\n${offenders.join('\n')}`);
});

// Unit: production worktree metadata must be loadable by the Node execution
// host. A normal directory must not receive a managed-worktree lease; journal
// placement must use the exact profile injected by that host, without Electron.
test('shared worktree metadata loads under Node and uses the configured Host profile', async () => {
  const { configureUserDataDir, configureAppDataDir } = await import('../../desktop/src/main/userDataPath.ts');
  const profile = path.join(os.tmpdir(), 'cindy-metadata-profile');
  configureUserDataDir(profile);
  configureAppDataDir(path.join(os.tmpdir(), 'cindy-metadata-app-data'));
  const { recycleJournalRoot } = await import('../../desktop/src/main/worktree/recycleJournal.ts');
  const { acquireWorktreeRuntimeLease } = await import('../../desktop/src/main/worktree/runtimeLeases.ts');
  await import('../../desktop/src/main/worktree/piSubagentReferences.ts');
  assert.equal(recycleJournalRoot(), path.join(profile, 'worktree-recycle'));
  assert.equal(await acquireWorktreeRuntimeLease('fixture-task', path.join(os.tmpdir(), 'cindy-unmanaged-project')), null);
});
// architecture-invariants §5: the shared transfer must run in Node without the
// Electron assembly. Desktop transport mocks cannot catch that load boundary.
// Unit: download bytes through the real factory; a same-size corrupt response
// must preserve the previous file and remove the unpublished partial download.
test('Node media transfer publishes only integrity-checked attachment bytes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-media-transfer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'attachment.txt');
  const bytes = Buffer.from('verified attachment');
  let received = bytes;
  const transfer = createMediaTransfer({
    fetch: async () => new Response(received),
    uploadFetch: async () => { throw new Error('unexpected upload'); },
    deviceLinkApiFetch: async () => ({ getUrl: 'https://media.invalid/fixture' }),
    officialDeviceLinkApiFetch: async () => { throw new Error('unexpected shared-task route'); },
    requireAppCapability: () => {},
  });
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await transfer.downloadToFile('fixture-key', target, expected);
  assert.deepEqual(fs.readFileSync(target), bytes);
  received = Buffer.alloc(bytes.length, 0);
  await assert.rejects(transfer.downloadToFile('fixture-key', target, expected),
    (error) => error instanceof AttachmentIntegrityError && error.reason === 'sha256');
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(fs.readdirSync(dir), ['attachment.txt']);
});

// Unit, self-hosted-relay-plan §5.2/§8 and architecture-invariants §5: the Node
// assembly must preserve credential routing and reject a changed route after
// preparation. Existing Desktop tests mock Electron and cannot load this boundary.
test('Node device API isolates relay credentials and rechecks prepared routes', async () => {
  const requests = [];
  let accountReads = 0;
  let status = 401;
  let relay = { relayId: 'fixture', baseUrl: 'https://relay.invalid', deviceId: 'fixture-device',
    credential: 'test-relay-credential', scopeKey: 'fixture-owner', ownerPublicKey: 'fixture-key' };
  const serverApiFetch = createServerApiClient({
    fetch: async (url, init) => {
      requests.push({ url, authorization: init.headers.Authorization });
      return new Response(JSON.stringify(status === 401 ? { error: 'UNAUTHORIZED' } : { ok: true }), { status });
    },
    auth: {
      getAccessToken: () => { accountReads++; return 'test-account-token'; },
      refresh: async () => { throw new Error('relay must not refresh the account'); },
      invalidateSession: async () => { throw new Error('relay must not sign out the account'); },
    },
    locale: () => 'en',
    log: { debug() {}, warn() {}, error() {} },
  });
  const api = createDeviceLinkApi({
    getClientEndpoint: () => 'https://official.invalid', serverApiFetch,
    activeSelfHostedRelay: () => relay,
    readCurrentDeviceDirectory: async () => { throw new Error('unexpected directory request'); },
    legacyDeviceView: () => { throw new Error('unexpected directory projection'); },
    prepareAgentNetRuntime: async () => { throw new Error('unexpected encrypted mutation'); },
    prepareOwnerScope: async () => { throw new Error('unexpected encrypted mutation'); },
    prepareRelayConfig: async () => { relay = null; return { readRelaySecrets: () => null }; },
  });
  await assert.rejects(api.deviceLinkApiFetch('/api/device-link/media/presign-get'), { statusCode: 401 });
  assert.deepEqual(requests, [{ url: 'https://relay.invalid/api/device-link/media/presign-get', authorization: 'CindyRelay test-relay-credential' }]);
  assert.equal(accountReads, 0);
  status = 200;
  assert.deepEqual(await api.officialDeviceLinkApiFetch('/api/device-link/media/presign-get'), { ok: true });
  assert.deepEqual(requests[1], { url: 'https://official.invalid/api/device-link/media/presign-get', authorization: 'Bearer test-account-token' });
  await assert.rejects(api.deviceLinkApiFetch('/api/device-link/devices/peer', { method: 'DELETE' }), /DEVICE_LINK_SCOPE_CHANGED/);
  assert.equal(requests.length, 2);
});
