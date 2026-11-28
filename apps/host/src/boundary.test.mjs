import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMediaTransfer, AttachmentIntegrityError } from '../../desktop/src/main/device-link/mediaTransfer.js';
import { createDeviceLinkApi } from '../../desktop/src/main/device-link/deviceLinkApi.js';
import { createServerApiClient } from '../../desktop/src/main/serverApiClient.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:[cm]?ts|tsx|jsx?|mjs)$/.test(entry.name) ? [full] : [];
  });
}

// Source Host must never execute the npm entry: even require('electron') via
// an aliased createRequire can synchronously install the missing runtime.
// The .cjs workers, unlike the Node Host, run inside Electron.
test('host sources never import or execute the Electron package entry', () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/['"`]electron(?:\/|['"`])/.test(text)) continue;
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    const resolvesPath = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'resolve';
    function visit(node) {
      // Match literal entry loads regardless of the local name of require.
      // require.resolve only finds the file, and does not execute it.
      const declaration = ts.isImportDeclaration(node) || ts.isExportDeclaration(node);
      let spec;
      if (declaration) spec = node.moduleSpecifier;
      else if (ts.isExternalModuleReference(node)) spec = node.expression;
      else if (ts.isCallExpression(node) && (!ts.isPropertyAccessExpression(node.expression)
          || /^(?:require|_load)$/.test(node.expression.name.text))) {
        spec = node.arguments[0];
        if (spec && resolvesPath(spec)) spec = spec.arguments[0];
      }
      if (spec && ts.isStringLiteralLike(spec) && (/^electron(?:\/(?:index(?:\.js)?)?)?$/.test(spec.text)
          || declaration && spec.text.startsWith('electron/'))) {
        const line = tree.getLineAndCharacterOfPosition(spec.getStart(tree)).line + 1;
        offenders.push(`${path.relative(srcDir, file)}:${line} -> ${spec.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
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
    managementScopeKey: () => 'test-owner',
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
/** Restore owner write and search permission on every directory, then remove the tree. */
const skipDirectoryChmod = process.platform === 'win32' && 'Windows chmod(0) does not deny directory access';

function removeTemporaryTree(root) {
  const makeWritable = (dir) => {
    try { fs.chmodSync(dir, 0o700); } catch { /* removed or not ours */ }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (entry.isDirectory()) makeWritable(path.join(dir, entry.name));
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

async function skillBoundaryProfile(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-skill-boundary-')));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = path.join(root, 'home');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(home);
  fs.mkdirSync(profile);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const appData = path.join(root, 'app-data');
  fs.mkdirSync(appData);
  const { configureUserDataDir, getUserDataDir, configureAppDataDir, getAppDataDir } = await import('../../desktop/src/main/userDataPath.ts');
  let previousProfile = null;
  let previousAppData = null;
  try { previousProfile = getUserDataDir(); } catch { /* not configured yet */ }
  try { previousAppData = getAppDataDir(); } catch { /* not configured yet */ }
  configureUserDataDir(profile);
  configureAppDataDir(appData);
  const boundary = await import('../../desktop/src/main/authBoundaryQuarantine.ts');
  const observer = await import('./agent/skill-projection-boundary.ts');
  t.after(() => {
    boundary.__testing.setStrictLockWaitMs(null);
    if (previousProfile) configureUserDataDir(previousProfile);
    if (previousAppData) configureAppDataDir(previousAppData);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // A case may leave a directory unreadable (the sweep blockers). A throwing after-hook would skip
    // every hook registered after this one (node:test runs them in order), so never throw here.
    try { removeTemporaryTree(root); }
    catch (error) { t.diagnostic(`temporary profile not removed: ${root} (${error?.code ?? error})`); }
  });
  for (const file of [boundary.__testing.filePath(), boundary.__testing.lockPath(), boundary.__testing.sharedSkillRootsLockPath()]) {
    assert.ok(file.startsWith(root + path.sep), `boundary path escapes the temporary profile: ${file}`);
  }
  // As the window does on sign-in; the Host itself never commits (option A).
  const commitOwner = (nextOwnerId, previousOwnerId = null) => boundary.withGhostSkillProjectionOwnerCommit({
    previousOwnerId, nextOwnerId, prepareTransition: async () => {}, commit: () => undefined,
  });
  return { root, home, profile, appData, boundary, observer, commitOwner };
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

/*
 * Release table row 25, step 25b (reviewer decision (a) and its conditions). Production entries:
 * the serve refusal (agent/skill-projection-owner.ts, injected by main.ts; the guard
 * scripts/__tests__/host-skill-projection-owner.test.mjs pins that call), `cindy-host login`
 * (login-cli.mjs runLoginCommand, with fake auth servers on loopback and an in-memory credential
 * store), serve's logout sweep, the shared global Skill preparation and `/api/agent-skills`.
 * Gap: 25a covered only joining; nothing published the owner of a Host's own profile, swept an
 * outgoing owner's Skills, or honoured the desktop's hold. Every case runs under the temporary HOME,
 * profile and app-data of skillBoundaryProfile, which asserts the lock paths are inside them first.
 * Tier: unit (loopback HTTP and the file system only).
 */
function snapshotTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      // Directory mtimes move when a lock record is published and removed; a file keeps its mtime.
      out.push(`${path.relative(dir, full).split(path.sep).join('/')}:${entry.isSymbolicLink() ? 'l' : entry.isDirectory() ? 'd' : 'f'}:${stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : ''}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

/** An owner projection with one Ghost Skill linked from the shared ~/.claude/skills and privately. */
async function plantOwnerSkillLinks(profile, home, ownerId) {
  const { ownerScopedPath } = await import('../../desktop/src/main/dataOwnerPath.ts');
  const { ghostSkillPluginRoot } = await import('../../desktop/src/main/cindy-brain/skillSlot.ts');
  const root = ownerScopedPath(profile, ownerId, 'cindy-brain');
  const source = path.join(root, 'fixture-ghost', 'skills', 'fixture-skill');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: fixture-skill\ndescription: fixture\n---\n');
  const shared = path.join(home, '.claude', 'skills', 'fixture-ghost--fixture-skill');
  const privateDir = path.join(ghostSkillPluginRoot(root), 'skills');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  fs.symlinkSync(source, shared, 'dir');
  fs.symlinkSync(source, path.join(privateDir, 'fixture-ghost--fixture-skill'), 'dir');
  return { shared, privateLink: path.join(privateDir, 'fixture-ghost--fixture-skill') };
}

const linkExists = (file) => { try { fs.lstatSync(file); return true; } catch { return false; } };

test('25b: serve refuses to publish the projection owner and writes no state', async (t) => {
  const { boundary } = await skillBoundaryProfile(t);
  const owner = await import('./agent/skill-projection-owner.ts');
  owner.refuseSkillProjectionOwnerCommit();
  t.after(() => owner.allowSkillProjectionOwnerCommit());
  const prepareTransition = async () => { throw new Error('the teardown must not run'); };
  await assert.rejects(boundary.withGhostSkillProjectionOwnerCommit({ previousOwnerId: null, nextOwnerId: 'owner-a', prepareTransition, commit: () => undefined }),
    /This process cannot publish the Ghost projection owner/);
  assert.equal(fs.existsSync(boundary.__testing.filePath()), false);
  assert.equal(fs.existsSync(boundary.__testing.quarantinePath()), false);
});

async function fakeLoginAuth({ region = 'global', discoveryStatus = 404, social = ['google'] } = {}) {
  const { createServer } = await import('node:http');
  const hits = [];
  let member = 'member-a';
  let kind = 'personal';
  const server = createServer((request, response) => {
    hits.push(request.url);
    const json = (value) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    const membership = { id: member, kind, role: 'owner', displayName: 'Fixture', email: null, orgId: null, orgName: null };
    if (request.url === '/api/auth/providers') return json({ region, attribution: 'email', email: true, phone: false, social });
    if (request.url === '/api/auth/sso/discovery') {
      if (discoveryStatus === 404) {
        return response.writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { code: 'ORG_SSO_NOT_FOUND', message: 'Not found' } }));
      }
      if (discoveryStatus !== 200) return response.writeHead(discoveryStatus).end('{}');
      return json({ region, orgName: 'Fixture Org',
        connections: [{ protocol: 'oidc', connectionId: `sso-${region}`, connectionName: 'SSO' }] });
    }
    if (request.url === '/api/auth/desktop/callback/poll') return json({ status: 'ok', code: 'fixture-code' });
    if (request.url === '/api/auth/token') return json({ status: 'ok', accessToken: 'fixture-access', refreshToken: `fixture-refresh-${member}`, membership });
    if (request.url === '/api/auth/logout') return json({ status: 'ok' });
    return response.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  return { hits, port, close, setMember: (id) => { member = id; }, setKind: (value) => { kind = value; },
    setDiscoveryStatus: value => { discoveryStatus = value; } };
}

async function loginEnvironment(t, root, profile, port) {
  const endpointDir = path.join(root, 'endpoints');
  fs.mkdirSync(endpointDir, { recursive: true });
  for (const [region, file] of [['cn', 'endpoint.json'], ['global', 'endpoint.global.json']]) {
    const base = `https://127.0.0.1:${typeof port === 'number' ? port : port[region]}`;
    fs.writeFileSync(path.join(endpointDir, file), JSON.stringify({
      authApiBaseUrl: base, authDesktopCallbackUrl: `${base}/desktop/callback`,
    }));
  }
  const saved = { CINDY_HOST_DATA_DIR: process.env.CINDY_HOST_DATA_DIR, CINDY_HOST_ENDPOINT_DIR: process.env.CINDY_HOST_ENDPOINT_DIR,
    CINDY_HOST_APP_DATA_DIR: process.env.CINDY_HOST_APP_DATA_DIR };
  process.env.CINDY_HOST_DATA_DIR = profile;
  process.env.CINDY_HOST_ENDPOINT_DIR = endpointDir;
  process.env.CINDY_HOST_APP_DATA_DIR = path.join(root, 'app-data');
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const records = new Map();
  const store = { read: (key) => records.get(key) ?? null, write: (key, value) => records.set(key, value), remove: (key) => records.delete(key) };
  const { runLoginCommand } = await import('./login-cli.mjs');
  const { CindyAuthClient } = await import('@cindy/auth-client');
  const diagnostics = [];
  const login = (deps = {}, stdout = () => {}, argv = [], terminal = {}) => runLoginCommand(['--no-open', ...argv], { stdout, stderr: line => diagnostics.push(line), ...terminal, deps: {
    store, readStatus: async () => ({ running: false }), scanDesktops: async () => [],
    // The manifest must be https (endpoints.mjs); the fake server listens on plain loopback HTTP.
    createAuthClient: (options) => new CindyAuthClient({ ...options, fetch: (input, init) => fetch(String(input).replace(/^https:/, 'http:'), init) }),
    ...deps } });
  return { login, records, diagnostics };
}

/*
 * Cloud status gap 9 / CLI entry: runLoginCommand with a loopback CindyAuthClient,
 * isolated profile and simulated TTY streams. A personal realm advertising two
 * methods must accept an interactive choice, while a pipe must fail before any
 * authorize or credential write and tell scripts which --method to pass.
 * Tier: unit with loopback HTTP, in-memory credentials and no real browser.
 */
test('personal CLI login chooses in a TTY and gives a method code outside one', async (t) => {
  const { root, profile } = await skillBoundaryProfile(t);
  const auth = await fakeLoginAuth({ social: ['apple', 'google'] });
  t.after(auth.close);
  const { login, records } = await loginEnvironment(t, root, profile, auth.port);
  const { reportLoginCommandFailure } = await import('./login-cli.mjs');

  const lines = [];
  const pipedInput = new PassThrough();
  const pipedOutput = new PassThrough();
  pipedInput.isTTY = false;
  pipedOutput.isTTY = false;
  const refusal = await login({}, line => lines.push(line), [], {
    stdin: pipedInput, stdoutStream: pipedOutput,
  }).then(() => null, error => error);
  assert.equal(refusal?.code, 'LOGIN_METHOD_REQUIRED');
  assert.equal(refusal?.exitCode, 2);
  assert.match(lines.join('\n'), /Continue with Apple.*--method=apple/);
  assert.match(lines.join('\n'), /Continue with Google.*--method=google/);
  assert.match(lines.join('\n'), /Complete verification in your browser/);
  const failures = [];
  assert.equal(reportLoginCommandFailure(refusal, line => failures.push(line)), 2);
  assert.match(failures[0], /\[LOGIN_METHOD_REQUIRED\].*--method=<id>/);
  assert.deepEqual(auth.hits.splice(0), ['/api/auth/providers']);
  assert.equal(records.size, 0);

  const ttyInput = new PassThrough();
  const ttyOutput = new PassThrough();
  ttyInput.isTTY = true;
  ttyOutput.isTTY = true;
  let question = '';
  let answered = false;
  ttyOutput.on('data', chunk => {
    question += chunk.toString();
    if (!answered && question.includes('Select a method [1-2]:')) {
      answered = true;
      ttyInput.write('2\n');
    }
  });
  const chosen = await login({}, line => lines.push(line), [], {
    stdin: ttyInput, stdoutStream: ttyOutput,
  });
  assert.equal(chosen.method, 'google');
  assert.match(question, /Select a method \[1-2\]:/);
  assert.ok(records.size > 0, 'only the selected login saves a session');

  const explicit = await login({}, undefined, ['--method=apple'], {
    stdin: pipedInput, stdoutStream: pipedOutput,
  });
  assert.equal(explicit.method, 'apple', 'existing non-interactive --method scripts still work');
});

/*
 * Test value (engineering-conventions §3.2)
 * - Entry: runLoginCommand with real auth-client requests to two loopback servers.
 * - Regression: CLI sent an explicit enterprise identifier to the build region
 *   only. One valid CN discovery plus an unavailable global realm must sign in.
 * - Gap: auth-client tests cover selection in isolation, not the CLI warning and
 *   retry instructions, callback, saved realm, or explicit --region bypass.
 * - Tier: unit with isolated profile, loopback and in-memory credentials.
 */
test('enterprise login uses the discovered realm once and respects an explicit region', async t => {
  const { root, profile } = await skillBoundaryProfile(t);
  const cn = await fakeLoginAuth({ region: 'cn', discoveryStatus: 200 });
  t.after(cn.close);
  const global = await fakeLoginAuth({ discoveryStatus: 503 });
  t.after(global.close);
  cn.setKind('org');
  global.setKind('org');
  const { login, records, diagnostics } = await loginEnvironment(t, root, profile, { cn: cn.port, global: global.port });
  const { AUTH_SESSION_KEY } = await import('../../desktop/src/main/authCredentialKeys.ts');
  const { parseAuthSessionRecord } = await import('@cindy/auth-client');
  const org = '--org=fixture-org';
  const discover = '/api/auth/sso/discovery';
  const signIn = [discover, '/api/auth/desktop/callback/poll', '/api/auth/token'];
  const profileLine = `Profile: ${profile}`;

  await t.test('warns when the other region is unavailable and stays quiet on a confirmed miss', async () => {
    const selected = await login({}, undefined, [org]);
    assert.equal(selected.realm, 'cn');
    assert.equal(selected.method, 'sso-cn');
    assert.deepEqual(cn.hits.splice(0), signIn);
    assert.deepEqual(global.hits.splice(0), [discover]);
    assert.equal(parseAuthSessionRecord(records.get(AUTH_SESSION_KEY)).realm, 'cn');
    assert.deepEqual(diagnostics.splice(0), [
      'Warning: Could not confirm the global auth region. Using cn. If this is not the correct region, rerun with --region=cn or --region=global.',
      profileLine,
    ]);

    global.setDiscoveryStatus(404);
    assert.equal((await login({}, undefined, [org])).realm, 'cn');
    assert.deepEqual(diagnostics.splice(0), [profileLine], 'a confirmed miss does not need a warning');
    assert.deepEqual(cn.hits.splice(0), signIn);
    assert.deepEqual(global.hits.splice(0), [discover]);
  });

  await t.test('explains how to retry a dual hit and respects the explicit region', async () => {
    global.setDiscoveryStatus(200);
    await assert.rejects(login({}, undefined, [org]), {
      code: 'ORG_REALM_AMBIGUOUS',
      statusCode: 409,
      message: 'Enterprise identifier exists in both auth regions. Rerun with --region=cn or --region=global.',
    });
    assert.deepEqual(cn.hits.splice(0), [discover]);
    assert.deepEqual(global.hits.splice(0), [discover]);
    assert.equal(parseAuthSessionRecord(records.get(AUTH_SESSION_KEY)).realm, 'cn', 'ambiguous discovery does not change the saved session');

    const forced = await login({}, undefined, [org, '--region=global']);
    assert.equal(forced.realm, 'global');
    assert.deepEqual(diagnostics, [profileLine], 'an explicit region does not need a warning');
    assert.deepEqual(cn.hits, []);
    assert.deepEqual(global.hits, signIn);
    assert.equal(parseAuthSessionRecord(records.get(AUTH_SESSION_KEY)).realm, 'global');
  });
});

test('25b: cindy-host login publishes the owner that serve then reads as stable, and sweeps the previous account', async (t) => {
  const { root, home, profile, observer, boundary } = await skillBoundaryProfile(t);
  const auth = await fakeLoginAuth();
  try {
    const { login, records } = await loginEnvironment(t, root, profile, auth.port);
    const { AUTH_SESSION_KEY } = await import('../../desktop/src/main/authCredentialKeys.ts');
    const { parseAuthSessionRecord } = await import('@cindy/auth-client');

    await login();
    assert.equal(observer.readSkillProjectionBoundaryStatus('member-a'), 'stable');
    assert.equal(parseAuthSessionRecord(records.get(AUTH_SESSION_KEY))?.refreshToken, 'fixture-refresh-member-a');

    // Switching to B revokes A's shared and private Ghost Skill links before B becomes visible.
    const links = await plantOwnerSkillLinks(profile, home, 'member-a');
    auth.setMember('member-b');
    await login();
    assert.equal(observer.readSkillProjectionBoundaryStatus('member-b'), 'stable');
    assert.equal(linkExists(links.shared), false);
    assert.equal(linkExists(links.privateLink), false);

    // A sweep blocker aborts the switch: B is not published, the boundary stays pending, and B's
    // session is rolled back to the previous record. Fixing it and running login again recovers.
    const again = await plantOwnerSkillLinks(profile, home, 'member-b');
    auth.setMember('member-c');
    await t.test('a failed sweep rolls back the switch', { skip: skipDirectoryChmod }, async () => {
      const sharedDir = path.dirname(again.shared);
      fs.chmodSync(sharedDir, 0o000);
      try {
        await assert.rejects(login(), /cleanup incomplete/);
        assert.equal(boundary.readGhostSkillProjectionBoundaryState()?.phase, 'pending');
        assert.equal(parseAuthSessionRecord(records.get(AUTH_SESSION_KEY))?.refreshToken, 'fixture-refresh-member-b');
      } finally {
        fs.chmodSync(sharedDir, 0o755);
      }
    });
    await login();
    assert.equal(observer.readSkillProjectionBoundaryStatus('member-c'), 'stable');
    assert.equal(linkExists(again.shared), false);
  } finally {
    await auth.close();
  }
});

test('25b: login refuses while a desktop uses the profile, or the scan cannot tell, and commits nothing', async (t) => {
  const { root, profile, boundary } = await skillBoundaryProfile(t);
  const auth = await fakeLoginAuth();
  try {
    const { login, records } = await loginEnvironment(t, root, profile, auth.port);
    await assert.rejects(login({ scanDesktops: async () => [4242] }), /Quit the Cindy desktop app that is using this profile/);
    await assert.rejects(login({ scanDesktops: async () => { throw Object.assign(new Error('EACCES: registry'), { code: 'EACCES' }); } }),
      /Cannot tell whether the Cindy desktop app is using this profile \(EACCES: registry\)/);
    assert.equal(records.size, 0);
    assert.deepEqual(auth.hits, []);
    assert.equal(fs.existsSync(boundary.__testing.filePath()), false);
  } finally {
    await auth.close();
  }
});

test('25b: a running serve admits a first login and the same account, and refuses replacing its account', async (t) => {
  const { root, profile, observer } = await skillBoundaryProfile(t);
  const auth = await fakeLoginAuth();
  try {
    const { login, records } = await loginEnvironment(t, root, profile, auth.port);
    // Serve running without an account runtime: the first login goes through.
    const printed = [];
    await login({ readStatus: async () => ({ running: true, runtime: { state: 'uninitialized', owner: null } }) }, (line) => printed.push(line));
    assert.equal(observer.readSkillProjectionBoundaryStatus('member-a'), 'stable');
    // serve does not adopt the new session while running: the output says a restart is needed, and how.
    assert.ok(printed.some((line) => line.includes('takes effect after Cindy Host restarts')
      && line.includes('systemctl --user restart cindy-host') && line.includes('cindy-host stop')), printed.join('\n'));
    const quiet = [];
    await login({}, (line) => quiet.push(line));
    assert.equal(quiet.some((line) => line.includes('restarts')), false, 'no restart hint when serve is not running');
    // Serve running A: A signs in again.
    await login({ readStatus: async () => ({ running: true, runtime: { state: 'ready', owner: 'member-a' } }) });
    // Serve running A: B is refused after the exchange, its session ended and not saved.
    auth.setMember('member-b');
    const before = records.get([...records.keys()][0]);
    await assert.rejects(login({ readStatus: async () => ({ running: true, runtime: { state: 'ready', owner: 'member-a' } }) }),
      /Cindy Host is running another account/);
    assert.equal(records.get([...records.keys()][0]), before);
    assert.equal(auth.hits.filter((hit) => hit === '/api/auth/logout').length, 1);
    assert.equal(observer.readSkillProjectionBoundaryStatus('member-a'), 'stable');
    // An unresponsive serve is refused before anything else.
    await assert.rejects(login({ readStatus: async () => ({ running: null }) }), /Cindy Host is not responding/);
  } finally {
    await auth.close();
  }
});

test('25b: serve logout sweeps the outgoing owner once, skips while a desktop holds the profile, and never refuses', async (t) => {
  const { root, home, profile, commitOwner, boundary } = await skillBoundaryProfile(t);
  const { sweepOwnerSkillProjectionsAtLogout } = await import('./agent/skill-projection-owner.ts');
  await commitOwner('owner-a');
  const links = await plantOwnerSkillLinks(profile, home, 'owner-a');
  const warnings = [];
  const sweep = (held) => sweepOwnerSkillProjectionsAtLogout({ userDataDir: profile, ownerId: 'owner-a',
    isProfileHeld: () => held, warn: (_message, fields) => warnings.push(fields.outcome) });
  // Held: the shared projections are the running desktop's; not a byte changes.
  await boundary.withSharedSkillRootsLock(async () => {}); // materialize the shared-roots lock directory first
  const before = snapshotTree(root);
  assert.equal(await sweep(true), 'skipped-profile-held');
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(linkExists(links.shared), true);
  // Not held: revoked, and a second sweep (both sides in client mode) finds nothing and does not fail.
  assert.equal(await sweep(false), 'revoked');
  assert.equal(linkExists(links.shared), false);
  assert.equal(linkExists(links.privateLink), false);
  assert.equal(await sweep(false), 'revoked');
  // The window signed out first (stable(null)): serve leaves its transition alone.
  await commitOwner(null, 'owner-a');
  assert.equal(await sweep(false), 'skipped-not-stable');
  assert.deepEqual(warnings, ['skipped-profile-held', 'skipped-not-stable']);
});

test('25b: shared Skill preparation publishes the bundle under the stable owner, writes nothing when held, and without locks writes only the empty ~/.agents/skills root the desktop also creates before taking the lock', async (t) => {
  const { root, appData, commitOwner } = await skillBoundaryProfile(t);
  const { createHostSharedGlobalSkills } = await import('./agent/shared-global-skills.ts');
  const { configureHostOwner } = await import('./agent/claude-auth.mjs');
  const bundle = path.join(srcDir, '../../desktop/resources/system-skills');
  const lockDir = path.join(appData, 'Cindy', 'shared-skill-mutation-locks');
  configureHostOwner({ userDataDir: path.join(root, 'profile'), ownerId: 'owner-a' });
  await commitOwner('owner-a');
  let held = true;
  const skills = () => createHostSharedGlobalSkills({ isProfileHeld: () => held, bundledSystemSkillsRoot: () => bundle });
  const before = snapshotTree(root);
  await skills().ensureSharedGlobalSkills();
  assert.deepEqual(snapshotTree(root), before, 'held: nothing written');
  // The Skill mutation lock directory cannot be created (a file occupies it): this round is skipped.
  held = false;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.writeFileSync(lockDir, 'occupied');
  const { withSharedSkillRootsLock } = await import('../../desktop/src/main/authBoundaryQuarantine.ts');
  await withSharedSkillRootsLock(async () => {}); // the boundary's own lock directory, made once
  const blocked = snapshotTree(root);
  await skills().ensureSharedGlobalSkills();
  // No bundle, no manifest, no link is written. The one addition is the empty ~/.agents/skills root:
  // the desktop's prepareSharedGlobalSkillLinks creates it before it asks for the Skill mutation
  // lease (shared-global-skills.ts), so the Host, running that code, does too (reported, not changed).
  assert.deepEqual(snapshotTree(root).sort(), [...blocked, 'home/.agents:d:', 'home/.agents/skills:d:'].sort(), 'no lock directory: only the empty ~/.agents/skills root, a known behavior shared with the desktop: its prepareSharedGlobalSkillLinks creates this directory before it takes the Skill mutation lock');
  assert.deepEqual(fs.readdirSync(path.join(root, 'home', '.agents', 'skills')), []);
  // With the locks available the bundle this Host carries is published in the shared app-data root.
  fs.rmSync(lockDir);
  await skills().ensureSharedGlobalSkills();
  assert.ok(fs.existsSync(path.join(appData, 'Cindy', 'shared-system-skills', '.cindy-system-skills.json')));
});

test('25b L1: /api/agent-skills drops a Skill the user switched off, and only lists while a desktop holds the profile', async (t) => {
  const { root, appData } = await skillBoundaryProfile(t);
  const { Maker } = await import('@cindy/maker-core');
  const { BaseAgent } = await import('../../../packages/maker-core/src/agents/base-agent.ts');
  const { setCindySkillEnabled } = await import('../../desktop/src/main/skillhub/activationPreferences.ts');
  const { createHostAgentSkillList } = await import('./agent/agent-skills.ts');
  void appData;
  const kept = path.join(root, 'skills', 'kept', 'SKILL.md');
  const off = path.join(root, 'skills', 'off', 'SKILL.md');
  for (const file of [kept, off]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '---\nname: x\n---\n'); }
  await setCindySkillEnabled(off, false);
  const agent = Object.create(BaseAgent.prototype);
  agent.deps = {};
  agent.listAgentSkills = async () => ({ skills: [{ name: 'kept', path: kept }, { name: 'off', path: off }] });
  const maker = { storage: { get: async () => null }, requireAgent: () => agent, getSession: () => undefined, listAgentSkills: Maker.prototype.listAgentSkills };
  let held = false;
  let refreshes = 0;
  const list = createHostAgentSkillList({ maker: () => maker, hasAgent: () => true, readStoredWorkDir: async () => ({ found: false }),
    isProfileHeld: () => held, ensureSharedGlobalSkills: async () => { refreshes += 1; } });
  assert.deepEqual((await list({ agentKind: 'claude-code' })).skills.map((skill) => skill.name), ['kept']);
  assert.equal(refreshes, 1);
  held = true;
  assert.deepEqual((await list({ agentKind: 'pi' })).skills.map((skill) => skill.name), ['kept']);
  assert.equal(refreshes, 1, 'held: listed without refreshing');
  // #12732 + Node Host ACP support: when `acp` is not registered, `/api/agent-skills` must report
  // "not registered" instead of falling back to Claude; when `acp` is registered, it lists ACP's Skills
  // with the same disabled-Skill filtering as built-in engines.
  let acpRegistered = false;
  const acpAgent = Object.create(BaseAgent.prototype);
  acpAgent.deps = {};
  acpAgent.listAgentSkills = async () => ({ skills: [{ name: 'acp-kept', path: kept }, { name: 'acp-off', path: off }] });
  const acpMaker = {
    storage: { get: async () => null },
    requireAgent: (kind) => (kind === 'acp' ? acpAgent : agent),
    getSession: () => undefined,
    listAgentSkills: Maker.prototype.listAgentSkills,
  };
  const acpList = createHostAgentSkillList({
    maker: () => acpMaker,
    hasAgent: (kind) => kind !== 'acp' || acpRegistered,
    readStoredWorkDir: async () => ({ found: false }),
    isProfileHeld: () => held,
    ensureSharedGlobalSkills: async () => { refreshes += 1; },
  });
  assert.deepEqual(await acpList({ agentKind: 'acp' }), { success: false, error: "Agent 'acp' is not registered" });
  acpRegistered = true;
  held = false;
  assert.deepEqual((await acpList({ agentKind: 'acp' })).skills.map((skill) => skill.name), ['acp-kept']);
  assert.equal(refreshes, 2, 'acp refreshes shared global skills when not held');
});

// Review follow-ups (25b): the browser step can take minutes, so the desktop scan and serve's state are
// read again right before the commit; a running serve's account must not be transitioned under it; a
// save that fails ends the issued session. Minimal failures: a desktop appearing after the first scan
// is ignored; serve running A with an unset boundary loses A's links; a failed commit leaves a session.
test('25b: login re-checks right before committing, protects a running serve, and ends a session it could not save', async (t) => {
  const { root, home, profile, boundary } = await skillBoundaryProfile(t);
  const auth = await fakeLoginAuth();
  try {
    const { login, records } = await loginEnvironment(t, root, profile, auth.port);
    // A desktop appears while the browser step runs (the second scan sees it).
    let scans = 0;
    await assert.rejects(login({ scanDesktops: async () => (scans++ === 0 ? [] : [4242]) }), /Quit the Cindy desktop app/);
    assert.equal(records.size, 0);
    assert.equal(fs.existsSync(boundary.__testing.filePath()), false);
    assert.equal(auth.hits.filter((hit) => hit === '/api/auth/logout').length, 1, 'the unsaved session is ended');
    // serve runs A, the boundary is not set yet: A signing in again is refused, A's links stay.
    const links = await plantOwnerSkillLinks(profile, home, 'member-a');
    await assert.rejects(login({ readStatus: async () => ({ running: true, runtime: { state: 'ready', owner: 'member-a' } }) }),
      /Stop Cindy Host \(cindy-host stop\), run cindy-host login again/);
    assert.equal(linkExists(links.shared), true);
    assert.equal(records.size, 0);
    assert.equal(auth.hits.filter((hit) => hit === '/api/auth/logout').length, 2);
  } finally {
    await auth.close();
  }
});

// Review (25b, before the Host commits land): a commit that fails and rolls back must release every
// lock on its way out: the account vault's cross-process lock (with its heartbeat), the boundary's
// strict owner lock and the shared-roots lock. A leaked file lock would not keep the process alive,
// so the case looks for the lock records themselves and then signs in again in the same process.
// Minimal failure: the failure path keeps the vault lock (the next login waits its 5 s and is refused
// as busy) or the strict lock's in-process tail (the next commit never starts).
test('25b: a login whose commit failed releases every lock, and the next login goes straight through', { timeout: 30_000, skip: skipDirectoryChmod }, async (t) => {
  const { root, home, profile, observer, boundary } = await skillBoundaryProfile(t);
  const auth = await fakeLoginAuth();
  try {
    const { login } = await loginEnvironment(t, root, profile, auth.port);
    // Every login is bounded, so a lock that is never released fails this case fast instead of hanging the run.
    const bounded = (promise, label) => {
      let timer;
      return Promise.race([promise, new Promise((_resolve, reject) => {
        // real-wait: a deadline, not a wait; it fires only when a leaked lock blocks the login and is cleared otherwise.
        timer = setTimeout(() => reject(new Error(`${label} is still waiting for a lock after 8 s`)), 8_000);
      })]).finally(() => clearTimeout(timer));
    };
    await bounded(login(), 'the first login');
    const links = await plantOwnerSkillLinks(profile, home, 'member-a');
    const sharedDir = path.dirname(links.shared);
    // Track the intervals the failing login starts (the vault lock's heartbeat); each must be cleared.
    const started = new Set();
    const { setInterval: realSetInterval, clearInterval: realClearInterval } = globalThis;
    globalThis.setInterval = (...args) => { const handle = realSetInterval(...args); started.add(handle); return handle; };
    globalThis.clearInterval = (handle) => { started.delete(handle); return realClearInterval(handle); };
    fs.chmodSync(sharedDir, 0o000);
    try {
      auth.setMember('member-b');
      await assert.rejects(bounded(login(), 'the failing login'), /cleanup incomplete/);
    } finally {
      fs.chmodSync(sharedDir, 0o755);
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
    const leftRunning = started.size;
    for (const handle of started) realClearInterval(handle);
    assert.equal(leftRunning, 0, 'a lock heartbeat was left running after the failed commit');
    for (const lock of [path.join(profile, '.cindy-auth-accounts-v1.lock'), boundary.__testing.lockPath(), boundary.__testing.sharedSkillRootsLockPath()]) {
      assert.equal(linkExists(lock), false, `lock still held after the failed commit: ${path.relative(root, lock)}`);
    }
    const retryStarted = Date.now();
    await bounded(login(), 'the retry');
    assert.ok(Date.now() - retryStarted < 4_000, `the retry waited ${Date.now() - retryStarted} ms for a lock`);
    assert.equal(observer.readSkillProjectionBoundaryStatus('member-b'), 'stable');
    assert.equal(linkExists(links.shared), false);
  } finally {
    await auth.close();
  }
});
