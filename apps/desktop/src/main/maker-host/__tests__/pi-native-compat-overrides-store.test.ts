import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PI_CACHE_RECOVERY_SOURCE } from '../../../../../../packages/maker-core/src/agents/pi/cache-recovery-source.js';
import { withCrossProcessLock } from '../../device-link/crossProcessLock.js';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const root = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({ app: { getPath: () => root.path } }));
vi.mock('../logger-adapter.js', () => ({ desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } }));
import { readPiNativeCompatOverride as read, recordPiNativeCompatOverride as record } from '../pi-native-compat-overrides-store.js';
let file: string;
const fixtureDirs: string[] = [];
const a = 'a'.repeat(64), b = 'b'.repeat(64);
const fix = { supportsLongCacheRetention: false };
afterAll(() => {
  for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  // Each case needs its own lock path: a killed child can leave an advisory
  // record that Windows cannot reclaim within the next case's wait budget.
  root.path = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-compat-'));
  fixtureDirs.push(root.path);
  file = path.join(root.path, 'pi-native-compat-overrides.json');
});
describe('learned cache compatibility', () => {
  it('expires untimed legacy learning from stable file time and preserves its deadline across writes', async () => {
    const writtenAt = Date.now() - 86400000;
    const key = JSON.stringify(['a', 'model', a]);
    fs.writeFileSync(file, JSON.stringify({ routes: { [key]: fix } }));
    fs.utimesSync(file, writtenAt / 1000, writtenAt / 1000);
    const learnedAt = fs.statSync(file).mtimeMs;
    expect(read('a', 'model', a)).toEqual(fix);
    await record('b', 'other', fix, b);
    const migrated = JSON.parse(fs.readFileSync(file, 'utf8')).routes[key];
    expect(migrated).toMatchObject({ evidence: 'explicit', learnedAt, expiresAt: learnedAt + 7 * 86400000 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(learnedAt + 7 * 86400000 + 1);
    try { expect(read('a', 'model', a)).toBeUndefined(); } finally { clock.mockRestore(); }
  });
  it('persists only the permitted fix and isolates connection, wire model and route', async () => {
    expect(await record('a', 'model', { ...fix, supportsStore: true }, a)).toBe(true);
    expect(read('a', 'model', a)).toEqual(fix);
    expect(read('b', 'model', a)).toBeUndefined();
    expect(read('a', 'other', a)).toBeUndefined();
    expect(read('a', 'model', b)).toBeUndefined();
    expect(read('a', 'model')).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('supportsStore');
  });
  it('preserves native trial expiry metadata when another route is recorded', async () => {
    const learnedAt = Date.now();
    const timed = { ...fix, learnedAt, expiresAt: learnedAt + 86400000, evidence: 'opaque' };
    const key = JSON.stringify(['a', 'model', a]);
    fs.writeFileSync(file, JSON.stringify({ routes: { [key]: timed } }));
    await record('b', 'other', fix, b);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).routes[key]).toEqual(timed);
    fs.writeFileSync(file, JSON.stringify({ routes: { [key]: { ...timed, expiresAt: learnedAt - 1, learnedAt: learnedAt - 86400000 } } }));
    expect(read('a', 'model', a)).toBeUndefined();
  });
  it('merges concurrent updates without losing another model', async () => {
    expect(await Promise.all([record('a', 'one', fix, a), record('a', 'two', fix, a)])).toEqual([true, true]);
    expect(read('a', 'one', a)).toEqual(fix);
    expect(read('a', 'two', a)).toEqual(fix);
  });
  it('does not turn invalid timed metadata into a permanent legacy override', async () => {
    const key = JSON.stringify(['a', 'model', a]);
    fs.writeFileSync(file, JSON.stringify({ routes: { [key]: { ...fix, learnedAt: 1, evidence: 'opaque' } } }));
    expect(read('a', 'model', a)).toBeUndefined();
    await record('b', 'other', fix, b);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).routes[key]).toBeUndefined();
  });
  it('does not overwrite malformed files or report an unpersisted success', async () => {
    fs.writeFileSync(file, '{bad-json');
    expect(await record('a', 'model', fix, a)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{bad-json');
  });
  it('does not import unscoped legacy records into a new route', () => {
    fs.writeFileSync(file, JSON.stringify({ models: { a: { model: fix } } }));
    expect(read('a', 'model', a)).toBeUndefined();
  });
  it('allows precise reset by removing an entry and observes file replacement', async () => {
    await record('a', 'model', fix, a);
    const replacement = file + '.replacement';
    fs.writeFileSync(replacement, JSON.stringify({ routes: {} }));
    fs.renameSync(replacement, file);
    expect(read('a', 'model', a)).toBeUndefined();
  });
  it('rejects missing routes, controls and arbitrary compat patches', async () => {
    expect(await record('a', 'model', fix)).toBe(false);
    expect(await record('a', 'model\n', fix, a)).toBe(false);
    expect(await record('a', 'model', { supportsStore: false }, a)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});


// Real child processes execute the production bridge wrapper. A controlled
// rename barrier holds one writer after its disk read, reproducing lost updates
// without relying on scheduler timing; the other writer must observe the lock.
function cacheProcess(id: string, options: { pause?: boolean; failWrite?: boolean; failRelease?: 'once' | 'held'; freezeClock?: boolean } = {}) {
  const release = path.join(root.path, 'release-' + id);
  const script = `
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createInterface } from 'node:readline';
process.send = value => console.log(JSON.stringify(value));
const file = ${JSON.stringify(file)}, release = ${JSON.stringify(release)};
const model = { provider: 'fixture', id: ${JSON.stringify(id)}, api: 'openai-completions', baseUrl: 'http://127.0.0.1/v1' };
const key = JSON.stringify(['child', model.id, 'c'.repeat(64)]);
const rule = JSON.stringify([{ ...model, providerId: 'child', routeKey: 'c'.repeat(64) }]);
const ruleFile = path.join('/fixture', 'pi-cache-compatibility.json');
const handlers = new Map();
const registry = { getProvider() {}, getRegisteredNativeProvider() {} };
const fixtureNow = Date.now();
let pendingTimers = 0;
let calls = 0, pause = ${Boolean(options.pause)}, failWrite = ${Boolean(options.failWrite)};
let releaseFailure = ${JSON.stringify(options.failRelease ?? '')};
const api = runInNewContext(${JSON.stringify(PI_CACHE_RECOVERY_SOURCE + '\ninstallCindyCacheRecovery(pi)')}, {
  ...fs, path, process: { pid: process.pid, platform: process.platform, uptime: () => process.uptime(), kill: (...a) => process.kill(...a),
    env: { PI_CODING_AGENT_DIR: '/fixture', CINDY_PI_CACHE_COMPAT_FILE: file } },
  createHash, randomUUID, Buffer, clearTimeout,
  Date: ${options.freezeClock ? 'class extends Date { static now() { return fixtureNow; } }' : 'Date'},
  setTimeout: (fn, ms) => {
    pendingTimers++;
    return setTimeout(() => {
      pendingTimers--; fn();
      setImmediate(() => { if (!pendingTimers) process.send({ event: 'persistence-idle' }); });
    }, ms);
  }, homedir: () => '/fixture',
  pi: { on: (event, fn) => handlers.set(event, fn) },
  statSync: (name, ...args) => name === ruleFile ? { size: rule.length } : fs.statSync(name, ...args),
  readFileSync: (name, ...a) => name === ruleFile ? rule : fs.readFileSync(name, ...a),
  writeFileSync: (name, ...a) => {
    if (failWrite && typeof name === 'string' && name.endsWith('.tmp')) throw new Error('fixture write failure');
    return fs.writeFileSync(name, ...a);
  },
  rmSync: (name, ...args) => {
    if (name === file + '.lock' && releaseFailure) {
      if (releaseFailure === 'once') releaseFailure = '';
      throw Object.assign(new Error('fixture release failure'), { code: 'EPERM' });
    }
    return fs.rmSync(name, ...args);
  },
  renameSync: (from, to) => {
    if (to === file && pause) {
      pause = false; process.send({ event: 'before-rename' });
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(release)) {
        if (Date.now() >= deadline) throw new Error('barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return fs.renameSync(from, to);
  },
});
api.ownRegistry?.(registry);
function start() {
  handlers.get('before_agent_start')({});
  handlers.get('message_start')({ message: { role: 'user', content: [{ type: 'text', text: 'OK' }] } }, { modelRegistry: registry });
}
async function request() {
  const sent = [];
  const invoke = async function* (options) {
    calls++;
    const payload = await options.onPayload({ model: model.id, prompt_cache_key: 'cache' }, model);
    sent.push(payload);
    if (payload.prompt_cache_key) yield { type: 'error', error: { stopReason: 'error', content: [], errorMessage: '400: {"error":{"message":"opaque refusal","type":"invalid_request_error"}}' } };
    else yield { type: 'done', message: { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] } };
  };
  const events = [];
  for await (const event of api.wrap(model, {}, invoke)) events.push(event.type);
  return { calls, sent, events };
}
createInterface({ input: process.stdin }).on('line', async command => {
  try {
    if (command === 'start') { start(); process.send({ event: 'success', ...await request() }); }
    if (command === 'next') { failWrite = false; releaseFailure = ''; start(); process.send({ event: 'next', ...await request() }); }
    if (command === 'stop') { process.stdin.destroy(); }
  } catch (error) { process.send({ event: 'error', message: String(error) }); process.exitCode = 1; process.stdin.destroy(); }
});
process.send({ event: 'ready', key });
`;
  const scriptFile = path.join(root.path, 'child-' + id + '.mjs');
  fs.writeFileSync(scriptFile, script);
  const child = spawn(process.execPath, [scriptFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', data => { stderr += data; });
  const messages: any[] = [];
  let stdout = '';
  child.stdout!.on('data', data => {
    stdout += data;
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(stdout.slice(0, newline))); stdout = stdout.slice(newline + 1);
    }
  });
  const send = (command: string) => child.stdin!.write(command + '\n');
  return {
    child, release, send,
    async event(name: string, occurrence = 1) {
      await vi.waitFor(() => {
        expect(child.exitCode, stderr).toBeNull();
        expect(messages.find(message => message.event === 'error'), stderr).toBeUndefined();
        expect(messages.filter(message => message.event === name).length, stderr).toBeGreaterThanOrEqual(occurrence);
      }, { timeout: 2000 });
      return messages.filter(message => message.event === name)[occurrence - 1];
    },
    async stop() {
      fs.writeFileSync(release, 'release');
      if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
      fs.rmSync(release, { force: true });
    },
  };
}

describe('native and Desktop cache writers share one lock', () => {
  it.each(['native', 'desktop'])('merges an overlapping %s writer after a native read', async writer => {
    const first = cacheProcess('first', { pause: true });
    const second = writer === 'native' ? cacheProcess('second') : undefined;
    try {
      await first.event('ready');
      if (second) await second.event('ready');
      first.send('start');
      await first.event('before-rename');
      let attempted = false;
      const open = fsp.open.bind(fsp);
      const spy = vi.spyOn(fsp, 'open').mockImplementation((...args: Parameters<typeof fsp.open>) => {
        if (args[0] === file + '.lock') attempted = true;
        return open(...args);
      });
      const other = second
        ? (second.send('start'), second.event('success'))
        : record('desktop', 'second', fix, b);
      if (second) await other;
      else await vi.waitFor(() => expect(attempted).toBe(true));
      spy.mockRestore();
      fs.writeFileSync(first.release, 'release');
      expect((await first.event('success')).events).toEqual(['done']);
      await other;
      await vi.waitFor(() => expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).routes)).toHaveLength(2));
      const records = JSON.parse(fs.readFileSync(file, 'utf8')).routes;
      expect(records[JSON.stringify(['child', 'first', 'c'.repeat(64)])]).toMatchObject({ evidence: 'opaque' });
      expect(records[JSON.stringify(writer === 'native' ? ['child', 'second', 'c'.repeat(64)] : ['desktop', 'second', b])]).toBeDefined();
    } finally { vi.restoreAllMocks(); await first.stop(); await second?.stop(); }
  });

  it('returns successful generation while Desktop owns the lock, then merges after release', async () => {
    // This case tests serialization, not the native writer's one-second budget.
    // Keep its clock fixed while the parent holds/releases the lock under CI load;
    // the busy-persistence case below still verifies the real bounded timeout.
    const native = cacheProcess('waiting', { freezeClock: true });
    try {
      await native.event('ready');
      await withCrossProcessLock(file + '.lock', { label: 'fixture' }, async status => {
        expect(status.held).toBe(true);
        native.send('start');
        expect((await native.event('success')).events).toEqual(['done']);
        // Actual Desktop writer queues behind this same lock, as does native.
        expect(fs.existsSync(file)).toBe(false);
      });
      expect(await record('desktop', 'other', fix, b)).toBe(true);
      // Generation finishes before the native writer's background persistence.
      // Wait for its existing completion signal before asserting both writers merged.
      await native.event('persistence-idle');
      expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).routes)).toHaveLength(2);
    } finally { await native.stop(); }
  });

  it.each(['valid', 'wrong nonce', 'active gate', 'wrong filename', 'invalid nonce', 'malformed', 'oversized', 'directory'])('validates %s after Desktop publishes a release credential for an undeletable held gate', async credential => {
    const gateDir = file + '.lock.reclaim.d';
    const rm = fsp.rm.bind(fsp);
    let gate: string | undefined;
    const spy = vi.spyOn(fsp, 'rm').mockImplementation((target, options) => {
      if (typeof target === 'string' && path.dirname(target) === gateDir && target.endsWith('.json') && fs.existsSync(target)) {
        gate ??= target;
        if (target === gate) return Promise.reject(Object.assign(new Error('fixture gate busy'), { code: 'EBUSY' }));
      }
      return rm(target, options);
    });
    const native = cacheProcess('desktop-released');
    try {
      await withCrossProcessLock(file + '.lock', { label: 'fixture' }, async status => {
        expect(status.held).toBe(true);
      });
      expect(gate).toBeDefined();
      const held = JSON.parse(fs.readFileSync(gate!, 'utf8'));
      expect(held).toMatchObject({ state: 'held', pid: process.pid });
      expect(JSON.parse(fs.readFileSync(gate! + '.released', 'utf8'))).toEqual({ gateFile: path.basename(gate!), nonce: held.nonce });
      const marker = gate! + '.released';
      if (credential === 'wrong nonce') fs.writeFileSync(marker, JSON.stringify({ gateFile: path.basename(gate!), nonce: '00000000-0000-4000-8000-000000000000' }));
      if (credential === 'active gate') fs.rmSync(marker);
      if (credential === 'wrong filename') fs.writeFileSync(marker, JSON.stringify({ gateFile: 'gate-other.json', nonce: held.nonce }));
      if (credential === 'invalid nonce') {
        fs.writeFileSync(gate!, JSON.stringify({ ...held, nonce: 'invalid' }));
        fs.writeFileSync(marker, JSON.stringify({ gateFile: path.basename(gate!), nonce: 'invalid' }));
      }
      if (credential === 'malformed') fs.writeFileSync(marker, '{bad-json');
      if (credential === 'oversized') fs.writeFileSync(marker, JSON.stringify({ gateFile: path.basename(gate!), nonce: held.nonce, padding: 'x'.repeat(4096) }));
      if (credential === 'directory') { fs.rmSync(marker); fs.mkdirSync(marker); }
      // The Desktop process remains alive, and its own production release
      // function, rather than this fixture, minted the original credential.
      await native.event('ready'); native.send('start');
      const first = await native.event('success');
      expect(first.events).toEqual(['done']); expect(first.calls).toBe(2);
      if (credential === 'valid') {
        await vi.waitFor(() => expect(read('child', 'desktop-released', 'c'.repeat(64))).toEqual(fix));
      } else {
        await native.event('persistence-idle');
        expect(fs.existsSync(file)).toBe(false);
      }
      native.send('next');
      const next = await native.event('next');
      expect(next.events).toEqual(['done']); expect(next.calls).toBe(3);
      expect(next.sent).toEqual([{ model: 'desktop-released' }]);
      if (credential !== 'valid') {
        await native.event('persistence-idle', 2);
        expect(fs.existsSync(file)).toBe(false);
      }
      expect(fs.existsSync(gate!)).toBe(true);
    } finally {
      spy.mockRestore(); await native.stop();
      fs.rmSync(gateDir, { recursive: true, force: true });
    }
  });

  it.each(['once', 'held'] as const)('lets Desktop persist while Pi stays alive after %s release failure', async failRelease => {
    const native = cacheProcess('release', { failRelease });
    try {
      await native.event('ready'); native.send('start');
      const result = await native.event('success');
      expect(result.events).toEqual(['done']); expect(result.calls).toBe(2);
      if (failRelease === 'held') {
        await native.event('persistence-idle');
        expect(fs.existsSync(file + '.lock')).toBe(true);
        // The successful learning is already durable, so there is no memory
        // write to incidentally clean up this owner's abandoned lock.
        native.send('next');
        const next = await native.event('next');
        expect(next.events).toEqual(['done']); expect(next.calls).toBe(3);
        expect(next.sent).toEqual([{ model: 'release' }]);
      }
      await vi.waitFor(() => expect(fs.existsSync(file + '.lock')).toBe(false));
      expect(native.child.exitCode).toBeNull();
      expect(await record('desktop', 'after-release', fix, b)).toBe(true);
      expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).routes)).toHaveLength(2);
    } finally { await native.stop(); fs.rmSync(file + '.lock', { force: true }); }
  });

  it.each(['busy', 'write', 'corrupt'])('keeps success and memory learning after %s persistence failure', async failure => {
    if (failure === 'busy') fs.writeFileSync(file + '.lock', JSON.stringify({ pid: process.pid, nonce: 'fixture-owner', startedAt: Date.now() }));
    if (failure === 'corrupt') fs.writeFileSync(file, '{bad-json');
    const native = cacheProcess('failure', { failWrite: failure === 'write' });
    try {
      await native.event('ready');
      native.send('start');
      const result = await native.event('success');
      expect(result.events).toEqual(['done']); expect(result.calls).toBe(2);
      if (failure === 'corrupt') expect(fs.readFileSync(file, 'utf8')).toBe('{bad-json');
      // Wait until the bounded lock attempt ends before allowing persistence.
      if (failure === 'busy') await native.event('persistence-idle');
      fs.rmSync(file + '.lock', { force: true });
      if (failure === 'corrupt') fs.rmSync(file);
      native.send('next');
      const next = await native.event('next');
      expect(next.events).toEqual(['done']); expect(next.calls).toBe(3);
      expect(next.sent).toEqual([{ model: 'failure' }]);
      await vi.waitFor(() => expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).routes)).toHaveLength(1));
    } finally { await native.stop(); fs.rmSync(file + '.lock', { force: true }); }
  });
});
