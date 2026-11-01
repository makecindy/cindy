import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '../client.js';
import { HermesManager } from '../hermes-manager.js';
import {
  METHODS,
  NOTIFICATIONS,
  type RpcNotification,
  type SessionClosedNotification,
} from '../protocol.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));

class NotificationCollector {
  readonly list: RpcNotification[] = [];
  private readonly waiters: Array<{
    pred: (n: RpcNotification) => boolean;
    resolve: (n: RpcNotification) => void;
    timer: NodeJS.Timeout;
  }> = [];

  push(n: RpcNotification): void {
    this.list.push(n);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].pred(n)) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(n);
      }
    }
  }

  waitFor(pred: (n: RpcNotification) => boolean, timeoutMs = 10_000): Promise<RpcNotification> {
    const existing = this.list.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise<RpcNotification>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`timed out waiting for notification (collected ${this.list.length})`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  eventsOfType(type: string): RpcNotification[] {
    return this.list.filter(
      (n) =>
        n.method === NOTIFICATIONS.QUERY_EVENT &&
        (n.params as { event?: { type?: string } }).event?.type === type,
    );
  }

  closedEvents(): SessionClosedNotification[] {
    return this.list
      .filter((n) => n.method === NOTIFICATIONS.SESSION_CLOSED)
      .map((n) => n.params as SessionClosedNotification);
  }
}

interface Harness {
  manager: HermesManager;
  client: RpcClient;
  collector: NotificationCollector;
  dir: string;
  registryFile: string;
  warnings: Array<{ msg: string; ctx?: Record<string, unknown> }>;
}

let current: Harness | null = null;

async function startHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mgr-test-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // Safe-mode (`--safe-mode`) requires an explicit route; the daemon resolves
  // it from the home config (see hermes-config.ts).
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'model:\n  default: fake/default-model\n  provider: fake-provider\n_config_version: 1\n',
  );
  const registryFile = path.join(home, 'hermes-mgr', 'sessions.json');
  const socketPath = path.join(dir, 'm.sock');
  const warnings: Harness['warnings'] = [];
  const manager = new HermesManager({
    socketPath, hermesHome: home, hermesBin: process.execPath, hermesExtraArgs: [FIXTURE], registryFile,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg, ctx) => warnings.push({ msg, ...(ctx ? { ctx } : {}) }),
      error: () => undefined,
    },
  });
  await manager.start();
  const socket = net.createConnection(socketPath);
  await once(socket, 'connect');
  const collector = new NotificationCollector();
  const client = new RpcClient(socket, {
    onNotification: (n) => collector.push(n),
  });
  await client.hello({ timeoutMs: 5_000 });
  return { manager, client, collector, dir, registryFile, warnings };
}

function recordPath(dir: string, name: string): string {
  return path.join(dir, `${name}-argv.json`);
}

beforeEach(async () => {
  current = await startHarness();
});

afterEach(async () => {
  await current?.manager.stop();
  current?.client.dispose();
  delete process.env.FAKE_VERSION;
  delete process.env.FAKE_VERSION_ERROR;
  current = null;
});

