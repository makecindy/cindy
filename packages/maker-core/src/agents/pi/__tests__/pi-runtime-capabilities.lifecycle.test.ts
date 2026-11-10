import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  instances: [] as Array<{
    sessionId: string;
    sdkSessionId: string;
    args: string[];
    requests: Array<Record<string, unknown>>;
    closed: boolean;
    onExit?: (info: { code: number | null; signal: string | null }) => void;
  }>,
  catalogs: {} as Record<string, unknown>,
  runtimeFailures: new Set<string>(),
  runtimeFailureMessage: 'provider=/secret/path rejected',
  runtimeDeferred: false,
  runtimeRelease: undefined as (() => void) | undefined,
  rewindStateFailure: false,
}));

vi.mock('../transport.js', () => ({
  createPiStdioTransport: (opts: {
    args: string[];
    env: Record<string, string | undefined>;
    onProcessSpawned?: (pid: number) => void | (() => void);
  }) => {
    // session 身份/env/args 断言移到 transport 工厂(spawn 行为在 stdio transport)。
    const state = {
      sessionId: opts.env.CINDY_PI_SESSION_ID ?? '',
      sdkSessionId: `/mock/${opts.env.CINDY_PI_SESSION_ID || 'fork'}.jsonl`,
      args: [...opts.args],
      requests: [] as Array<Record<string, unknown>>,
      closed: false,
      onExit: undefined as undefined | ((info: { code: number | null; signal: string | null }) => void),
    };
    captured.instances.push(state);
    opts.onProcessSpawned?.(1234);
    return {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 1234,
      isClosed: () => false,
    };
  },
  attachJsonlReader: () => {},
}));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    private readonly state: (typeof captured.instances)[number];
    isClosed = false;
    constructor(opts: {
      onEvent: (event: unknown) => void;
      onExit?: (info: { code: number | null; signal: string | null }) => void;
    }) {
      this.state = captured.instances[captured.instances.length - 1];
      this.state.onExit = opts.onExit;
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
          return { type: 'response', command: 'get_commands', success: false, error: captured.runtimeFailureMessage };
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
import { Session } from '../../../session.js';
import { PINNED_SKILL_INVOCATION } from '../../base-agent.js';
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
    captured.runtimeFailureMessage = 'provider=/secret/path rejected';
    captured.runtimeDeferred = false;
    captured.runtimeRelease = undefined;
    captured.rewindStateFailure = false;
    home = mkdtempSync(path.join(tmpdir(), 'pi-runtime-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-runtime-cwd-'));
  });
  afterEach(() => {
    vi.useRealTimers();
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

  function pinnedSkill() {
    const skillFile = path.join(cwd, 'SKILL.md');
    writeFileSync(skillFile, '# Learn');
    captured.catalogs.s1 = { commands: [{
      name: 'skill:learn', source: 'skill', sourceInfo: { path: skillFile },
    }] };
    return { [PINNED_SKILL_INVOCATION]: { name: 'learn', path: skillFile } };
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

  it.each(['hello', '/skill:learn release flow'])('does not block unpinned %s when get_commands fails', async (content) => {
    captured.runtimeFailures.add('s1');
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    await vi.waitFor(() => {
      expect(handle.getRuntimeCapabilities?.()).toMatchObject({
        status: 'failed',
        error: { code: 'rpc_failed', message: 'Pi runtime command discovery was rejected' },
      });
    });
    await expect(handle.send({ type: 'user', content })).resolves.toBeUndefined();
    expect(captured.instances[0]!.requests.filter((request) => request.type === 'prompt')).toEqual([
      { type: 'prompt', message: content },
    ]);
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

  // #9620 (unit): startSession/send must await the pending discovery retry,
  // not reject a pinned Skill using its published failed/unknown snapshot.
  // Existing lifecycle cases only dispatched unpinned messages during discovery.
  it.each([
    { status: 'failed', error: 'discovery rejected' },
    { status: 'unknown', error: 'unsupported command' },
  ])('waits for pinned Skill provenance after a $status discovery attempt', async ({ status, error }) => {
    vi.useFakeTimers();
    captured.runtimeFailures.add('s1');
    captured.runtimeFailureMessage = error;
    const sendOptions = pinnedSkill();
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    try {
      await vi.waitFor(() => expect(handle.getRuntimeCapabilities?.()?.status).toBe(status));
      const send = handle.send({ type: 'user', content: '/skill:learn release flow' }, sendOptions)
        .then(() => 'sent', (error: unknown) => error);
      captured.runtimeFailures.delete('s1');
      captured.runtimeDeferred = true;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(captured.runtimeRelease).toBeTypeOf('function');
      expect(captured.instances[0]!.requests.filter((request) => request.type === 'prompt')).toEqual([]);
      captured.runtimeRelease?.();
      expect(await send).toBe('sent');
      expect(captured.instances[0]!.requests.filter((request) => request.type === 'prompt')).toEqual([
        { type: 'prompt', message: '/skill:learn release flow' },
      ]);
    } finally {
      captured.runtimeRelease?.();
      // Real config-home cleanup may retry a transient Windows file lock.
      // Keep fake time for discovery assertions, not filesystem teardown.
      vi.useRealTimers();
      await handle.close();
    }
  });

  it('rejects pinned dispatch after retries are exhausted without starting another discovery chain', async () => {
    vi.useFakeTimers();
    captured.runtimeFailures.add('s1');
    const sendOptions = pinnedSkill();
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    try {
      await vi.waitFor(() => expect(handle.getRuntimeCapabilities?.()?.status).toBe('failed'));
      let settled = false;
      const send = handle.send({ type: 'user', content: '/skill:learn' }, sendOptions)
        .then(() => undefined, (error: unknown) => error)
        .finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(33_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await send).toEqual(new Error('Pi runtime Skill provenance is unavailable'));
      await expect(handle.send({ type: 'user', content: '/skill:learn' }, sendOptions))
        .rejects.toThrow('Pi runtime Skill provenance is unavailable');
      expect(captured.instances[0]!.requests.filter((request) => request.type === 'get_commands')).toHaveLength(4);
      expect(captured.instances[0]!.requests.filter((request) => request.type === 'prompt')).toEqual([]);
    } finally {
      vi.useRealTimers();
      await handle.close();
    }
  });

  // #9626 review (unit): Stop must release Session's dispatch reservation before
  // discovery settles. The previous case advanced the full retry chain after
  // abort, so it could not detect a blocked next send or a terminal-drain fence.
  it.each([
    { phase: 'retry backoff', elapsed: 0 },
    { phase: 'pending catalog RPC', elapsed: 4_000 },
  ])('releases a cancelled pinned send during $phase without stopping discovery', async ({ elapsed }) => {
    vi.useFakeTimers();
    captured.runtimeFailures.add('s1');
    const sendOptions = pinnedSkill();
    const agent = new PiAgent(deps());
    const handle = await agent.startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    const session = new Session({
      id: 's1', agentKind: 'pi', workDir: cwd, handle,
      capabilities: agent.capabilities, logger: noopLogger, turnStallMs: 0,
    });
    try {
      await vi.waitFor(() => expect(handle.getRuntimeCapabilities?.()?.status).toBe('failed'));
      let outcome: unknown = 'pending';
      const send = session.send('/skill:learn', sendOptions)
        .then((result) => { outcome = result; }, (error: unknown) => { outcome = error; });
      captured.runtimeFailures.delete('s1');
      captured.runtimeDeferred = true;
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(outcome).toBe('pending');
      await expect(session.send('overlapping send')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
      await session.abort();
      // Do not advance discovery's retry clock: cancellation itself must settle.
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
      await send;
      expect(captured.instances[0]!.requests.filter((request) => request.type === 'prompt')).toEqual([]);
      await expect(session.send('continue normally')).resolves.toEqual({ accepted: true });

      // The shared discovery still completes, but cannot revive the cancelled input.
      await vi.advanceTimersByTimeAsync(4_000 - elapsed);
      expect(captured.runtimeRelease).toBeTypeOf('function');
      captured.runtimeRelease?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.getRuntimeCapabilities?.()?.status).toBe('loaded');
      expect(captured.instances[0]!.requests.filter((request) => request.type === 'get_commands')).toHaveLength(2);
      expect(captured.instances[0]!.requests.filter((request) => request.type === 'prompt')).toEqual([
        { type: 'prompt', message: 'continue normally' },
      ]);
    } finally {
      captured.runtimeRelease?.();
      vi.useRealTimers();
      await session.close();
    }
  });

  it('does not dispatch or republish a pinned catalog that arrives after close', async () => {
    vi.useFakeTimers();
    captured.runtimeFailures.add('s1');
    const sendOptions = pinnedSkill();
    const handle = await new PiAgent(deps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
    try {
      await vi.waitFor(() => expect(handle.getRuntimeCapabilities?.()?.status).toBe('failed'));
      const send = handle.send({ type: 'user', content: '/skill:learn' }, sendOptions)
        .then(() => undefined, (error: unknown) => error);
      captured.runtimeFailures.delete('s1');
      captured.runtimeDeferred = true;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(captured.runtimeRelease).toBeTypeOf('function');
      vi.useRealTimers();
      await handle.close();
      captured.runtimeRelease?.();
      expect(await send).toBeInstanceOf(Error);
      expect(handle.getRuntimeCapabilities?.()).toBeUndefined();
      expect(captured.instances[0]!.requests.filter((request) => request.type === 'prompt')).toEqual([]);
    } finally {
      captured.runtimeRelease?.();
      vi.useRealTimers();
      await handle.close();
    }
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
      hostedGuestHome: home,
    });
    expect(fork.runtimeCapabilities).toBeUndefined();
    expect(captured.instances.at(-1)?.args).toEqual(expect.arrayContaining([
      '--no-approve', '--no-extensions', '--session-dir', path.join(home, 'pi-sessions'),
    ]));
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
