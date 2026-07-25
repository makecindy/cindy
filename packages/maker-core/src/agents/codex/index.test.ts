import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

import { CodexAgent } from './index.js';
import { Method } from './app-server/protocol.js';
import type { ThreadEventHandlers } from './app-server/host.js';
import type { AgentDeps } from '../base-agent.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../../types/events.js';
import type { Logger } from '../../interfaces/logger.js';

const { MockCodexTransport, createdTransports } = vi.hoisted(() => {
  type LineHandler = (line: string) => void;
  type StderrHandler = (line: string) => void;
  type CloseHandler = (info: { reason: string }) => void;

  class MockCodexTransport {
    static threadSeq = 1;
    static failThreadStart = false;
    static dropThreadUnsubscribe = false;
    static beforeThreadStartResponse: ((transport: MockCodexTransport) => Promise<void> | void) | null = null;
    static onCreate: ((transport: MockCodexTransport) => void) | null = null;

    readonly lines: string[] = [];
    closed = false;
    private memoryEnabled = false;

    private readonly lineHandlers = new Set<LineHandler>();
    private readonly stderrHandlers = new Set<StderrHandler>();
    private readonly closeHandlers = new Set<CloseHandler>();
    private readonly responseOverrides = new Map<string, {
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    }>();

    constructor() {
      MockCodexTransport.onCreate?.(this);
    }

    async writeLine(line: string): Promise<void> {
      this.lines.push(line);
      const req = JSON.parse(line) as { id?: number | string; method?: string; params?: unknown };
      if (req.id === undefined) return;
      const responseOverride = req.method ? this.responseOverrides.get(req.method) : undefined;
      if (responseOverride) {
        this.emitLine({ id: req.id, ...responseOverride });
        return;
      }
      if (req.method === 'initialize') {
        this.emitLine({
          id: req.id,
          result: {
            userAgent: 'mock-codex',
            codexHome: '/tmp/mock-codex-home',
            platformOs: 'macos',
            defaultModel: 'gpt-5.4',
            logFile: '/tmp/mock-codex.log',
          },
        });
        return;
      }
      if (req.method === 'thread/start') {
        if (MockCodexTransport.failThreadStart) {
          this.emitLine({
            id: req.id,
            error: { code: -32000, message: 'thread start boom' },
          });
          return;
        }
        await MockCodexTransport.beforeThreadStartResponse?.(this);
        this.emitLine({
          id: req.id,
          result: {
            thread: { id: `thread-${MockCodexTransport.threadSeq++}` },
            model: 'gpt-5.4',
            modelProvider: 'openai',
            cwd: '/repo',
          },
        });
        return;
      }
      if (req.method === 'thread/resume') {
        this.emitLine({
          id: req.id,
          result: {
            thread: { id: `thread-${MockCodexTransport.threadSeq++}` },
            model: 'gpt-5.4',
            modelProvider: 'openai',
            cwd: '/repo',
          },
        });
        return;
      }
      if (req.method === 'thread/fork') {
        this.emitLine({
          id: req.id,
          result: {
            thread: { id: `fork-thread-${MockCodexTransport.threadSeq++}` },
            model: 'gpt-5.4',
            modelProvider: 'openai',
          },
        });
        return;
      }
      if (req.method === 'thread/rollback') {
        this.emitLine({
          id: req.id,
          result: {
            thread: { id: `rollback-thread-${MockCodexTransport.threadSeq++}` },
          },
        });
        return;
      }
      if (req.method === 'thread/unsubscribe') {
        if (MockCodexTransport.dropThreadUnsubscribe) return;
        this.emitLine({ id: req.id, result: { status: 'unsubscribed' } });
        return;
      }
      if (req.method === 'skills/list') {
        const params = req.params as { cwds?: string[] } | undefined;
        const cwds = params?.cwds ?? ['/repo'];
        this.emitLine({
          id: req.id,
          result: {
            data: cwds.map((cwd) => ({
              cwd,
              skills: [],
              errors: [],
            })),
          },
        });
        return;
      }
      if (req.method === 'model/list') {
        this.emitLine({ id: req.id, result: { data: [], nextCursor: null } });
        return;
      }
      if (req.method === 'config/read') {
        this.emitLine({
          id: req.id,
          result: { config: { features: { memories: this.memoryEnabled } } },
        });
        return;
      }
      if (req.method === 'experimentalFeature/enablement/set') {
        const params = req.params as { enablement?: { memories?: unknown } } | undefined;
        if (typeof params?.enablement?.memories === 'boolean') {
          this.memoryEnabled = params.enablement.memories;
        }
        this.emitLine({ id: req.id, result: {} });
        return;
      }
      if (req.method === 'memory/reset') {
        this.emitLine({ id: req.id, result: {} });
        return;
      }
      this.emitLine({
        id: req.id,
        error: { code: -32601, message: `unexpected method: ${req.method}` },
      });
    }

    onLine(handler: LineHandler): () => void {
      this.lineHandlers.add(handler);
      return () => this.lineHandlers.delete(handler);
    }

    onStderr(handler: StderrHandler): () => void {
      this.stderrHandlers.add(handler);
      return () => this.stderrHandlers.delete(handler);
    }

    onClose(handler: CloseHandler): () => void {
      this.closeHandlers.add(handler);
      return () => this.closeHandlers.delete(handler);
    }

    async close(reason = 'MockCodexTransport.close()'): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      for (const handler of this.closeHandlers) {
        handler({ reason });
      }
    }

    emitMockLine(message: unknown): void {
      this.emitLine(message);
    }

    emitMockStderr(line: string): void {
      for (const handler of this.stderrHandlers) handler(line);
    }

    setMockResponse(
      method: string,
      response: {
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      },
    ): void {
      this.responseOverrides.set(method, response);
    }

    private emitLine(message: unknown): void {
      const line = JSON.stringify(message);
      queueMicrotask(() => {
        for (const handler of this.lineHandlers) handler(line);
      });
    }
  }

  const createdTransports: MockCodexTransport[] = [];
  return { MockCodexTransport, createdTransports };
});

vi.mock('./app-server/stdioTransport.js', () => ({
  createStdioTransport: () => {
    const transport = new MockCodexTransport();
    createdTransports.push(transport);
    return transport;
  },
}));

beforeEach(() => {
  createdTransports.length = 0;
  MockCodexTransport.threadSeq = 1;
  MockCodexTransport.failThreadStart = false;
  MockCodexTransport.dropThreadUnsubscribe = false;
  MockCodexTransport.beforeThreadStartResponse = null;
  MockCodexTransport.onCreate = null;
});

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function createNoopLogger(): Logger {
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

function createDeps(
  runtimeConfig: AgentDeps['runtimeConfig'] = {},
  overrides: Partial<AgentDeps> = {},
): AgentDeps {
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
    runtimeConfig,
    binaryPath: process.execPath,
    logger: createNoopLogger(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForExpectation(assertion: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function installFakeHost(
  agent: CodexAgent,
  requestImpl?: (method: string, params: unknown) => Promise<unknown> | unknown,
  opts: {
    codexProxyActive?: boolean;
    remoteCompactionProviderId?: string;
    userAgent?: string;
    codexHome?: string;
  } = {},
) {
  const ensureStarted = vi.fn(async () => ({
    userAgent: opts.userAgent ?? 'mock-codex/0.144.6',
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
  }));
  let threadHandlers: ThreadEventHandlers | null = null;
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (requestImpl) {
      const response = await requestImpl(method, params);
      if (response !== undefined) return response;
    }
    if (method === Method.ThreadStart) {
      return {
        thread: { id: 'start-thread-id' },
        model: 'gpt-5.4',
        modelProvider: 'openai',
        cwd: '/repo',
      };
    }
    if (method === Method.ThreadResume) {
      return {
        thread: { id: 'resume-thread-id' },
        model: 'gpt-5.4',
        modelProvider: 'openai',
        cwd: '/repo',
      };
    }
    if (method === Method.ThreadFork) {
      return {
        thread: { id: 'fork-thread-id' },
        model: 'gpt-5.4',
        modelProvider: 'openai',
      };
    }
    if (method === Method.ThreadRollback) {
      return { thread: { id: 'rollback-thread-id' } };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const subscribeThread = vi.fn((_threadId: string, handlers: ThreadEventHandlers) => {
    threadHandlers = handlers;
    return { release: vi.fn() };
  });
  const unsubscribeThread = vi.fn(async (_threadId: string) => {});
  const isCodexProxyActive = vi.fn(() => opts.codexProxyActive === true);
  const getRemoteCompactionProviderId = vi.fn(() => opts.remoteCompactionProviderId ?? null);
  const host = {
    ensureStarted,
    request,
    subscribeThread,
    unsubscribeThread,
    isCodexProxyActive,
    getRemoteCompactionProviderId,
    getConnectionId: () => 'test-connection',
    getThreadHandlers: () => threadHandlers,
  };

  Object.defineProperty(agent, 'getHost', {
    value: async () => host,
  });

  return host;
}

async function nextEvent(iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<AgentEvent>>((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for event')), 50);
    }),
  ]);
  if (result.done) throw new Error('event stream ended');
  return result.value;
}

describe('CodexAgent permissions', () => {
  it('advertises distinct Ask, Auto, and Full access modes', () => {
    const agent = new CodexAgent(createDeps());
    expect(agent.capabilities.permissionModes?.map((mode) => mode.id)).toEqual([
      'ask',
      'auto',
      'bypassPermissions',
    ]);
    expect(agent.capabilities.extraDirs).toEqual({ supported: true });
  });
});

describe('CodexAgent reference directories', () => {
  const profileName = 'cindy-readonly-references';

  it('keeps reference roots read-only on thread/start and every turn', async () => {
    const agent = new CodexAgent(createDeps());
    let turnSeq = 0;
    const host = installFakeHost(
      agent,
      (method) => {
        if (method === Method.TurnStart) return { turn: { id: `turn-${++turnSeq}` } };
        return undefined;
      },
      { codexHome: '/tmp/mock-codex-home' },
    );
    const handle = await agent.startSession({
      sessionId: 'session-extra-dirs',
      model: 'gpt-5.4',
      workingDir: '/repo',
      extraDirs: ['/shared-a'],
    });

    const [, startParams] = host.request.mock.calls.find(
      ([method]) => method === Method.ThreadStart,
    ) as [string, Record<string, unknown>];
    expect(startParams.runtimeWorkspaceRoots).toEqual(['/repo', '/shared-a']);
    expect(startParams.permissions).toBe(profileName);
    expect('sandbox' in startParams).toBe(false);

    const profile = (
      startParams.config as Record<string, {
        filesystem: Record<string, unknown>;
        network: { enabled: boolean };
      }>
    )[`permissions.${profileName}`];
    expect(profile).toBeDefined();
    expect(profile.network).toEqual({ enabled: false });
    expect(profile.filesystem).toMatchObject({
      ':root': 'read',
      ':workspace_roots': 'read',
      ':tmpdir': 'write',
      ':slash_tmp': 'write',
      '/repo': {
        '.': 'write',
        '.git': 'read',
        '.agents': 'read',
        '.codex': 'read',
      },
      '/tmp/mock-codex-home/memories': 'write',
    });
    expect(profile.filesystem['/shared-a']).toBeUndefined();

    await handle.send({ type: 'user', content: 'read the shared project' });
    const turnCalls = () => host.request.mock.calls.filter(
      ([method]) => method === Method.TurnStart,
    );
    const [, firstTurn] = turnCalls()[0] as [string, Record<string, unknown>];
    expect(firstTurn.runtimeWorkspaceRoots).toEqual(['/repo', '/shared-a']);
    expect(firstTurn.permissions).toBe(profileName);
    expect('sandboxPolicy' in firstTurn).toBe(false);

    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1', status: 'completed' },
    });

    await handle.setExtraDirs?.(['/shared-b']);
    await handle.send({ type: 'user', content: 'use the replacement reference' });
    const [, secondTurn] = turnCalls()[1] as [string, Record<string, unknown>];
    expect(secondTurn.runtimeWorkspaceRoots).toEqual(['/repo', '/shared-b']);
    expect(secondTurn.permissions).toBe(profileName);
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-2', status: 'completed' },
    });

    await handle.setPermissionMode?.('bypassPermissions');
    await handle.send({ type: 'user', content: 'run with full access' });
    const [, bypassTurn] = turnCalls()[2] as [string, Record<string, unknown>];
    expect(bypassTurn.runtimeWorkspaceRoots).toEqual(['/repo', '/shared-b']);
    expect('permissions' in bypassTurn).toBe(false);
    expect(bypassTurn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-3', status: 'completed' },
    });

    await handle.setPermissionMode?.('ask');
    await handle.setExtraDirs?.([]);
    await handle.send({ type: 'user', content: 'continue without references' });
    const [, noReferencesTurn] = turnCalls()[3] as [string, Record<string, unknown>];
    expect(noReferencesTurn.runtimeWorkspaceRoots).toEqual(['/repo']);
    expect('permissions' in noReferencesTurn).toBe(false);
    expect(noReferencesTurn.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/tmp/mock-codex-home/memories'],
    });
    await handle.close();
  });

  it('restores reference roots and the permission profile on thread/resume', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-extra-dirs-resume',
      model: 'gpt-5.4',
      workingDir: '/repo',
      extraDirs: ['/shared-resume'],
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
    });

    const [, resumeParams] = host.request.mock.calls.find(
      ([method]) => method === Method.ThreadResume,
    ) as [string, Record<string, unknown>];
    expect(resumeParams.runtimeWorkspaceRoots).toEqual(['/repo', '/shared-resume']);
    expect(resumeParams.permissions).toBe(profileName);
    expect('sandbox' in resumeParams).toBe(false);
    expect(resumeParams.config).toHaveProperty(`permissions.${profileName}`);
    await handle.close();
  });

  it('reapplies roots and the profile when a stale daemon requires resume + retry', async () => {
    const agent = new CodexAgent(createDeps());
    let turnStartCount = 0;
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        turnStartCount += 1;
        if (turnStartCount === 1) throw new Error('thread not found');
        return { turn: { id: 'turn-retry' } };
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-extra-dirs-retry',
      model: 'gpt-5.4',
      workingDir: '/repo',
      extraDirs: ['/shared-retry'],
    });

    await handle.send({ type: 'user', content: 'retry after restart' });

    const resumeCalls = host.request.mock.calls.filter(
      ([method]) => method === Method.ThreadResume,
    );
    expect(resumeCalls).toHaveLength(1);
    const [, resumeParams] = resumeCalls[0] as [string, Record<string, unknown>];
    expect(resumeParams.runtimeWorkspaceRoots).toEqual(['/repo', '/shared-retry']);
    expect(resumeParams.permissions).toBe(profileName);
    expect(resumeParams.config).toHaveProperty(`permissions.${profileName}`);

    const turnCalls = host.request.mock.calls.filter(
      ([method]) => method === Method.TurnStart,
    );
    expect(turnCalls).toHaveLength(2);
    for (const [, params] of turnCalls as Array<[string, Record<string, unknown>]>) {
      expect(params.runtimeWorkspaceRoots).toEqual(['/repo', '/shared-retry']);
      expect(params.permissions).toBe(profileName);
      expect('sandboxPolicy' in params).toBe(false);
    }
    await handle.close();
  });

  it('rejects reference roots when a remote app-server is too old to keep them read-only', async () => {
    const agent = new CodexAgent(createDeps());
    installFakeHost(agent, undefined, { userAgent: 'mock-codex/0.143.0' });
    await expect(agent.startSession({
      sessionId: 'session-extra-dirs-old-server',
      model: 'gpt-5.4',
      workingDir: '/repo',
      extraDirs: ['/shared-old'],
    })).rejects.toThrow('require app-server 0.144.6 or newer');
  });
});

describe('CodexAgent.listCustomizations', () => {
  it('uses filesystem scanning without starting the Codex app-server', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-codex-customizations-'));
    tempRoots.push(root);
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    const globalSkill = path.join(home, '.agents', 'skills', 'global-demo');
    const repoSkill = path.join(repo, '.agents', 'skills', 'repo-demo');
    await fs.mkdir(globalSkill, { recursive: true });
    await fs.writeFile(
      path.join(globalSkill, 'SKILL.md'),
      ['---', 'description: Global demo', '---', '', '# Global demo', ''].join('\n'),
      'utf-8',
    );
    await fs.mkdir(repoSkill, { recursive: true });
    await fs.writeFile(
      path.join(repoSkill, 'SKILL.md'),
      ['---', 'description: Repo demo', '---', '', '# Repo demo', ''].join('\n'),
      'utf-8',
    );
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    const agent = new CodexAgent(createDeps());
    const result = await agent.listCustomizations({ workingDirs: [repo], kinds: ['skill'] });

    expect(createdTransports).toHaveLength(0);
    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => ({
      engine: item.engine,
      kind: item.kind,
      scope: item.scope,
      name: item.name,
      description: item.description,
      workingDir: item.workingDir,
    }))).toEqual([
      {
        engine: 'codex',
        kind: 'skill',
        scope: 'repo',
        name: 'repo-demo',
        description: 'Repo demo',
        workingDir: repo,
      },
      {
        engine: 'codex',
        kind: 'skill',
        scope: 'user',
        name: 'global-demo',
        description: 'Global demo',
        workingDir: undefined,
      },
    ]);
  });
});

