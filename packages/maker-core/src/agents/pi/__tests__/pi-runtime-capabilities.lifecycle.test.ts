import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  instances: [] as Array<{
    sessionId: string;
    sdkSessionId: string;
    requests: Array<Record<string, unknown>>;
    closed: boolean;
    onExit?: (info: { code: number | null; signal: string | null }) => void;
  }>,
  catalogs: {} as Record<string, unknown>,
  runtimeFailures: new Set<string>(),
  runtimeDeferred: false,
  runtimeRelease: undefined as (() => void) | undefined,
  rewindStateFailure: false,
}));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    private readonly state: (typeof captured.instances)[number];
    isClosed = false;
    constructor(opts: {
      env: Record<string, string | undefined>;
      onEvent: (event: unknown) => void;
      onExit?: (info: { code: number | null; signal: string | null }) => void;
    }) {
      this.state = {
        sessionId: opts.env.CINDY_PI_SESSION_ID ?? '',
        sdkSessionId: `/mock/${opts.env.CINDY_PI_SESSION_ID || 'fork'}.jsonl`,
        requests: [],
        closed: false,
        onExit: opts.onExit,
      };
      captured.instances.push(this.state);
      void opts.onEvent;
    }
    async request(command: Record<string, unknown>): Promise<{ type?: string; command?: string; success: boolean; data?: unknown; error?: string }> {
      this.state.requests.push(command);
      if (command.type === 'get_state') {
        if (captured.rewindStateFailure && this.state.requests.some((request) => request.type === 'fork')) {
          return { success: false, error: 'rewind state unavailable' };
        }
        return { success: true, data: { sessionFile: this.state.sdkSessionId, model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'get_commands') {
        if (captured.runtimeFailures.has(this.state.sessionId)) {
          return { type: 'response', command: 'get_commands', success: false, error: 'provider=/secret/path rejected' };
        }
        if (captured.runtimeDeferred) {
          await new Promise<void>((resolve) => { captured.runtimeRelease = resolve; });
        }
        const data = captured.catalogs[this.state.sessionId] ?? { commands: [] };
        return { type: 'response', command: 'get_commands', success: true, data };
      }
      if (command.type === 'get_fork_messages') {
        return { success: true, data: { messages: [{ entryId: 'rewind-entry' }] } };
      }
      if (command.type === 'fork') {
        this.state.sdkSessionId = `/mock/${this.state.sessionId || 'fork'}-rewind.jsonl`;
        return { success: true, data: {} };
      }
      if (command.type === 'switch_session') return { success: true, data: {} };
      if (command.type === 'clone') return { success: true, data: {} };
      return { success: true, data: { entries: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      this.isClosed = true;
      this.state.closed = true;
    }
  },
}));

import { PiAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => noopLogger,
};

