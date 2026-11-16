import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/*
 * Skill projection owner boundary in the Node Host (release table row 25, step 25a).
 * Production entry: the desktop's authBoundaryQuarantine.ts loaded by the Host, and the Host's
 * read-only observer agent/skill-projection-boundary.ts that main.ts calls after configureHostOwner
 * and on every authorized /health (runtime.skillProjectionBoundary).
 * Rule: option A (reviewer, 2026-11-17): the window commits the owner, the Host joins only an exact
 * stable owner; the status reports a category and never an owner id; mutations fail closed.
 * Gap: the desktop's unit test mocks Electron, the lock and the logger, and cannot see whether the
 * module loads under Node, which profile it resolves, or that the Host defaults to "not passive".
 * Minimal failure: before 25a the import itself throws (electron has no `app` export under Node).
 * Tier: unit. One real child process holds the lock; the wait is shortened through `__testing`.
 * Every case runs under a temporary HOME and profile, and checks the lock paths are inside them
 * before touching anything, so ~/.agents/skills, ~/.claude/skills and ~/.cindy are never reached.
 */
async function skillBoundaryProfile(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-skill-boundary-')));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = path.join(root, 'home');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(home);
  fs.mkdirSync(profile);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { configureUserDataDir, getUserDataDir } = await import('../../desktop/src/main/userDataPath.ts');
  let previousProfile = null;
  try { previousProfile = getUserDataDir(); } catch { /* not configured yet */ }
  configureUserDataDir(profile);
  const boundary = await import('../../desktop/src/main/authBoundaryQuarantine.ts');
  const observer = await import('./agent/skill-projection-boundary.ts');
  t.after(() => {
    boundary.__testing.setStrictLockWaitMs(null);
    if (previousProfile) configureUserDataDir(previousProfile);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const file of [boundary.__testing.filePath(), boundary.__testing.lockPath(), boundary.__testing.sharedSkillRootsLockPath()]) {
    assert.ok(file.startsWith(root + path.sep), `boundary path escapes the temporary profile: ${file}`);
  }
  // As the window does on sign-in; the Host itself never commits (option A).
  const commitOwner = (nextOwnerId, previousOwnerId = null) => boundary.withGhostSkillProjectionOwnerCommit({
    previousOwnerId, nextOwnerId, prepareTransition: async () => {}, commit: () => undefined,
  });
  return { profile, boundary, observer, commitOwner };
}

test('skill projection boundary loads in the Host, uses its profile and joins the stable owner', async (t) => {
  const { profile, boundary, observer, commitOwner } = await skillBoundaryProfile(t);
  assert.equal(boundary.__testing.filePath(), path.join(profile, 'ghost-skill-projection-boundary.json'));
  // Not passive by default: a passive instance could not publish an owner at all.
  await commitOwner('owner-a');
  const warnings = [];
  const observe = observer.createSkillProjectionBoundaryObserver({ warn: (message, fields) => warnings.push({ message, fields }) });
  assert.equal(observe('owner-a'), 'stable');
  assert.equal(await boundary.withSharedGlobalSkillProjectionMutation('owner-a', async () => 'projected'), 'projected');
  assert.deepEqual(warnings, []);
});

test('skill projection boundary reports each unstable category without owner ids and refuses the mutation', async (t) => {
  const { boundary, observer, commitOwner } = await skillBoundaryProfile(t);
  const stateFile = boundary.__testing.filePath();
  const quarantineFile = boundary.__testing.quarantinePath();
  const record = (fields) => JSON.stringify({ version: 1, transitionId: 'fixture-transition', updatedAt: 1, ...fields });
  const cases = [
    { name: 'other owner', status: 'other-owner', error: /not stable for the active owner/,
      arrange: () => commitOwner('owner-b') },
    { name: 'pending', status: 'pending', error: /not stable for the active owner/,
      arrange: () => fs.writeFileSync(stateFile, record({ phase: 'pending', previousOwnerId: 'owner-b', nextOwnerId: 'owner-a' })) },
    { name: 'durably quarantined', status: 'quarantined', error: /quarantined after an uncertain owner commit/,
      arrange: async () => {
        await commitOwner('owner-a');
        fs.writeFileSync(quarantineFile, record({ phase: 'quarantined', previousOwnerId: 'owner-b', nextOwnerId: 'owner-a' }));
      } },
    { name: 'missing', status: 'missing-or-invalid', error: /not stable for the active owner/, arrange: () => {} },
    { name: 'malformed', status: 'missing-or-invalid', error: /not stable for the active owner/,
      arrange: () => fs.writeFileSync(stateFile, '{"version":1,"phase":"stable"') },
  ];
  for (const entry of cases) {
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(quarantineFile, { force: true });
    await entry.arrange();
    const warnings = [];
    const observe = observer.createSkillProjectionBoundaryObserver({ warn: (message, fields) => warnings.push({ message, fields }) });
    assert.equal(observe('owner-a'), entry.status, entry.name);
    observe('owner-a');
    assert.deepEqual(warnings, [{ message: 'skill projection boundary is not stable for this Host owner', fields: { boundary: entry.status } }], entry.name);
    assert.doesNotMatch(JSON.stringify(warnings), /owner-[ab]|profile/, entry.name);
    let ran = false;
    await assert.rejects(boundary.withSharedGlobalSkillProjectionMutation('owner-a', async () => { ran = true; }), entry.error, entry.name);
    assert.equal(ran, false, entry.name);
  }
});

test('skill projection boundary fails closed while another process holds the owner lock', async (t) => {
  const { boundary, commitOwner } = await skillBoundaryProfile(t);
  await commitOwner('owner-a');
  boundary.__testing.setStrictLockWaitMs(20);
  const lockModule = pathToFileURL(path.join(srcDir, '../../desktop/src/main/device-link/crossProcessLock.ts')).href;
  // The Host's own loaders (package.json "test"), so the desktop module resolves as in the Host.
  const holder = spawn(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs', '--input-type=module', '-e', `
    const { withSecurityBoundaryLock } = await import(${JSON.stringify(lockModule)});
    await withSecurityBoundaryLock(process.argv[1], { label: 'host-test-holder', waitMs: 0 }, async (status) => {
      process.stdout.write(status.held ? 'HELD\\n' : 'NOT-HELD\\n');
      await new Promise((resolve) => process.stdin.once('end', resolve).resume());
    });
  `, boundary.__testing.lockPath()], { cwd: path.join(srcDir, '..'), stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  t.after(() => { if (holder.exitCode === null) process.kill(holder.pid); });
  const first = await new Promise((resolve, reject) => {
    holder.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
    holder.once('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  assert.equal(first, 'HELD');
  let ran = false;
  await assert.rejects(boundary.withSharedGlobalSkillProjectionMutation('owner-a', async () => { ran = true; }), /boundary lock is busy or unavailable/);
  assert.equal(ran, false);
  holder.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(await boundary.withSharedGlobalSkillProjectionMutation('owner-a', async () => 'after release'), 'after release');
});