describe('CodexAgent.refreshLocalModels', () => {
  it('reads every model/list page and publishes one complete snapshot', async () => {
    const onCodexLocalModelsListed = vi.fn().mockResolvedValue(undefined);
    const agent = new CodexAgent(createDeps({}, { onCodexLocalModelsListed }));
    const pages = new Map<string | null, unknown>([
      [null, {
        data: [{ id: 'gpt-5.6', model: 'gpt-5.6', displayName: 'GPT-5.6' }],
        nextCursor: 'page-2',
      }],
      ['page-2', {
        data: [{ id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5' }],
        nextCursor: null,
      }],
    ]);
    const host = installFakeHost(agent, (method, params) => {
      if (method !== Method.ModelList) return undefined;
      const cursor = (params as { cursor?: string | null }).cursor ?? null;
      return pages.get(cursor);
    });
    (agent as unknown as { hosts: Map<string, unknown> }).hosts.set('local', host);

    await expect(agent.refreshLocalModels()).resolves.toBe(true);
    expect(host.request.mock.calls.filter(([method]) => method === Method.ModelList)).toEqual([
      [Method.ModelList, { cursor: null, limit: 100, includeHidden: false }],
      [Method.ModelList, { cursor: 'page-2', limit: 100, includeHidden: false }],
    ]);
    expect(onCodexLocalModelsListed).toHaveBeenCalledOnce();
    expect(onCodexLocalModelsListed.mock.calls[0][0].map((model: { id: string }) => model.id))
      .toEqual(['gpt-5.6', 'gpt-5.5']);
  });

  it('rejects a repeated cursor without publishing a partial snapshot', async () => {
    const onCodexLocalModelsListed = vi.fn();
    const agent = new CodexAgent(createDeps({}, { onCodexLocalModelsListed }));
    let page = 0;
    const host = installFakeHost(agent, (method) => {
      if (method !== Method.ModelList) return undefined;
      page += 1;
      return { data: [], nextCursor: 'same-cursor' };
    });
    (agent as unknown as { hosts: Map<string, unknown> }).hosts.set('local', host);

    await expect(agent.refreshLocalModels()).rejects.toThrow('repeated cursor: same-cursor');
    expect(page).toBe(2);
    expect(onCodexLocalModelsListed).not.toHaveBeenCalled();
  });

  it('drops a late model/list result after the originating host is retired', async () => {
    const onCodexLocalModelsListed = vi.fn();
    const agent = new CodexAgent(createDeps({}, { onCodexLocalModelsListed }));
    const host = installFakeHost(agent, (method) => {
      if (method !== Method.ModelList) return undefined;
      (agent as unknown as { hosts: Map<string, unknown> }).hosts.delete('local');
      return { data: [{ id: 'old', model: 'old' }], nextCursor: null };
    });
    (agent as unknown as { hosts: Map<string, unknown> }).hosts.set('local', host);

    await expect(agent.refreshLocalModels()).resolves.toBe(false);
    expect(onCodexLocalModelsListed).not.toHaveBeenCalled();
  });
});

describe('CodexAgent.startSession developerInstructions', () => {
  it('rejects session creation when thread/start fails', async () => {
    const workingDir = path.join('workspace', 'repo');
    const agent = new CodexAgent(createDeps());
    installFakeHost(agent, (method) => {
      if (method === Method.ThreadStart) {
        throw new Error('thread start boom');
      }
      return undefined;
    });

    await expect(agent.startSession({
      sessionId: 'session-start-failed',
      model: 'gpt-5.4',
      workingDir,
    })).rejects.toThrow('Failed to start Codex thread: Error: thread start boom');
  });

  it('rejects session creation when thread/resume fails', async () => {
    const workingDir = path.join('workspace', 'repo');
    const agent = new CodexAgent(createDeps());
    installFakeHost(agent, (method) => {
      if (method === Method.ThreadResume) {
        throw new Error('thread resume boom');
      }
      return undefined;
    });

    await expect(agent.startSession({
      sessionId: 'session-resume-failed',
      model: 'gpt-5.4',
      workingDir,
      resumeSessionId: '11111111-1111-1111-1111-111111111111',
    })).rejects.toThrow('Failed to resume Codex thread: Error: thread resume boom');
  });

  it('blocks local credential changes while a local session is still starting', async () => {
    const workingDir = path.join('workspace', 'repo');
    const agent = new CodexAgent(createDeps());
    const threadStartGate = deferred<void>();
    const host = installFakeHost(agent, async (method) => {
      if (method === Method.ThreadStart) {
        await threadStartGate.promise;
      }
      return undefined;
    });

    const startPromise = agent.startSession({
      sessionId: 'session-starting',
      model: 'gpt-5.4',
      workingDir,
    });

    await waitForExpectation(() => {
      expect(host.request).toHaveBeenCalledWith(Method.ThreadStart, expect.anything());
    });

    const guard = await agent.beginLocalHostCredentialChange('test credential change');
    try {
      expect(() => guard.assertIdle()).toThrow(/active Codex session/);
    } finally {
      guard.release();
    }

    threadStartGate.resolve();
    const handle = await startPromise;
    await handle.close();
  });

  it('passes the OpenAI compaction provider to thread/start only for oauth-family sessions', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, undefined, {
      codexProxyActive: true,
      remoteCompactionProviderId: 'cindy_openai',
    });

    // 显式 openai 来源(ChatGPT 订阅直连)→ thread 选 OpenAI 身份 provider(远端压缩)。
    const oauthHandle = await agent.startSession({
      sessionId: 'session-oauth',
      model: 'gpt-5.4',
      providerId: 'openai',
      workingDir: '/repo',
    });
    const oauthParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      modelProvider?: string;
    };
    expect(oauthParams.modelProvider).toBe('cindy_openai');
    await oauthHandle.close();

    // 折扣 codex/(gateway-key 家族)→ 保持默认 provider(本地压缩)。
    host.request.mock.calls.length = 0;
    const gatewayHandle = await agent.startSession({
      sessionId: 'session-gateway',
      model: 'codex/gpt-5.5',
      providerId: 'xd',
      workingDir: '/repo',
    });
    const gatewayParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      modelProvider?: string;
    };
    expect(gatewayParams.modelProvider).toBeUndefined();
    await gatewayHandle.close();

    // xAI(provider-oauth 家族)→ 保持默认 provider。
    host.request.mock.calls.length = 0;
    const xaiHandle = await agent.startSession({
      sessionId: 'session-xai',
      model: 'xai/grok-4.3',
      providerId: 'xai',
      workingDir: '/repo',
    });
    const xaiParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      modelProvider?: string;
    };
    expect(xaiParams.modelProvider).toBeUndefined();
    await xaiHandle.close();
  });

  it('passes the OpenAI compaction provider for implicit-source sessions on an oauth-effective host', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, undefined, {
      codexProxyActive: true,
      remoteCompactionProviderId: 'cindy_openai',
    });
    // 隐式来源(providerId 缺省 + 普通模型)解析不出凭证家族,回退读 host 登记的
    // 归一化生效形态(createHost 时写入);oauth spawn → 订阅直连 → 授予 OpenAI 身份。
    (agent as unknown as { hostEffectiveCredentialModes: Map<string, string> })
      .hostEffectiveCredentialModes.set('local', 'oauth-bearer');

    const handle = await agent.startSession({
      sessionId: 'session-implicit-oauth',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const params = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      modelProvider?: string;
    };
    expect(params.modelProvider).toBe('cindy_openai');
    await handle.close();

    // 对照:host 生效形态为 gateway-key(API key fallback)时,隐式会话不授予。
    (agent as unknown as { hostEffectiveCredentialModes: Map<string, string> })
      .hostEffectiveCredentialModes.set('local', 'gateway-key');
    host.request.mock.calls.length = 0;
    const gatewayHandle = await agent.startSession({
      sessionId: 'session-implicit-gateway',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const gatewayParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      modelProvider?: string;
    };
    expect(gatewayParams.modelProvider).toBeUndefined();
    await gatewayHandle.close();
  });

  it('omits the OpenAI compaction provider when the host did not advertise one', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, undefined, { codexProxyActive: true });

    const handle = await agent.startSession({
      sessionId: 'session-no-compact-provider',
      model: 'gpt-5.4',
      providerId: 'openai',
      workingDir: '/repo',
    });
    const params = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      modelProvider?: string;
    };
    expect(params.modelProvider).toBeUndefined();
    await handle.close();
  });

  it('passes the OpenAI compaction provider to thread/resume for oauth-family sessions', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, undefined, {
      codexProxyActive: true,
      remoteCompactionProviderId: 'cindy_openai',
    });

    const handle = await agent.startSession({
      sessionId: 'session-oauth-resume',
      model: 'gpt-5.4',
      providerId: 'openai',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
    });
    const params = host.request.mock.calls.find(([method]) => method === Method.ThreadResume)?.[1] as {
      modelProvider?: string;
    };
    expect(params.modelProvider).toBe('cindy_openai');
    await handle.close();
  });

  it('omits thread/start developerInstructions and registers prompt when codex proxy is active', async () => {
    const runtimeConfig = { systemPrompt: 'HOST PRODUCT PROMPT' };
    const userPrompt = [
      'You are a worker agent in an Orca multi-agent workflow.',
      'ALWAYS call send_to_lead when complete or blocked.',
      'worker_id=worker-test-id',
    ].join('\n');
    const baselineAgent = new CodexAgent(createDeps(runtimeConfig));
    const baselineHost = installFakeHost(baselineAgent);
    const registerCodexSystemPromptForThread = vi.fn();
    const proxyAgent = new CodexAgent(createDeps(runtimeConfig, {
      registerCodexSystemPromptForThread,
    }));
    const proxyHost = installFakeHost(proxyAgent, undefined, { codexProxyActive: true });

    const baselineHandle = await baselineAgent.startSession({
      sessionId: 'session-baseline',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt,
    });
    const proxyHandle = await proxyAgent.startSession({
      sessionId: 'session-proxy',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt,
    });

    const baselineParams = baselineHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    const proxyParams = proxyHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    expect(proxyParams.developerInstructions).toBeUndefined();
    expect(registerCodexSystemPromptForThread).toHaveBeenCalledTimes(1);
    expect(registerCodexSystemPromptForThread).toHaveBeenCalledWith({
      sessionId: 'session-proxy',
      threadId: 'start-thread-id',
      text: baselineParams.developerInstructions,
    });
    expect(proxyHandle.codexProductPromptDelivery).toEqual({
      threadId: 'start-thread-id',
      historyHasProductPrompt: false,
    });
    expect(baselineParams.developerInstructions).toContain('HOST PRODUCT PROMPT');
    expect(baselineParams.developerInstructions).toContain('send_to_lead');
    expect(baselineParams.developerInstructions).toContain('worker_id=worker-test-id');

    await baselineHandle.close();
    await proxyHandle.close();
  });

  it('omits thread/resume developerInstructions and registers prompt when codex proxy is active', async () => {
    const runtimeConfig = { systemPrompt: 'HOST PRODUCT PROMPT' };
    const userPrompt = [
      'You are a worker agent in an Orca multi-agent workflow.',
      'ALWAYS call send_to_lead when complete or blocked.',
      'worker_id=worker-test-id',
    ].join('\n');
    const resumeSessionId = '123e4567-e89b-12d3-a456-426614174000';
    const startBaselineAgent = new CodexAgent(createDeps(runtimeConfig));
    const startBaselineHost = installFakeHost(startBaselineAgent);
    const registerCodexSystemPromptForThread = vi.fn();
    const proxyAgent = new CodexAgent(createDeps(runtimeConfig, {
      registerCodexSystemPromptForThread,
    }));
    const proxyHost = installFakeHost(proxyAgent, undefined, { codexProxyActive: true });

    const startBaselineHandle = await startBaselineAgent.startSession({
      sessionId: 'session-baseline',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt,
    });
    const proxyHandle = await proxyAgent.startSession({
      sessionId: 'session-proxy',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId,
      codexHistoryHasProductPrompt: false,
      userPrompt,
    });

    const startBaselineParams = startBaselineHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    const proxyParams = proxyHost.request.mock.calls.find(([method]) => method === Method.ThreadResume)?.[1] as {
      developerInstructions?: string;
    };
    expect(proxyParams.developerInstructions).toBeUndefined();
    expect(registerCodexSystemPromptForThread).toHaveBeenCalledTimes(1);
    expect(registerCodexSystemPromptForThread).toHaveBeenCalledWith({
      sessionId: 'session-proxy',
      threadId: 'resume-thread-id',
      text: startBaselineParams.developerInstructions,
    });
    expect(proxyHandle.codexProductPromptDelivery).toEqual({
      threadId: 'resume-thread-id',
      historyHasProductPrompt: false,
    });
    expect(startBaselineParams.developerInstructions).toContain('HOST PRODUCT PROMPT');
    expect(startBaselineParams.developerInstructions).toContain('send_to_lead');
    expect(startBaselineParams.developerInstructions).toContain('worker_id=worker-test-id');

    await startBaselineHandle.close();
    await proxyHandle.close();
  });

  it('omits developerInstructions from thread/resume params when codex proxy is inactive and history already has product prompt', async () => {
    const registerCodexSystemPromptForThread = vi.fn();
    const agent = new CodexAgent(createDeps(
      { systemPrompt: 'HOST PRODUCT PROMPT' },
      {
        registerCodexSystemPromptForThread,
      },
    ));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-inactive-resume',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
      codexHistoryHasProductPrompt: true,
      userPrompt: 'USER PROMPT',
    });

    expect(host.request).toHaveBeenCalledWith(
      Method.ThreadResume,
      expect.objectContaining({
        threadId: '123e4567-e89b-12d3-a456-426614174000',
      }),
    );
    const resumeParams = host.request.mock.calls.find(([method]) => method === Method.ThreadResume)?.[1] as {
      developerInstructions?: string;
    };
    expect(resumeParams.developerInstructions).toBeUndefined();
    expect(handle.codexProductPromptDelivery).toBeUndefined();
    expect(registerCodexSystemPromptForThread).not.toHaveBeenCalled();
    await handle.close();
  });

  it('restores developerInstructions on thread/resume when codex proxy is inactive and history lacks product prompt', async () => {
    const runtimeConfig = { systemPrompt: 'HOST PRODUCT PROMPT' };
    const userPrompt = 'USER PROMPT';
    const resumeSessionId = '123e4567-e89b-12d3-a456-426614174000';
    const baselineAgent = new CodexAgent(createDeps(runtimeConfig));
    const baselineHost = installFakeHost(baselineAgent);
    const registerCodexSystemPromptForThread = vi.fn();
    const resumeAgent = new CodexAgent(createDeps(runtimeConfig, {
      registerCodexSystemPromptForThread,
    }));
    const resumeHost = installFakeHost(resumeAgent);

    const baselineHandle = await baselineAgent.startSession({
      sessionId: 'session-baseline',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt,
    });
    const resumeHandle = await resumeAgent.startSession({
      sessionId: 'session-restore',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId,
      codexHistoryHasProductPrompt: false,
      userPrompt,
    });

    const baselineParams = baselineHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    const resumeParams = resumeHost.request.mock.calls.find(([method]) => method === Method.ThreadResume)?.[1] as {
      developerInstructions?: string;
    };
    expect(resumeParams.developerInstructions).toBe(baselineParams.developerInstructions);
    expect(resumeParams.developerInstructions).toContain('HOST PRODUCT PROMPT');
    expect(resumeParams.developerInstructions).toContain('USER PROMPT');
    expect(resumeHandle.codexProductPromptDelivery).toEqual({
      threadId: 'resume-thread-id',
      historyHasProductPrompt: true,
    });
    expect(registerCodexSystemPromptForThread).not.toHaveBeenCalled();
    await baselineHandle.close();
    await resumeHandle.close();
  });

  it('restores developerInstructions on thread/resume when codex proxy is inactive and history prompt state is unknown', async () => {
    const registerCodexSystemPromptForThread = vi.fn();
    const agent = new CodexAgent(createDeps(
      { systemPrompt: 'HOST PRODUCT PROMPT' },
      {
        registerCodexSystemPromptForThread,
      },
    ));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-unknown-resume',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
      userPrompt: 'USER PROMPT',
    });

    const resumeParams = host.request.mock.calls.find(([method]) => method === Method.ThreadResume)?.[1] as {
      developerInstructions?: string;
    };
    expect(resumeParams.developerInstructions).toContain('HOST PRODUCT PROMPT');
    expect(resumeParams.developerInstructions).toContain('USER PROMPT');
    expect(handle.codexProductPromptDelivery).toEqual({
      threadId: 'resume-thread-id',
      historyHasProductPrompt: true,
    });
    expect(registerCodexSystemPromptForThread).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps developerInstructions when codex proxy is inactive', async () => {
    const registerCodexSystemPromptForThread = vi.fn();
    const agent = new CodexAgent(createDeps(
      { systemPrompt: 'HOST PRODUCT PROMPT' },
      {
        registerCodexSystemPromptForThread,
      },
    ));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-inactive',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });

    const startParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    expect(startParams.developerInstructions).toContain('HOST PRODUCT PROMPT');
    expect(startParams.developerInstructions).toContain('USER PROMPT');
    expect(handle.codexProductPromptDelivery).toEqual({
      threadId: 'start-thread-id',
      historyHasProductPrompt: true,
    });
    expect(registerCodexSystemPromptForThread).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps developerInstructions when codex proxy active hook is missing', async () => {
    const registerCodexSystemPromptForThread = vi.fn();
    const agent = new CodexAgent(createDeps(
      { systemPrompt: 'HOST PRODUCT PROMPT' },
      { registerCodexSystemPromptForThread },
    ));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-no-active-hook',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });

    const startParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    expect(startParams.developerInstructions).toContain('HOST PRODUCT PROMPT');
    expect(startParams.developerInstructions).toContain('USER PROMPT');
    expect(registerCodexSystemPromptForThread).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps developerInstructions when codex proxy is active but no register hook exists', async () => {
    const agent = new CodexAgent(createDeps(
      { systemPrompt: 'HOST PRODUCT PROMPT' },
      {},
    ));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-no-register-hook',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });

    const startParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    expect(startParams.developerInstructions).toContain('HOST PRODUCT PROMPT');
    expect(startParams.developerInstructions).toContain('USER PROMPT');
    await handle.close();
  });

  it('keeps developerInstructions for remote sessions when their host is not proxy-active', async () => {
    const registerCodexSystemPromptForThread = vi.fn();
    const agent = new CodexAgent(createDeps(
      { systemPrompt: 'HOST PRODUCT PROMPT' },
      {
        registerCodexSystemPromptForThread,
      },
    ));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-remote',
      model: 'gpt-5.4',
      workingDir: '/repo',
      remoteHostId: 'remote-host-1',
      userPrompt: 'USER PROMPT',
    });

    const startParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    expect(startParams.developerInstructions).toContain('HOST PRODUCT PROMPT');
    expect(registerCodexSystemPromptForThread).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps thread/start developerInstructions identical to proxy resume registered text for the same prompt inputs', async () => {
    const runtimeConfig = { systemPrompt: 'HOST PRODUCT PROMPT' };
    const userPrompt = [
      'You are a worker agent in an Orca multi-agent workflow.',
      'ALWAYS call send_to_lead when complete or blocked.',
      'worker_id=worker-test-id',
    ].join('\n');
    const startAgent = new CodexAgent(createDeps(runtimeConfig));
    const registerCodexSystemPromptForThread = vi.fn();
    const resumeAgent = new CodexAgent(createDeps(runtimeConfig, {
      registerCodexSystemPromptForThread,
    }));
    const startHost = installFakeHost(startAgent);
    const resumeHost = installFakeHost(resumeAgent, undefined, { codexProxyActive: true });

    const startHandle = await startAgent.startSession({
      sessionId: 'session-start',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt,
    });
    const resumeHandle = await resumeAgent.startSession({
      sessionId: 'session-resume',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
      userPrompt,
    });

    const startParams = startHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      developerInstructions?: string;
    };
    const resumeParams = resumeHost.request.mock.calls.find(([method]) => method === Method.ThreadResume)?.[1] as {
      developerInstructions?: string;
    };
    expect(resumeParams.developerInstructions).toBeUndefined();
    expect(registerCodexSystemPromptForThread).toHaveBeenCalledTimes(1);
    expect(registerCodexSystemPromptForThread).toHaveBeenCalledWith({
      sessionId: 'session-resume',
      threadId: 'resume-thread-id',
      text: startParams.developerInstructions,
    });
    const registeredText = registerCodexSystemPromptForThread.mock.calls[0]?.[0]?.text;
    expect(registeredText).toContain(userPrompt);
    expect(registeredText).toContain('send_to_lead');
    expect(registeredText).toContain('worker_id=worker-test-id');

    await startHandle.close();
    await resumeHandle.close();
  });
});

describe('CodexAgent fast mode service tier', () => {
  it('normalizes app-server priority service tier from thread/start as fast mode', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.ThreadStart) {
        return {
          thread: { id: 'start-thread-id' },
          model: 'gpt-5.4',
          modelProvider: 'openai',
          cwd: '/repo',
          serviceTier: 'priority',
        };
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-priority-thread-start',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });

    expect(handle.getFastMode?.()).toBe(true);

    await handle.send({ type: 'user', content: 'hello' });

    const turnStartParams = host.request.mock.calls.find(([method]) => method === Method.TurnStart)?.[1] as
      | { serviceTier?: unknown }
      | undefined;
    expect(turnStartParams?.serviceTier).toBe('fast');
    await handle.close();
  });

  it('normalizes app-server priority service tier from turn/start as fast mode', async () => {
    const agent = new CodexAgent(createDeps());
    installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return {
          turn: { id: 'turn-1' },
          serviceTier: 'priority',
        };
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-priority-turn-start',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });

    await handle.send({ type: 'user', content: 'hello' });

    expect(handle.getFastMode?.()).toBe(true);
    await handle.close();
  });
});

describe('CodexAgent thread/settings/update channel', () => {
  const settingsCalls = (host: { request: { mock: { calls: Array<[string, unknown]> } } }) =>
    host.request.mock.calls.filter(([m]) => m === Method.ThreadSettingsUpdate).map(([, p]) => p);

  it('setFastMode mid-session pushes thread/settings/update (fast then null)', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 's-settings-fast',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    // startSession 走 thread/start 携带初始设置, 不应自己发 settings/update。
    expect(settingsCalls(host)).toHaveLength(0);

    await handle.setFastMode?.(true);
    await handle.setFastMode?.(false);

    expect(settingsCalls(host)).toEqual([
      { threadId: 'start-thread-id', serviceTier: 'fast' },
      { threadId: 'start-thread-id', serviceTier: null },
    ]);
    await handle.close();
  });

  it('setModel / setEffort push thread/settings/update; gpt-5 sentinel is skipped', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 's-settings-model-effort',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });

    await handle.setModel?.('gpt-5.4-codex');
    await handle.setEffort?.('low'); // 默认 high → low, 变化 → 推送
    await handle.setModel?.('gpt-5'); // server 默认哨兵 → 不推
    await handle.setEffort?.('low'); // 去重: 值没变 → 不推

    expect(settingsCalls(host)).toEqual([
      { threadId: 'start-thread-id', model: 'gpt-5.4-codex' },
      { threadId: 'start-thread-id', effort: 'low' },
    ]);
    await handle.close();
  });

  it('dedups no-op set* (re-applying identical values pushes nothing)', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 's-settings-dedup',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    // 模拟 renderer 单次切换全量重调 set*: 都是与启动时相同的值 → 一条 RPC 都不该发
    await handle.setModel?.('gpt-5.4'); // 同 model
    await handle.setEffort?.('high'); // 默认就是 high
    await handle.setFastMode?.(false); // 启动未开 fast → 仍是关
    expect(settingsCalls(host)).toEqual([]);
    await handle.close();
  });

  it('does not push thread/settings/update after close (closed gate)', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 's-settings-closed',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    await handle.close();
    const before = settingsCalls(host).length;
    await handle.setFastMode?.(true);
    expect(settingsCalls(host).length).toBe(before);
  });

  it('reconciles local state from thread/settings/updated (server fast downgrade)', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.ThreadStart) {
        return {
          thread: { id: 'start-thread-id' },
          model: 'gpt-5.4',
          modelProvider: 'openai',
          cwd: '/repo',
          serviceTier: 'fast',
        };
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 's-settings-notif',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    expect(handle.getFastMode?.()).toBe(true);

    // server 因模型不支持 fast 而降级, 回带权威快照。
    host.getThreadHandlers()?.threadSettingsUpdated?.({
      threadId: 'start-thread-id',
      threadSettings: { serviceTier: null, model: 'gpt-5.4-codex', effort: 'high' },
    });

    expect(handle.getFastMode?.()).toBe(false);
    expect(handle.model).toBe('gpt-5.4-codex');
    await handle.close();
  });

  it('swallows thread/settings/update failure and still carries serviceTier via turn/start', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.ThreadSettingsUpdate) throw new Error('boom');
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 's-settings-reject',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });

    await handle.setFastMode?.(true);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 让被吞的 rejection 落定

    await handle.send({ type: 'user', content: 'hi' });
    const turn = host.request.mock.calls.find(([m]) => m === Method.TurnStart)?.[1] as
      | { serviceTier?: unknown }
      | undefined;
    expect(turn?.serviceTier).toBe('fast');
    await handle.close();
  });
});

describe('CodexAgent send', () => {
  it('clamps minimal effort to low before turn/start', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-minimal-effort',
      model: 'gpt-5.4-mini',
      effort: 'minimal',
      workingDir: '/repo',
    });

    await handle.send({ type: 'user', content: 'hello' });

    expect(host.request).toHaveBeenCalledWith(
      Method.TurnStart,
      expect.objectContaining({
        effort: 'low',
      }),
    );
    await handle.close();
  });

  it('keeps medium effort before turn/start', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-medium-effort',
      model: 'gpt-5.4-mini',
      effort: 'medium',
      workingDir: '/repo',
    });

    await handle.send({ type: 'user', content: 'hello' });

    expect(host.request).toHaveBeenCalledWith(
      Method.TurnStart,
      expect.objectContaining({
        effort: 'medium',
      }),
    );
    await handle.close();
  });

  it('passes max effort through to turn/start without downgrade (issue #352)', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-max-effort',
      model: 'gpt-5.4-mini',
      effort: 'max',
      workingDir: '/repo',
    });

    await handle.send({ type: 'user', content: 'hello' });

    expect(host.request).toHaveBeenCalledWith(
      Method.TurnStart,
      expect.objectContaining({
        effort: 'max',
      }),
    );
    await handle.close();
  });

  it('passes ultra effort through to turn/start without downgrade (issue #352)', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-ultra-effort',
      model: 'gpt-5.4-mini',
      effort: 'ultra',
      workingDir: '/repo',
    });

    await handle.send({ type: 'user', content: 'hello' });

    expect(host.request).toHaveBeenCalledWith(
      Method.TurnStart,
      expect.objectContaining({
        effort: 'ultra',
      }),
    );
    await handle.close();
  });

  it('clamps minimal effort set during a session to low before turn/start', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-set-minimal-effort',
      model: 'gpt-5.4-mini',
      effort: 'medium',
      workingDir: '/repo',
    });

    if (!handle.setEffort) throw new Error('Codex handle should support setEffort');
    await handle.setEffort('minimal');
    await handle.send({ type: 'user', content: 'hello' });

    expect(host.request).toHaveBeenCalledWith(
      Method.TurnStart,
      expect.objectContaining({
        effort: 'low',
      }),
    );
    await handle.close();
  });

  it('rejects turn/start failures when the caller needs accepted-or-rejected semantics', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) throw new Error('turn start rejected');
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-send-start-fails',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });

    await expect(
      handle.send({ type: 'user', content: 'hello' }, { throwOnStartFailure: true }),
    ).rejects.toThrow(/turn start rejected/);
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnStart)).toHaveLength(1);

    await handle.close();
  });

  it('rejects accepted-or-rejected sends if the session closes before turn/start resolves', async () => {
    const agent = new CodexAgent(createDeps());
    const turnStart = deferred<unknown>();
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) return turnStart.promise;
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-send-close-race',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });

    const sendPromise = handle.send(
      { type: 'user', content: 'hello' },
      { throwOnStartFailure: true },
    );
    for (let i = 0; i < 5; i += 1) {
      if (host.request.mock.calls.some(([method]) => method === Method.TurnStart)) break;
      await Promise.resolve();
    }
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnStart)).toHaveLength(1);

    await handle.close();
    turnStart.resolve({ turn: { id: 'late-turn' } });

    await expect(sendPromise).rejects.toThrow(/session is closed after turn\/start/i);
  });
});

