import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNotAuthenticatedError, AgentStartupCleanupPendingError, AgentStartupStoppedError, type AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { SessionMeta, SessionStorage } from '../../../interfaces/session-storage.js';
import { Maker, type CreateSessionOptions } from '../../../maker.js';
import { createAsyncQueue } from '../../shared/async-queue.js';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query, forkSession: vi.fn() }));
import { ClaudeCodeAgent } from '../index.js';

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

describe('Claude startup exit evidence', () => {
  let workingDir: string;
  beforeEach(async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), 'claude-startup-cleanup-'));
    sdk.query.mockReset();
  });
  afterEach(async () => { await rm(workingDir, { recursive: true, force: true }); });

  function deps(): AgentDeps {
    return {
      binaryPath: process.execPath, runtimeConfig: {}, logger,
      auth: {
        getState: vi.fn(async () => ({ authenticated: true })),
        getAuthEnv: vi.fn(async () => ({})),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
      },
    };
  }

  it.each(['getState', 'getAuthEnv'] as const)('proves %s failures happened before any SDK dispatch', async (hook) => {
    const dependencies = deps();
    const error = new TypeError('preparation failed');
    vi.mocked(dependencies.auth[hook]).mockRejectedValueOnce(error);
    const agent = new ClaudeCodeAgent(dependencies);
    const failure = await agent.startSession({ sessionId: 'failed', workingDir, model: 'claude-sonnet-4-6' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AgentStartupStoppedError);
    expect(failure).toMatchObject({ cause: error });
    expect(sdk.query).not.toHaveBeenCalled();

    // A later attempt reaches the SDK; its unknown exit is kept distinct from
    // the proven pre-spawn failure so Maker cannot release a live writer.
    const dispatchedError = new Error('SDK exit unconfirmed');
    sdk.query.mockImplementationOnce(() => { throw dispatchedError; });
    await expect(agent.startSession({ sessionId: 'fresh', workingDir, model: 'claude-sonnet-4-6' })).rejects.toBe(dispatchedError);
    expect(sdk.query).toHaveBeenCalledOnce();
  });

  it('preserves the authentication error class used by callers', async () => {
    const dependencies = deps();
    vi.mocked(dependencies.auth.getState).mockResolvedValueOnce({ authenticated: false });
    await expect(new ClaudeCodeAgent(dependencies).startSession({ workingDir, model: 'claude-sonnet-4-6' }))
      .rejects.toBeInstanceOf(AgentNotAuthenticatedError);
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('retains protection when the remote factory rejects without proving exit', async () => {
    const dependencies = deps();
    const error = new Error('remote startup reply lost');
    dependencies.remoteCcQueryFactory = vi.fn().mockRejectedValueOnce(error);
    await expect(new ClaudeCodeAgent(dependencies).startSession({
      workingDir, model: 'claude-sonnet-4-6', sessionId: 'remote-failure', remoteHostId: 'remote-1',
    })).rejects.toBe(error);
    expect(dependencies.remoteCcQueryFactory).toHaveBeenCalledOnce();
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('releases the failed attempt through Maker and creates a replacement without releasing another task', async () => {
    const dependencies = deps();
    const error = new Error('environment failed before CLI startup');
    vi.mocked(dependencies.auth.getAuthEnv).mockRejectedValueOnce(error);
    const rows = new Map<string, SessionMeta>();
    const storage: SessionStorage = {
      async create(meta) {
        const row = { ...meta, createdAt: Date.now(), updatedAt: Date.now() };
        rows.set(row.id, row);
        return row;
      },
      async get(id) { return rows.get(id) ?? null; },
      async list() { return [...rows.values()]; },
      async update(id, patch) {
        const row = rows.get(id);
        if (!row) throw new Error('missing test task');
        const next = { ...row, ...patch, updatedAt: Date.now() };
        rows.set(id, next);
        return next;
      },
      async compareAndClearSdkSessionId() { return false; },
      async delete(id) { rows.delete(id); },
    };
    const other = {} as CreateSessionOptions;
    const leases = new Set<CreateSessionOptions>([other]);
    const maker = new Maker({
      agents: { 'claude-code': new ClaudeCodeAgent(dependencies) }, storage, logger,
      lifecycleHooks: {
        prepareStartOptions: (_id, options) => { leases.add(options); },
        onStartFailed: ({ options, runtimeMayBeAlive }) => { if (!runtimeMayBeAlive) leases.delete(options); },
        onClose: (_id, options) => { leases.delete(options); },
      },
    });
    const options = { agentKind: 'claude-code' as const, workingDir, model: 'claude-sonnet-4-6' };
    await expect(maker.createSession({ ...options, id: 'failed' })).rejects.toBe(error);
    expect(leases).toEqual(new Set([other]));
    expect(rows.has('failed')).toBe(false);

    sdk.query.mockImplementationOnce(({ options: sdkOptions }) => {
      const queue = createAsyncQueue<never>();
      sdkOptions.abortController.signal.addEventListener('abort', () => queue.end(), { once: true });
      return queue;
    });
    const replacement = await maker.createSession({ ...options, id: 'replacement' });
    expect(maker.getSession('replacement')).toBe(replacement);
    expect(rows.has('replacement')).toBe(true);
    expect(leases.size).toBe(2);
    await replacement.close();
    await vi.waitFor(() => expect(leases).toEqual(new Set([other])));
  });

  it('does not nest explicit stopped errors from pre-spawn validation', async () => {
    const dependencies = deps();
    const error = new AgentStartupStoppedError(new Error('already confirmed'));
    vi.mocked(dependencies.auth.getState).mockRejectedValueOnce(error);
    await expect(new ClaudeCodeAgent(dependencies).startSession({ workingDir, model: 'claude-sonnet-4-6' })).rejects.toBe(error);
  });

  it('does not turn pending cleanup evidence into a stopped error', async () => {
    const dependencies = deps();
    const error = new AgentStartupCleanupPendingError('cleanup unconfirmed', {
      cause: new Error('preparation helper failed'), whenStopped: new Promise(() => {}),
    });
    vi.mocked(dependencies.auth.getState).mockRejectedValueOnce(error);
    await expect(new ClaudeCodeAgent(dependencies).startSession({ workingDir, model: 'claude-sonnet-4-6' }))
      .rejects.toBe(error);
  });
});
