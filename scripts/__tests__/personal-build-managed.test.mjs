import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseManifest, queueRequest, runtimeEnv, toolBundle } from '../personal-build/managed.mjs';
import { checkCheckout } from '../personal-build/checkout-guard.mjs';
import { run } from '../personal-build.mjs';
import { personalLaunchCommand } from '../personal-build/automatic.mjs';

// Script integration tier. Legacy update errors could overwrite work or roll old code onto a
// partially migrated database. Exercise the actual shell engine in disposable Git worktrees;
// pnpm checks are substituted, SQLite and Git are real. No application or user DB is touched.
// Existing portable composition tests do not exercise this lifecycle. Standalone budget <5s.
const here = path.dirname(fileURLToPath(import.meta.url));
const temp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-managed-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

test('supervised terminal forwards the same credential certificate as the legacy resolver', { skip: process.platform !== 'darwin' }, t => {
  const root = temp(t), bin = path.join(root, 'bin'), data = path.join(root, 'profile');
  fs.mkdirSync(bin); fs.mkdirSync(data);
  // Apple names signing identities by the SHA-1 fingerprint of the certificate; this is the fingerprint of
  // the stubbed fixture bytes below (printf "fixture certificate, not a real credential" | shasum -a 1).
  const previous = '39D80FB7DBAD88F2C9CAD8CD560F6C31611D8F04', other = 'B'.repeat(40);
  const stub = (name, body) => { put(path.join(bin, name), '#!/bin/sh\n' + body); fs.chmodSync(path.join(bin, name), 0o755); };
  stub('security', `printf '%s\\n' '  1) ${previous} "Apple Development: Fixture"' '  2) ${other} "Apple Development: Other"'`);
  stub('zsh', 'printf "%s\\n" "$TEST_SHELL_IDENTITY"');
  stub('codesign', 'for arg do case "$arg" in --extract-certificates=*) prefix=${arg#*=};; esac; done\nprintf "%s" "fixture certificate, not a real credential" > "${prefix}0"');
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ZDOTDIR: root,
    PERSONAL_DATA_DIR: data, PERSONAL_STATE_DIR: root,
    PERSONAL_TOOLS_DIR: path.resolve(here, '../personal-build') };
  const start = extra => {
    const r = spawnSync('/bin/zsh', ['-f', '-c', personalLaunchCommand, 'personal-build',
      '/bin/sh', '-c', 'printf "CHILD_IDENTITY=%s\\n" "$CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY"'],
      { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return /CHILD_IDENTITY=(.*)/.exec(r.stdout)?.[1];
  };
  assert.equal(start({ CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY: other }), other);
  assert.equal(start({ TEST_SHELL_IDENTITY: previous }), previous);
  // Multiple identities must not pick an arbitrary certificate.
  assert.equal(start({}), '');
  put(path.join(data, 'remote-desktop/native-credentials/old/cindy-macos-remote-credentials'), 'fixture');
  assert.equal(start({}), previous);
});

test('legacy manifests stay data, unsafe paths fail, and pending requests cannot be overwritten', t => {
  const root = temp(t), target = 'a'.repeat(40);
  assert.equal(parseManifest(`TARGET=${target}\nLABEL="a $(command) label"\nPACK=""`).LABEL, 'a $(command) label');
  assert.throws(() => parseManifest(`TARGET=${target}\nPACK=../escape`), /Unsafe/);
  assert.throws(() => parseManifest(`TARGET=${target}\nsource evil`), /Invalid/);
  assert.throws(() => parseManifest(JSON.stringify({ TARGET: target, FORCE_RESTART: '1' })), /forced restart/);
  queueRequest(root, 'stage'); assert.throws(() => queueRequest(root, 'restart'), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(root, 'request'), 'utf8'), 'stage\n');
});