describe('CodexAgent MCP thread context hooks', () => {
  it('passes target context to Codex extra spawn config and reuses the shared local host', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: ['-c', 'mcp_servers.cindy_test.url="http://127.0.0.1:1234/mcp/cindy_test"'],
      extraEnv: { LIZI_MCP_TOKEN: 'token' },
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const first = await agent.startSession({
      sessionId: 'session-shared-host-a',
      model: 'gpt-5.4',
      workingDir: '/repo-a',
      vendorOptions: { orcaRole: 'lead' },
    });
    const second = await agent.startSession({
      sessionId: 'session-shared-host-b',
      model: 'gpt-5.4',
      workingDir: '/repo-b',
      vendorOptions: { orcaRole: 'worker' },
    });

    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledWith([], {
      remoteHostId: undefined,
      credentialMode: undefined,
    });
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].lines.some((line) => line.includes('initialize'))).toBe(true);

    await first.close();
    await second.close();
    expect(createdTransports[0].closed).toBe(false);

    await agent.dispose();
    expect(createdTransports[0].closed).toBe(true);
  });

  it('runs utility calls on the shared local host instead of spawning another local host', async () => {
    const agent = new CodexAgent(createDeps());

    const handle = await agent.startSession({
      sessionId: 'session-utility-host',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    expect(createdTransports).toHaveLength(1);

    const rateLimits = {
      rateLimits: { planType: 'plus', primary: { usedPercent: 100, windowMinutes: 300 } },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 2, credits: null },
    };
    createdTransports[0].setMockResponse(Method.AccountRateLimitsRead, { result: rateLimits });
    createdTransports[0].setMockResponse(Method.AccountRateLimitResetCreditConsume, {
      result: { outcome: 'reset' },
    });

    await agent.setMemory(true);
    const pushCountAfterSet = createdTransports[0].lines
      .filter((line) => line.includes('experimentalFeature/enablement/set'))
      .length;

    await expect(agent.listAgentSkills({ workingDir: '/repo' })).resolves.toMatchObject({
      skills: [],
    });
    await expect(agent.getMemoryStatus()).resolves.toEqual({
      enabled: true,
      source: 'host-runtime',
    });
    await expect(agent.resetMemory()).resolves.toEqual({});
    await expect(agent.readAccountRateLimits()).resolves.toEqual(rateLimits);
    await expect(agent.consumeAccountRateLimitResetCredit({
      idempotencyKey: '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
      creditId: 'credit-earliest',
    })).resolves.toEqual({ outcome: 'reset' });

    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].lines.some((line) => line.includes('skills/list'))).toBe(true);
    expect(createdTransports[0].lines.some((line) => line.includes('config/read'))).toBe(true);
    expect(createdTransports[0].lines.some((line) => line.includes('memory/reset'))).toBe(true);
    expect(createdTransports[0].lines.some((line) => line.includes('account/rateLimits/read'))).toBe(true);
    expect(createdTransports[0].lines.some((line) => (
      line.includes('account/rateLimitResetCredit/consume')
      && line.includes('018f4ec7-c6d8-7f10-8d43-9f8791d33000')
      && line.includes('credit-earliest')
    ))).toBe(true);
    expect(
      createdTransports[0].lines.filter((line) => line.includes('experimentalFeature/enablement/set')).length,
    ).toBe(pushCountAfterSet);

    await handle.close();
    await agent.dispose();
  });

  it('starts a cold OAuth host before account rate-limit RPCs', async () => {
    const rateLimits = {
      rateLimits: { planType: 'plus', primary: { usedPercent: 100, windowMinutes: 300 } },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 1, credits: null },
    };
    MockCodexTransport.onCreate = (transport) => {
      transport.setMockResponse(Method.AccountRateLimitsRead, { result: rateLimits });
      transport.setMockResponse(Method.AccountRateLimitResetCreditConsume, {
        result: { outcome: 'reset' },
      });
    };
    const agent = new CodexAgent(createDeps());

    await expect(agent.readAccountRateLimits()).resolves.toEqual(rateLimits);
    await expect(agent.consumeAccountRateLimitResetCredit({
      idempotencyKey: '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
    })).resolves.toEqual({ outcome: 'reset' });

    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].lines[0]).toContain('initialize');
    expect(createdTransports[0].lines.some((line) => line.includes('account/rateLimits/read'))).toBe(true);
    await agent.dispose();
  });

  it('refuses account reset RPCs on a differently-authenticated active host', async () => {
    const agent = new CodexAgent(createDeps());
    const handle = await agent.startSession({
      sessionId: 'session-gateway-host',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo',
    });

    await expect(agent.readAccountRateLimits()).rejects.toThrow(/active Codex session/i);
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);

    await handle.close();
    await agent.dispose();
  });

  it('does not retire an active local host for local credential restarts', async () => {
    const agent = new CodexAgent(createDeps());

    const handle = await agent.startSession({
      sessionId: 'session-local-credential-active',
      model: 'gpt-5.4',
      workingDir: '/repo-local',
    });

    await expect(agent.disposeLocalHostForCredentialChange()).rejects.toThrow(/active Codex session/i);
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);

    await handle.close();
    await agent.dispose();
  });

  it('retires only the local host when local Codex credentials change', async () => {
    const getRemoteCodexTransport = vi.fn(() => {
      const transport = new MockCodexTransport();
      createdTransports.push(transport);
      return transport;
    });
    const agent = new CodexAgent(createDeps({}, {
      getRemoteCodexTransport,
    }));

    const localHandle = await agent.startSession({
      sessionId: 'session-local-credential-restart',
      model: 'gpt-5.4',
      workingDir: '/repo-local',
    });
    const remoteHandle = await agent.startSession({
      sessionId: 'session-remote-survives-local-restart',
      model: 'gpt-5.4',
      workingDir: '/repo-remote',
      remoteHostId: 'remote-host-1',
    });
    expect(createdTransports).toHaveLength(2);

    await localHandle.close();
    await agent.disposeLocalHostForCredentialChange();

    expect(createdTransports[0].closed).toBe(true);
    expect(createdTransports[1].closed).toBe(false);

    await remoteHandle.send({ type: 'user', content: 'still remote' });
    expect(createdTransports[1].lines.some((line) => line.includes('turn/start'))).toBe(true);

    await remoteHandle.close();
    await agent.dispose();
  });

  it('force-disposes only the local host when local Codex auth logs out', async () => {
    const getRemoteCodexTransport = vi.fn(() => {
      const transport = new MockCodexTransport();
      createdTransports.push(transport);
      return transport;
    });
    const agent = new CodexAgent(createDeps({}, {
      getRemoteCodexTransport,
    }));

    const localHandle = await agent.startSession({
      sessionId: 'session-local-auth-logout',
      model: 'gpt-5.4',
      workingDir: '/repo-local',
    });
    const remoteHandle = await agent.startSession({
      sessionId: 'session-remote-survives-local-auth-logout',
      model: 'gpt-5.4',
      workingDir: '/repo-remote',
      remoteHostId: 'remote-host-1',
    });

    await agent.forceDisposeLocalHostForAuthChange();

    expect(createdTransports[0].closed).toBe(true);
    expect(createdTransports[1].closed).toBe(false);

    await remoteHandle.send({ type: 'user', content: 'still remote' });
    await localHandle.close();
    await remoteHandle.close();
    await agent.dispose();
  });

  it('collapses in-flight turn state with a terminal transport error when the local host is force-retired', async () => {
    // 回归 2026-07-19:auth 失效触发 retiring host with active sessions 时,原实现
    // 静默清 subscribers 再杀进程,session 收不到任何终态事件 → isTurnRunning 永久
    // true,上层输入排队 / Stop 锁 / 凭证切换 busy 重试全部卡死。
    const agent = new CodexAgent(createDeps());

    const handle = await agent.startSession({
      sessionId: 'session-forced-retire-in-flight-turn',
      model: 'gpt-5.4',
      workingDir: '/repo-local',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const transport = createdTransports[0];

    transport.emitMockLine({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-forced-retire' } },
    });
    await waitForExpectation(() => {
      expect(handle.isTurnRunning?.()).toBe(true);
    });

    await agent.forceDisposeLocalHostForAuthChange('test forced retire');

    expect(handle.isTurnRunning?.()).toBe(false);
    expect(transport.closed).toBe(true);
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: 'error',
      data: expect.objectContaining({
        isTerminal: true,
        willRetry: false,
        message: expect.stringContaining('app-server force-retired'),
      }),
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: 'status',
      data: expect.objectContaining({ status: 'Done', isRunning: false }),
    });

    await handle.close();
    await agent.dispose();
  });

  it('keeps shared Codex sessions usable when ordinary stderr contains auth keywords', async () => {
    const invalidate = vi.fn(async () => undefined);
    const agent = new CodexAgent(createDeps({}, {
      auth: {
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
        invalidate,
      },
    }));

    const first = await agent.startSession({
      sessionId: 'session-stderr-auth-keyword-a',
      model: 'gpt-5.4',
      workingDir: '/repo-a',
    });
    const second = await agent.startSession({
      sessionId: 'session-stderr-auth-keyword-b',
      model: 'gpt-5.4',
      workingDir: '/repo-b',
    });
    const transport = createdTransports[0];
    expect(createdTransports).toHaveLength(1);

    transport.emitMockStderr(
      'tool output: const errorCode = "token_invalidated"; // not an auth request failure',
    );
    await Promise.resolve();

    expect(invalidate).not.toHaveBeenCalled();
    expect(transport.closed).toBe(false);

    transport.setMockResponse(Method.TurnStart, {
      result: { turn: { id: 'turn-after-stderr' } },
    });
    await expect(second.send({ type: 'user', content: 'still works' })).resolves.toBeUndefined();

    transport.emitMockLine({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-to-steer-after-stderr' } },
    });
    await waitForExpectation(() => {
      expect(first.isTurnRunning?.()).toBe(true);
    });
    transport.setMockResponse(Method.TurnSteer, {
      result: { turnId: 'turn-to-steer-after-stderr' },
    });
    await expect(
      first.steer({ type: 'user', content: 'steer still works' }),
    ).resolves.toBeUndefined();

    expect(transport.closed).toBe(false);
    expect(createdTransports).toHaveLength(1);

    await first.close();
    await second.close();
    await agent.dispose();
  });

  it('retires only the local host when local Codex auth is invalidated', async () => {
    const invalidate = vi.fn(async () => undefined);
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
      invalidate,
    };
    const getRemoteCodexTransport = vi.fn(() => {
      const transport = new MockCodexTransport();
      createdTransports.push(transport);
      return transport;
    });
    const agent = new CodexAgent(createDeps({}, {
      auth,
      getRemoteCodexTransport,
    }));

    const localHandle = await agent.startSession({
      sessionId: 'session-local-auth-invalidated',
      model: 'gpt-5.4',
      workingDir: '/repo-local',
    });
    const remoteHandle = await agent.startSession({
      sessionId: 'session-remote-survives-local-auth-invalidated',
      model: 'gpt-5.4',
      workingDir: '/repo-remote',
      remoteHostId: 'remote-host-1',
    });

    createdTransports[0].setMockResponse(Method.TurnStart, {
      error: {
        code: -32000,
        message: 'OAuth refresh token was already used',
        data: { reason: 'cloudRequirements', errorCode: 'Auth' },
      },
    });
    await expect(
      localHandle.send(
        { type: 'user', content: 'trigger structured auth failure' },
        { throwOnStartFailure: true },
      ),
    ).rejects.toThrow(/refresh token was already used/i);

    await waitForExpectation(() => {
      expect(createdTransports[0].closed).toBe(true);
    });
    expect(invalidate).toHaveBeenCalledWith('refresh_token_reused');
    expect(createdTransports[1].closed).toBe(false);

    await remoteHandle.send({ type: 'user', content: 'still remote' });
    await localHandle.close();
    await remoteHandle.close();
    await agent.dispose();
  });

  it('retires only the remote host when remote Codex auth is invalidated', async () => {
    const invalidate = vi.fn(async () => undefined);
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
      invalidate,
    };
    const getRemoteCodexTransport = vi.fn(() => {
      const transport = new MockCodexTransport();
      createdTransports.push(transport);
      return transport;
    });
    const agent = new CodexAgent(createDeps({}, {
      auth,
      getRemoteCodexTransport,
    }));

    const localHandle = await agent.startSession({
      sessionId: 'session-local-survives-remote-auth-invalidated',
      model: 'gpt-5.4',
      workingDir: '/repo-local',
    });
    const remoteHandle = await agent.startSession({
      sessionId: 'session-remote-auth-invalidated',
      model: 'gpt-5.4',
      workingDir: '/repo-remote',
      remoteHostId: 'remote-host-1',
    });

    createdTransports[1].setMockResponse(Method.TurnStart, {
      error: {
        code: -32000,
        message: 'OAuth refresh token was already used',
        data: { reason: 'cloudRequirements', action: 'relogin' },
      },
    });
    await expect(
      remoteHandle.send(
        { type: 'user', content: 'trigger structured auth failure' },
        { throwOnStartFailure: true },
      ),
    ).rejects.toThrow(/refresh token was already used/i);

    await waitForExpectation(() => {
      expect(createdTransports[1].closed).toBe(true);
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(createdTransports[0].closed).toBe(false);

    await localHandle.send({ type: 'user', content: 'still local' });
    await localHandle.close();
    await remoteHandle.close();
    await agent.dispose();
  });

  it('does not retire an explicit credential host for provider-agnostic utility calls', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const handle = await agent.startSession({
      sessionId: 'session-explicit-utility-host',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo',
    });
    expect(createdTransports).toHaveLength(1);

    await expect(agent.listAgentSkills({ workingDir: '/repo' })).resolves.toMatchObject({
      skills: [],
    });

    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);

    await handle.close();
    await agent.dispose();
  });

  it('does not retire an explicit credential host for Codex fork utility calls', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const prepareCodexLocalCredentialModeSwitch: NonNullable<AgentDeps['prepareCodexLocalCredentialModeSwitch']> =
      vi.fn(async () => undefined);
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
      prepareCodexLocalCredentialModeSwitch,
    }));

    const handle = await agent.startSession({
      sessionId: 'session-explicit-fork-host',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo',
    });
    expect(createdTransports).toHaveLength(1);

    const result = await agent.forkSdkSession({
      sourceSdkSessionId: 'thread-1',
      upToMessageId: undefined,
      tailTurnsToDrop: 0,
    });

    expect(result.newSdkSessionId).toMatch(/^fork-thread-/);
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);
    expect(prepareCodexLocalCredentialModeSwitch).not.toHaveBeenCalled();

    await handle.close();
    await agent.dispose();
  });

  it('passes gateway credential mode for XD Codex sessions', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const handle = await agent.startSession({
      sessionId: 'session-xd-credential-mode',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo',
    });

    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledWith([], {
      remoteHostId: undefined,
      credentialMode: 'gateway-key',
    });

    await handle.close();
    await agent.dispose();
  });

  it('does not retire an active local host without a credential switch coordinator', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const keyHandle = await agent.startSession({
      sessionId: 'session-active-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    expect(createdTransports).toHaveLength(1);

    await expect(agent.startSession({
      sessionId: 'session-active-oauth',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo-oauth',
    })).rejects.toThrow(/active Codex session/i);

    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);

    await keyHandle.close();
    await agent.dispose();
  });

  it('recreates the local host when Codex credential mode changes', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const keyHandle = await agent.startSession({
      sessionId: 'session-mode-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    expect(createdTransports).toHaveLength(1);

    await keyHandle.close();
    const oauthHandle = await agent.startSession({
      sessionId: 'session-mode-oauth',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo-oauth',
    });

    expect(createdTransports).toHaveLength(2);
    expect(createdTransports[0].closed).toBe(true);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenNthCalledWith(1, [], {
      remoteHostId: undefined,
      credentialMode: 'gateway-key',
    });
    expect(prepareCodexExtraSpawnConfig).toHaveBeenNthCalledWith(2, [], {
      remoteHostId: undefined,
      credentialMode: 'oauth-bearer',
    });

    await oauthHandle.close();
    await agent.dispose();
  });

  it('does not reuse an explicit credential host for fallback Codex sessions', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const keyHandle = await agent.startSession({
      sessionId: 'session-explicit-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    await keyHandle.close();
    const fallbackHandle = await agent.startSession({
      sessionId: 'session-fallback',
      model: 'gpt-5.4',
      workingDir: '/repo-fallback',
    });

    expect(createdTransports).toHaveLength(2);
    expect(createdTransports[0].closed).toBe(true);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenNthCalledWith(1, [], {
      remoteHostId: undefined,
      credentialMode: 'gateway-key',
    });
    expect(prepareCodexExtraSpawnConfig).toHaveBeenNthCalledWith(2, [], {
      remoteHostId: undefined,
      credentialMode: undefined,
    });

    await fallbackHandle.close();
    await agent.dispose();
  });

  // review P1 回归:排队假死修复的核心场景。providerId=null 的 fallback 会话经
  // authSource 归一化后与显式 gateway-key host 同族 → 必须复用现有进程(不重建、
  // 不二次 spawn),且登记形态保持 gateway-key(后续显式 xd 会话也复用)。
  // spawn 契约不变:fallback 传给 prepareCodexExtraSpawnConfig 的仍是 undefined
  // (本用例复用了 host 所以根本不会二次调用;上一个用例钉住了 undefined 透传)。
  it('reuses an explicit gateway host for fallback sessions when authSource resolves to the same mode', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const auth: AuthAdapter = {
      async getState() {
        // fallback 实际钥匙是网关 key(如 `codex login --api-key` / 仅配 XD key)
        return { authenticated: true, authSource: 'api-key' };
      },
      async triggerLogin() {
        return { authenticated: true };
      },
      async logout() {},
      async getAuthEnv() {
        return {};
      },
    };
    const agent = new CodexAgent(createDeps({}, {
      auth,
      prepareCodexExtraSpawnConfig,
    }));

    const keyHandle = await agent.startSession({
      sessionId: 'session-explicit-key-normalized',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    expect(createdTransports).toHaveLength(1);
    await keyHandle.close();

    const fallbackHandle = await agent.startSession({
      sessionId: 'session-fallback-normalized',
      model: 'gpt-5.4',
      workingDir: '/repo-fallback',
    });

    // 同族复用:进程没被重建,spawn 配置也没有第二次调用
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledWith([], {
      remoteHostId: undefined,
      credentialMode: 'gateway-key',
    });
    await fallbackHandle.close();

    // 登记形态是归一化后的 gateway-key:后续显式 xd 会话同样复用,不触发重建
    const keyHandleAgain = await agent.startSession({
      sessionId: 'session-explicit-key-again',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key-2',
    });
    expect(createdTransports).toHaveLength(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);

    await keyHandleAgain.close();
    await agent.dispose();
  });

  // ── 方案 A(2026-07):oauth 超集 host,订阅/API 会话并行不排队 ───────────────

  it('serves XD gateway sessions on a live oauth superset host without restart', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: true,
    }));
    const agent = new CodexAgent(createDeps({}, { prepareCodexExtraSpawnConfig }));

    const oauthHandle = await agent.startSession({
      sessionId: 'session-superset-oauth', providerId: 'openai',
      model: 'gpt-5.4', workingDir: '/repo-oauth',
    });
    const xdHandle = await agent.startSession({
      sessionId: 'session-superset-xd', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    });

    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    await oauthHandle.close();
    await xdHandle.close();
    await agent.dispose();
  });

  it('upgrades a cold gateway-key spawn to oauth when both credentials are available', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: true,
    }));
    const auth: AuthAdapter = {
      async getState(options) {
        return options?.credentialMode === 'gateway-key'
          ? { authenticated: true, authSource: 'api-key' }
          : { authenticated: true, authSource: 'oauth' };
      },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    const agent = new CodexAgent(createDeps({}, { auth, prepareCodexExtraSpawnConfig }));

    const xdHandle = await agent.startSession({
      sessionId: 'session-cold-xd-superset', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    });
    const oauthHandle = await agent.startSession({
      sessionId: 'session-cold-oauth-parallel', providerId: 'openai',
      model: 'gpt-5.4', workingDir: '/repo-oauth',
    });

    expect(createdTransports).toHaveLength(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledWith([], {
      remoteHostId: undefined, credentialMode: 'oauth-bearer',
    });
    await xdHandle.close();
    await oauthHandle.close();
    await agent.dispose();
  });

  it('keeps gateway-key spawn for API-only users', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: true,
    }));
    const auth: AuthAdapter = {
      async getState() { return { authenticated: true, authSource: 'api-key' }; },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    const agent = new CodexAgent(createDeps({}, { auth, prepareCodexExtraSpawnConfig }));

    const handle = await agent.startSession({
      sessionId: 'session-apionly-xd', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    });
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledWith([], {
      remoteHostId: undefined, credentialMode: 'gateway-key',
    });
    await handle.close();
    await agent.dispose();
  });

  it('rejects a cold XD session without a gateway key even when OAuth is available', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: true,
    }));
    const auth: AuthAdapter = {
      async getState(options) {
        return options?.credentialMode === 'gateway-key'
          ? { authenticated: false, errorReason: 'no_key' }
          : { authenticated: true, authSource: 'oauth' };
      },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    const agent = new CodexAgent(createDeps({}, { auth, prepareCodexExtraSpawnConfig }));

    await expect(agent.startSession({
      sessionId: 'session-cold-xd-without-key', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    })).rejects.toThrow(/gateway credentials unavailable.*no_key/i);
    expect(prepareCodexExtraSpawnConfig).not.toHaveBeenCalled();
    expect(createdTransports).toHaveLength(0);
    await agent.dispose();
  });

  it('validates the gateway key before reusing a live oauth superset host', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: true,
    }));
    const auth: AuthAdapter = {
      async getState(options) {
        return options?.credentialMode === 'gateway-key'
          ? { authenticated: false, errorReason: 'no_key' }
          : { authenticated: true, authSource: 'oauth' };
      },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    const agent = new CodexAgent(createDeps({}, { auth, prepareCodexExtraSpawnConfig }));
    const oauthHandle = await agent.startSession({
      sessionId: 'session-live-oauth-before-missing-key', providerId: 'openai',
      model: 'gpt-5.4', workingDir: '/repo-oauth',
    });

    await expect(agent.startSession({
      sessionId: 'session-xd-missing-key-on-superset', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    })).rejects.toThrow(/gateway credentials unavailable.*no_key/i);
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);
    await oauthHandle.close();
    await agent.dispose();
  });

  it('downgrades a cold superset spawn when the loopback proxy is unavailable', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: false,
    }));
    const auth: AuthAdapter = {
      async getState(options) {
        return options?.credentialMode === 'gateway-key'
          ? { authenticated: true, authSource: 'api-key' }
          : { authenticated: true, authSource: 'oauth' };
      },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    const agent = new CodexAgent(createDeps({}, { auth, prepareCodexExtraSpawnConfig }));
    const handle = await agent.startSession({
      sessionId: 'session-superset-downgrade', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    });

    expect(createdTransports).toHaveLength(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(2);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenNthCalledWith(1, [], {
      remoteHostId: undefined, credentialMode: 'oauth-bearer',
    });
    expect(prepareCodexExtraSpawnConfig).toHaveBeenNthCalledWith(2, [], {
      remoteHostId: undefined, credentialMode: 'gateway-key',
    });
    await handle.close();
    await agent.dispose();
  });

  it('downgrades a cold superset spawn after a fatal OAuth proxy error', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async (_providers: unknown, ctx: { credentialMode?: string }) => {
      if (ctx.credentialMode === 'oauth-bearer') {
        const error = new Error('OAuth proxy is not ready');
        (error as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
        throw error;
      }
      return { extraArgs: [], extraEnv: {}, codexProxyActive: false };
    });
    const auth: AuthAdapter = {
      async getState(options) {
        return options?.credentialMode === 'gateway-key'
          ? { authenticated: true, authSource: 'api-key' }
          : { authenticated: true, authSource: 'oauth' };
      },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    const agent = new CodexAgent(createDeps({}, {
      auth,
      prepareCodexExtraSpawnConfig: prepareCodexExtraSpawnConfig as unknown as NonNullable<AgentDeps['prepareCodexExtraSpawnConfig']>,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-superset-fatal-downgrade', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    });

    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(2);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenLastCalledWith([], {
      remoteHostId: undefined, credentialMode: 'gateway-key',
    });
    await handle.close();
    await agent.dispose();
  });

  it('rebuilds instead of reusing an oauth host when the proxy is inactive', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: false,
    }));
    const agent = new CodexAgent(createDeps({}, { prepareCodexExtraSpawnConfig }));
    const oauthHandle = await agent.startSession({
      sessionId: 'session-nonproxy-oauth', providerId: 'openai',
      model: 'gpt-5.4', workingDir: '/repo-oauth',
    });
    await oauthHandle.close();
    const xdHandle = await agent.startSession({
      sessionId: 'session-nonproxy-xd', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    });

    expect(createdTransports).toHaveLength(2);
    expect(createdTransports[0].closed).toBe(true);
    await xdHandle.close();
    await agent.dispose();
  });

  it('deduplicates concurrent cold XD and OAuth starts while superset mode resolves', async () => {
    const fallbackEntered = deferred<void>();
    const fallbackRelease = deferred<void>();
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: true,
    }));
    const auth: AuthAdapter = {
      async getState(options) {
        if (options?.credentialMode === 'gateway-key') {
          return { authenticated: true, authSource: 'api-key' };
        }
        if (options?.credentialMode === 'oauth-bearer') {
          return { authenticated: true, authSource: 'oauth' };
        }
        fallbackEntered.resolve();
        await fallbackRelease.promise;
        return { authenticated: true, authSource: 'oauth' };
      },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    const agent = new CodexAgent(createDeps({}, { auth, prepareCodexExtraSpawnConfig }));

    const xdStart = agent.startSession({
      sessionId: 'session-concurrent-cold-xd', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    });
    await fallbackEntered.promise;
    const oauthStart = agent.startSession({
      sessionId: 'session-concurrent-cold-oauth', providerId: 'openai',
      model: 'gpt-5.4', workingDir: '/repo-oauth',
    });
    fallbackRelease.resolve();

    const [xdHandle, oauthHandle] = await Promise.all([xdStart, oauthStart]);
    expect(createdTransports).toHaveLength(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    await xdHandle.close();
    await oauthHandle.close();
    await agent.dispose();
  });

  it('starts OAuth independently when a concurrent unresolved gateway inflight fails validation', async () => {
    const gatewayEntered = deferred<void>();
    const gatewayRelease = deferred<void>();
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [], extraEnv: {}, codexProxyActive: true,
    }));
    const auth: AuthAdapter = {
      async getState(options) {
        if (options?.credentialMode === 'gateway-key') {
          gatewayEntered.resolve();
          await gatewayRelease.promise;
          return { authenticated: false, errorReason: 'expired_key' };
        }
        return { authenticated: true, authSource: 'oauth' };
      },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    const agent = new CodexAgent(createDeps({}, { auth, prepareCodexExtraSpawnConfig }));

    const xdStart = agent.startSession({
      sessionId: 'session-concurrent-invalid-xd', providerId: 'xd',
      model: 'codex/gpt-5.5', workingDir: '/repo-xd',
    });
    await gatewayEntered.promise;
    const oauthStart = agent.startSession({
      sessionId: 'session-concurrent-valid-oauth', providerId: 'openai',
      model: 'gpt-5.4', workingDir: '/repo-oauth',
    });
    const xdAssertion = expect(xdStart).rejects.toThrow(
      /gateway credentials unavailable.*expired_key/i,
    );
    gatewayRelease.resolve();

    const oauthHandle = await oauthStart;
    await xdAssertion;
    expect(createdTransports).toHaveLength(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledWith([], {
      remoteHostId: undefined, credentialMode: 'oauth-bearer',
    });
    await oauthHandle.close();
    await agent.dispose();
  });

  it('recreates a non-proxy host before serving provider OAuth sessions', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async (_providers, ctx) => ({
      extraArgs: [],
      extraEnv: {},
      codexProxyActive: ctx.credentialMode === 'provider-oauth',
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const keyHandle = await agent.startSession({
      sessionId: 'session-non-proxy-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    expect(createdTransports).toHaveLength(1);
    await keyHandle.close();

    const xaiHandle = await agent.startSession({
      sessionId: 'session-provider-oauth-xai',
      providerId: 'xai',
      model: 'xai/grok-4.3',
      workingDir: '/repo-xai',
    });

    expect(createdTransports).toHaveLength(2);
    expect(createdTransports[0].closed).toBe(true);
    expect(createdTransports[1].closed).toBe(false);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenNthCalledWith(1, [], {
      remoteHostId: undefined,
      credentialMode: 'gateway-key',
    });
    expect(prepareCodexExtraSpawnConfig).toHaveBeenNthCalledWith(2, [], {
      remoteHostId: undefined,
      credentialMode: 'provider-oauth',
    });

    await xaiHandle.close();
    await agent.dispose();
  });

  it('infers provider OAuth host mode from implicit xAI model ids', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async (_providers, ctx) => ({
      extraArgs: [],
      extraEnv: {},
      codexProxyActive: ctx.credentialMode === 'provider-oauth',
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const xaiHandle = await agent.startSession({
      sessionId: 'session-implicit-xai',
      model: 'xai/grok-4.3',
      workingDir: '/repo-xai',
    });

    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledWith([], {
      remoteHostId: undefined,
      credentialMode: 'provider-oauth',
    });

    await xaiHandle.close();
    await agent.dispose();
  });

  it('reuses a proxy-active OAuth host for provider OAuth sessions', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
      codexProxyActive: true,
    }));
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const openAiHandle = await agent.startSession({
      sessionId: 'session-proxy-openai',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo-openai',
    });
    expect(createdTransports).toHaveLength(1);
    await openAiHandle.close();

    const xaiHandle = await agent.startSession({
      sessionId: 'session-proxy-xai',
      providerId: 'xai',
      model: 'xai/grok-4.3',
      workingDir: '/repo-xai',
    });

    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);

    await xaiHandle.close();
    await agent.dispose();
  });

  // review P2 回归:归一化解析(getState 含 fs/reconcile)不允许进复用快路径。
  // implicit-implicit 复用必须走「原始诉求逐字相等」的纯内存比较 —— 第二个隐式
  // 会话不得触发任何额外 getState(唯一一次来自 createHost 的 auth gate)。
  it('keeps implicit-implicit host reuse free of auth getState calls', async () => {
    const getState = vi.fn(async () => ({ authenticated: true, authSource: 'api-key' as const }));
    const auth: AuthAdapter = {
      getState,
      async triggerLogin() {
        return { authenticated: true };
      },
      async logout() {},
      async getAuthEnv() {
        return {};
      },
    };
    const agent = new CodexAgent(createDeps({}, { auth }));

    const first = await agent.startSession({
      sessionId: 'session-implicit-1',
      model: 'gpt-5.4',
      workingDir: '/repo-a',
    });
    const callsAfterFirst = getState.mock.calls.length;

    const second = await agent.startSession({
      sessionId: 'session-implicit-2',
      model: 'gpt-5.4',
      workingDir: '/repo-b',
    });

    // 复用同一 host(不重建),且没有为复用判定多打一次 getState
    expect(createdTransports).toHaveLength(1);
    expect(getState.mock.calls.length).toBe(callsAfterFirst);

    await first.close();
    await second.close();
    await agent.dispose();
  });

  it('rejects an in-flight stale host when another credential mode replaces it before startup', async () => {
    const gatewayGate = deferred<void>();
    const prepareCodexExtraSpawnConfig: NonNullable<AgentDeps['prepareCodexExtraSpawnConfig']> = vi.fn(async (_providers, ctx) => {
      if (ctx.credentialMode === 'gateway-key') {
        await gatewayGate.promise;
      }
      return {
        extraArgs: [],
        extraEnv: {},
      };
    });
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const keyStart = agent.startSession({
      sessionId: 'session-inflight-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    await waitForExpectation(() => {
      expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    });

    const oauthStart = agent.startSession({
      sessionId: 'session-inflight-oauth',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo-oauth',
    });
    await waitForExpectation(() => {
      expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(2);
    });
    gatewayGate.resolve();

    await expect(keyStart).rejects.toThrow(/superseded/i);
    const oauthHandle = await oauthStart;
    expect(createdTransports).toHaveLength(1);

    await oauthHandle.close();
    await agent.dispose();
  });

  it('runs the credential mode switch coordinator before replacing an active local host', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    let keyHandle: Awaited<ReturnType<CodexAgent['startSession']>> | null = null;
    const prepareCodexLocalCredentialModeSwitch: NonNullable<AgentDeps['prepareCodexLocalCredentialModeSwitch']> = vi.fn(async () => {
      if (!keyHandle) throw new Error('key handle missing');
      await keyHandle.close();
    });
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
      prepareCodexLocalCredentialModeSwitch,
    }));

    keyHandle = await agent.startSession({
      sessionId: 'session-stale-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    const oauthHandle = await agent.startSession({
      sessionId: 'session-stale-oauth',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo-oauth',
    });

    expect(prepareCodexLocalCredentialModeSwitch).toHaveBeenCalledWith({
      fromMode: 'gateway-key',
      fromModeEffective: 'gateway-key',
      toMode: 'oauth-bearer',
      activeSubscriptions: 1,
    });
    expect(createdTransports).toHaveLength(2);
    expect(createdTransports[0].closed).toBe(true);

    await oauthHandle.close();
    await agent.dispose();
  });

  it('runs the credential mode switch coordinator before replacing an idle live host', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const prepareCodexLocalCredentialModeSwitch: NonNullable<AgentDeps['prepareCodexLocalCredentialModeSwitch']> =
      vi.fn(async () => undefined);
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
      prepareCodexLocalCredentialModeSwitch,
    }));

    const keyHandle = await agent.startSession({
      sessionId: 'session-idle-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    await createdTransports[0].close('transport error before next send');
    await waitForExpectation(() => {
      expect(createdTransports[0].closed).toBe(true);
    });

    const oauthHandle = await agent.startSession({
      sessionId: 'session-idle-oauth',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo-oauth',
    });

    expect(prepareCodexLocalCredentialModeSwitch).toHaveBeenCalledWith({
      fromMode: 'gateway-key',
      fromModeEffective: 'gateway-key',
      toMode: 'oauth-bearer',
      activeSubscriptions: 0,
    });
    expect(createdTransports).toHaveLength(2);

    await keyHandle.close();
    await oauthHandle.close();
    await agent.dispose();
  });

  it('fails closed when the credential mode switch coordinator leaves sessions attached', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const prepareCodexLocalCredentialModeSwitch: NonNullable<AgentDeps['prepareCodexLocalCredentialModeSwitch']> =
      vi.fn(async () => undefined);
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
      prepareCodexLocalCredentialModeSwitch,
    }));

    const keyHandle = await agent.startSession({
      sessionId: 'session-still-attached-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });

    await expect(agent.startSession({
      sessionId: 'session-still-attached-oauth',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo-oauth',
    })).rejects.toThrow(/still attached/i);

    expect(prepareCodexLocalCredentialModeSwitch).toHaveBeenCalledTimes(1);
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);

    await keyHandle.close();
    await agent.dispose();
  });

  it('counts in-flight thread binding as active use during credential mode switches', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const prepareCodexLocalCredentialModeSwitch: NonNullable<AgentDeps['prepareCodexLocalCredentialModeSwitch']> =
      vi.fn(async () => undefined);
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
      prepareCodexLocalCredentialModeSwitch,
    }));
    let triggered = false;
    let oauthStart: ReturnType<CodexAgent['startSession']> | null = null;
    MockCodexTransport.beforeThreadStartResponse = async () => {
      if (triggered) return;
      triggered = true;
      oauthStart = agent.startSession({
        sessionId: 'session-lease-oauth',
        providerId: 'openai',
        model: 'gpt-5.4',
        workingDir: '/repo-oauth',
      });
      oauthStart.catch(() => undefined);
      await waitForExpectation(() => {
        expect(prepareCodexLocalCredentialModeSwitch).toHaveBeenCalledTimes(1);
      });
    };

    const keyHandle = await agent.startSession({
      sessionId: 'session-lease-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });

    await expect(oauthStart).rejects.toThrow(/still attached/i);
    expect(prepareCodexLocalCredentialModeSwitch).toHaveBeenCalledWith({
      fromMode: 'gateway-key',
      fromModeEffective: 'gateway-key',
      toMode: 'oauth-bearer',
      activeSubscriptions: 1,
    });
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].closed).toBe(false);

    await keyHandle.close();
    await agent.dispose();
  });

  it('holds utility requests until a credential mode switch finishes', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const switchGate = deferred<void>();
    const prepareCodexLocalCredentialModeSwitch: NonNullable<AgentDeps['prepareCodexLocalCredentialModeSwitch']> =
      vi.fn(async () => {
        await switchGate.promise;
      });
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
      prepareCodexLocalCredentialModeSwitch,
    }));

    const keyHandle = await agent.startSession({
      sessionId: 'session-utility-switch-key',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
      workingDir: '/repo-key',
    });
    const oauthStart = agent.startSession({
      sessionId: 'session-utility-switch-oauth',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo-oauth',
    });
    await waitForExpectation(() => {
      expect(prepareCodexLocalCredentialModeSwitch).toHaveBeenCalledTimes(1);
    });

    const skills = agent.listAgentSkills({ workingDir: '/repo' });
    await Promise.resolve();
    await Promise.resolve();
    expect(createdTransports[0].lines.some((line) => line.includes('skills/list'))).toBe(false);

    await keyHandle.close();
    switchGate.resolve();
    const oauthHandle = await oauthStart;
    await expect(skills).resolves.toMatchObject({ skills: [] });
    expect(createdTransports).toHaveLength(2);
    expect(createdTransports[1].lines.some((line) => line.includes('skills/list'))).toBe(true);

    await oauthHandle.close();
    await agent.dispose();
  });

  it('holds new local sessions while an explicit credential change guard is open', async () => {
    const agent = new CodexAgent(createDeps());

    const guard = await agent.beginLocalHostCredentialChange();
    const start = agent.startSession({
      sessionId: 'session-explicit-credential-guard',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(createdTransports).toHaveLength(0);

    await guard.finalize();
    const handle = await start;
    expect(createdTransports).toHaveLength(1);

    await handle.close();
    await agent.dispose();
  });

  it('continues without MCP when OAuth spawn config fails without a fatal marker', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => {
      throw new Error('proxy is not ready');
    });
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    const handle = await agent.startSession({
      sessionId: 'session-oauth-proxy-missing',
      providerId: 'openai',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    expect(createdTransports).toHaveLength(1);
    await handle.close();
    await agent.dispose();
  });

  it('fails closed when fallback spawn config marks OAuth proxy preparation fatal', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => {
      const error = new Error('fallback proxy is not ready');
      (error as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
      throw error;
    });
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
    }));

    await expect(agent.startSession({
      sessionId: 'session-fallback-oauth-proxy-missing',
      model: 'gpt-5.4',
      workingDir: '/repo',
    })).rejects.toThrow(/fallback proxy is not ready/i);
    expect(createdTransports).toHaveLength(0);
  });

  it('passes only remote host context to remote Codex extra spawn config', async () => {
    const prepareCodexExtraSpawnConfig = vi.fn(async () => ({
      extraArgs: [],
      extraEnv: {},
    }));
    const getRemoteCodexTransport = vi.fn(() => {
      const transport = new MockCodexTransport();
      createdTransports.push(transport);
      return transport;
    });
    const agent = new CodexAgent(createDeps({}, {
      prepareCodexExtraSpawnConfig,
      getRemoteCodexTransport,
    }));

    const handle = await agent.startSession({
      sessionId: 'session-remote-spawn-context',
      model: 'gpt-5.4',
      workingDir: '/repo',
      remoteHostId: 'remote-host-1',
      vendorOptions: { orcaRole: 'lead' },
    });

    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledTimes(1);
    expect(prepareCodexExtraSpawnConfig).toHaveBeenCalledWith([], {
      remoteHostId: 'remote-host-1',
      credentialMode: undefined,
    });
    expect(getRemoteCodexTransport).toHaveBeenCalledWith('remote-host-1');
    await handle.close();
  });

  it('registers and unregisters Codex MCP thread context for local sessions', async () => {
    const registerCodexMcpThreadContext = vi.fn();
    const unregisterCodexMcpThreadContext = vi.fn();
    const agent = new CodexAgent(createDeps({}, {
      registerCodexMcpThreadContext,
      unregisterCodexMcpThreadContext,
    }));
    installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-codex-mcp-context',
      model: 'gpt-5.4',
      workingDir: '/repo',
      vendorOptions: { orcaRole: 'lead' },
    });

    expect(registerCodexMcpThreadContext).toHaveBeenCalledTimes(1);
    expect(registerCodexMcpThreadContext).toHaveBeenCalledWith({
      threadId: 'start-thread-id',
      sessionId: 'session-codex-mcp-context',
      workingDir: '/repo',
      vendorOptions: { orcaRole: 'lead' },
    });

    await handle.close();
    expect(unregisterCodexMcpThreadContext).toHaveBeenCalledTimes(1);
    expect(unregisterCodexMcpThreadContext).toHaveBeenCalledWith('start-thread-id');
  });

  it('unsubscribes the app-server thread when closing a local session without stopping the shared host', async () => {
    const agent = new CodexAgent(createDeps());
    const handle = await agent.startSession({
      sessionId: 'session-codex-mcp-runtime-release',
      model: 'gpt-5.4',
      workingDir: '/repo',
      vendorOptions: { orcaRole: 'worker' },
    });

    const transport = createdTransports[0];
    expect(transport).toBeDefined();

    await handle.close();

    const unsubscribe = transport!.lines
      .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
      .find((request) => request.method === Method.ThreadUnsubscribe);
    expect(unsubscribe).toMatchObject({
      method: Method.ThreadUnsubscribe,
      params: { threadId: 'thread-1' },
    });
    expect(transport!.closed).toBe(false);
  });

  it('finishes closing when the app-server stays connected without answering thread/unsubscribe', async () => {
    vi.useFakeTimers();
    try {
      MockCodexTransport.dropThreadUnsubscribe = true;
      const agent = new CodexAgent(createDeps());
      const handle = await agent.startSession({
        sessionId: 'session-codex-mcp-runtime-release-timeout',
        model: 'gpt-5.4',
        workingDir: '/repo',
        vendorOptions: { orcaRole: 'worker' },
      });

      const closePromise = handle.close();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(closePromise).resolves.toBeUndefined();
      expect(createdTransports[0]?.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips Codex MCP thread context registration for remote sessions', async () => {
    const registerCodexMcpThreadContext = vi.fn();
    const unregisterCodexMcpThreadContext = vi.fn();
    const agent = new CodexAgent(createDeps({}, {
      registerCodexMcpThreadContext,
      unregisterCodexMcpThreadContext,
    }));
    installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-remote-codex-mcp-context',
      model: 'gpt-5.4',
      workingDir: '/repo',
      remoteHostId: 'remote-host-1',
    });

    expect(registerCodexMcpThreadContext).not.toHaveBeenCalled();
    await handle.close();
    expect(unregisterCodexMcpThreadContext).not.toHaveBeenCalled();
  });

  it('passes MCP tool params to host policy and auto-approves safe inner calls', async () => {
    const policy = vi.fn(() => 'auto-approve' as const);
    const agent = new CodexAgent(createDeps({}, {
      getMcpToolApprovalPolicy: policy,
    }));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-trusted-elicitation',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const handlers = host.getThreadHandlers();
    expect(handlers).not.toBeNull();
    if (!handlers?.mcpServerElicitation) throw new Error('expected mcpServerElicitation handler');

    const result = await handlers.mcpServerElicitation({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      serverName: 'cindy_contacts',
      mode: 'form',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_params: { name: 'contacts_search', args: { query: 'Carol' } },
      },
      message: 'Allow tool call',
      requestedSchema: {},
    });

    expect(result).toEqual({ action: 'accept', content: null, _meta: null });
    expect(policy).toHaveBeenCalledWith({
      serverName: 'cindy_contacts',
      toolParams: { name: 'contacts_search', args: { query: 'Carol' } },
    });
    await handle.close();
  });

  it('prompts every time for high-risk inner MCP calls and never persists approval', async () => {
    const agent = new CodexAgent(createDeps({}, {
      getMcpToolApprovalPolicy: () => 'prompt-each-time',
    }));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-high-risk-elicitation',
      model: 'gpt-5.4',
      workingDir: '/repo',
      permissionMode: 'ask',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.mcpServerElicitation) throw new Error('expected mcpServerElicitation handler');
    const resolver = vi.fn(async (req: InteractionRequest) => {
      expect(req).toMatchObject({
        kind: 'permission',
        toolName: 'mcp:cindy_contacts',
        title: 'Allow Codex to use contacts_delete?',
        input: {
          serverName: 'cindy_contacts',
          toolParams: { name: 'contacts_delete', args: { id: 'contact-1' } },
        },
      });
      if (req.kind !== 'permission') throw new Error('expected permission request');
      expect(req.suggestions).toBeUndefined();
      return {
        kind: 'permission' as const,
        behavior: 'allow' as const,
        // Even a stale/custom UI asking for session scope must not persist it.
        permissionUpdates: [{ destination: 'session' }],
      };
    });
    handle.setInteractionResolver(resolver);

    const request = {
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      serverName: 'cindy_contacts',
      mode: 'form' as const,
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        tool_params: { name: 'contacts_delete', args: { id: 'contact-1' } },
      },
      message: 'Allow tool call',
      requestedSchema: {},
    };
    expect(await handlers.mcpServerElicitation(request)).toEqual({
      action: 'accept',
      content: null,
      _meta: null,
    });
    expect(await handlers.mcpServerElicitation(request)).toEqual({
      action: 'accept',
      content: null,
      _meta: null,
    });
    expect(resolver).toHaveBeenCalledTimes(2);
    await handle.close();
  });

  it('still prompts for prompt-each-time inner MCP calls in Full access mode', async () => {
    // 回归:宽松档曾无条件 accept, 让高风险 inner tool(contacts_delete 等)
    // 绕过逐次确认；Full access 也必须保留 forcePrompt 护栏。
    const agent = new CodexAgent(createDeps({}, {
      getMcpToolApprovalPolicy: () => 'prompt-each-time',
    }));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-high-risk-full-access-mode',
      model: 'gpt-5.4',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.mcpServerElicitation) throw new Error('expected mcpServerElicitation handler');
    const resolver = vi.fn(async (req: InteractionRequest) => {
      expect(req).toMatchObject({ kind: 'permission', toolName: 'mcp:cindy_contacts' });
      return { kind: 'permission' as const, behavior: 'deny' as const };
    });
    handle.setInteractionResolver(resolver);

    const result = await handlers.mcpServerElicitation({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      serverName: 'cindy_contacts',
      mode: 'form',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_params: { name: 'contacts_delete', args: { id: 'contact-1' } },
      },
      message: 'Allow tool call',
      requestedSchema: {},
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ action: 'decline', content: null, _meta: null });
    await handle.close();
  });

  it('declines pending prompt-each-time approvals when permission mode switches to auto', async () => {
    // Auto 也不能批量放行 forcePrompt 高风险审批，必须 fail-closed 关闭挂起请求。
    const agent = new CodexAgent(createDeps({}, {
      getMcpToolApprovalPolicy: () => 'prompt-each-time',
    }));
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-high-risk-mode-switch',
      model: 'gpt-5.4',
      workingDir: '/repo',
      permissionMode: 'ask',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const handlers = host.getThreadHandlers();
    if (!handlers?.mcpServerElicitation) throw new Error('expected mcpServerElicitation handler');
    const pendingDecision = deferred<InteractionDecision>();
    handle.setInteractionResolver(async () => pendingDecision.promise);

    const responsePromise = handlers.mcpServerElicitation({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      serverName: 'cindy_contacts',
      mode: 'form',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_params: { name: 'contacts_merge', args: { targetId: 'a', sourceId: 'b' } },
      },
      message: 'Allow tool call',
      requestedSchema: {},
    });

    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('auto');

    await expect(responsePromise).resolves.toEqual({ action: 'decline', content: null, _meta: null });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: 'interaction_dismissed',
      data: {
        reason: 'permission_mode_changed_to_auto',
        resolvedAs: 'deny',
      },
    });
    pendingDecision.resolve({ kind: 'permission', behavior: 'allow' });
    await handle.close();
  });

  it('maps auto permission mode to Codex built-in automatic approval review', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-auto-approval-policy' } };
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-auto-approval-policy',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });

    const startParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      approvalPolicy?: string;
      approvalsReviewer?: string;
      sandbox?: string;
    };
    expect(startParams).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
    });

    await handle.send({ type: 'user', content: 'hello' });
    const turnParams = host.request.mock.calls.find(([method]) => method === Method.TurnStart)?.[1] as {
      approvalPolicy?: string;
      approvalsReviewer?: string;
      sandboxPolicy?: { type?: string };
    };
    expect(turnParams).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: { type: 'workspaceWrite' },
    });

    await handle.close();
  });

  it('falls back to untrusted approvals without reviewer fields on an older app-server', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-legacy-auto' } };
      }
      return undefined;
    }, { userAgent: 'mock-codex/0.143.0 (Linux; x86_64)' });
    const handle = await agent.startSession({
      sessionId: 'session-legacy-auto',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });

    const startParams = host.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      approvalPolicy?: string;
      approvalsReviewer?: string;
    };
    expect(startParams.approvalPolicy).toBe('untrusted');
    expect(startParams).not.toHaveProperty('approvalsReviewer');

    await handle.send({ type: 'user', content: 'hello' });
    const turnParams = host.request.mock.calls.find(([method]) => method === Method.TurnStart)?.[1] as {
      approvalPolicy?: string;
      approvalsReviewer?: string;
    };
    expect(turnParams.approvalPolicy).toBe('untrusted');
    expect(turnParams).not.toHaveProperty('approvalsReviewer');
    await handle.close();
  });

  it('falls back to the approval UI if Auto-review still forwards a command request', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-auto-command-fallback',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.commandExecutionApproval) throw new Error('expected commandExecutionApproval handler');
    const resolver = vi.fn(async () => ({ kind: 'permission' as const, behavior: 'allow' as const }));
    handle.setInteractionResolver(resolver);

    const result = await handlers.commandExecutionApproval({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      approvalId: 'approval-1',
      command: 'pwd',
      cwd: '/repo',
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(resolver).toHaveBeenCalledOnce();
    await handle.close();
  });

  it('keeps a denied Guardian auto-review fail-closed without opening a user override prompt', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-guardian-denial-fail-closed',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });
    const resolver = vi.fn(async () => ({ kind: 'permission' as const, behavior: 'allow' as const }));
    handle.setInteractionResolver(resolver);
    const handlers = host.getThreadHandlers();
    if (!handlers?.autoApprovalReviewCompleted) throw new Error('expected autoApprovalReviewCompleted');

    handlers.autoApprovalReviewCompleted({
      threadId: 'start-thread-id',
      turnId: 'turn-guardian',
      startedAtMs: 1_000,
      completedAtMs: 1_042,
      reviewId: 'review-denied-1',
      targetItemId: 'item-command-1',
      decisionSource: 'agent',
      review: {
        status: 'denied',
        riskLevel: 'high',
        userAuthorization: 'low',
        rationale: 'The command removes persistent data.',
      },
      action: {
        type: 'command',
        source: 'shell',
        command: 'rm -f /tmp/data.db',
        cwd: '/repo',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolver).not.toHaveBeenCalled();
    expect(host.request.mock.calls.some(([method]) => method === 'thread/approveGuardianDeniedAction')).toBe(false);
    await handle.close();
  });

  it('surfaces Guardian auto-review timeouts as visible non-terminal errors', async () => {
    const classifierUnavailable = vi.fn();
    const agent = new CodexAgent(createDeps({}, {
      onAutoPermissionClassifierUnavailable: classifierUnavailable,
    }));
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-guardian-timeout',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const handlers = host.getThreadHandlers();
    if (!handlers?.autoApprovalReviewCompleted) throw new Error('expected autoApprovalReviewCompleted');
    handlers.autoApprovalReviewCompleted({
      threadId: 'start-thread-id',
      turnId: 'turn-guardian',
      startedAtMs: 1,
      completedAtMs: 2,
      reviewId: 'review-timeout-1',
      targetItemId: 'item-network-1',
      decisionSource: 'agent',
      review: { status: 'timedOut', riskLevel: null, userAuthorization: null, rationale: 'review timed out' },
      action: { type: 'networkAccess', target: 'https://example.com', host: 'example.com', protocol: 'https', port: 443 },
    });
    expect(classifierUnavailable).not.toHaveBeenCalled();
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: 'error',
      data: {
        reason: 'codex-auto-review-unavailable',
        isTerminal: false,
        reviewRationale: 'review timed out',
      },
    });
    await Promise.resolve();
    expect(classifierUnavailable).toHaveBeenCalledWith({
      sessionId: 'session-guardian-timeout',
      agentKind: 'codex',
      status: 408,
    });
    await handle.close();
  });

  it('switches the local runtime to Ask before notifying the host about a Guardian timeout', async () => {
    const classifierUnavailable = vi.fn();
    const agent = new CodexAgent(createDeps({}, {
      onAutoPermissionClassifierUnavailable: classifierUnavailable,
    }));
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) return { turn: { id: 'turn-after-guardian-timeout' } };
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-guardian-timeout-runtime',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.autoApprovalReviewCompleted) throw new Error('expected autoApprovalReviewCompleted');

    handlers.autoApprovalReviewCompleted({
      threadId: 'start-thread-id',
      turnId: 'turn-guardian',
      startedAtMs: 1,
      completedAtMs: 2,
      reviewId: 'review-timeout-runtime',
      targetItemId: 'item-network-runtime',
      decisionSource: 'agent',
      review: { status: 'timedOut', riskLevel: null, userAuthorization: null, rationale: null },
      action: { type: 'networkAccess', target: 'https://example.com', host: 'example.com', protocol: 'https', port: 443 },
    });

    expect(classifierUnavailable).not.toHaveBeenCalled();
    await handle.send({ type: 'user', content: 'retry after fallback' });
    const turnParams = host.request.mock.calls.find(([method]) => method === Method.TurnStart)?.[1] as {
      approvalPolicy?: string;
      approvalsReviewer?: string;
    };
    expect(turnParams.approvalPolicy).toBe('on-request');
    expect(turnParams).not.toHaveProperty('approvalsReviewer');
    expect(classifierUnavailable).toHaveBeenCalledWith({
      sessionId: 'session-guardian-timeout-runtime',
      agentKind: 'codex',
      status: 408,
    });
    await handle.close();
  });

  it('treats Guardian reviewer failures as unavailable and contains host callback errors', async () => {
    const classifierUnavailable = vi.fn(() => {
      throw new Error('host callback failed');
    });
    const agent = new CodexAgent(createDeps({}, {
      onAutoPermissionClassifierUnavailable: classifierUnavailable,
    }));
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-guardian-reviewer-failure',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const handlers = host.getThreadHandlers();
    if (!handlers?.autoApprovalReviewCompleted) throw new Error('expected autoApprovalReviewCompleted');

    handlers.autoApprovalReviewCompleted({
      threadId: 'start-thread-id',
      turnId: 'turn-guardian',
      startedAtMs: 1,
      completedAtMs: 2,
      reviewId: 'review-failed-1',
      targetItemId: 'item-command-failed',
      decisionSource: 'agent',
      review: {
        status: 'denied',
        riskLevel: 'high',
        userAuthorization: 'unknown',
        rationale: 'Automatic approval review failed: invalid reviewer response',
      },
      action: { type: 'command', source: 'shell', command: 'pwd', cwd: '/repo' },
    });
    expect(classifierUnavailable).not.toHaveBeenCalled();

    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: 'error',
      data: { reason: 'codex-auto-review-unavailable', isTerminal: false },
    });
    await Promise.resolve();
    expect(classifierUnavailable).toHaveBeenCalledWith({
      sessionId: 'session-guardian-reviewer-failure',
      agentKind: 'codex',
      status: 500,
    });
    await handle.close();
  });

  it('ignores a stale Guardian timeout from a previous turn', async () => {
    const classifierUnavailable = vi.fn();
    const agent = new CodexAgent(createDeps({}, {
      onAutoPermissionClassifierUnavailable: classifierUnavailable,
    }));
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) return { turn: { id: 'turn-current' } };
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-guardian-stale-timeout',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });
    await handle.send({ type: 'user', content: 'current turn' });
    const handlers = host.getThreadHandlers();
    if (!handlers?.autoApprovalReviewCompleted) throw new Error('expected autoApprovalReviewCompleted');

    handlers.autoApprovalReviewCompleted({
      threadId: 'start-thread-id',
      turnId: 'turn-previous',
      startedAtMs: 1,
      completedAtMs: 2,
      reviewId: 'review-stale-timeout',
      targetItemId: 'item-stale',
      decisionSource: 'agent',
      review: { status: 'timedOut', riskLevel: null, userAuthorization: null, rationale: null },
      action: { type: 'command', source: 'shell', command: 'pwd', cwd: '/repo' },
    });

    await Promise.resolve();
    expect(classifierUnavailable).not.toHaveBeenCalled();
    const turnParams = host.request.mock.calls.find(([method]) => method === Method.TurnStart)?.[1] as {
      approvalsReviewer?: string;
    };
    expect(turnParams.approvalsReviewer).toBe('auto_review');
    await handle.close();
  });

  it('interrupts an active Auto-review turn when switching back to Ask', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-auto-review-tighten' } };
      }
      if (method === Method.TurnInterrupt) return {};
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-auto-review-tighten',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'auto',
    });

    await handle.send({ type: 'user', content: 'do work' });
    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('ask');

    expect(host.request).toHaveBeenCalledWith(Method.TurnInterrupt, {
      threadId: 'start-thread-id',
      turnId: 'turn-auto-review-tighten',
    });
    await handle.close();
  });

  it('times out a hanging tighten interrupt and surfaces the non-terminal error', async () => {
    // app-server 无响应时 turn/interrupt 永久悬挂 —— 必须有界超时并走重试 /
    // 失败提示路径, 否则免审 turn 无声继续跑 (review #969 第六轮 Greptile P1)。
    const agent = new CodexAgent(createDeps());
    let interruptAttempts = 0;
    installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-interrupt-hangs' } };
      }
      if (method === Method.TurnInterrupt) {
        interruptAttempts += 1;
        return new Promise(() => {});
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-tighten-interrupt-hangs',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    await handle.send({ type: 'user', content: 'do work' });
    await nextEvent(iterator); // turn-start status

    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    vi.useFakeTimers();
    try {
      const switchPromise = handle.setPermissionMode('ask');
      await vi.advanceTimersByTimeAsync(10_000); // 第一次尝试超时
      await vi.advanceTimersByTimeAsync(10_000); // 重试同样超时
      await switchPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(interruptAttempts).toBe(2);
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: 'error',
      data: expect.objectContaining({
        isTerminal: false,
        reason: 'permission-tighten-interrupt-failed',
      }),
    });

    await handle.close();
  });

  it('retries a failed tighten interrupt and surfaces a non-terminal error when both attempts fail', async () => {
    // 收紧 fail-safe 的唯一执行手段是 turn/interrupt RPC; 失败不能静默 —— UI 已按
    // ask 展示而免审 turn 还在跑, 必须重试并在终失败时透出错误 (review #969 第五轮)。
    const agent = new CodexAgent(createDeps());
    let interruptAttempts = 0;
    installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-interrupt-fails' } };
      }
      if (method === Method.TurnInterrupt) {
        interruptAttempts += 1;
        throw new Error('transport hiccup');
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-tighten-interrupt-fails',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    await handle.send({ type: 'user', content: 'do work' });
    // 消费 send 产生的 turn-start status 事件, 只留 error 待断言。
    await nextEvent(iterator);

    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('ask');

    expect(interruptAttempts).toBe(2);
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: 'error',
      data: expect.objectContaining({
        isTerminal: false,
        reason: 'permission-tighten-interrupt-failed',
      }),
    });

    await handle.close();
  });

  it('interrupts the running turn when tightening from Full access to ask', async () => {
    // 收紧兜底: Full access turn 在 server 侧是 never + danger-full-access, turn 内不会
    // 再有审批请求流经本地 —— 切回 ask 时必须 interrupt 当前 turn, 否则已撤销的
    // 宽松授权会在 turn 剩余部分继续免审执行 (review #969 Greptile P1)。
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-tighten-interrupt' } };
      }
      if (method === Method.TurnInterrupt) {
        return {};
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-tighten-interrupt',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    await handle.send({ type: 'user', content: 'do work' });

    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('ask');

    const interruptCall = host.request.mock.calls.find(([method]) => method === Method.TurnInterrupt);
    expect(interruptCall?.[1]).toMatchObject({
      threadId: 'start-thread-id',
      turnId: 'turn-tighten-interrupt',
    });

    await handle.close();
  });

  it('interrupts the running Full access turn when tightening to Auto', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-tighten-to-auto' } };
      }
      if (method === Method.TurnInterrupt) {
        return {};
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-tighten-to-auto',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    await handle.send({ type: 'user', content: 'do work' });

    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('auto');

    expect(host.request).toHaveBeenCalledWith(Method.TurnInterrupt, {
      threadId: 'start-thread-id',
      turnId: 'turn-tighten-to-auto',
    });

    await handle.close();
  });

  it('interrupts a pending turn/start once its id arrives when tightened mid-flight', async () => {
    // turn/start 已携带旧宽松策略发出、id 未回时收紧 —— 该 turn 不会再发审批请求,
    // 必须在拿到 id 的瞬间补中断 (review #969 第二轮 Greptile P1 / Codex P2)。
    const agent = new CodexAgent(createDeps());
    const turnStartGate = deferred<{ turn: { id: string } }>();
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return turnStartGate.promise;
      }
      if (method === Method.TurnInterrupt) {
        return {};
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-pending-tighten',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    const sendPromise = handle.send({ type: 'user', content: 'do work' });
    // turn/start 已发出但 id 未回的窗口内收紧。
    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('ask');
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnInterrupt)).toHaveLength(0);

    turnStartGate.resolve({ turn: { id: 'turn-late-id' } });
    await sendPromise;

    const interruptCall = host.request.mock.calls.find(([method]) => method === Method.TurnInterrupt);
    expect(interruptCall?.[1]).toMatchObject({
      threadId: 'start-thread-id',
      turnId: 'turn-late-id',
    });

    await handle.close();
  });

  it('does not reactivate a turn whose completion arrived before the turn/start response', async () => {
    // 收紧补中断是 fire-and-forget: turnStarted 先到 → 中断 → turnCompleted
    // (interrupted) 也抢在 turn/start RPC 响应之前到达。响应回来后不得把已
    // 终结的 turn 重新置活, 否则会话永远卡 running (review #969 第四轮)。
    const agent = new CodexAgent(createDeps());
    const turnStartGate = deferred<{ turn: { id: string } }>();
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return turnStartGate.promise;
      }
      if (method === Method.TurnInterrupt) {
        return {};
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-tombstone-race',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    const sendPromise = handle.send({ type: 'user', content: 'do work' });
    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('ask');

    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');
    // 通知流抢跑: started → (fire-and-forget interrupt) → completed(interrupted),
    // 全部发生在 turn/start RPC 响应之前。
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-tombstone' } });
    handlers.turnCompleted?.({ threadId: 'start-thread-id', turn: { id: 'turn-tombstone', status: 'interrupted' } });

    turnStartGate.resolve({ turn: { id: 'turn-tombstone' } });
    await sendPromise;

    // isTurnInFlight 未被响应重新置活 → steer 本地拒绝。
    await expect(handle.steer({ type: 'user', content: 'probe' })).rejects.toThrow(
      /No active Codex turn to steer/,
    );

    await handle.close();
  });

  it('does not interrupt an ask-launched pending turn after a transient Full access toggle', async () => {
    // ask 策略发射的 turn 审批请求照常流经本地; 在飞期间 UI 短暂切 Full access 又切回
    // ask, 不得误杀该正常 turn (review #969 第三轮 Codex P2)。
    const agent = new CodexAgent(createDeps());
    const turnStartGate = deferred<{ turn: { id: string } }>();
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return turnStartGate.promise;
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-ask-launch-toggle',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'ask',
    });
    const sendPromise = handle.send({ type: 'user', content: 'do work' });
    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('bypassPermissions');
    await handle.setPermissionMode('ask');

    turnStartGate.resolve({ turn: { id: 'turn-ask-launched' } });
    await sendPromise;

    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnInterrupt)).toHaveLength(0);

    await handle.close();
  });

  it('does not interrupt an ask-launched running turn after a transient Full access toggle', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-ask-running' } };
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-ask-running-toggle',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'ask',
    });
    await handle.send({ type: 'user', content: 'do work' });
    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('bypassPermissions');
    await handle.setPermissionMode('ask');

    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnInterrupt)).toHaveLength(0);

    await handle.close();
  });

  it('clears the pending tighten interrupt when loosening back before the turn id arrives', async () => {
    // 收紧后又切回宽松档: 在飞的 turn 本就获用户重新授权, 不得再补中断。
    const agent = new CodexAgent(createDeps());
    const turnStartGate = deferred<{ turn: { id: string } }>();
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return turnStartGate.promise;
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-pending-tighten-undo',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    const sendPromise = handle.send({ type: 'user', content: 'do work' });
    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('ask');
    await handle.setPermissionMode('bypassPermissions');

    turnStartGate.resolve({ turn: { id: 'turn-undo-id' } });
    await sendPromise;

    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnInterrupt)).toHaveLength(0);

    await handle.close();
  });

  it('does not interrupt when loosening or when no turn is running', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return { turn: { id: 'turn-no-interrupt' } };
      }
      return undefined;
    });

    // 无运行中 turn 时收紧: 不发 interrupt。
    const handle = await agent.startSession({
      sessionId: 'session-no-interrupt',
      model: 'gpt-5.5',
      workingDir: '/repo',
      permissionMode: 'bypassPermissions',
    });
    if (!handle.setPermissionMode) throw new Error('expected setPermissionMode');
    await handle.setPermissionMode('ask');

    // ask → Full access 后启动 turn，再重复设置 Full access：不发 interrupt。
    await handle.setPermissionMode('bypassPermissions');
    await handle.send({ type: 'user', content: 'do work' });
    await handle.setPermissionMode('bypassPermissions');

    // ask 起步的放宽同样不触发。
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnInterrupt)).toHaveLength(0);

    await handle.close();
  });

  it('routes untrusted MCP server elicitations through approval UI', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-untrusted-elicitation',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const handlers = host.getThreadHandlers();
    expect(handlers).not.toBeNull();
    if (!handlers?.mcpServerElicitation) throw new Error('expected mcpServerElicitation handler');
    handle.setInteractionResolver(async (req) => {
      expect(req).toMatchObject({
        kind: 'permission',
        toolName: 'mcp:third_party',
      });
      return { kind: 'permission', behavior: 'allow' };
    });

    const result = await handlers.mcpServerElicitation({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      serverName: 'third_party',
      mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      message: 'Allow tool call',
      requestedSchema: {},
    });

    expect(result).toEqual({ action: 'accept', content: null, _meta: null });
    await handle.close();
  });

  it('registers ask_user_question as a thread/start dynamic fallback for non-xAI Codex new threads', async () => {
    const startAgent = new CodexAgent(createDeps());
    const startHost = installFakeHost(startAgent);
    const startHandle = await startAgent.startSession({
      sessionId: 'session-dynamic-tool-start',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });

    const startParams = startHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      dynamicTools?: Array<{
        namespace?: string;
        name?: string;
        description?: string;
        inputSchema?: {
          properties?: {
            questions?: { description?: string };
          };
        };
      }>;
    };
    expect(startParams.dynamicTools).toEqual([
      expect.objectContaining({
        namespace: 'cindy',
        name: 'ask_user_question',
      }),
    ]);
    expect(startParams.dynamicTools?.[0]?.description).toContain('the user asks to choose');
    expect(startParams.dynamicTools?.[0]?.description).toContain('provide a generic list');
    expect(startParams.dynamicTools?.[0]?.description).toContain('Ask 1 to 3 short questions in a single call');
    expect(startParams.dynamicTools?.[0]?.inputSchema?.properties?.questions?.description).toContain('Bundle independent choices');

    const openAiAgent = new CodexAgent(createDeps());
    const openAiHost = installFakeHost(openAiAgent);
    const openAiHandle = await openAiAgent.startSession({
      sessionId: 'session-dynamic-tool-openai',
      model: 'gpt-5.4',
      providerId: 'openai',
      workingDir: '/repo',
    });
    const openAiParams = openAiHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      dynamicTools?: Array<{ namespace?: string; name?: string }>;
    };
    expect(openAiParams.dynamicTools).toEqual([
      expect.objectContaining({
        namespace: 'cindy',
        name: 'ask_user_question',
      }),
    ]);

    const xdAgent = new CodexAgent(createDeps());
    const xdHost = installFakeHost(xdAgent);
    const xdHandle = await xdAgent.startSession({
      sessionId: 'session-dynamic-tool-xd',
      model: 'gpt-5.4',
      providerId: 'xd',
      workingDir: '/repo',
    });
    const xdParams = xdHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      dynamicTools?: Array<{ namespace?: string; name?: string }>;
    };
    expect(xdParams.dynamicTools).toEqual([
      expect.objectContaining({
        namespace: 'cindy',
        name: 'ask_user_question',
      }),
    ]);

    const resumeAgent = new CodexAgent(createDeps());
    const resumeHost = installFakeHost(resumeAgent);
    const resumeHandle = await resumeAgent.startSession({
      sessionId: 'session-dynamic-tool-resume',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
    });
    const resumeParams = resumeHost.request.mock.calls.find(([method]) => method === Method.ThreadResume)?.[1] as {
      dynamicTools?: unknown;
    };
    expect(resumeParams.dynamicTools).toBeUndefined();

    await startHandle.close();
    await openAiHandle.close();
    await xdHandle.close();
    await resumeHandle.close();
  });

  it('does not register ask_user_question dynamic fallback for xAI Codex providers', async () => {
    const explicitAgent = new CodexAgent(createDeps());
    const explicitHost = installFakeHost(explicitAgent);
    const explicitHandle = await explicitAgent.startSession({
      sessionId: 'session-dynamic-tool-xai',
      model: 'xai/grok-4.3',
      providerId: 'xai',
      workingDir: '/repo',
    });

    const explicitStartParams = explicitHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      dynamicTools?: unknown;
    };
    expect(explicitStartParams.dynamicTools).toBeUndefined();

    const implicitAgent = new CodexAgent(createDeps());
    const implicitHost = installFakeHost(implicitAgent);
    const implicitHandle = await implicitAgent.startSession({
      sessionId: 'session-dynamic-tool-implicit-xai',
      model: 'xai/grok-4.3',
      workingDir: '/repo',
    });
    const implicitStartParams = implicitHost.request.mock.calls.find(([method]) => method === Method.ThreadStart)?.[1] as {
      dynamicTools?: unknown;
    };
    expect(implicitStartParams.dynamicTools).toBeUndefined();

    await explicitHandle.close();
    await implicitHandle.close();
  });

  it('routes native requestUserInput without tool context to ask_user_question', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-native-user-input',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.requestUserInput) throw new Error('expected requestUserInput handler');

    const seen = vi.fn();
    handle.setInteractionResolver(async (req) => {
      seen(req);
      expect(req).toMatchObject({
        kind: 'ask_user_question',
        requestId: 'req-user-input',
        questions: [
          {
            question: 'Which mode should Codex use?',
            header: 'Mode',
            options: [{ label: 'Fast', description: 'Move quickly' }],
            multiSelect: false,
          },
        ],
      });
      return { kind: 'ask_user_question', answers: { 'Which mode should Codex use?': 'Fast' } };
    });

    const result = await handlers.requestUserInput({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [{
        id: 'q1',
        header: 'Mode',
        question: 'Which mode should Codex use?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'Fast', description: 'Move quickly' }],
      }],
    }, { requestId: 'req-user-input' });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ answers: { q1: { answers: ['Fast'] } } });
    await handle.close();
  });

  it('refuses native secret requestUserInput without showing normal UI', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-secret-user-input',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.requestUserInput) throw new Error('expected requestUserInput handler');
    const resolver = vi.fn(async () => ({ kind: 'ask_user_question' as const, answers: {} }));
    handle.setInteractionResolver(resolver);

    const result = await handlers.requestUserInput({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [{
        id: 'secret',
        header: 'Token',
        question: 'Enter token',
        isOther: true,
        isSecret: true,
        options: null,
      }],
    }, { requestId: 'req-secret' });

    expect(resolver).not.toHaveBeenCalled();
    expect(result).toEqual({ answers: { secret: { answers: [] } } });
    await handle.close();
  });

  it('classifies requestUserInput from MCP tool calls as permission', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-user-input-permission',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.itemStarted || !handlers.requestUserInput) throw new Error('expected handlers');

    handlers.itemStarted({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      item: {
        id: 'mcp-call-1',
        type: 'mcpToolCall',
        server: 'third_party',
        tool: 'block_contacts',
      },
    });
    handle.setInteractionResolver(async (req) => {
      expect(req).toMatchObject({
        kind: 'permission',
        requestId: 'req-tool-input',
        toolName: 'mcp:third_party:block_contacts',
        metadata: { userInputKind: 'tool_side_effect' },
      });
      return { kind: 'permission', behavior: 'allow' };
    });

    const result = await handlers.requestUserInput({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      itemId: 'mcp-call-1',
      questions: [{
        id: 'confirm',
        header: 'Confirm',
        question: 'Continue?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Deny', description: '' },
          { label: 'Allow', description: '' },
        ],
      }, {
        id: 'confirm-custom',
        header: 'Confirm',
        question: 'Proceed with custom labels?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Proceed', description: '' },
          { label: 'Cancel', description: '' },
        ],
      }],
    }, { requestId: 'req-tool-input' });

    expect(result).toEqual({
      answers: {
        confirm: { answers: ['Allow'] },
        'confirm-custom': { answers: ['Proceed'] },
      },
    });
    await handle.close();
  });

  it('routes Ask command approvals through UI and uses displayCommand on Windows', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-command-approval-display-command',
      model: 'gpt-5.4',
      workingDir: '/repo',
      permissionMode: 'ask',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.commandExecutionApproval) throw new Error('expected commandExecutionApproval handler');
    const rawCommand =
      '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command "Write-Output \\"hello world\\""';

    handle.setInteractionResolver(async (req) => {
      expect(req).toMatchObject({
        kind: 'permission',
        requestId: 'approval-1',
        toolName: 'exec',
        input: {
          command: rawCommand,
          cwd: 'E:\\xdt-maker',
          displayCommand: 'Write-Output "hello world"',
        },
      });
      return { kind: 'permission', behavior: 'allow' };
    });

    const result = await handlers.commandExecutionApproval({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      approvalId: 'approval-1',
      command: rawCommand,
      cwd: 'E:\\xdt-maker',
    });

    expect(result).toEqual({ decision: 'accept' });
    await handle.close();
  });

  it('routes dynamic ask_user_question tool calls through ask_user_question', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-dynamic-user-input',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers?.dynamicToolCall) throw new Error('expected dynamicToolCall handler');
    let requestCount = 0;
    handle.setInteractionResolver(async (req) => {
      requestCount += 1;
      expect(req).toMatchObject({
        kind: 'ask_user_question',
        requestId: requestCount === 1 ? 'req-dynamic' : 'req-dynamic-legacy',
      });
      return { kind: 'ask_user_question', answers: { 'What next?': 'Keep going' } };
    });

    const result = await handlers.dynamicToolCall({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      callId: 'dynamic-call-1',
      namespace: 'cindy',
      tool: 'ask_user_question',
      arguments: {
        questions: [{
          id: 'q1',
          header: 'Direction',
          question: 'What next?',
          options: [{ label: 'Keep going', description: 'Continue current work' }],
        }],
      },
    }, { requestId: 'req-dynamic' });

    expect(result.success).toBe(true);
    expect(result.contentItems).toEqual([
      { type: 'inputText', text: JSON.stringify({ q1: { answers: ['Keep going'] } }) },
    ]);

    const legacyResult = await handlers.dynamicToolCall({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      callId: 'dynamic-call-legacy',
      namespace: 'xdt_maker',
      tool: 'ask_user_question',
      arguments: {
        questions: [{
          id: 'q1',
          header: 'Direction',
          question: 'What next?',
          options: [{ label: 'Keep going', description: 'Continue current work' }],
        }],
      },
    }, { requestId: 'req-dynamic-legacy' });
    expect(legacyResult).toEqual(result);
    expect(requestCount).toBe(2);
    await handle.close();
  });

  it('cancels pending user input when serverRequest/resolved arrives', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-user-input-resolved',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const handlers = host.getThreadHandlers();
    if (!handlers?.requestUserInput || !handlers.serverRequestResolved) throw new Error('expected handlers');
    const pendingDecision = deferred<InteractionDecision>();
    handle.setInteractionResolver(async () => pendingDecision.promise);

    const responsePromise = handlers.requestUserInput({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [{
        id: 'q1',
        header: 'Question',
        question: 'Pick one',
        isOther: false,
        isSecret: false,
        options: null,
      }],
    }, { requestId: 'req-resolved' });

    handlers.serverRequestResolved({ threadId: 'start-thread-id', requestId: 'req-resolved' });

    await expect(responsePromise).resolves.toEqual({ answers: {} });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: 'interaction_dismissed',
      data: {
        requestId: 'req-resolved',
        reason: 'server_request_resolved',
        resolvedAs: 'deny',
      },
    });
    pendingDecision.resolve({ kind: 'ask_user_question', answers: { q1: 'late' } });
    await handle.close();
  });

  it('updates the registered vendorOptions object by reference on setVendorOptions', async () => {
    const registerCodexMcpThreadContext = vi.fn();
    const agent = new CodexAgent(createDeps({}, {
      registerCodexMcpThreadContext,
    }));
    installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-vendor-options-update',
      model: 'gpt-5.4',
      workingDir: '/repo',
      vendorOptions: { orcaRole: 'lead' },
    });
    const firstCtx = registerCodexMcpThreadContext.mock.calls[0]?.[0];
    expect(firstCtx?.vendorOptions).toEqual({ orcaRole: 'lead' });

    await handle.setVendorOptions?.({
      orcaWorkflowId: 'workflow-1',
      orcaLeadSessionId: 'session-vendor-options-update',
    });

    expect(registerCodexMcpThreadContext).toHaveBeenCalledTimes(2);
    const secondCtx = registerCodexMcpThreadContext.mock.calls[1]?.[0];
    expect(secondCtx?.vendorOptions).toBe(firstCtx?.vendorOptions);
    expect(secondCtx?.vendorOptions).toEqual({
      orcaRole: 'lead',
      orcaWorkflowId: 'workflow-1',
      orcaLeadSessionId: 'session-vendor-options-update',
    });
    await handle.close();
  });
});