describe('HermesManager socket integration (fake hermes)', () => {
  it('completes a full happy-path turn: events stream, session binds, registry persists', async () => {
    const h = current!;
    const rec = recordPath(h.dir, 's1-turn1');
    process.env.FAKE_RECORD = rec;
    try {
      const start = await h.client.request(METHODS.QUERY_START, {
        sessionId: 's1',
        cwd: h.dir,
        permissionMode: 'bypassPermissions',
      }, { timeoutMs: 5_000 });
      expect(start).toEqual({ sessionId: 's1' });

      const send = await h.client.request(METHODS.QUERY_SEND, { sessionId: 's1', text: 'hello' }, { timeoutMs: 5_000 });
      expect(send).toEqual({ sessionId: 's1' });

      const closed = await h.collector.waitFor(
        (n) => n.method === NOTIFICATIONS.SESSION_CLOSED,
      );
      expect((closed.params as SessionClosedNotification).reason).toBe('completed');
    } finally {
      delete process.env.FAKE_RECORD;
    }

    // Hermes events arrived verbatim, in order, with monotonic seqs.
    const inits = h.collector.eventsOfType('system');
    expect(inits).toHaveLength(1);
    expect((inits[0].params as { event: { session_id: string } }).event.session_id).toBe('fake-h-1');
    expect(h.collector.eventsOfType('text')).toHaveLength(2);
    expect(h.collector.eventsOfType('tool_use')).toHaveLength(1);
    expect(h.collector.eventsOfType('tool_result')).toHaveLength(1);
    expect(h.collector.eventsOfType('result')).toHaveLength(1);

    // The daemon synthesized a session-bound event after init.
    const bound = await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.QUERY_EVENT &&
        (n.params as { event?: { subtype?: string } }).event?.subtype === 'session-bound',
    );
    expect((bound.params as { event: { hermesSessionId: string } }).event.hermesSessionId).toBe('fake-h-1');

    // Session list + persisted registry reflect the binding.
    const list = await h.client.request(METHODS.SESSION_LIST, {}, { timeoutMs: 5_000 });
    const entry = (list as { sessions: Array<{ sessionId: string; hermesSessionId?: string; running: boolean }> })
      .sessions.find((s) => s.sessionId === 's1');
    expect(entry?.hermesSessionId).toBe('fake-h-1');
    expect(entry?.running).toBe(false);

    expect(fs.existsSync(h.registryFile)).toBe(true);
    expect(fs.readFileSync(h.registryFile, 'utf8')).toContain('fake-h-1');

    // Full-access mode mapped to --yolo in the spawned child.
    const argv = JSON.parse(fs.readFileSync(rec, 'utf8')) as string[];
    expect(argv).toContain('--yolo');
    expect(argv).not.toContain('--safe-mode');
  }, 20_000);

  it('resumes the bound hermes session on the next turn and maps safe mode to --safe-mode', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sr',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });
    await h.client.request(METHODS.QUERY_SEND, { sessionId: 'sr', text: 'turn one' }, { timeoutMs: 5_000 });
    await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.SESSION_CLOSED &&
        (n.params as SessionClosedNotification).sessionId === 'sr',
    );

    const rec = recordPath(h.dir, 'sr-turn2');
    process.env.FAKE_RECORD = rec;
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 'sr', text: 'turn two' }, { timeoutMs: 5_000 });
      await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.SESSION_CLOSED &&
          (n.params as SessionClosedNotification).sessionId === 'sr' &&
          h.collector.closedEvents().filter((c) => c.sessionId === 'sr').length >= 2,
      );
    } finally {
      delete process.env.FAKE_RECORD;
    }

    // Two completed closes for 'sr' proves a second turn ran and settled.
    const closes = h.collector.closedEvents().filter((c) => c.sessionId === 'sr');
    expect(closes).toHaveLength(2);
    expect(closes.every((c) => c.reason === 'completed')).toBe(true);

    // The second turn resumed the bound Hermes session, under safe mode, and
    // carried the daemon-resolved home route (safe mode refuses profile defaults).
    const argv = JSON.parse(fs.readFileSync(rec, 'utf8')) as string[];
    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('fake-h-1');
    expect(argv).toContain('--safe-mode');
    expect(argv).not.toContain('--yolo');
    expect(argv[argv.indexOf('-m') + 1]).toBe('fake/default-model');
    expect(argv[argv.indexOf('--provider') + 1]).toBe('fake-provider');
  }, 20_000);

  // Runs one turn for `sessionId` and returns every fake-Hermes invocation it made
  // (argv + query text): a model switch is a `/model` run followed by the real turn.
  type Invocation = { argv: string[]; text: string };
  async function runTurnLog(h: Harness, sessionId: string, turnNo: number): Promise<Invocation[]> {
    const rec = recordPath(h.dir, `${sessionId}-turn${turnNo}`);
    process.env.FAKE_RECORD_TEXT = rec;
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId, text: `turn ${turnNo}` }, { timeoutMs: 5_000 });
      await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.SESSION_CLOSED &&
          h.collector.closedEvents().filter((c) => c.sessionId === sessionId).length >= turnNo,
      );
    } finally {
      delete process.env.FAKE_RECORD_TEXT;
    }
    return fs
      .readFileSync(rec, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Invocation);
  }
  const flagOf = (argv: string[], name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

  // Real Hermes 0.22.5 rejects a resume whose -m/--provider differ from the
  // session's launch ("use /model after resuming to switch"; live-checked
  // 2026-10-30), so the daemon replays the launch flags and switches with /model.
  it('query/setModel switches a resumed session with /model, never with a changed -m (full access)', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sm-yolo',
      cwd: h.dir,
      permissionMode: 'bypassPermissions',
    }, { timeoutMs: 5_000 });

    const first = await runTurnLog(h, 'sm-yolo', 1);
    expect(first).toHaveLength(1);
    expect(first[0].argv).toContain('--yolo');
    expect(first[0].argv).not.toContain('-m');

    await h.client.request(METHODS.QUERY_SET_MODEL, { sessionId: 'sm-yolo', model: 'override/model-x' }, { timeoutMs: 5_000 });
    const second = await runTurnLog(h, 'sm-yolo', 2);
    expect(second.map((r) => r.text)).toEqual(['/model override/model-x', 'turn 2']);
    for (const r of second) {
      expect(r.argv).toContain('--resume');
      expect(r.argv).not.toContain('-m');
    }
    // The override changes the session only; the home config.yaml stays untouched.
    expect(fs.readFileSync(path.join(h.dir, 'home', 'config.yaml'), 'utf8')).toContain('default: fake/default-model');

    // Same model again: no switch.
    const same = await runTurnLog(h, 'sm-yolo', 3);
    expect(same.map((r) => r.text)).toEqual(['turn 3']);

    // Cindy's 'hermes-default' sentinel arrives as '': switch back to the home default.
    await h.client.request(METHODS.QUERY_SET_MODEL, { sessionId: 'sm-yolo', model: '' }, { timeoutMs: 5_000 });
    const cleared = await runTurnLog(h, 'sm-yolo', 4);
    expect(cleared.map((r) => r.text)).toEqual(['/model fake/default-model', 'turn 4']);
    for (const r of cleared) expect(r.argv).not.toContain('-m');
  }, 30_000);

  it('query/setModel in safe mode replays the launch route on resume and switches with /model', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sm-safe',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });

    const first = await runTurnLog(h, 'sm-safe', 1);
    expect(flagOf(first[0].argv, '-m')).toBe('fake/default-model');
    expect(flagOf(first[0].argv, '--provider')).toBe('fake-provider');

    await h.client.request(METHODS.QUERY_SET_MODEL, { sessionId: 'sm-safe', model: 'override/model-y' }, { timeoutMs: 5_000 });
    const second = await runTurnLog(h, 'sm-safe', 2);
    expect(second.map((r) => r.text)).toEqual(['/model override/model-y', 'turn 2']);
    for (const r of second) {
      expect(flagOf(r.argv, '-m')).toBe('fake/default-model');
      expect(flagOf(r.argv, '--provider')).toBe('fake-provider');
    }

    await h.client.request(METHODS.QUERY_SET_MODEL, { sessionId: 'sm-safe', model: '' }, { timeoutMs: 5_000 });
    const third = await runTurnLog(h, 'sm-safe', 3);
    expect(third.map((r) => r.text)).toEqual(['/model fake/default-model', 'turn 3']);
    for (const r of third) expect(flagOf(r.argv, '-m')).toBe('fake/default-model');
  }, 30_000);

  it('query/setModel with a changed provider starts a fresh Hermes session on the new provider', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sm-switch-provider',
      cwd: h.dir,
      permissionMode: 'bypassPermissions',
    }, { timeoutMs: 5_000 });

    const first = await runTurnLog(h, 'sm-switch-provider', 1);
    expect(first).toHaveLength(1);
    expect(first[0].argv).not.toContain('--base-url');

    // Switch model AND provider to local custom endpoint
    await h.client.request(METHODS.QUERY_SET_MODEL, {
      sessionId: 'sm-switch-provider',
      model: 'qwen3-8b',
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
    }, { timeoutMs: 5_000 });

    const second = await runTurnLog(h, 'sm-switch-provider', 2);
    // Provider changed, so Hermes CLI cannot resume: runs a fresh session with new flags, no /model switch
    expect(second.map((r) => r.text)).toEqual(['turn 2']);
    expect(second[0].argv).not.toContain('--resume');
    expect(flagOf(second[0].argv, '-m')).toBe('qwen3-8b');
    expect(flagOf(second[0].argv, '--provider')).toBe('custom');
    expect(flagOf(second[0].argv, '--base-url')).toBe('http://127.0.0.1:1234/v1');

    // Next turn on the same local provider resumes it
    const third = await runTurnLog(h, 'sm-switch-provider', 3);
    expect(third[0].argv).toContain('--resume');
    expect(flagOf(third[0].argv, '-m')).toBe('qwen3-8b');
    expect(flagOf(third[0].argv, '--provider')).toBe('custom');
    expect(flagOf(third[0].argv, '--base-url')).toBe('http://127.0.0.1:1234/v1');
  }, 30_000);

  it('query/setModel ends the turn with an error when the /model switch fails, without running the turn', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sm-fail',
      cwd: h.dir,
      permissionMode: 'bypassPermissions',
    }, { timeoutMs: 5_000 });
    await runTurnLog(h, 'sm-fail', 1);
    await h.client.request(METHODS.QUERY_SET_MODEL, { sessionId: 'sm-fail', model: 'override/bad' }, { timeoutMs: 5_000 });

    process.env.FAKE_BEHAVIOR = 'fail';
    let turn: Invocation[];
    try {
      turn = await runTurnLog(h, 'sm-fail', 2);
    } finally {
      delete process.env.FAKE_BEHAVIOR;
    }
    expect(turn.map((r) => r.text)).toEqual(['/model override/bad']);
    const closed = h.collector.closedEvents().filter((c) => c.sessionId === 'sm-fail');
    expect(closed[closed.length - 1].reason).toBe('error');
  }, 30_000);

  it('query/setModel rejects an unknown session and a missing model', async () => {
    const h = current!;
    await expect(
      h.client.request(METHODS.QUERY_SET_MODEL, { sessionId: 'nope', model: 'a/b' }, { timeoutMs: 5_000 }),
    ).rejects.toBeTruthy();
    await h.client.request(METHODS.QUERY_START, { sessionId: 'sm-bad', cwd: h.dir, permissionMode: 'default' }, { timeoutMs: 5_000 });
    await expect(
      h.client.request(METHODS.QUERY_SET_MODEL, { sessionId: 'sm-bad' }, { timeoutMs: 5_000 }),
    ).rejects.toBeTruthy();
  }, 15_000);

  it('starts a fresh Hermes session when --resume names a session the home lost', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sf',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });
    await h.client.request(METHODS.QUERY_SEND, { sessionId: 'sf', text: 'turn one' }, { timeoutMs: 5_000 });
    await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.SESSION_CLOSED &&
        (n.params as SessionClosedNotification).sessionId === 'sf',
    );

    const log = path.join(h.dir, 'sf-argv.log');
    process.env.FAKE_BEHAVIOR = 'missing-session';
    process.env.FAKE_RECORD_LOG = log;
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 'sf', text: 'turn two' }, { timeoutMs: 5_000 });
      await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.SESSION_CLOSED &&
          (n.params as SessionClosedNotification).sessionId === 'sf' &&
          h.collector.closedEvents().filter((c) => c.sessionId === 'sf').length >= 2,
      );
    } finally {
      delete process.env.FAKE_BEHAVIOR;
      delete process.env.FAKE_RECORD_LOG;
    }

    // Attempt one resumed the dead id; the fallback dropped --resume and replayed
    // the same input against a fresh session.
    const attempts = fs.readFileSync(log, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toContain('--resume');
    expect(attempts[0][attempts[0].indexOf('--resume') + 1]).toBe('fake-h-1');
    expect(attempts[1]).not.toContain('--resume');

    // Nothing from the failed lookup reached the client: the turn completed
    // once, and the retry's own init/result are the only ones besides turn one.
    const closes = h.collector.closedEvents().filter((c) => c.sessionId === 'sf');
    expect(closes).toHaveLength(2);
    expect(closes.every((c) => c.reason === 'completed')).toBe(true);
    const results = h.collector.eventsOfType('result')
      .map((n) => (n.params as { event: { exit_code: number } }).event);
    expect(results).toHaveLength(2);
    expect(results.every((event) => event.exit_code === 0)).toBe(true);
    const inits = h.collector.eventsOfType('system')
      .map((n) => (n.params as { event: { session_id: string } }).event);
    expect(inits.map((event) => event.session_id)).toEqual(['fake-h-1', 'fake-h-fresh']);

    // The client is told why the history is missing, and the registry forgets
    // the dead id in favour of the fresh one so later turns stop resuming it.
    const reset = h.collector.eventsOfType('hermes-mgr').find(
      (n) => (n.params as { event: { subtype?: string } }).event.subtype === 'resume-reset',
    );
    expect((reset?.params as { event: { previousHermesSessionId: string } }).event.previousHermesSessionId)
      .toBe('fake-h-1');
    const list = await h.client.request(METHODS.SESSION_LIST, {}, { timeoutMs: 5_000 });
    const entry = (list as { sessions: Array<{ sessionId: string; hermesSessionId?: string }> })
      .sessions.find((s) => s.sessionId === 'sf');
    expect(entry?.hermesSessionId).toBe('fake-h-fresh');
  }, 20_000);

  it('binds the session id from the result event when init reports none', async () => {
    const h = current!;
    process.env.FAKE_INIT_EMPTY = '1';
    try {
      await h.client.request(METHODS.QUERY_START, {
        sessionId: 's7',
        cwd: h.dir,
        permissionMode: 'default',
      }, { timeoutMs: 5_000 });
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 's7', text: 'hello' }, { timeoutMs: 5_000 });
      await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.SESSION_CLOSED &&
          (n.params as SessionClosedNotification).sessionId === 's7',
      );
    } finally {
      delete process.env.FAKE_INIT_EMPTY;
    }

    // Current Hermes builds put the id only on `result`; the registry must
    // still learn it or the next turn has nothing to resume.
    const list = await h.client.request(METHODS.SESSION_LIST, {}, { timeoutMs: 5_000 });
    const entry = (list as { sessions: Array<{ sessionId: string; hermesSessionId?: string }> })
      .sessions.find((s) => s.sessionId === 's7');
    expect(entry?.hermesSessionId).toBe('fake-h-1');
    const bound = h.collector.eventsOfType('hermes-mgr').filter(
      (n) => (n.params as { event: { subtype?: string } }).event.subtype === 'session-bound',
    );
    expect(bound).toHaveLength(1);
    expect((bound[0].params as { event: { hermesSessionId: string } }).event.hermesSessionId)
      .toBe('fake-h-1');
  }, 20_000);

  it('does not retry a non-resume failure as a fresh session', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 's4',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });
    await h.client.request(METHODS.QUERY_SEND, { sessionId: 's4', text: 'turn one' }, { timeoutMs: 5_000 });
    await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.SESSION_CLOSED &&
        (n.params as SessionClosedNotification).sessionId === 's4',
    );

    const log = path.join(h.dir, 's4-argv.log');
    process.env.FAKE_BEHAVIOR = 'fail';
    process.env.FAKE_RECORD_LOG = log;
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 's4', text: 'crash me' }, { timeoutMs: 5_000 });
      await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.SESSION_CLOSED &&
          (n.params as SessionClosedNotification).sessionId === 's4' &&
          h.collector.closedEvents().filter((c) => c.sessionId === 's4').length >= 2,
      );
    } finally {
      delete process.env.FAKE_BEHAVIOR;
      delete process.env.FAKE_RECORD_LOG;
    }

    // One attempt only: an unrelated crash must surface, not silently restart.
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    const closes = h.collector.closedEvents().filter((c) => c.sessionId === 's4');
    expect(closes).toHaveLength(2);
    expect(closes[1].reason).toBe('error');
    expect(closes[1].detail).toContain('simulated hermes crash');
    expect(
      h.collector.eventsOfType('hermes-mgr').some(
        (n) => (n.params as { event: { subtype?: string } }).event.subtype === 'resume-reset',
      ),
    ).toBe(false);
  }, 20_000);

  it('fails with an actionable error when safe mode has no resolvable home route', async () => {
    const h = current!;
    fs.rmSync(path.join(h.dir, 'home', 'config.yaml'));
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sr-missing',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });

    await expect(
      h.client.request(METHODS.QUERY_SEND, { sessionId: 'sr-missing', text: 'hello' }, { timeoutMs: 5_000 }),
    ).rejects.toThrow(/model\.default[\s\S]*Full access/);
    expect(h.collector.closedEvents().filter((c) => c.sessionId === 'sr-missing')).toHaveLength(0);
  });

  it('interrupts a running turn and reports killed', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 's2',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });
    // The child inherits this process's env through the daemon's spawn.
    process.env.FAKE_BEHAVIOR = 'slow';
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 's2', text: 'long job' }, { timeoutMs: 5_000 });
    } finally {
      delete process.env.FAKE_BEHAVIOR;
    }
    await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.QUERY_EVENT &&
        (n.params as { event?: { type?: string } }).event?.type === 'system',
    );

    // Concurrent send while the turn runs must be rejected.
    await expect(
      h.client.request(METHODS.QUERY_SEND, { sessionId: 's2', text: 'nope' }, { timeoutMs: 5_000 }),
    ).rejects.toThrow(/TURN_ALREADY_RUNNING/);

    await h.client.request(METHODS.QUERY_INTERRUPT, { sessionId: 's2' }, { timeoutMs: 5_000 });
    const closed = await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.SESSION_CLOSED &&
        (n.params as SessionClosedNotification).sessionId === 's2',
    );
    expect((closed.params as SessionClosedNotification).reason).toBe('killed');
  }, 20_000);

  it('marks the interrupted turn not-running in the registry and resumes the same Hermes session (ROADMAP 1.10)', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'si1',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });
    process.env.FAKE_BEHAVIOR = 'slow';
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 'si1', text: 'long job' }, { timeoutMs: 5_000 });
      await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.QUERY_EVENT &&
          (n.params as { event?: { type?: string } }).event?.type === 'system',
      );
      await h.client.request(METHODS.QUERY_INTERRUPT, { sessionId: 'si1' }, { timeoutMs: 5_000 });
      const killed = await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.SESSION_CLOSED &&
          (n.params as SessionClosedNotification).sessionId === 'si1',
      );
      expect((killed.params as SessionClosedNotification).reason).toBe('killed');
    } finally {
      delete process.env.FAKE_BEHAVIOR;
    }

    // The aborted turn is marked not-running in the registry, in memory and on
    // disk, and the bound Hermes session id survived the interrupt.
    const list = (await h.client.request(METHODS.SESSION_LIST, {}, { timeoutMs: 5_000 })) as {
      sessions: Array<{ sessionId: string; running: boolean; hermesSessionId?: string }>;
    };
    expect(list.sessions.find((s) => s.sessionId === 'si1'))
      .toMatchObject({ running: false, hermesSessionId: 'fake-h-1' });
    const afterInterrupt = JSON.parse(fs.readFileSync(h.registryFile, 'utf8')) as
      Array<{ sessionId: string; running: boolean }>;
    expect(afterInterrupt.find((s) => s.sessionId === 'si1')?.running).toBe(false);

    // The conversation stays resumable: the next send is accepted (no
    // TURN_ALREADY_RUNNING) and replays the bound id instead of starting fresh.
    const argvRecord = recordPath(h.dir, 'si1-turn2');
    process.env.FAKE_RECORD = argvRecord;
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 'si1', text: 'carry on' }, { timeoutMs: 5_000 });
      const second = await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.SESSION_CLOSED &&
          (n.params as SessionClosedNotification).sessionId === 'si1' &&
          h.collector.closedEvents().filter((c) => c.sessionId === 'si1').length >= 2,
      );
      expect((second.params as SessionClosedNotification).reason).toBe('completed');
    } finally {
      delete process.env.FAKE_RECORD;
    }
    const argv = JSON.parse(fs.readFileSync(argvRecord, 'utf8')) as string[];
    const resumeIndex = argv.indexOf('--resume');
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(argv[resumeIndex + 1]).toBe('fake-h-1');
  }, 20_000);

  it('repairs a crash-left running flag at startup and keeps the session resumable (ROADMAP 1.10)', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sc1',
      cwd: h.dir,
      permissionMode: 'bypassPermissions',
    }, { timeoutMs: 5_000 });
    await h.client.request(METHODS.QUERY_SEND, { sessionId: 'sc1', text: 'hello' }, { timeoutMs: 5_000 });
    await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.SESSION_CLOSED &&
        (n.params as SessionClosedNotification).sessionId === 'sc1',
    );

    // Forge what a hard daemon kill (SIGKILL, power loss) leaves behind: the
    // child died with the daemon, but the persisted record claims a live turn.
    const raw = JSON.parse(fs.readFileSync(h.registryFile, 'utf8')) as Array<Record<string, unknown>>;
    const crashed = raw.find((r) => r.sessionId === 'sc1');
    expect(crashed).toBeDefined();
    crashed!.running = true;
    fs.writeFileSync(h.registryFile, JSON.stringify(raw));

    // Restart a daemon against the same registry file.
    const socketPath2 = path.join(h.dir, 'm2.sock');
    const manager2 = new HermesManager({
      socketPath: socketPath2,
      hermesHome: path.join(h.dir, 'home'),
      hermesBin: process.execPath,
      hermesExtraArgs: [FIXTURE],
      registryFile: h.registryFile,
    });
    await manager2.start();
    const socket2 = net.createConnection(socketPath2);
    await once(socket2, 'connect');
    const collector2 = new NotificationCollector();
    const client2 = new RpcClient(socket2, { onNotification: (n) => collector2.push(n) });
    try {
      await client2.hello({ timeoutMs: 5_000 });
      const list = (await client2.request(METHODS.SESSION_LIST, {}, { timeoutMs: 5_000 })) as {
        sessions: Array<{ sessionId: string; running: boolean }>;
      };
      expect(list.sessions.find((s) => s.sessionId === 'sc1')).toMatchObject({ running: false });

      // The repaired session accepts a new turn instead of rejecting it as
      // TURN_ALREADY_RUNNING forever.
      await client2.request(METHODS.QUERY_SEND, { sessionId: 'sc1', text: 'after restart' }, { timeoutMs: 5_000 });
      const closed = await collector2.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.SESSION_CLOSED &&
          (n.params as SessionClosedNotification).sessionId === 'sc1',
      );
      expect((closed.params as SessionClosedNotification).reason).toBe('completed');
    } finally {
      client2.dispose();
      await manager2.stop();
    }
  }, 20_000);

  it('persists running:false when the daemon stops during a live turn (ROADMAP 1.10)', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 'sst1',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });
    process.env.FAKE_BEHAVIOR = 'slow';
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 'sst1', text: 'long job' }, { timeoutMs: 5_000 });
      await h.collector.waitFor(
        (n) =>
          n.method === NOTIFICATIONS.QUERY_EVENT &&
          (n.params as { event?: { type?: string } }).event?.type === 'system',
      );
      // Graceful shutdown mid-turn (the SIGTERM path in bin/hermes-mgr.ts):
      // the child is killed and the record must not claim a live turn after.
      await h.manager.stop();
    } finally {
      delete process.env.FAKE_BEHAVIOR;
    }
    const onDisk = JSON.parse(fs.readFileSync(h.registryFile, 'utf8')) as
      Array<{ sessionId: string; running: boolean }>;
    expect(onDisk.find((s) => s.sessionId === 'sst1')?.running).toBe(false);
  }, 20_000);

  it('reports a failed run (non-zero exit, no result event) as error with stderr detail', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 's3',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });
    process.env.FAKE_BEHAVIOR = 'fail';
    try {
      await h.client.request(METHODS.QUERY_SEND, { sessionId: 's3', text: 'doomed' }, { timeoutMs: 5_000 });
    } finally {
      delete process.env.FAKE_BEHAVIOR;
    }
    const closed = await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.SESSION_CLOSED &&
        (n.params as SessionClosedNotification).sessionId === 's3',
    );
    const params = closed.params as SessionClosedNotification;
    expect(params.reason).toBe('error');
    expect(params.detail).toContain('simulated hermes crash');
  }, 20_000);

  it('query/close removes the session and emits a closed notification', async () => {
    const h = current!;
    await h.client.request(METHODS.QUERY_START, {
      sessionId: 's5',
      cwd: h.dir,
      permissionMode: 'default',
    }, { timeoutMs: 5_000 });
    await h.client.request(METHODS.QUERY_SEND, { sessionId: 's5', text: 'then close me' }, { timeoutMs: 5_000 });
    await h.collector.waitFor(
      (n) =>
        n.method === NOTIFICATIONS.SESSION_CLOSED &&
        (n.params as SessionClosedNotification).sessionId === 's5',
    );
    await h.client.request(METHODS.QUERY_CLOSE, { sessionId: 's5' }, { timeoutMs: 5_000 });
    const list = await h.client.request(METHODS.SESSION_LIST, {}, { timeoutMs: 5_000 });
    expect((list as { sessions: Array<{ sessionId: string }> }).sessions.some((s) => s.sessionId === 's5')).toBe(false);
    const closes = h.collector.closedEvents().filter((c) => c.sessionId === 's5');
    expect(closes[closes.length - 1].reason).toBe('closed');
  }, 20_000);

  it('warns on status when the installed Hermes version differs from the pin', async () => {
    const h = current!;
    process.env.FAKE_VERSION = '0.22.6';

    const status = await h.client.request(METHODS.CONFIG_STATUS, {}, { timeoutMs: 5_000 });

    expect(status).toEqual({
      installedVersion: '0.22.6',
      pinnedVersion: '0.22.5',
      matches: false,
    });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0].msg).toBe('Hermes CLI version mismatch');
    expect(h.warnings[0].ctx).toEqual({
      installedVersion: '0.22.6',
      pinnedVersion: '0.22.5',
    });
  });

  it('does not warn on status when the installed Hermes version matches the pin', async () => {
    const h = current!;
    process.env.FAKE_VERSION = '0.22.5';

    const status = await h.client.request(METHODS.CONFIG_STATUS, {}, { timeoutMs: 5_000 });

    expect(status).toEqual({
      installedVersion: '0.22.5',
      pinnedVersion: '0.22.5',
      matches: true,
    });
    expect(h.warnings).toHaveLength(0);
  });

  it('reports an unverified status and warns when the Hermes version cannot be read', async () => {
    const h = current!;
    process.env.FAKE_VERSION_ERROR = '1';

    const status = await h.client.request(METHODS.CONFIG_STATUS, {}, { timeoutMs: 5_000 });

    expect(status).toEqual({
      installedVersion: null,
      pinnedVersion: '0.22.5',
      matches: null,
    });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0].msg).toBe('Unable to verify Hermes CLI version');
  });

  it('rejects protocol version mismatch', async () => {
    const h = current!;
    const socket = net.createConnection(path.join(h.dir, 'm.sock'));
    await once(socket, 'connect');
    const bad = new RpcClient(socket);
    try {
      await expect(
        bad.request(METHODS.PROTOCOL_HELLO, { protocolVersion: 999 }, { timeoutMs: 5_000 }),
      ).rejects.toThrow(/INVALID_PROTOCOL_VERSION/);
    } finally {
      bad.dispose();
    }
  }, 20_000);
});
