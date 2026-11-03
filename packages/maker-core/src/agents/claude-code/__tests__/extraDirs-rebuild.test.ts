/**
 * Claude 中途注入 extraDirs 必须走 rewind 同款 resume+fork 续聊,禁止 fresh:true。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { SessionMeta, SessionStorage } from '../../../interfaces/session-storage.js';
import { Maker } from '../../../maker.js';
import { sanitizeClaudeProjectKey } from '../claude-projects-fs.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

vi.mock('../../shared/image-resizer.js', () => ({
  getDefaultImageResizer: () => ({
    process: vi.fn(async (p: string) => p),
    validateBuffer: vi.fn(async () => true),
  }),
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalIdleTimeout = process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;

function createLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };
  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createLogger(),
  };
}

function createControlledStream() {
  const items: unknown[] = [];
  let waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null =
    null;
  let ended = false;
  const pump = (): void => {
    if (!waiter) return;
    if (items.length > 0) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: false, value: items.shift() });
      return;
    }
    if (ended) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: true, value: undefined });
    }
  };
  return {
    emit(msg: unknown): void {
      items.push(msg);
      pump();
    },
    end(): void {
      ended = true;
      pump();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiter = { resolve, reject };
            pump();
          }),
      };
    },
  };
}

function createFakeQuery(stream = createControlledStream()) {
  let closed = false;
  return {
    stream,
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => {
      if (closed) throw new Error('ProcessTransport is not ready for writing');
    }),
    setModel: vi.fn(async () => {
      if (closed) throw new Error('ProcessTransport is not ready for writing');
    }),
    applyFlagSettings: vi.fn(async () => {
      if (closed) throw new Error('ProcessTransport is not ready for writing');
    }),
    interrupt: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(() => {
      closed = true;
    }),
    rewindFiles: vi.fn(async () => ({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-extradirs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalIdleTimeout === undefined) delete process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;
  else process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Claude extraDirs mid-session rebuild', () => {
  it.each(['none', 'remove', 'disable', 'enable'] as const)('setExtraDirs rebuild preserves conversation and launch skill preferences: %s', async (change) => {
    const configDir = await makeTempDir();
    const workingDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    const sdkSessionId = 'sdk-live-library';
    const normalized = await fs.realpath(workingDir);
    const projectDir = path.join(configDir, 'projects', sanitizeClaudeProjectKey(normalized));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, `${sdkSessionId}.jsonl`), '{"type":"summary"}\n', 'utf8');

    const firstQuery = createFakeQuery();
    const closeFirstQuery = firstQuery.close;
    sdkMock.query.mockReturnValue(firstQuery);
    const deps = createDeps();
    const observations: unknown[] = [];
    deps.onClaudeLiveUserRules = async request => {
      const result = await request.read();
      if (request.isCurrent()) observations.push(result);
      return { kind: 'unavailable', reason: 'fixture-content-only' };
    };
    const managedDir = path.join(configDir, 'managed', 'example--demo');
    let disabledPaths = change === 'enable' ? [managedDir] : [];
    deps.getDisabledSkillPaths = () => disabledPaths;
    if (change !== 'none') {
      await fs.mkdir(managedDir, { recursive: true });
      await fs.writeFile(path.join(managedDir, 'SKILL.md'), '---\nname: demo\ndescription: Fixture\n---\nBody');
      deps.getManagedSkills = vi.fn(async () => await fs.stat(managedDir).then(() => [{
        kind: 'agent-skill' as const, name: 'demo', source: 'skill' as const,
        path: path.join(managedDir, 'SKILL.md'), claudeCommandName: 'cindy-plugin-example:demo',
      }]).catch(() => []));
    }
    const agent = new ClaudeCodeAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'session-library-extradirs',
      sessionInstanceId: 'session-library-instance',
      model: 'claude-opus-4-6',
      workingDir,
      resumeSessionId: sdkSessionId,
    });

    if (change === 'remove' || change === 'disable') {
      expect(sdkMock.query.mock.calls[0]?.[0].options.plugins).toHaveLength(1);
    } else {
      expect(sdkMock.query.mock.calls[0]?.[0].options.plugins).toBeUndefined();
    }
    if (change === 'remove') {
      await fs.rm(managedDir, { recursive: true });
    }
    if (change === 'disable') disabledPaths = [managedDir];
    if (change === 'enable') disabledPaths = [];
    const libraryRoot = '/Users/example/libraries/xd-mivo';
    await handle.setExtraDirs?.([libraryRoot], libraryRoot);

    const secondQuery = Object.assign(createFakeQuery(), {
      initializationResult: vi.fn(async () => ({})),
      listPermissionRules: vi.fn(async () => ({ state: {
        originalCwd: workingDir, managedOnly: false, rules: [
          { source: 'userSettings', behavior: 'deny', rule: 'Bash(rebuilt-command)', editability: 'persistent' },
        ],
      } })),
    });
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'read the canvas asset' });

    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      options: Record<string, unknown>;
    };
    expect(rebuildArgs.options.forkSession).toBe(true);
    expect(rebuildArgs.options.resume).toBe(sdkSessionId);
    expect(rebuildArgs.options.additionalDirectories).toEqual([libraryRoot]);
    expect(rebuildArgs.options.resumeSessionAt).toBeUndefined();
    expect(rebuildArgs.options).not.toHaveProperty('fresh');
    expect(closeFirstQuery).toHaveBeenCalled();
    expect(observations).toEqual([expect.objectContaining({ kind: 'available',
      clauses: [expect.objectContaining({ original: 'Bash(rebuilt-command)' })],
    })]);
    if (change !== 'none') {
      expect(deps.getManagedSkills).toHaveBeenCalledTimes(2);
    }
    if (change === 'disable') {
      expect(rebuildArgs.options.plugins).toHaveLength(1);
    } else {
      expect(rebuildArgs.options.plugins).toBeUndefined();
    }
    const wire = sdkMock.query.mock.calls[1][0].prompt as AsyncIterable<{ message: { content: unknown } }>;
    const next = await wire[Symbol.asyncIterator]().next();
    expect(JSON.stringify(next.value.message.content)).toContain('libraryRoot');
    expect(JSON.stringify(next.value.message.content)).toContain(libraryRoot);


    const source = await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain('pendingRewindTo = durableSdkSessionId');
    expect(source).toContain('directoryGrantRebuild ? {} : { resumeSessionAt: resumeAt }');
    expect(source).toContain('extraDirsCopyFallbackEnabled = false');
    expect(source).toContain('下一 turn 生效,不用 fresh:true');
    expect(source).not.toContain('每 turn 读最新值传给 SDK options.additionalDirectories — 即时生效');

    await handle.close();
  });
});

// Test value (unit): the real startSession → handle.send → SDK input queue must
// observe live user rules only after Main can register the active instance. The
// prior rebuild cases never exercised a rules read or a late control response.
// Minimal failure: a user deny exists on the very Query receiving the first input.
describe('Claude same-Query user rules at input acceptance', () => {
  type Observe = NonNullable<AgentDeps['onClaudeLiveUserRules']>;
  type Observation = Awaited<ReturnType<Parameters<Observe>[0]['read']>>;
  const liveState = (workingDir: string) => ({ state: {
    originalCwd: workingDir, managedOnly: false, errors: [], workspaceDirectories: [],
    rules: [{ source: 'userSettings', behavior: 'deny', rule: 'Bash(git push:*)', editability: 'persistent' }],
  } });

  async function startLive(observe: (request: Parameters<Observe>[0]) => Promise<void>, read?: () => Promise<unknown>) {
    process.env.CLAUDE_CONFIG_DIR = await makeTempDir();
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    const workingDir = await makeTempDir();
    const query = Object.assign(createFakeQuery(), {
      initializationResult: vi.fn(async () => ({})),
      listPermissionRules: vi.fn(read ?? (async () => liveState(workingDir))),
    });
    const closeQuery = query.close;
    sdkMock.query.mockReturnValue(query);
    const deps = createDeps();
    deps.runtimeConfig = { behaviorFlags: { HOME: workingDir, USERPROFILE: workingDir } };
    const handle = await new ClaudeCodeAgent({ ...deps, onClaudeLiveUserRules: async request => {
      await observe(request);
      return { kind: 'unavailable', reason: 'fixture-content-only' };
    } }).startSession({
      sessionId: 'live-rules-session', sessionInstanceId: 'live-rules-instance',
      model: 'claude-opus-4-6', workingDir,
    });
    const wire = sdkMock.query.mock.calls.at(-1)![0].prompt as AsyncIterable<{ message: { content: unknown } }>;
    return { handle, query, closeQuery, workingDir, wire };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }

  // Unit: real send must expose all three live sources before enqueue, from one
  // control response. User-only coverage missed project/local content entirely.
  it('observes three source contents once before the real send is enqueued', async () => {
    const observations: unknown[] = [];
    const h = await startLive(async request => {
      if ('readSources' in request && typeof request.readSources === 'function') {
        observations.push(await request.readSources());
        expect(await request.read()).toMatchObject({ kind: 'available', source: 'userSettings' });
      }
    });
    h.query.listPermissionRules.mockResolvedValue({ state: { originalCwd: h.workingDir, managedOnly: false, errors: [],
      rules: ['userSettings', 'projectSettings', 'localSettings'].map(source => ({
        source, behavior: 'deny', rule: 'Bash(git push)', editability: 'persistent',
      })),
    } });
    try {
      const next = h.wire[Symbol.asyncIterator]().next();
      await h.handle.send({ type: 'user', content: 'ordinary input' });
      expect((await next).value?.message.content).toBe('ordinary input');
      expect(observations).toEqual([expect.objectContaining({
        userSettings: expect.objectContaining({ kind: 'available', source: 'userSettings' }),
        projectSettings: expect.objectContaining({ kind: 'available', source: 'projectSettings' }),
        localSettings: expect.objectContaining({ kind: 'available', source: 'localSettings' }),
      })]);
      expect(h.query.listPermissionRules).toHaveBeenCalledTimes(1);
    } finally { await h.handle.close(); }
  });

  it('captures the Host lease after startup and observes rules before the actual input is queued', async () => {
    const configDir = await makeTempDir();
    const workingDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    const query = Object.assign(createFakeQuery(), {
      initializationResult: vi.fn(async () => ({})),
      listPermissionRules: vi.fn(async () => ({ state: {
        originalCwd: workingDir, managedOnly: false, errors: [], workspaceDirectories: [],
        rules: [{ source: 'userSettings', behavior: 'deny', rule: 'Bash(git push:*)', editability: 'persistent' }],
      } })),
    });
    sdkMock.query.mockReturnValue(query);
    const observations: unknown[] = [];
    let inputArrived = false;
    const onClaudeLiveUserRules = vi.fn(async (request: {
      sessionId: string; sessionInstanceId: string; isCurrent: () => boolean; read: () => Promise<unknown>;
      spawnProfile: Parameters<Observe>[0]['spawnProfile']; signal: AbortSignal;
    }) => {
      expect(request.spawnProfile).toEqual(process.platform === 'win32' ? null : { platform: process.platform,
        configRoot: path.join(workingDir, '.claude'), basis: 'default-home' });
      expect(request.signal.aborted).toBe(false);
      expect(request.sessionId).toBe('live-rules-session');
      expect(maker.listActiveSessions().find(session => session.id === request.sessionId)?.instanceId)
        .toBe(request.sessionInstanceId);
      expect(request.sessionInstanceId).toEqual(expect.any(String));
      expect(query.listPermissionRules).not.toHaveBeenCalled();
      const result = await request.read();
      expect(inputArrived).toBe(false);
      if (request.isCurrent()) observations.push(result);
      return { kind: 'unavailable' as const, reason: 'fixture-content-only' };
    });
    const deps = Object.assign(createDeps(), { onClaudeLiveUserRules });
    deps.runtimeConfig = { behaviorFlags: { HOME: workingDir, USERPROFILE: workingDir } };
    const rows = new Map<string, SessionMeta>();
    const storage: SessionStorage = {
      async create(meta) { const row = { ...meta, createdAt: 1, updatedAt: 1 }; rows.set(row.id, row); return row; },
      async get(id) { return rows.get(id) ?? null; },
      async list() { return [...rows.values()]; },
      async update(id, patch) {
        const row = rows.get(id);
        if (!row) throw new Error('missing fixture row');
        const updated = { ...row, ...patch }; rows.set(id, updated); return updated;
      },
      async compareAndClearSdkSessionId() { return false; },
      async delete(id) { rows.delete(id); },
    };
    const maker = new Maker({
      agents: { 'claude-code': new ClaudeCodeAgent(deps) }, storage, logger: createLogger(),
      lifecycleHooks: { onStartSucceeded() {
        expect(maker.listActiveSessions()).toEqual([]);
        expect(onClaudeLiveUserRules).not.toHaveBeenCalled();
      } },
    });
    const session = await maker.createSession({ id: 'live-rules-session',
      agentKind: 'claude-code', model: 'claude-opus-4-6', workingDir });
    const wire = sdkMock.query.mock.calls[0][0].prompt as AsyncIterable<{ message: { content: unknown } }>;
    const receiving = wire[Symbol.asyncIterator]().next().then(item => { inputArrived = true; return item; });
    try {
      expect(onClaudeLiveUserRules).not.toHaveBeenCalled();
      await session.send({ type: 'user', content: 'first input' });
      expect(observations).toEqual([expect.objectContaining({ kind: 'available',
        source: 'userSettings', originalCwd: workingDir,
        clauses: [expect.objectContaining({ original: 'Bash(git push:*)', decision: 'deny' })],
      })]);
      expect((await receiving).value.message.content).toBe('first input');
    } finally { await maker.shutdown(); }
  });

  it('uses the captured spawn profile even when the ambient config directory changes before send', async () => {
    let observed: Parameters<Observe>[0] | undefined;
    const h = await startLive(async request => { observed = request; await request.read(); });
    const launched = sdkMock.query.mock.calls.at(-1)![0].options.env;
    expect(launched.CLAUDE_CONFIG_DIR).toBeUndefined(); // Existing auth sanitization is preserved.
    process.env.CLAUDE_CONFIG_DIR = await makeTempDir();
    try {
      await h.handle.send({ type: 'user', content: 'original profile' });
      expect(observed?.spawnProfile).toEqual(process.platform === 'win32' ? null : { platform: process.platform,
        configRoot: path.join(launched.HOME, '.claude'), basis: 'default-home' });
      expect(observed?.signal.aborted).toBe(true);
      expect(observed?.isCurrent()).toBe(false);
    } finally { await h.handle.close(); }
  });

  it('independently expires Host authority when a busy event loop delays the deadline timer', async () => {
    const clock = vi.spyOn(performance, 'now');
    let now = 0;
    clock.mockImplementation(() => now);
    const accepted: boolean[] = [];
    const h = await startLive(async request => {
      await request.read();
      now = 1001; // Timer has not fired; a write's own predicate must still fail.
      accepted.push(request.isCurrent());
    });
    try {
      await h.handle.send({ type: 'user', content: 'native input continues' });
      expect(accepted).toEqual([false]);
      expect((await h.wire[Symbol.asyncIterator]().next()).value.message.content).toBe('native input continues');
      expect(h.closeQuery).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); await h.handle.close(); }
  });

  it.each(['missing', 'missing-init', 'read-failed', 'host-failed'] as const)('preserves actual input when %s', async failure => {
    const results: Observation[] = [];
    const { handle, query, closeQuery, wire } = await startLive(async request => {
      if (failure === 'host-failed') throw new Error('owner unavailable');
      results.push(await request.read());
    }, async () => { throw new Error('control unavailable'); });
    if (failure === 'missing') Reflect.deleteProperty(query, 'listPermissionRules');
    if (failure === 'missing-init') Reflect.deleteProperty(query, 'initializationResult');
    try {
      await handle.send({ type: 'user', content: 'normal input' });
      expect((await wire[Symbol.asyncIterator]().next()).value.message.content).toBe('normal input');
      expect(results).toEqual(failure === 'host-failed' ? [] : [{ kind: 'unavailable',
        reason: failure === 'missing' || failure === 'missing-init' ? 'capability-unavailable' : 'read-failed' }]);
      expect(closeQuery).not.toHaveBeenCalled();
      expect(query.interrupt).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });

  it.each(['initialization', 'rules'] as const)('times out during %s without interrupting the real Query and discards its late result', async stage => {
    const gate = deferred<ReturnType<typeof liveState>>();
    const started = deferred<void>();
    const finished = deferred<void>();
    const results: Observation[] = [];
    const accepted: Observation[] = [];
    let retained: Parameters<Observe>[0] | undefined;
    const { handle, query, closeQuery, wire, workingDir } = await startLive(async request => {
      retained = request;
      await request.readSources?.();
      const result = await request.read();
      results.push(result);
      if (request.isCurrent()) accepted.push(result);
      finished.resolve();
    }, () => { started.resolve(); return gate.promise; });
    if (stage === 'initialization') {
      query.initializationResult.mockImplementation(() => { started.resolve(); return gate.promise; });
    }
    vi.useFakeTimers();
    try {
      const sending = handle.send({ type: 'user', content: 'input survives timeout' });
      await started.promise;
      await vi.advanceTimersByTimeAsync(1000);
      await sending;
      expect((await wire[Symbol.asyncIterator]().next()).value.message.content).toBe('input survives timeout');
      expect(closeQuery).not.toHaveBeenCalled();
      expect(query.interrupt).not.toHaveBeenCalled();
      expect(retained?.isCurrent()).toBe(false);
      gate.resolve(liveState(workingDir));
      await finished.promise;
      expect(results).toEqual([{ kind: 'unavailable', reason: 'stale' }]);
      expect(accepted).toEqual([]);
      await expect(retained?.read()).resolves.toEqual({ kind: 'unavailable', reason: 'stale' });
      expect(query.listPermissionRules).toHaveBeenCalledTimes(stage === 'initialization' ? 0 : 1);
    } finally { await handle.close(); }
  });

  it.each(['close', 'query-close', 'cancel', 'stop'] as const)('rejects input and drops a control response after %s', async change => {
    const gate = deferred<unknown>();
    const started = deferred<void>();
    const finished = deferred<void>();
    const accepted: Observation[] = [];
    const { handle, query, wire, workingDir } = await startLive(async request => {
      await request.readSources?.();
      const result = await request.read();
      if (request.isCurrent()) accepted.push(result);
      finished.resolve();
    }, () => { started.resolve(); return gate.promise; });
    const signal = new AbortController();
    try {
      const sending = handle.send({ type: 'user', content: 'must not reach CLI' }, { signal: signal.signal })
        .then(() => undefined, (error: unknown) => error);
      await started.promise;
      if (change === 'close') await handle.close();
      else if (change === 'query-close') query.close();
      else if (change === 'stop') await handle.abort();
      else signal.abort();
      gate.resolve(liveState(workingDir));
      expect(await sending).toBeInstanceOf(Error);
      await finished.promise;
      expect(accepted).toEqual([]);
      await handle.close();
      expect(await wire[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
    } finally { await handle.close(); }
  });
});