describe('CodexAgent steer', () => {
  it('rejects when the session is already closed before steering', async () => {
    const agent = new CodexAgent(createDeps());
    installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-steer-already-closed',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });

    await handle.close();

    await expect(handle.steer({ type: 'user', content: 'steer message' })).rejects.toThrow(/session is closed/i);
  });

  it('injects the message into the active turn via turn/steer without interrupting', async () => {
    // 同轮注入(2026-07-12 统一):steer 只发 turn/steer,不 interrupt、不另起
    // follow-up turn,当前 turn 继续跑。
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnSteer) return { turnId: 'turn-to-steer' };
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-steer-same-turn',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });
    const handlers = host.getThreadHandlers();
    expect(handlers).not.toBeNull();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-to-steer' },
    });

    await handle.steer({ type: 'user', content: 'steer message' });

    const steerCall = host.request.mock.calls.find(([method]) => method === Method.TurnSteer);
    expect(steerCall?.[1]).toMatchObject({
      threadId: 'start-thread-id',
      expectedTurnId: 'turn-to-steer',
    });
    expect((steerCall?.[1] as { input?: unknown[] }).input).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'steer message' })]),
    );
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnInterrupt)).toHaveLength(0);
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnStart)).toHaveLength(0);
    await handle.close();
  });

  it('rejects locally when there is no active turn to steer', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);

    const handle = await agent.startSession({
      sessionId: 'session-steer-no-active-turn',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });

    await expect(handle.steer({ type: 'user', content: 'steer message' })).rejects.toThrow(/No active Codex turn to steer/);
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnSteer)).toHaveLength(0);
    await handle.close();
  });

  it('propagates a server-side no-active-turn rejection for the normal-send fallback', async () => {
    // expectedTurnId 撞上 server 端已结束的 turn 时, server 报 no active turn to
    // steer;错误原样上抛, coordinator 按 NO_ACTIVE_TURN fallback 成普通派发。
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnSteer) {
        throw Object.assign(
          new Error('codex app-server turn/steer error -32602: no active turn to steer'),
          { code: -32602 },
        );
      }
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-steer-server-no-active-turn',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });
    const handlers = host.getThreadHandlers();
    expect(handlers).not.toBeNull();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-already-finished' },
    });

    await expect(handle.steer({ type: 'user', content: 'steer message' })).rejects.toThrow(/no active turn to steer/i);
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnStart)).toHaveLength(0);
    await handle.close();
  });

  it('resolves as delivered when the turn ends before the steer acknowledgement arrives', async () => {
    // review #939 第二轮 P1: ack 与 turn 终态乱序——server 已确认接受注入,消息
    // 已进 rollout,必须按**已投递**成功返回;抛 NO_ACTIVE_TURN 会让 coordinator
    // fallback 重发同一条消息,模型消费两次。turn 已死的收口由 coordinator 侧
    // 自查 isTurnRunning 合成(见 coordinator 用例)。
    const agent = new CodexAgent(createDeps());
    const ack = deferred<{ turnId: string }>();
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnSteer) return ack.promise;
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-steer-ack-after-turn-end',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });
    const handlers = host.getThreadHandlers();
    expect(handlers).not.toBeNull();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-to-steer' },
    });

    const steerPromise = handle.steer({ type: 'user', content: 'steer message' });
    for (let i = 0; i < 5; i += 1) {
      if (host.request.mock.calls.some(([method]) => method === Method.TurnSteer)) break;
      await Promise.resolve();
    }
    expect(host.request.mock.calls.some(([method]) => method === Method.TurnSteer)).toBe(true);

    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-to-steer',
      scope: 'turn',
      willRetry: false,
      error: { message: 'terminal error before steer ack' },
    });
    ack.resolve({ turnId: 'turn-to-steer' });

    await expect(steerPromise).resolves.toBeUndefined();
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnStart)).toHaveLength(0);
    await handle.close();
  });

  it('rejects a cancelled steer while the turn/steer ack is pending', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnSteer) return new Promise(() => {});
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-steer-cancelled',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });
    const handlers = host.getThreadHandlers();
    expect(handlers).not.toBeNull();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-to-steer' },
    });

    const controller = new AbortController();
    const steerPromise = handle.steer(
      { type: 'user', content: 'steer message' },
      { signal: controller.signal },
    );
    for (let i = 0; i < 5; i += 1) {
      if (host.request.mock.calls.some(([method]) => method === Method.TurnSteer)) break;
      await Promise.resolve();
    }
    expect(host.request.mock.calls.some(([method]) => method === Method.TurnSteer)).toBe(true);

    controller.abort();

    await expect(steerPromise).rejects.toThrow(/cancelled before acceptance/i);
    expect(host.request.mock.calls.filter(([method]) => method === Method.TurnStart)).toHaveLength(0);
    await handle.close();
  });

  it('rejects instead of hanging forever when turn/steer is never acknowledged', async () => {
    // app-server 卡死不回 turn/steer 的 ack 时, steer promise 必须有界 settle ——
    // 否则上层 coordinator 的 steering marker 永久残留, 后续所有插话点击被静默
    // 吞掉 (2026-06 "插话没反应" 反馈的根因之一)。
    const agent = new CodexAgent(createDeps());
    const lateAck = deferred<{ turnId: string }>();
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnSteer) return lateAck.promise;
      return undefined;
    });

    const handle = await agent.startSession({
      sessionId: 'session-steer-never-acks',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });
    const handlers = host.getThreadHandlers();
    expect(handlers).not.toBeNull();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-to-steer' },
    });

    vi.useFakeTimers();
    try {
      const steerPromise = handle.steer({ type: 'user', content: 'steer message' });
      for (let i = 0; i < 5; i += 1) {
        if (host.request.mock.calls.some(([method]) => method === Method.TurnSteer)) break;
        await Promise.resolve();
      }
      expect(host.request.mock.calls.some(([method]) => method === Method.TurnSteer)).toBe(true);

      const assertion = expect(steerPromise).rejects.toThrow(/did not acknowledge/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(host.request.mock.calls.filter(([method]) => method === Method.TurnStart)).toHaveLength(0);
      // 迟到 ack(review #939 P1 观察路径):late-resolution 观察器吞掉迟到结果并
      // 留 warn,不产生 unhandled rejection——冒烟:resolve 后测试正常结束即通过。
      lateAck.resolve({ turnId: 'turn-to-steer' });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
    await handle.close();
  });
});