describe('Pi runtime capability lifecycle', () => {
  let home = '';
  let cwd = '';

  beforeEach(() => {
    captured.instances = [];
    captured.catalogs = {};
    captured.runtimeFailures = new Set();
    captured.runtimeDeferred = false;
    captured.runtimeRelease = undefined;
    captured.rewindStateFailure = false;
    home = mkdtempSync(path.join(tmpdir(), 'pi-runtime-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-runtime-cwd-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function deps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' }, binaryPath: '/mock/pi', logger: noopLogger,
      capabilityAdditions: { availableModels: [{ id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null }] },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => home,
    };
  }

  const catalog = (name: string) => ({ commands: [{ name, source: 'skill', sourceInfo: { source: 'auto', scope: 'user', baseDir: '/tmp' } }] });

  it('captures once after ready, exposes a stable per-session query/event contract, and clears on close', async () => {
    captured.catalogs.s1 = catalog('skill:s1');
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    await vi.waitFor(() => {
      expect(handle.getRuntimeCapabilities?.()).toMatchObject({ status: 'loaded', sessionId: 's1', commands: [{ name: 'skill:s1' }] });
    });
    const changes: unknown[] = [];
    const dispose = handle.onRuntimeCapabilitiesChange?.((manifest) => changes.push(manifest));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: 'loaded', commands: [{ name: 'skill:s1' }] });
    expect(captured.instances[0]?.requests.filter((request) => request.type === 'get_commands')).toHaveLength(1);
    await handle.close();
    expect(handle.getRuntimeCapabilities?.()).toBeUndefined();
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ status: 'loaded', commands: [{ name: 'skill:s1' }] });
    expect(changes[1]).toBeUndefined();
    dispose?.();
  });

  it('clears the catalog when the Pi process exits unexpectedly', async () => {
    captured.catalogs.s1 = catalog('skill:s1');
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    const instance = captured.instances[0]!;
    const changes: unknown[] = [];
    handle.onRuntimeCapabilitiesChange?.((manifest) => changes.push(manifest));
    instance.onExit?.({ code: 1, signal: null });
    expect(handle.getRuntimeCapabilities?.()).toBeUndefined();
    expect(changes.at(-1)).toBeUndefined();
    expect(changes.length).toBeGreaterThanOrEqual(1);
    await handle.close();
    expect(instance.closed).toBe(true);
  });

  it('does not block normal prompt dispatch when get_commands fails', async () => {
    captured.runtimeFailures.add('s1');
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    await vi.waitFor(() => {
      expect(handle.getRuntimeCapabilities?.()).toMatchObject({
        status: 'failed',
        error: { code: 'rpc_failed', message: 'Pi runtime command discovery was rejected' },
      });
    });
    await expect(handle.send({ type: 'user', content: 'hello' })).resolves.toBeUndefined();
    await handle.close();
  });

  it('does not block ready while capability discovery is pending', async () => {
    captured.catalogs.s1 = catalog('skill:s1');
    captured.runtimeDeferred = true;
    const start = new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    const handle = await start;
    expect(handle.getRuntimeCapabilities?.()).toBeUndefined();
    captured.runtimeRelease?.();
    await vi.waitFor(() => {
      expect(handle.getRuntimeCapabilities?.()).toMatchObject({ status: 'loaded', commands: [{ name: 'skill:s1' }] });
    });
    await handle.close();
  });

  it('keeps concurrent session catalogs isolated and does not let list calls trigger RPC', async () => {
    captured.catalogs.s1 = catalog('skill:s1');
    captured.catalogs.s2 = catalog('skill:s2');
    const agent = new PiAgent(deps());
    const [first, second] = await Promise.all([
      agent.startSession({ sessionId: 's1', workingDir: cwd, model: 'm' }),
      agent.startSession({ sessionId: 's2', workingDir: cwd, model: 'm' }),
    ]);
    await vi.waitFor(() => {
      expect(first.getRuntimeCapabilities?.()?.commands[0]?.name).toBe('skill:s1');
      expect(second.getRuntimeCapabilities?.()?.commands[0]?.name).toBe('skill:s2');
    });
    const before = captured.instances.map((instance) => instance.requests.length);
    await agent.listAgentSkills({ workingDir: cwd });
    expect(captured.instances.map((instance) => instance.requests.length)).toEqual(before);
    await Promise.all([first.close(), second.close()]);
  });

  it('clears the old catalog immediately when rewind changes runtime identity', async () => {
    captured.catalogs.s1 = catalog('skill:before-failed-rewind');
    const failedHandle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    await vi.waitFor(() => {
      expect(failedHandle.getRuntimeCapabilities?.()).toMatchObject({ status: 'loaded' });
    });
    const failedChanges: unknown[] = [];
    failedHandle.onRuntimeCapabilitiesChange?.((manifest) => failedChanges.push(manifest));
    captured.rewindStateFailure = true;
    await expect(failedHandle.commitRewindFiles?.('', '', { tailTurnsToDrop: 1 }))
      .rejects.toThrow('pi rewind get_state failed');
    expect(failedHandle.getRuntimeCapabilities?.()).toBeUndefined();
    expect(failedChanges.at(-1)).toBeUndefined();
    await failedHandle.close();

    captured.rewindStateFailure = false;
    captured.catalogs.s1 = catalog('skill:before-rewind');
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    await vi.waitFor(() => {
      expect(handle.getRuntimeCapabilities?.()).toMatchObject({
        status: 'loaded',
        sdkSessionId: '/mock/s1.jsonl',
        commands: [{ name: 'skill:before-rewind' }],
      });
    });

    const changes: unknown[] = [];
    handle.onRuntimeCapabilitiesChange?.((manifest) => changes.push(manifest));
    captured.runtimeDeferred = true;
    captured.catalogs.s1 = catalog('skill:after-rewind');

    const result = await handle.commitRewindFiles?.('', '', { tailTurnsToDrop: 1 });
    expect(result?.sdkSessionId).toBe('/mock/s1-rewind.jsonl');
    expect(handle.getRuntimeCapabilities?.()).toBeUndefined();
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ sdkSessionId: '/mock/s1.jsonl', status: 'loaded' });
    expect(changes[1]).toBeUndefined();

    captured.runtimeRelease?.();
    await vi.waitFor(() => {
      expect(handle.getRuntimeCapabilities?.()).toMatchObject({
        status: 'loaded',
        sdkSessionId: '/mock/s1-rewind.jsonl',
        commands: [{ name: 'skill:after-rewind' }],
      });
    });
    expect(captured.instances.at(-1)?.requests.filter((request) => request.type === 'get_commands')).toHaveLength(2);
    await handle.close();
  });

  it('refreshes the catalog after switch_session resume and returns a separate fork catalog', async () => {
    captured.catalogs.s1 = catalog('skill:resumed');
    const resumeFile = path.join(cwd, 'resume.jsonl');
    writeFileSync(resumeFile, '{}');
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm', resumeSessionId: resumeFile });
    const instance = captured.instances[0]!;
    expect(instance.requests.filter((request) => request.type === 'switch_session')).toHaveLength(1);
    expect(instance.requests.filter((request) => request.type === 'get_commands')).toHaveLength(1);
    await vi.waitFor(() => {
      expect(handle.getRuntimeCapabilities?.()).toMatchObject({ status: 'loaded', commands: [{ name: 'skill:resumed' }] });
    });
    await handle.close();

    captured.catalogs[''] = catalog('skill:fork');
    captured.catalogs.forked = catalog('skill:fork');
    const fork = await new PiAgent(deps()).forkSdkSession({
      sourceSdkSessionId: '/mock/source.jsonl', upToMessageId: undefined, workingDir: cwd,
    });
    expect(fork.runtimeCapabilities).toBeUndefined();
    expect(captured.instances.at(-1)?.requests.filter((request) => request.type === 'get_commands')).toHaveLength(0);

    const forkedHandle = await new PiAgent(deps()).startSession({
      sessionId: 'forked', workingDir: cwd, model: 'm', resumeSessionId: fork.newSdkSessionId,
    });
    await vi.waitFor(() => {
      expect(forkedHandle.getRuntimeCapabilities?.()).toMatchObject({ status: 'loaded', commands: [{ name: 'skill:fork' }] });
    });
    await forkedHandle.close();
  });
});
