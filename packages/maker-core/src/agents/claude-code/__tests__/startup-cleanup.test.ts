import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNotAuthenticatedError, AgentStartupCleanupPendingError, AgentStartupStoppedError, type AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import { NATIVE_SUBSCRIPTION_ACCOUNT, type NativeSubscriptionAccount } from '../../../interfaces/auth-adapter.js';
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

  // Test value: real startSession must keep an opt-in native runtime separate from
  // gateway/remote routing, and preserve no-process failure evidence. Existing
  // startup tests did not cover host-supplied executable/network capabilities.
  // Minimal regression: authenticated native account + failing prepare; unit SDK fake.
  function externalAccount(overrides: Record<string, string> = {}): NativeSubscriptionAccount {
    return {
      id: 'default', configDir: path.join(workingDir, 'external-profile'),
      assertCurrent: vi.fn(), readState: async () => ({ authenticated: true }),
      claudeRuntime: {
        executablePath: path.join(workingDir, 'external-claude.exe'),
        env: { HTTPS_PROXY: 'http://127.0.0.1:17890', BROWSER: path.join(workingDir, 'browser.exe'), ...overrides },
        prepare: vi.fn(async () => {}),
      },
    };
  }

  it('selects the external executable, profile and pinned network only for native subscription dispatch', async () => {
    const account = externalAccount();
    const dependencies = deps();
    sdk.query.mockImplementationOnce(() => { throw new Error('dispatch observed'); });
    await expect(new ClaudeCodeAgent(dependencies).startSession({
      workingDir, model: 'claude-sonnet-4-6', providerId: 'anthropic',
      [NATIVE_SUBSCRIPTION_ACCOUNT]: account,
    })).rejects.toThrow('dispatch observed');
    const options = sdk.query.mock.calls[0][0].options;
    expect(options.pathToClaudeCodeExecutable).toBe(account.claudeRuntime!.executablePath);
    expect(options.env).toMatchObject({ ...account.claudeRuntime!.env, CLAUDE_CONFIG_DIR: account.configDir });
    expect(options.settings.env).toMatchObject({ ...account.claudeRuntime!.env, CLAUDE_CONFIG_DIR: account.configDir });
    expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(account.claudeRuntime!.prepare).toHaveBeenCalledOnce();
  });

  it.each(['prepare', 'identity', 'forbidden-env'] as const)('fails closed before CLI dispatch: %s', async failure => {
    const account = externalAccount(failure === 'forbidden-env' ? { ANTHROPIC_BASE_URL: 'https://invalid.test' } : {});
    if (failure === 'prepare') vi.mocked(account.claudeRuntime!.prepare).mockRejectedValueOnce(new Error('proxy unavailable'));
    if (failure === 'identity') vi.mocked(account.claudeRuntime!.prepare).mockImplementationOnce(async () => {
      vi.mocked(account.assertCurrent).mockImplementation(() => { throw new Error('account changed'); });
    });
    await expect(new ClaudeCodeAgent(deps()).startSession({
      workingDir, model: 'claude-sonnet-4-6', providerId: 'anthropic',
      [NATIVE_SUBSCRIPTION_ACCOUNT]: account,
    })).rejects.toBeInstanceOf(AgentStartupStoppedError);
    expect(sdk.query).not.toHaveBeenCalled();
  });

  // Unit: opt-in external-default status must not authenticate a no-account
  // fallback that would otherwise launch the bundled CLI with the old profile.
  it.each([undefined, 'anthropic'])('rejects unbound local subscription startup with configured external default (%s)', async providerId => {
    const dependencies = deps();
    dependencies.requiresNativeSubscriptionAccount = vi.fn(() => true);
    dependencies.auth.getState = vi.fn(async () => ({ authenticated: true, authSource: 'oauth' as const }));
    sdk.query.mockImplementationOnce(() => { throw new Error('unexpected bundled dispatch'); });
    await expect(new ClaudeCodeAgent(dependencies).startSession({ workingDir, model: 'claude-sonnet-4-6', providerId }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining('Select the configured Claude subscription provider') }) });
    expect(sdk.query).not.toHaveBeenCalled();
    expect(dependencies.requiresNativeSubscriptionAccount).toHaveBeenCalledOnce();
  });

  it('never applies the local external runtime to remote execution', async () => {
    const account = externalAccount();
    const dependencies = deps();
    dependencies.remoteCcQueryFactory = vi.fn().mockRejectedValueOnce(new Error('remote dispatch observed'));
    dependencies.requiresNativeSubscriptionAccount = vi.fn(() => { throw new Error('local configuration must not be read'); });
    Object.defineProperty(dependencies, 'binaryPath', { get: () => { throw new Error('local binary must not be read'); } });
    await expect(new ClaudeCodeAgent(dependencies).startSession({
      workingDir, model: 'claude-sonnet-4-6', providerId: 'anthropic', remoteHostId: 'remote-1', sessionId: 'remote',
      [NATIVE_SUBSCRIPTION_ACCOUNT]: account,
    })).rejects.toThrow('remote dispatch observed');
    expect(dependencies.remoteCcQueryFactory).toHaveBeenCalledOnce();
    expect(dependencies.requiresNativeSubscriptionAccount).not.toHaveBeenCalled();
    expect(account.claudeRuntime!.prepare).not.toHaveBeenCalled();
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('does not apply a native external runtime to a company gateway session', async () => {
    const account = externalAccount();
    const dependencies = deps();
    dependencies.runtimeConfig.endpoint = 'http://127.0.0.1:19090';
    dependencies.requiresNativeSubscriptionAccount = vi.fn(() => { throw new Error('native policy must not affect gateway'); });
    dependencies.auth.getAuthEnv = vi.fn(async () => ({ ANTHROPIC_API_KEY: 'synthetic-test-key' }));
    sdk.query.mockImplementationOnce(() => { throw new Error('gateway dispatch observed'); });
    await expect(new ClaudeCodeAgent(dependencies).startSession({
      workingDir, model: 'claude-sonnet-4-6', providerId: 'xd',
      [NATIVE_SUBSCRIPTION_ACCOUNT]: account,
    })).rejects.toThrow('gateway dispatch observed');
    const options = sdk.query.mock.calls[0][0].options;
    expect(options.pathToClaudeCodeExecutable).toBe(process.execPath);
    expect(options.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:19090');
    expect(options.env.ANTHROPIC_API_KEY).toBe('synthetic-test-key');
    expect(dependencies.requiresNativeSubscriptionAccount).not.toHaveBeenCalled();
    expect(options.env.BROWSER).not.toBe(account.claudeRuntime!.env.BROWSER);
    expect(account.claudeRuntime!.prepare).not.toHaveBeenCalled();
  });

  // Unit: offline construction must expose local capabilities, while missing
  // runtime failure on actual dispatch still proves no process owns the workdir.
  it('defers the live runtime getter until use and observes a later installation', async () => {
    let installed = false;
    const readPath = vi.fn(() => {
      if (!installed) throw new Error('runtime not installed');
      return process.execPath;
    });
    const dependencies = deps();
    Object.defineProperty(dependencies, 'binaryPath', { get: readPath });
    const agent = new ClaudeCodeAgent(dependencies);
    expect(readPath).not.toHaveBeenCalled();
    await expect(agent.startSession({ sessionId: 'offline', workingDir, model: 'claude-sonnet-4-6' }))
      .rejects.toBeInstanceOf(AgentStartupStoppedError);
    expect(sdk.query).not.toHaveBeenCalled();
    installed = true;
    sdk.query.mockImplementationOnce(() => { throw new Error('dispatch reached'); });
    await expect(agent.startSession({ sessionId: 'installed', workingDir, model: 'claude-sonnet-4-6' }))
      .rejects.toThrow('dispatch reached');
    expect(sdk.query).toHaveBeenCalledOnce();
  });

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

  // #10523, unit: reject before SDK dispatch and preserve the no-process exit
  // evidence so a failed proxy does not leave a workdir lease stuck.
  it.each([undefined, 'fixture-provider'])('reports proxy failure before spawning and retries (%s)', async providerId => {
    const dependencies = deps();
    const error = new Error('proxy unavailable');
    let ready = false;
    vi.mocked(dependencies.auth.getState).mockImplementation(async options => ({
      authenticated: options?.credentialMode !== 'provider-oauth' || ready,
      ...(!ready ? { errorReason: 'proxy_not_ready' } : {}),
    }));
    dependencies.runtimeConfig.resolveLocalEndpoint = vi.fn().mockRejectedValueOnce(error)
      .mockImplementation(async () => { ready = true; return 'http://127.0.0.1:12345'; });
    const agent = new ClaudeCodeAgent(dependencies);
    await expect(agent.startSession({ workingDir, providerId, model: 'claude-sonnet-4-6' }))
      .rejects.toMatchObject({ cause: error });
    expect(sdk.query).not.toHaveBeenCalled();
    sdk.query.mockImplementationOnce(() => { throw new Error('dispatch reached'); });
    await expect(agent.startSession({ workingDir, providerId, model: 'claude-sonnet-4-6' })).rejects.toThrow('dispatch reached');
    expect(sdk.query).toHaveBeenCalledOnce();
  });

  it('retains protection when the remote factory rejects without proving exit', async () => {
    const dependencies = deps();
    dependencies.runtimeConfig.resolveLocalEndpoint = vi.fn(async () => { throw new Error('local proxy unavailable'); });
    // Remote execution must not read an unavailable local runtime getter.
    Object.defineProperty(dependencies, 'binaryPath', { get: () => { throw new Error('local runtime missing'); } });
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