describe('CodexAgent.forkSdkSession', () => {
  it('prepares an imported source thread before thread/fork', async () => {
    const order: string[] = [];
    const prepareCodexResumeSession = vi.fn(async () => {
      order.push('prepare');
    });
    const agent = new CodexAgent(createDeps({}, { prepareCodexResumeSession }));
    const host = installFakeHost(agent, (method) => {
      if (method === Method.ThreadFork) order.push('fork');
      return undefined;
    });

    await agent.forkSdkSession({
      sourceSdkSessionId: 'imported-source-thread',
      upToMessageId: undefined,
    });

    expect(prepareCodexResumeSession).toHaveBeenCalledWith('imported-source-thread');
    expect(order).toEqual(['prepare', 'fork']);
    expect(host.request).toHaveBeenCalledWith(Method.ThreadFork, expect.objectContaining({
      threadId: 'imported-source-thread',
    }));
  });

  it('does not call thread/fork when source-thread preparation fails', async () => {
    const prepareCodexResumeSession = vi.fn(async () => {
      throw new Error('rollout copy failed');
    });
    const agent = new CodexAgent(createDeps({}, { prepareCodexResumeSession }));
    const host = installFakeHost(agent);

    await expect(agent.forkSdkSession({
      sourceSdkSessionId: 'imported-source-thread',
      upToMessageId: undefined,
    })).rejects.toThrow('rollout copy failed');

    expect(host.request).not.toHaveBeenCalled();
  });

  it('forks the source thread, then rolls back the forked thread by tail turns', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);

    const result = await agent.forkSdkSession({
      sourceSdkSessionId: 'source-thread-id',
      upToMessageId: undefined,
      tailTurnsToDrop: 2,
      workingDir: '/repo',
      title: '[Fork] demo',
    });

    expect(host.ensureStarted).toHaveBeenCalledTimes(1);
    expect(host.request).toHaveBeenCalledTimes(2);
    expect(host.request).toHaveBeenNthCalledWith(1, Method.ThreadFork, {
      threadId: 'source-thread-id',
      persistExtendedHistory: true,
      cwd: '/repo',
    });
    expect(host.request).toHaveBeenNthCalledWith(2, Method.ThreadRollback, {
      threadId: 'fork-thread-id',
      numTurns: 2,
    });
    expect(result.newSdkSessionId).toBe('rollback-thread-id');
    expect(result.uuidMap.size).toBe(0);
  });

  it('skips rollback when no tail turns need to be removed', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);

    const result = await agent.forkSdkSession({
      sourceSdkSessionId: 'source-thread-id',
      upToMessageId: undefined,
      tailTurnsToDrop: 0,
    });

    expect(host.ensureStarted).toHaveBeenCalledTimes(1);
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.request).toHaveBeenCalledWith(Method.ThreadFork, {
      threadId: 'source-thread-id',
      persistExtendedHistory: true,
    });
    expect(result.newSdkSessionId).toBe('fork-thread-id');
    expect(result.uuidMap.size).toBe(0);
  });

  it('forks from a temporary rollout copy without unsafe payload lines', async () => {
    const agent = new CodexAgent(createDeps());
    let copied = '';
    const host = installFakeHost(agent, async (method, params) => {
      if (method !== Method.ThreadFork) return undefined;
      const forkPath = (params as { path?: string }).path;
      if (forkPath) copied = await fs.readFile(forkPath, 'utf8');
      return undefined;
    });
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-codex-home-'));
    try {
      (agent as unknown as { codexHome: string }).codexHome = codexHome;
      const sessionsDir = path.join(codexHome, 'sessions', '2026', '06', '11');
      await fs.mkdir(sessionsDir, { recursive: true });
      const sourceRollout = path.join(sessionsDir, 'rollout-2026-06-11-source-thread-id.jsonl');
      await fs.writeFile(
        sourceRollout,
        `${[
          JSON.stringify({ payload: { type: 'message', role: 'user' } }),
          JSON.stringify({ payload: { type: 'reasoning', encrypted_content: 'gAAA' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'image_generation_end', call_id: 'ig_1', result: 'data:image/png;base64,xxx' } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' } }),
          JSON.stringify({ payload: { type: 'message', role: 'assistant' } }),
        ].join('\n')}\n`,
        'utf8',
      );

      const result = await agent.forkSdkSession({
        sourceSdkSessionId: 'source-thread-id',
        upToMessageId: undefined,
        stripEncryptedReasoning: true,
      });

      expect(result.newSdkSessionId).toBe('fork-thread-id');
      const forkParams = host.request.mock.calls[0]?.[1] as { path?: string };
      expect(forkParams.path).toBeTruthy();
      expect(copied).toContain('"message"');
      expect(copied).toContain('"image_generation_call"');
      expect(copied).toContain('"ig_1"');
      expect(copied).not.toContain('"reasoning"');
      expect(copied).not.toContain('encrypted_content');
      expect(copied).not.toContain('"image_generation_end"');
      expect(copied).not.toContain('"call_id"');
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it('uses the rollout path returned by imported-thread preparation when stripping', async () => {
    const externalHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-codex-external-'));
    const sourceRollout = path.join(externalHome, 'rollout-imported-thread.jsonl');
    await fs.writeFile(sourceRollout, [
      JSON.stringify({ payload: { type: 'message', role: 'user' } }),
      JSON.stringify({ payload: { type: 'reasoning', encrypted_content: 'gAAA' } }),
      JSON.stringify({ payload: { type: 'message', role: 'assistant' } }),
    ].join('\n') + '\n', 'utf8');
    try {
      const prepareCodexResumeSession = vi.fn(async () => sourceRollout);
      const agent = new CodexAgent(createDeps({}, { prepareCodexResumeSession }));
      let copied = '';
      const host = installFakeHost(agent, async (method, params) => {
        if (method === Method.ThreadFork) {
          const forkPath = (params as { path?: string }).path;
          if (forkPath) copied = await fs.readFile(forkPath, 'utf8');
        }
        return undefined;
      });
      // The normal CODEX_HOME scan cannot see the external path; the prepared
      // path must still be used for the stripped fork.
      (agent as unknown as { codexHome: string }).codexHome = path.join(externalHome, 'empty-home');
      await agent.forkSdkSession({
        sourceSdkSessionId: 'imported-thread',
        upToMessageId: undefined,
        stripEncryptedReasoning: true,
      });
      expect(prepareCodexResumeSession).toHaveBeenCalledWith('imported-thread');
      expect(copied).toContain('"message"');
      expect(copied).not.toContain('encrypted_content');
      expect(host.request).toHaveBeenCalledWith(Method.ThreadFork, expect.objectContaining({
        path: expect.any(String),
      }));
    } finally {
      await fs.rm(externalHome, { recursive: true, force: true });
    }
  });
});

describe('CodexAgent rewind', () => {
  it('previews as conversation-only and commits via thread/rollback', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-rewind',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const previewRewindFiles = handle.previewRewindFiles;
    const commitRewindFiles = handle.commitRewindFiles;
    if (!previewRewindFiles || !commitRewindFiles) throw new Error('expected rewind methods');

    await expect(previewRewindFiles('ignored-user-uuid')).resolves.toEqual({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });

    const commitResult = await commitRewindFiles('', '', { tailTurnsToDrop: 2 });

    expect(host.request).toHaveBeenCalledWith(Method.ThreadRollback, {
      threadId: 'start-thread-id',
      numTurns: 2,
    });
    expect(commitResult).toEqual({ sdkSessionId: 'rollback-thread-id' });
    expect(host.subscribeThread).toHaveBeenCalledTimes(2);
    expect(host.subscribeThread).toHaveBeenLastCalledWith(
      'rollback-thread-id',
      expect.any(Object),
    );
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'session_id',
      data: 'rollback-thread-id',
      source: 'codex',
    });
    await handle.close();
  });

  it('re-registers proxy developer instructions for the replacement rollback thread', async () => {
    const registerCodexSystemPromptForThread = vi.fn();
    const agent = new CodexAgent(createDeps(
      { systemPrompt: 'HOST PRODUCT PROMPT' },
      { registerCodexSystemPromptForThread },
    ));
    installFakeHost(agent, undefined, { codexProxyActive: true });
    const handle = await agent.startSession({
      sessionId: 'session-rewind-proxy',
      model: 'gpt-5.4',
      workingDir: '/repo',
      userPrompt: 'USER PROMPT',
    });
    const registeredText = registerCodexSystemPromptForThread.mock.calls[0]?.[0]?.text;
    const commitRewindFiles = handle.commitRewindFiles;
    if (!commitRewindFiles) throw new Error('expected commitRewindFiles');

    await commitRewindFiles('', '', { tailTurnsToDrop: 1 });

    expect(registerCodexSystemPromptForThread).toHaveBeenLastCalledWith({
      sessionId: 'session-rewind-proxy',
      threadId: 'rollback-thread-id',
      text: registeredText,
    });
    await handle.close();
  });

  it('discards the replacement thread when close races with rollback cleanup', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-rewind-close-race',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const commitRewindFiles = handle.commitRewindFiles;
    if (!commitRewindFiles) throw new Error('expected commitRewindFiles');

    let resolveRelease: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const initialSubscription = host.subscribeThread.mock.results[0]?.value;
    const release = initialSubscription?.release;
    if (!release) throw new Error('expected initial subscription');
    release.mockImplementation(() => releaseGate);

    const rewindPromise = commitRewindFiles('', '', { tailTurnsToDrop: 1 });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    const closePromise = handle.close();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    resolveRelease?.();

    await expect(rewindPromise).resolves.toEqual({ sdkSessionId: 'start-thread-id' });
    await closePromise;
    expect(host.subscribeThread).toHaveBeenCalledTimes(1);
    expect(host.unsubscribeThread).toHaveBeenCalledWith('rollback-thread-id');
  });
});