test('deployed bundle is self-contained and paths with spaces survive dispatch', t => {
  const root = temp(t), bundle = path.join(root, 'tool bundle'); toolBundle(bundle);
  const help = run(process.execPath, [path.join(bundle, 'personal-build.mjs'), 'help'], root);
  assert.match(help, /sync-plugins/);
  const c = { name: 'fixture', region: 'global', app: { checkout: root, repository: 'example/app' }, runtime: { clientDir: path.join(root, 'app [test]'), stagingDir: 'stage', stateDir: 'state', dataDir: 'data', node: process.execPath, mode: 'shared', toolPaths: [], idleMinutes: 120 } };
  const env = runtimeEnv(c, path.join(root, 'config file.json'));
  assert.equal(env.PERSONAL_CONFIG, path.join(root, 'config file.json'));
  assert.ok(new RegExp(env.PERSONAL_ELECTRON_RE).test(path.join(c.runtime.clientDir, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')));
});

// Legacy gates identify the app by process name; a native build runs from the shared runtime cache.
// Minimal input: one checkout with a native receipt plus another checkout using the same runtime.
test('legacy process identity covers a native build\'s shared runtime for its own checkout only', { skip: process.platform !== 'darwin' && 'macOS-only native runtime' }, t => {
  const root = temp(t), client = path.join(root, 'client'), runtime = path.join(root, 'runtime');
  put(path.join(client, 'apps/desktop/resources/personal-native.json'), JSON.stringify({ state: 'built', runtime: { directory: runtime } }));
  const c = { name: 'fixture', region: 'global', app: { checkout: root, repository: 'example/app' }, runtime: { clientDir: client, stagingDir: 'stage', stateDir: 'state', dataDir: 'data', node: process.execPath, mode: 'shared', toolPaths: [], idleMinutes: 120 } };
  const re = new RegExp(runtimeEnv(c, path.join(root, 'config.json')).PERSONAL_ELECTRON_RE), exe = path.join(runtime, 'Cindy.app/Contents/MacOS/Electron');
  assert.ok(re.test(`${exe} ${client}/apps/desktop`));
  assert.equal(re.test(`${exe} ${path.join(root, 'other')}/apps/desktop`), false);
  assert.equal(re.test(`${exe}-helper ${client}/apps/desktop`), false);
});

const shellAvailable = spawnSync('zsh', ['--version']).status === 0 && spawnSync('sqlite3', ['--version']).status === 0;
test('real engine stages, preserves edits, switches, rolls back and blocks partial database recovery', { skip: !shellAvailable }, t => {
  const root = temp(t), source = path.join(root, 'source'), client = path.join(root, 'client'), state = path.join(root, 'state'), data = path.join(root, 'data'), bin = path.join(root, 'bin');
  for (const p of [source, state, data, bin]) fs.mkdirSync(p);
  const git = (...a) => run('git', a, source);
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  put(path.join(source, 'file'), 'old');
  put(path.join(source, 'pnpm-lock.yaml'), 'fixture');
  put(path.join(source, 'scripts/dev-migration-policy.mjs'), 'export function assertSharedDevMigrationPolicy() {}');
  put(path.join(source, 'scripts/design-inventory.mjs'), '');
  put(path.join(source, 'apps/desktop/drizzle/meta/_journal.json'), JSON.stringify({ entries: [{ idx: 0, tag: 'zero' }] }));
  git('add', '.'); git('commit', '-m', 'base'); const previous = git('rev-parse', 'HEAD');
  put(path.join(source, 'file'), 'new'); git('commit', '-am', 'target'); const target = git('rev-parse', 'HEAD');
  git('worktree', 'add', '--detach', client, previous);
  put(path.join(bin, 'pnpm'), '#!/bin/sh\n[ "${CHECK_FAIL:-}" != 1 ]\n'); fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
  const tools = path.resolve(here, '../personal-build');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PERSONAL_STATE_DIR: state, PERSONAL_SOURCE_DIR: source, PERSONAL_CLIENT_DIR: client, PERSONAL_STAGING_DIR: path.join(root, 'stage'), PERSONAL_DATA_DIR: data, PERSONAL_PREVIOUS_REF: 'personal-build/fixture/previous', PERSONAL_TARGET: target, PERSONAL_MODE: 'shared', PERSONAL_TOOLS_DIR: tools };
  const engine = (mode, extra = {}) => spawnSync('zsh', [path.join(tools, 'mac-engine.zsh'), mode], { env: { ...env, ...extra }, encoding: 'utf8' });
  let result = engine('stage'); assert.equal(result.status, 0, result.stdout + result.stderr);
  put(path.join(root, 'stage/file'), 'staging edit'); assert.notEqual(engine('stage').status, 0); assert.equal(fs.readFileSync(path.join(root, 'stage/file'), 'utf8'), 'staging edit');
  put(path.join(client, 'file'), 'my edit'); assert.throws(() => checkCheckout(client), /Uncommitted/);
  assert.notEqual(engine('apply').status, 0); assert.equal(fs.readFileSync(path.join(client, 'file'), 'utf8'), 'my edit');
  put(path.join(client, 'file'), 'old');
  result = engine('apply', { CHECK_FAIL: '1' }); assert.notEqual(result.status, 0); assert.equal(run('git', ['rev-parse', 'HEAD'], client), previous);
  result = engine('apply'); assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(run('git', ['rev-parse', 'HEAD'], client), target);
  result = engine('rollback'); assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(run('git', ['rev-parse', 'HEAD'], client), previous);
  // Real SQLite mismatch blocks a switch; an explicit failing migration must retain target code.
  run('sqlite3', [path.join(data, 'cindy-fixture.db'), 'CREATE TABLE migration_history(seq INT,file_name TEXT); INSERT INTO migration_history VALUES(0,"wrong.sql");'], root);
  assert.notEqual(engine('apply').status, 0); assert.equal(run('git', ['rev-parse', 'HEAD'], client), previous);
  put(path.join(state, 'migration.zsh'), '#!/bin/zsh\nexit 1\n');
  result = engine('apply', { PERSONAL_DB_SCRIPT: 'migration.zsh' }); assert.notEqual(result.status, 0); assert.equal(run('git', ['rev-parse', 'HEAD'], client), target);
  assert.ok(fs.existsSync(path.join(state, '.database-transition')));
  assert.notEqual(engine('rollback').status, 0); assert.notEqual(engine('apply').status, 0);
  assert.equal(run('git', ['rev-parse', 'HEAD'], client), target);
});