describe('CodexAgent turn lifecycle', () => {
  it('clears running state and emits done status after terminal error notification', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-terminal-error',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    expect(handle.isTurnRunning?.()).toBe(true);
    expect(handle.getCurrentTurnId?.()).toBe('turn-1');

    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'terminal error' },
    });

    expect(handle.isTurnRunning?.()).toBe(false);
    expect(handle.getCurrentTurnId?.()).toBeNull();
    const errorEvent = await nextEvent(iterator);
    const statusEvent = await nextEvent(iterator);
    expect(errorEvent).toMatchObject({
      type: 'error',
      data: { message: 'terminal error', isTerminal: true, willRetry: false },
    });
    expect(statusEvent).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });

    await handle.close();
  });

  it('does not emit another terminal event when turnCompleted arrives after terminal error', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-terminal-error-late-complete',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'terminal error' },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'error' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'terminal error' },
      },
    });

    await expect(nextEvent(iterator)).rejects.toThrow('timed out waiting for event');
    await handle.close();
  });

  it('emits a fallback terminal error before done when a failed turn carries no error message', async () => {
    // 原 bug 路径①: turnCompleted(status='failed') 但 turn.error.message 缺失、且之前没有
    // terminal error handler 触发 → 旧实现只发 done, renderer 的 state.error 不置位,
    // 失败被通知成"已完成"。现在补一条 reason='turn-failed' 的兜底 terminal error。
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-failed-without-detail',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-1',
        status: 'failed',
      },
    });

    expect(await nextEvent(iterator)).toMatchObject({
      type: 'error',
      data: { reason: 'turn-failed', isTerminal: true },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });
    await handle.close();
  });

  it('does NOT emit a fallback error for an interrupted turn without error message', async () => {
    // interrupted = 用户主动停止, 不算失败, 不该弹"执行失败"。
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-interrupted-without-detail',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-1',
        status: 'interrupted',
      },
    });

    expect(await nextEvent(iterator)).toMatchObject({
      type: 'done',
      data: { cancelled: true },
    });
    await handle.close();
  });

  it('keeps the current turn running when a stale terminal error arrives', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-stale-error',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-stale',
      willRetry: false,
      error: { message: 'stale terminal error' },
    });

    expect(handle.isTurnRunning?.()).toBe(true);

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-1',
        status: 'completed',
      },
    });

    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });
    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.close();
  });

  it('runs late turnCompleted bookkeeping after terminal error without duplicate UI events', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-terminal-error-bookkeeping',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    handlers.tokenUsageUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      tokenUsage: {
        total: {
          totalTokens: 108,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 5,
          reasoningOutputTokens: 3,
        },
        last: {
          totalTokens: 108,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 5,
          reasoningOutputTokens: 3,
        },
        modelContextWindow: 272000,
      },
    });
    expect(handle.getUsageSnapshot().tokenUsage).toBeGreaterThan(0);

    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'terminal error' },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'error' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'terminal error' },
      },
    });

    await waitForExpectation(() => {
      expect(handle.getUsageSnapshot().tokenUsage).toBe(0);
    });

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-2' },
    });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-2',
        status: 'completed',
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });
    await handle.close();
  });

  it('does not reset the active turn usage when an older terminal-error turn completes late', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return {
          turn: { id: 'turn-b' },
        };
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-overlap-late-complete',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-a' },
    });
    handlers.tokenUsageUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      tokenUsage: {
        total: {
          totalTokens: 91,
          inputTokens: 80,
          cachedInputTokens: 20,
          outputTokens: 7,
          reasoningOutputTokens: 4,
        },
        last: {
          totalTokens: 91,
          inputTokens: 80,
          cachedInputTokens: 20,
          outputTokens: 7,
          reasoningOutputTokens: 4,
        },
        modelContextWindow: 272000,
      },
    });
    expect(handle.getUsageSnapshot().tokenUsage).toBe(71);
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      willRetry: false,
      error: { message: 'terminal error' },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'error' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });

    await handle.send({ type: 'user', content: 'next turn' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { isRunning: true, tokenUsage: 0 },
    });
    expect(handle.getUsageSnapshot().tokenUsage).toBe(0);
    expect(handle.isTurnRunning?.()).toBe(true);

    handlers.tokenUsageUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-b',
      tokenUsage: {
        total: {
          totalTokens: 52,
          inputTokens: 50,
          cachedInputTokens: 10,
          outputTokens: 2,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 52,
          inputTokens: 50,
          cachedInputTokens: 10,
          outputTokens: 2,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 272000,
      },
    });
    expect(handle.getUsageSnapshot().tokenUsage).toBe(42);

    handlers.tokenUsageUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      tokenUsage: {
        total: {
          totalTokens: 203,
          inputTokens: 200,
          cachedInputTokens: 30,
          outputTokens: 3,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 203,
          inputTokens: 200,
          cachedInputTokens: 30,
          outputTokens: 3,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 272000,
      },
    });
    expect(handle.getUsageSnapshot().tokenUsage).toBe(42);

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-a',
        status: 'failed',
        error: { message: 'terminal error' },
      },
    });

    expect(handle.getUsageSnapshot().tokenUsage).toBe(42);
    expect(handle.isTurnRunning?.()).toBe(true);

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-a' },
    });
    expect(handle.isTurnRunning?.()).toBe(true);

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-b',
        status: 'completed',
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });
    expect(handle.getUsageSnapshot().tokenUsage).toBe(0);
    await handle.close();
  });

  it('keeps terminal-error tombstone while next TurnStartResponse is pending', async () => {
    let resolveTurnStart!: (value: { turn: { id: string } }) => void;
    const pendingTurnStart = new Promise<{ turn: { id: string } }>((resolve) => {
      resolveTurnStart = resolve;
    });
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return pendingTurnStart;
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-late-usage-before-turn-response',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-a' },
    });
    handlers.tokenUsageUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      tokenUsage: {
        total: {
          totalTokens: 91,
          inputTokens: 80,
          cachedInputTokens: 20,
          outputTokens: 7,
          reasoningOutputTokens: 4,
        },
        last: {
          totalTokens: 91,
          inputTokens: 80,
          cachedInputTokens: 20,
          outputTokens: 7,
          reasoningOutputTokens: 4,
        },
        modelContextWindow: 272000,
      },
    });
    expect(handle.getUsageSnapshot().tokenUsage).toBe(71);
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      willRetry: false,
      error: { message: 'terminal error' },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'error' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });

    const sendPromise = handle.send({ type: 'user', content: 'next turn' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { isRunning: true, tokenUsage: 0 },
    });
    expect(handle.getUsageSnapshot().tokenUsage).toBe(0);

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-a',
        status: 'failed',
        error: { message: 'terminal error' },
      },
    });
    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-a' },
    });
    handlers.tokenUsageUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      tokenUsage: {
        total: {
          totalTokens: 203,
          inputTokens: 200,
          cachedInputTokens: 30,
          outputTokens: 3,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 203,
          inputTokens: 200,
          cachedInputTokens: 30,
          outputTokens: 3,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 272000,
      },
    });
    handlers.itemStarted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'old-message', text: 'stale text' },
    });
    handlers.reasoningSummaryTextDelta?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      itemId: 'old-thinking',
      delta: 'stale thinking',
      summaryIndex: 0,
    });
    const tokenUsageAfterLateA = handle.getUsageSnapshot().tokenUsage;

    resolveTurnStart({ turn: { id: 'turn-b' } });
    await sendPromise;
    handlers.itemStarted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-b',
      item: { type: 'agentMessage', id: 'new-message', text: 'fresh text' },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Generating...' },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'text',
      data: { text: 'fresh text', isFinal: false },
    });
    handlers.reasoningSummaryTextDelta?.({
      threadId: 'start-thread-id',
      turnId: 'turn-b',
      itemId: 'new-thinking',
      delta: 'fresh thinking',
      summaryIndex: 0,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'thinking',
      data: { stage: 'start', blockId: 'new-thinking' },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'thinking',
      data: { stage: 'delta', blockId: 'new-thinking', text: 'fresh thinking' },
    });
    handlers.tokenUsageUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-b',
      tokenUsage: {
        total: {
          totalTokens: 52,
          inputTokens: 50,
          cachedInputTokens: 10,
          outputTokens: 2,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 52,
          inputTokens: 50,
          cachedInputTokens: 10,
          outputTokens: 2,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 272000,
      },
    });
    const tokenUsageAfterB = handle.getUsageSnapshot().tokenUsage;

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-b',
        status: 'completed',
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });
    await handle.close();

    expect(tokenUsageAfterLateA).toBe(0);
    expect(tokenUsageAfterB).toBe(42);
  });

  it('accepts terminal error before TurnStartResponse and does not revive that turn', async () => {
    let resolveTurnStart!: (value: { turn: { id: string } }) => void;
    const pendingTurnStart = new Promise<{ turn: { id: string } }>((resolve) => {
      resolveTurnStart = resolve;
    });
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return pendingTurnStart;
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-terminal-error-before-turn-response',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    const sendPromise = handle.send({ type: 'user', content: 'hello' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { isRunning: true },
    });

    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-from-response',
      willRetry: false,
      error: { message: 'terminal error before response' },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'error',
      data: { message: 'terminal error before response', isTerminal: true },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(handle.isTurnRunning?.()).toBe(false);

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-from-response',
        status: 'failed',
        error: { message: 'terminal error before response' },
      },
    });
    resolveTurnStart({ turn: { id: 'turn-from-response' } });
    await sendPromise;

    expect(handle.isTurnRunning?.()).toBe(false);
    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-from-response' },
    });
    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.close();
  });

  it('ignores stale turn-scoped item and reasoning events around the next turn', async () => {
    let resolveTurnStart!: (value: { turn: { id: string } }) => void;
    const pendingTurnStart = new Promise<{ turn: { id: string } }>((resolve) => {
      resolveTurnStart = resolve;
    });
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return pendingTurnStart;
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-stale-turn-scoped-events',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-a' },
    });
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      willRetry: false,
      error: { message: 'terminal error' },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'error' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });

    const sendPromise = handle.send({ type: 'user', content: 'next turn' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { isRunning: true },
    });

    handlers.itemStarted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      item: {
        id: 'stale-command',
        type: 'commandExecution',
        command: 'echo stale',
        cwd: '/repo',
        status: 'running',
      },
    });
    handlers.itemUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      item: {
        id: 'stale-message',
        type: 'agentMessage',
        text: 'stale text',
      },
    });
    handlers.itemCompleted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      item: {
        id: 'stale-final',
        type: 'agentMessage',
        text: 'stale final',
      },
    });
    handlers.reasoningSummaryTextDelta?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      itemId: 'stale-reasoning',
      summaryIndex: 0,
      delta: 'stale thought',
    });
    handlers.reasoningTextDelta?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      itemId: 'stale-raw-reasoning',
      contentIndex: 0,
      delta: 'stale raw thought',
    });

    resolveTurnStart({ turn: { id: 'turn-b' } });
    await sendPromise;
    handlers.itemUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      item: {
        id: 'stale-active-message',
        type: 'agentMessage',
        text: 'stale active text',
      },
    });

    handlers.reasoningSummaryTextDelta?.({
      threadId: 'start-thread-id',
      turnId: 'turn-b',
      itemId: 'turn-b-reasoning',
      summaryIndex: 0,
      delta: 'fresh thought',
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'thinking',
      data: { stage: 'start', blockId: 'turn-b-reasoning' },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'thinking',
      data: { stage: 'delta', blockId: 'turn-b-reasoning', text: 'fresh thought' },
    });
    handlers.itemUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-b',
      item: {
        id: 'turn-b-message',
        type: 'agentMessage',
        text: 'fresh text',
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'text',
      data: { text: 'fresh text', isFinal: false },
    });

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-b',
        status: 'completed',
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });
    await handle.close();
  });

  it('ignores turn-scoped events that arrive after a normally completed turn', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-late-events-after-normal-complete',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-completed' },
    });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-completed', status: 'completed' },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });
    expect(handle.isTurnRunning?.()).toBe(false);

    handlers.itemStarted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-completed',
      item: {
        id: 'late-tool',
        type: 'mcpToolCall',
        server: 'functions',
        tool: 'exec',
        status: 'inProgress',
        arguments: {},
      },
    });
    handlers.itemUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-completed',
      item: {
        id: 'late-message',
        type: 'agentMessage',
        text: 'late text',
      },
    });
    handlers.itemCompleted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-completed',
      item: {
        id: 'late-message',
        type: 'agentMessage',
        text: 'late final text',
      },
    });
    handlers.reasoningSummaryTextDelta?.({
      threadId: 'start-thread-id',
      turnId: 'turn-completed',
      itemId: 'late-reasoning',
      summaryIndex: 0,
      delta: 'late thought',
    });
    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-completed' },
    });

    await expect(nextEvent(iterator)).rejects.toThrow('timed out waiting for event');
    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.close();
  });

  it('emits the terminal boundary only once for duplicate turnCompleted notifications', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-duplicate-normal-complete',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();
    const completed = {
      threadId: 'start-thread-id',
      turn: { id: 'turn-completed', status: 'completed' as const },
    };

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-completed' },
    });
    handlers.turnCompleted?.(completed);
    expect(await nextEvent(iterator)).toMatchObject({ type: 'status' });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });

    handlers.turnCompleted?.(completed);

    await expect(nextEvent(iterator)).rejects.toThrow('timed out waiting for event');
    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.close();
  });

  it('keeps stale turn guard after an older terminal-error turn completes during another turn', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-stale-events-after-overlap-complete',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-a' },
    });
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      willRetry: false,
      error: { message: 'terminal error' },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'error' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-b' },
    });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-a',
        status: 'failed',
        error: { message: 'terminal error' },
      },
    });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-b', status: 'completed' },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });

    handlers.itemStarted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      item: {
        id: 'stale-command',
        type: 'commandExecution',
        command: 'echo stale',
        cwd: '/repo',
        status: 'inProgress',
      },
    });
    handlers.reasoningSummaryTextDelta?.({
      threadId: 'start-thread-id',
      turnId: 'turn-a',
      itemId: 'stale-reasoning',
      summaryIndex: 0,
      delta: 'stale thought',
    });

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-c' },
    });
    handlers.itemStarted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-c',
      item: {
        id: 'fresh-message',
        type: 'agentMessage',
        text: 'fresh text',
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Generating...' },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'text',
      data: { text: 'fresh text', isFinal: false },
    });
    await handle.close();
  });

  it('treats synthetic transport terminal error as the current running turn', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-synthetic-error',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: '',
      willRetry: false,
      scope: 'transport',
      error: { message: 'transport closed' },
    });

    expect(handle.isTurnRunning?.()).toBe(false);
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'error',
      data: { message: 'transport closed', isTerminal: true },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    await handle.close();
  });

  it('re-subscribes before the next send after an idle transport terminal error', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-idle-transport-error',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();

    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: '',
      willRetry: false,
      scope: 'transport',
      error: { message: 'transport closed while idle' },
    });

    await handle.send({ type: 'user', content: 'next turn' });

    expect(host.subscribeThread).toHaveBeenCalledTimes(2);
    expect(host.subscribeThread).toHaveBeenLastCalledWith('start-thread-id', handlers);
    await handle.close();
  });

  it('re-subscribes before the next send after an active transport terminal error', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-active-transport-error',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: '',
      willRetry: false,
      scope: 'transport',
      error: { message: 'transport closed during active turn' },
    });

    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.send({ type: 'user', content: 'next turn' });

    expect(host.subscribeThread).toHaveBeenCalledTimes(2);
    expect(host.subscribeThread).toHaveBeenLastCalledWith('start-thread-id', handlers);
    await handle.close();
  });

  it('uses TurnStartResponse turn id to handle terminal error before turnStarted notification', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return {
          turn: { id: 'turn-from-response' },
        };
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-error-before-turn-started',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    await handle.send({ type: 'user', content: 'hello' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { isRunning: true },
    });
    expect(handle.isTurnRunning?.()).toBe(true);

    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-from-response',
      willRetry: false,
      error: { message: 'terminal error before notification' },
    });

    expect(handle.isTurnRunning?.()).toBe(false);
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'error',
      data: {
        message: 'terminal error before notification',
        isTerminal: true,
        willRetry: false,
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    await handle.close();
  });

  it('ignores late turnStarted after terminal error from TurnStartResponse turn id', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        return {
          turn: { id: 'turn-from-response' },
        };
      }
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-late-turn-started-after-error',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    await handle.send({ type: 'user', content: 'hello' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { isRunning: true },
    });
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-from-response',
      willRetry: false,
      error: { message: 'terminal error before notification' },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'error' });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(handle.isTurnRunning?.()).toBe(false);

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-from-response' },
    });
    expect(handle.isTurnRunning?.()).toBe(false);

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-from-response',
        status: 'failed',
        error: { message: 'terminal error before notification' },
      },
    });

    await expect(nextEvent(iterator)).rejects.toThrow('timed out waiting for event');
    await handle.close();
  });

  it('lets turnCompleted finish the turn after non-terminal retrying error', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-retry-error-complete',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const subscribeCalls = host.subscribeThread.mock.calls as unknown as Array<[string, ThreadEventHandlers]>;
    const handlers = subscribeCalls[0]?.[1];
    expect(handlers).toBeDefined();
    const iterator = handle.events()[Symbol.asyncIterator]();

    handlers.turnStarted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1' },
    });
    handlers.error?.({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'temporary upstream error' },
    });
    expect(handle.isTurnRunning?.()).toBe(true);

    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: {
        id: 'turn-1',
        status: 'completed',
      },
    });

    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: 'done' });
    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.close();
  });
});

describe('CodexAgent plan mode', () => {
  const PLAN_SETTINGS = {
    model: 'gpt-5.4',
    reasoning_effort: 'high',
    developer_instructions: null,
  };

  function turnStartCalls(host: ReturnType<typeof installFakeHost>) {
    return host.request.mock.calls.filter(([method]) => method === Method.TurnStart);
  }

  function collaborationModeItem(mode: 'Plan' | 'Default') {
    return {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: `<collaboration_mode># ${mode} Mode\n</collaboration_mode>`,
        },
      ],
    };
  }

  function installTurnHost(agent: CodexAgent) {
    let turnSeq = 0;
    return installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) return { turn: { id: `turn-${++turnSeq}` } };
      return undefined;
    });
  }

  async function startPlanSession(agent: CodexAgent, host: ReturnType<typeof installFakeHost>, sessionId: string) {
    const handle = await agent.startSession({
      sessionId,
      model: 'gpt-5.4',
      workingDir: '/repo',
      planMode: true,
    });
    void host;
    return handle;
  }

  /** 模拟一个完整 plan turn: started → plan item → completed。 */
  function runPlanTurn(host: ReturnType<typeof installFakeHost>, turnId: string, planText: string) {
    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: turnId } });
    handlers.itemCompleted?.({
      threadId: 'start-thread-id',
      turnId,
      item: { type: 'plan', id: `${turnId}-plan`, text: planText },
    } as never);
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: turnId, status: 'completed' },
    });
  }

  it('carries collaborationMode plan on turn/start and omits it for normal sessions', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-turn-params');

    await handle.send({ type: 'user', content: 'make a plan' });

    const [, params] = turnStartCalls(host)[0] as [string, Record<string, unknown>];
    expect(params.collaborationMode).toEqual({ mode: 'plan', settings: PLAN_SETTINGS });
    // 一次性语义: send 消耗武装态, 勾选自动熄灭(本轮循环由 planCycleActive 继续)。
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();

    // 常规会话逐字节不变: 不携带 collaborationMode 字段。
    const normalAgent = new CodexAgent(createDeps());
    const normalHost = installTurnHost(normalAgent);
    const normalHandle = await normalAgent.startSession({
      sessionId: 'session-no-plan-turn-params',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    await normalHandle.send({ type: 'user', content: 'hello' });
    const [, normalParams] = turnStartCalls(normalHost)[0] as [string, Record<string, unknown>];
    expect('collaborationMode' in normalParams).toBe(false);
    expect(normalHandle.getPlanMode?.()).toBe(false);
    await normalHandle.close();
  });

  it('does not request a default marker for resumed native plan items without a collaboration marker', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.ThreadResume) {
        return {
          thread: {
            id: 'resume-thread-id',
            turns: [
              {
                id: 'turn-plan',
                items: [{ type: 'plan', id: 'plan-1', text: '1. inspect\n2. edit' }],
              },
            ],
          },
          model: 'gpt-5.4',
          modelProvider: 'openai',
          cwd: '/repo',
        };
      }
      if (method === Method.TurnStart) return { turn: { id: 'turn-1' } };
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-plan-resume-reset',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
    });

    await handle.send({ type: 'user', content: 'continue normally' });
    const [, params] = turnStartCalls(host)[0] as [string, Record<string, unknown>];
    expect(params.collaborationMode).toEqual({
      mode: 'default',
      settings: { ...PLAN_SETTINGS, developer_instructions: '' },
    });
    await handle.close();
  });

  it('resets sticky plan collaborationMode after resume when history only has the Plan Mode marker', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.ThreadResume) {
        return {
          thread: {
            id: 'resume-thread-id',
            turns: [
              {
                id: 'turn-plan-without-output',
                items: [collaborationModeItem('Plan')],
              },
            ],
          },
          model: 'gpt-5.4',
          modelProvider: 'openai',
          cwd: '/repo',
        };
      }
      if (method === Method.TurnStart) return { turn: { id: 'turn-1' } };
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-plan-marker-resume-reset',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
    });

    await handle.send({ type: 'user', content: 'continue normally' });
    const [, params] = turnStartCalls(host)[0] as [string, Record<string, unknown>];
    expect(params.collaborationMode).toEqual({
      mode: 'default',
      settings: PLAN_SETTINGS,
    });
    await handle.close();
  });

  it('does not request another default marker when resumed history already ended in Default Mode', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installFakeHost(agent, (method) => {
      if (method === Method.ThreadResume) {
        return {
          thread: {
            id: 'resume-thread-id',
            turns: [
              {
                id: 'turn-plan',
                items: [
                  collaborationModeItem('Plan'),
                  { type: 'plan', id: 'plan-1', text: '1. inspect\n2. edit' },
                ],
              },
              {
                id: 'turn-default',
                items: [collaborationModeItem('Default')],
              },
            ],
          },
          model: 'gpt-5.4',
          modelProvider: 'openai',
          cwd: '/repo',
        };
      }
      if (method === Method.TurnStart) return { turn: { id: 'turn-1' } };
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-plan-default-marker-resume',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
    });

    await handle.send({ type: 'user', content: 'continue normally' });
    const [, params] = turnStartCalls(host)[0] as [string, Record<string, unknown>];
    expect(params.collaborationMode).toEqual({
      mode: 'default',
      settings: { ...PLAN_SETTINGS, developer_instructions: '' },
    });
    await handle.close();
  });

  it('does not request a default marker for resumed threads without plan history', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-normal-resume-reset',
      model: 'gpt-5.4',
      workingDir: '/repo',
      resumeSessionId: '123e4567-e89b-12d3-a456-426614174000',
    });

    await handle.send({ type: 'user', content: 'continue normally' });

    const [, params] = turnStartCalls(host)[0] as [string, Record<string, unknown>];
    expect(params.collaborationMode).toEqual({
      mode: 'default',
      settings: { ...PLAN_SETTINGS, developer_instructions: '' },
    });
    await handle.close();
  });

  it('dispatches plan_review after a plan turn and starts the implementation turn on approval', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-approve');
    const iterator = handle.events()[Symbol.asyncIterator]();
    const seen: unknown[] = [];
    handle.setInteractionResolver(async (req) => {
      seen.push(req);
      return { kind: 'plan_review', behavior: 'allow' };
    });

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X\n2. do Y');

    // 批准 → 自动发起实施 turn (输入与官方 TUI 一致), 并退出计划模式。
    await vi.waitFor(() => {
      expect(turnStartCalls(host)).toHaveLength(2);
    });
    expect(seen[0]).toMatchObject({ kind: 'plan_review', plan: '1. do X\n2. do Y' });
    const [, implParams] = turnStartCalls(host)[1] as [string, {
      input: Array<{ type: string; text?: string }>;
      collaborationMode?: { mode: string; settings: { developer_instructions: string | null } };
    }];
    expect(implParams.input).toEqual([{ type: 'text', text: 'Implement the plan.' }]);
    // 进过 plan 的线程退出后必须显式复位 default，并让 app-server 注入官方 Default Mode marker。
    expect(implParams.collaborationMode).toEqual({
      mode: 'default',
      settings: PLAN_SETTINGS,
    });
    expect(handle.getPlanMode?.()).toBe(false);

    // plan_mode_changed 事件让 host 回写持久化。
    let sawPlanModeChanged = false;
    for (let i = 0; i < 30 && !sawPlanModeChanged; i++) {
      const ev = await nextEvent(iterator);
      if (ev.type === 'plan_mode_changed') {
        expect(ev.data).toEqual({ enabled: false });
        sawPlanModeChanged = true;
      }
    }
    expect(sawPlanModeChanged).toBe(true);
    // plan item 不再渲染为 update_plan 工具行 — tool_use 事件不该出现。
    await handle.close();
  });

  it('requests the default marker again when turn/start retries after a daemon restart', async () => {
    const agent = new CodexAgent(createDeps());
    let turnStartCount = 0;
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        turnStartCount += 1;
        if (turnStartCount === 1) return { turn: { id: 'turn-1' } };
        if (turnStartCount === 2) throw new Error('thread not found');
        return { turn: { id: `turn-${turnStartCount}` } };
      }
      if (method === Method.ThreadResume) {
        return {
          thread: {
            id: 'start-thread-id',
            turns: [
              {
                id: 'turn-1',
                items: [collaborationModeItem('Plan')],
              },
            ],
          },
          model: 'gpt-5.4',
          modelProvider: 'openai',
          cwd: '/repo',
        };
      }
      return undefined;
    });
    const handle = await startPlanSession(agent, host, 'session-plan-exit-retry');
    handle.setInteractionResolver(async () => ({ kind: 'plan_review', behavior: 'allow' }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X\n2. do Y');

    await vi.waitFor(() => {
      expect(turnStartCalls(host)).toHaveLength(3);
    });
    const [, failedImplParams] = turnStartCalls(host)[1] as [string, {
      collaborationMode?: { mode: string; settings: { developer_instructions: string | null } };
    }];
    const [, retryParams] = turnStartCalls(host)[2] as [string, {
      collaborationMode?: { mode: string; settings: { developer_instructions: string | null } };
    }];
    expect(failedImplParams.collaborationMode).toEqual({ mode: 'default', settings: PLAN_SETTINGS });
    expect(retryParams.collaborationMode).toEqual({ mode: 'default', settings: PLAN_SETTINGS });
    await handle.close();
  });

  it('emits a terminal event when the approved plan implementation turn cannot start', async () => {
    const agent = new CodexAgent(createDeps());
    let turnSeq = 0;
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        turnSeq += 1;
        if (turnSeq === 2) {
          throw new Error('Codex send cannot be accepted: stale host before turn/start');
        }
        return { turn: { id: `turn-${turnSeq}` } };
      }
      return undefined;
    });
    const handle = await startPlanSession(agent, host, 'session-plan-approve-start-fails');
    const iterator = handle.events()[Symbol.asyncIterator]();
    handle.setInteractionResolver(async () => ({ kind: 'plan_review', behavior: 'allow' }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X');

    await vi.waitFor(() => {
      expect(turnStartCalls(host)).toHaveLength(2);
    });
    let sawTerminalError = false;
    for (let i = 0; i < 30 && !sawTerminalError; i++) {
      const ev = await nextEvent(iterator);
      if (ev.type === 'error') {
        expect(ev.data).toMatchObject({
          message: expect.stringContaining('plan implementation turn failed to start'),
          isTerminal: true,
        });
        sawTerminalError = true;
      }
    }
    expect(sawTerminalError).toBe(true);
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });
    await handle.close();
  });

  it('appends the revised plan to the implementation message when user edited it', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-edited');
    handle.setInteractionResolver(async () => ({
      kind: 'plan_review',
      behavior: 'allow',
      editedPlan: '1. do X\n2. do Z (revised)',
    }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X\n2. do Y');

    await vi.waitFor(() => {
      expect(turnStartCalls(host)).toHaveLength(2);
    });
    const [, implParams] = turnStartCalls(host)[1] as [string, { input: Array<{ type: string; text?: string }> }];
    expect(implParams.input).toEqual([
      { type: 'text', text: 'Implement the plan. Follow this revised plan:\n\n1. do X\n2. do Z (revised)' },
    ]);
    await handle.close();
  });

  it('stays in plan mode and sends the feedback as a revision turn on deny with reason', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-revise');
    handle.setInteractionResolver(async () => ({
      kind: 'plan_review',
      behavior: 'deny',
      reason: '再加一步测试',
    }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X');

    await vi.waitFor(() => {
      expect(turnStartCalls(host)).toHaveLength(2);
    });
    const [, reviseParams] = turnStartCalls(host)[1] as [string, {
      input: Array<{ type: string; text?: string }>;
      collaborationMode?: { mode: string };
    }];
    expect(reviseParams.input).toEqual([{ type: 'text', text: '再加一步测试' }]);
    // 修订 turn 仍在本轮 plan 循环内(collaborationMode 保持 plan),
    // 但一次性勾选已在首次 send 消耗。
    expect(reviseParams.collaborationMode).toEqual({ mode: 'plan', settings: PLAN_SETTINGS });
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('emits a terminal event and ends the plan cycle when the revision turn cannot start', async () => {
    const agent = new CodexAgent(createDeps());
    let turnSeq = 0;
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        turnSeq += 1;
        if (turnSeq === 2) {
          throw new Error('Codex send cannot be accepted: stale host before turn/start');
        }
        return { turn: { id: `turn-${turnSeq}` } };
      }
      return undefined;
    });
    const handle = await startPlanSession(agent, host, 'session-plan-revision-start-fails');
    const iterator = handle.events()[Symbol.asyncIterator]();
    handle.setInteractionResolver(async () => ({
      kind: 'plan_review',
      behavior: 'deny',
      reason: '先补测试',
    }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X');

    await vi.waitFor(() => {
      expect(turnStartCalls(host)).toHaveLength(2);
    });
    let sawTerminalError = false;
    for (let i = 0; i < 30 && !sawTerminalError; i++) {
      const ev = await nextEvent(iterator);
      if (ev.type === 'error') {
        expect(ev.data).toMatchObject({
          message: expect.stringContaining('plan revision turn failed to start'),
          isTerminal: true,
        });
        sawTerminalError = true;
      }
    }
    expect(sawTerminalError).toBe(true);
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'status',
      data: { status: 'Done', isRunning: false },
    });

    await handle.send({ type: 'user', content: 'continue normally' });
    const [, nextParams] = turnStartCalls(host)[2] as [string, Record<string, unknown>];
    expect((nextParams.collaborationMode as { mode?: string } | undefined)?.mode).not.toBe('plan');
    await handle.close();
  });

  it('does not start a revision turn on system dismissal (deny + reason + dismissed)', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-system-dismiss');
    // 模拟 main 的 cleanupPendingInteractionsForSession(abort/close): deny 携带系统
    // reason + dismissed 标记 —— 绝不能被当成用户反馈发起修订 turn。
    handle.setInteractionResolver(async () => ({
      kind: 'plan_review',
      behavior: 'deny',
      reason: 'session_aborted',
      dismissed: true,
    }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnStartCalls(host)).toHaveLength(1);
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('attaches the latest structured plan snapshot to task_complete without changing statuses', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-plan-terminal-sync',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');

    await handle.send({ type: 'user', content: 'implement it' });
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1' } });
    const plan = [
      { step: 'Inspect', status: 'completed' as const },
      { step: 'Patch', status: 'in_progress' as const },
      { step: 'Test', status: 'pending' as const },
    ];
    handlers.turnPlanUpdated?.({ threadId: 'start-thread-id', turnId: 'turn-1', plan });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1', status: 'completed' },
    });

    let done: AgentEvent | null = null;
    for (let i = 0; i < 20 && !done; i += 1) {
      const event = await nextEvent(iterator);
      if (event.type === 'done') done = event;
    }
    expect(done).toMatchObject({
      type: 'done',
      data: { type: 'codex/event/task_complete', plan },
    });
    await handle.close();
  });

  it('does not attach a prior turn plan to a later task_complete', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-plan-terminal-cross-turn',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');

    await handle.send({ type: 'user', content: 'first turn' });
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1' } });
    handlers.turnPlanUpdated?.({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      plan: [{ step: 'Patch', status: 'in_progress' }],
    });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1', status: 'interrupted' },
    });
    while ((await nextEvent(iterator)).type !== 'done') { /* drain first turn */ }

    await handle.send({ type: 'user', content: 'second turn without a plan' });
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-2' } });
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-2', status: 'completed' },
    });

    const secondTurnEvents: AgentEvent[] = [];
    for (let i = 0; i < 20 && secondTurnEvents.at(-1)?.type !== 'done'; i += 1) {
      const event = await nextEvent(iterator);
      secondTurnEvents.push(event);
    }
    expect(secondTurnEvents.some((event) => event.type === 'tool_use')).toBe(false);
    await handle.close();
  });

  it('does not intercept native plan items from an active normal turn after arming the next turn', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-plan-armed-during-normal-turn',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const seen: unknown[] = [];
    handle.setInteractionResolver(async (req) => {
      seen.push(req);
      return { kind: 'plan_review', behavior: 'allow' };
    });
    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');

    await handle.send({ type: 'user', content: 'normal work' });
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1' } });

    await handle.setPlanMode?.(true);
    handlers.itemCompleted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      item: { type: 'plan', id: 'turn-1-plan', text: 'normal turn update_plan content' },
    } as never);
    handlers.turnCompleted?.({
      threadId: 'start-thread-id',
      turn: { id: 'turn-1', status: 'completed' },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(0);
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.send({ type: 'user', content: 'now make a plan' });
    const [, nextParams] = turnStartCalls(host)[1] as [string, Record<string, unknown>];
    expect(nextParams.collaborationMode).toEqual({
      mode: 'plan',
      settings: PLAN_SETTINGS,
    });
    await handle.close();
  });

  it('does not start a revision turn for listenerless plan review fallback', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-listenerless-dismiss');
    handle.setInteractionResolver(async () => ({
      kind: 'plan_review',
      behavior: 'deny',
      reason: 'no_listener_attached',
    }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnStartCalls(host)).toHaveLength(1);
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('does not start a revision turn for IM plan reject sentinel', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-im-reject');
    handle.setInteractionResolver(async () => ({
      kind: 'plan_review',
      behavior: 'deny',
      reason: 'user_rejected',
    }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnStartCalls(host)).toHaveLength(1);
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('keeps plan mode idle on dismissed review (deny without reason)', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-dismiss');
    handle.setInteractionResolver(async () => ({ kind: 'plan_review', behavior: 'deny' }));

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X');

    // 给 review flow 一个 tick — 不应发起任何新 turn。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnStartCalls(host)).toHaveLength(1);
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('plan mode is one-shot: the next send after an empty plan cycle resets to default', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-plan-toggle',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });

    await handle.setPlanMode?.(true);
    await handle.send({ type: 'user', content: 'plan it' });
    const [, planParams] = turnStartCalls(host)[0] as [string, Record<string, unknown>];
    expect(planParams.collaborationMode).toEqual({ mode: 'plan', settings: PLAN_SETTINGS });
    expect(handle.getPlanMode?.()).toBe(false);

    // 计划轮空跑(没产出 <proposed_plan>) → 循环结束; 第二条消息无需手动关,
    // 自动回到 default(sticky 复位)。
    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1' } });
    handlers.turnCompleted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1', status: 'completed' } });
    await waitForExpectation(() => {
      expect(turnStartCalls(host)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await handle.send({ type: 'user', content: 'just do it' });
    const [, resetParams] = turnStartCalls(host)[1] as [string, Record<string, unknown>];
    expect(resetParams.collaborationMode).toEqual({
      mode: 'default',
      settings: PLAN_SETTINGS,
    });
    await handle.close();
  });

  it('does not mark a failed plan turn/start as touched plan history', async () => {
    const agent = new CodexAgent(createDeps());
    let failNext = true;
    let turnSeq = 0;
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) {
        if (failNext) {
          failNext = false;
          throw new Error('boom: upstream rejected');
        }
        return { turn: { id: `turn-${++turnSeq}` } };
      }
      return undefined;
    });
    const handle = await startPlanSession(agent, host, 'session-plan-turnstart-fail');

    // 勾选被消耗 + turn/start 失败 → 循环结束(不泄漏), 勾选不复燃(与 turn 失败同语义)。
    // app-server 未接受 plan turn/start 前, thread history 里还没有 Plan Mode marker。
    await handle.send({ type: 'user', content: 'make a plan' });
    expect(handle.getPlanMode?.()).toBe(false);

    await handle.send({ type: 'user', content: 'just do it' });
    const [, params] = turnStartCalls(host)[1] as [string, Record<string, unknown>];
    expect('collaborationMode' in params).toBe(false);
    await handle.close();
  });

  it('honors the per-send plan intent snapshot over the current armed state', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await agent.startSession({
      sessionId: 'session-plan-send-snapshot',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });

    // 排队行快照 true + 当前未武装(排队后用户关掉勾选) → 本 turn 仍按计划执行。
    await handle.send({ type: 'user', content: 'queued plan request' }, { planMode: true });
    const [, planParams] = turnStartCalls(host)[0] as [string, Record<string, unknown>];
    expect(planParams.collaborationMode).toEqual({ mode: 'plan', settings: PLAN_SETTINGS });

    // 结束这轮空跑循环, 避免 cycle 干扰下一个断言。
    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1' } });
    handlers.turnCompleted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1', status: 'completed' } });

    // 排队行快照 false + 当前已武装(排队普通消息后用户重新勾选) → 本 turn 普通执行,
    // 武装态保留给未来消息。
    await handle.setPlanMode?.(true);
    await handle.send({ type: 'user', content: 'queued normal message' }, { planMode: false });
    const [, normalParams] = turnStartCalls(host)[1] as [string, Record<string, unknown>];
    expect((normalParams.collaborationMode as { mode?: string } | undefined)?.mode).not.toBe('plan');
    expect(handle.getPlanMode?.()).toBe(true);
    await handle.close();
  });

  it('honors explicit normal sends while a plan review is pending', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-review-control-send');
    const pendingDecision = deferred<InteractionDecision>();
    const seen: unknown[] = [];
    handle.setInteractionResolver(async (req) => {
      seen.push(req);
      return pendingDecision.promise;
    });

    await handle.send({ type: 'user', content: 'make a plan' });
    runPlanTurn(host, 'turn-1', '1. do X');
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });

    await handle.send({ type: 'user', content: 'control message' }, { planMode: false });
    const [, controlParams] = turnStartCalls(host)[1] as [string, Record<string, unknown>];
    expect(controlParams.collaborationMode).toEqual({
      mode: 'default',
      settings: PLAN_SETTINGS,
    });

    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-2' } });
    handlers.itemCompleted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-2',
      item: { type: 'plan', id: 'turn-2-plan', text: 'control turn native plan item' },
    } as never);
    handlers.turnCompleted?.({ threadId: 'start-thread-id', turn: { id: 'turn-2', status: 'completed' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);

    pendingDecision.resolve({ kind: 'plan_review', behavior: 'deny' });
    await handle.close();
  });

  it('keys early native plan item interception to the current turn send intent', async () => {
    const agent = new CodexAgent(createDeps());
    let turnSeq = 0;
    const host = installFakeHost(agent, (method) => {
      if (method !== Method.TurnStart) return undefined;
      turnSeq += 1;
      const turnId = `turn-${turnSeq}`;
      const handlers = host.getThreadHandlers();
      if (!handlers) throw new Error('expected thread handlers');
      handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: turnId } });
      if (turnSeq === 2) {
        handlers.itemCompleted?.({
          threadId: 'start-thread-id',
          turnId,
          item: { type: 'plan', id: `${turnId}-plan`, text: 'control turn early native plan item' },
        } as never);
        handlers.turnCompleted?.({
          threadId: 'start-thread-id',
          turn: { id: turnId, status: 'completed' },
        });
      }
      return { turn: { id: turnId } };
    });
    const handle = await startPlanSession(agent, host, 'session-plan-early-control-send');
    const iterator = handle.events()[Symbol.asyncIterator]();
    const pendingDecision = deferred<InteractionDecision>();
    const seen: unknown[] = [];
    handle.setInteractionResolver(async (req) => {
      seen.push(req);
      return pendingDecision.promise;
    });

    await handle.send({ type: 'user', content: 'make a plan' });
    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');
    handlers.itemCompleted?.({
      threadId: 'start-thread-id',
      turnId: 'turn-1',
      item: { type: 'plan', id: 'turn-1-plan', text: '1. do X' },
    } as never);
    handlers.turnCompleted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });

    await handle.send({ type: 'user', content: 'control message' }, { planMode: false });
    const [, controlParams] = turnStartCalls(host)[1] as [string, Record<string, unknown>];
    expect(controlParams.collaborationMode).toEqual({
      mode: 'default',
      settings: PLAN_SETTINGS,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
    let sawControlPlanItem = false;
    for (let i = 0; i < 30 && !sawControlPlanItem; i++) {
      const ev = await nextEvent(iterator);
      if (ev.type !== 'tool_use') continue;
      const data = ev.data as { toolName?: unknown; input?: { text?: unknown } };
      if (data.toolName === 'update_plan' && data.input?.text === 'control turn early native plan item') {
        sawControlPlanItem = true;
      }
    }
    expect(sawControlPlanItem).toBe(true);

    pendingDecision.resolve({ kind: 'plan_review', behavior: 'deny' });
    await handle.close();
  });

  it('steer injects into the running turn and keeps the armed selection', async () => {
    const agent = new CodexAgent(createDeps());
    let turnSeq = 0;
    const host = installFakeHost(agent, (method) => {
      if (method === Method.TurnStart) return { turn: { id: `turn-${++turnSeq}` } };
      if (method === Method.TurnSteer) return { turnId: 'turn-1' };
      return undefined;
    });
    const handle = await agent.startSession({
      sessionId: 'session-plan-steer',
      model: 'gpt-5.4',
      workingDir: '/repo',
    });
    const handlers = host.getThreadHandlers();
    if (!handlers) throw new Error('expected thread handlers');

    // 武装后开始一个普通 turn(快照 false), 流式中插话。
    await handle.setPlanMode?.(true);
    await handle.send({ type: 'user', content: 'normal work' }, { planMode: false });
    handlers.turnStarted?.({ threadId: 'start-thread-id', turn: { id: 'turn-1' } });

    await handle.steer({ type: 'user', content: '插一句' });

    // 同轮注入:不另起 turn(turn/start 只有最初那一次), 武装态保留给下一个真正的新 turn。
    expect(turnStartCalls(host)).toHaveLength(1);
    expect(host.request.mock.calls.some(([method]) => method === Method.TurnSteer)).toBe(true);
    expect(handle.getPlanMode?.()).toBe(true);
    await handle.close();
  });

  it('emits plan_mode_changed(false) when the armed selection is consumed by send', async () => {
    const agent = new CodexAgent(createDeps());
    const host = installTurnHost(agent);
    const handle = await startPlanSession(agent, host, 'session-plan-oneshot-emit');
    const iterator = handle.events()[Symbol.asyncIterator]();

    await handle.send({ type: 'user', content: 'make a plan' });

    let sawPlanModeChanged = false;
    for (let i = 0; i < 30 && !sawPlanModeChanged; i++) {
      const ev = await nextEvent(iterator);
      if (ev.type === 'plan_mode_changed') {
        expect(ev.data).toEqual({ enabled: false });
        sawPlanModeChanged = true;
      }
    }
    expect(sawPlanModeChanged).toBe(true);
    await handle.close();
  });
});
