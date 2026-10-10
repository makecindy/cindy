import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PiTransport } from '../transport.js';
import type { AgentEvent } from '../../../types/events.js';
import { MAIN_OWNED_SEND_CONTEXT, TurnDispatchRejectedError, type AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const fixture = vi.hoisted(() => ({
  transport: null as PiTransport | null,
  child: null as import('node:child_process').ChildProcess | null,
  packageToken: undefined as string | undefined,
}));

// Retain the real child to inject EPIPE, and expose a real extra stdio pipe as
// fixture stdout. Windows libuv intentionally skips fs.close for fd 0-2; fd 3
// can produce actual EOF while the executor remains alive. Never emit a fake
// Host end event; framing and all turn lifecycle consumers run unchanged.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, argv, options] = args;
      const child = actual.spawn(command, argv ?? [], {
        ...options, stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
      });
      child.stdout = child.stdio[3] as import('node:stream').Readable;
      fixture.child = child;
      return child;
    },
  };
});

// Replace only the executable. PiAgent, RPC framing, translator, queue and
// Session are production code. No provider or real build is involved.
vi.mock('../transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport.js')>();
  return {
    ...actual,
    createPiStdioTransport: (opts: Parameters<typeof actual.createPiStdioTransport>[0]) => {
      const program = `
        const { spawn } = require('node:child_process');
        const readline = require('node:readline');
        const { writeSync, closeSync } = require('node:fs');
        // Use the closeable extra pipe, not Windows' protected standard fd 1.
        // The spawn fixture exposes this real pipe to the production reader.
        const outputFd = 3;
        const output = frame => writeSync(outputFd, JSON.stringify(frame) + '\\n');
        const endOutput = tail => {
          if (tail !== undefined) writeSync(outputFd, tail);
          closeSync(outputFd);
        };
        const result = { content: [{ type: 'text', text: 'fixture build complete' }] };
        let rpcLost = false;
        let eofOnAbort = false;
        let loseNextPrompt = false;
        const finish = (omit) => {
          if (omit !== 'tool_execution_end') output({ type: 'tool_execution_end', toolCallId: 'build-1', toolName: 'bash', result });
          if (omit !== 'message_end') output({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Build finished.' }],
            stopReason: 'stop', usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13 } } });
          if (omit !== 'agent_settled') output({ type: 'agent_settled' });
        };
        readline.createInterface({ input: process.stdin }).on('line', line => {
          const cmd = JSON.parse(line);
          if (rpcLost) return process.exit(23);
          if (cmd.type === 'fixture_finish') {
            finish(cmd.omit);
            if (cmd.eof) endOutput();
            return;
          }
          if (cmd.type === 'fixture_eof_tail') return endOutput(JSON.stringify(cmd.frame));
          if (cmd.type === 'fixture_eof_on_abort') { eofOnAbort = true; return; }
          if (cmd.type === 'fixture_retry_exhausted_eof') {
            output({ type: 'auto_retry_end', success: false, finalError: 'The operation timed out.' });
            return endOutput();
          }
          if (cmd.type === 'fixture_retry_exhausted_then_next_prompt_eof') {
            output({ type: 'auto_retry_end', success: false, finalError: 'The operation timed out.' });
            output({ type: 'agent_settled' });
            loseNextPrompt = true;
            return;
          }
          if (cmd.type === 'fixture_lose_rpc') {
            rpcLost = true;
            output({ type: 'fixture_rpc_losing' });
            return endOutput();
          }
          if (cmd.type === 'fixture_exit_with_descendant') {
            const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
              // libuv's Windows job kills non-detached children on parent exit.
              // This fixture specifically needs a surviving pipe owner; production
              // spawn options remain unchanged, and afterEach owns its cleanup.
              detached: process.platform === 'win32',
              stdio: ['ignore', outputFd, 2], env: process.env
            });
            child.once('spawn', () => {
              output({ type: 'fixture_descendant', pid: child.pid });
              // output writes synchronously before exit, leaving both pipes
              // open in the descendant exactly as a shell/build child can.
              process.exit(23);
            });
            return;
          }
          if (cmd.type === 'fixture_exit') return process.exit(23);
          output({ type: 'response', id: cmd.id, command: cmd.type, success: true,
            data: cmd.type === 'get_state'
              ? { sessionFile: '/fixture/session.jsonl', model: { id: 'm', provider: 'cindy', contextWindow: 200000 } }
              : { commands: [], entries: [] } });
          if (cmd.type === 'prompt') {
            if (loseNextPrompt) return endOutput();
            output({ type: 'agent_start' });
            output({ type: 'tool_execution_start', toolCallId: 'build-1', toolName: 'bash', args: { command: 'fixture-build', timeout: 1800 } });
          }
          if (cmd.type === 'abort') {
            if (eofOnAbort) endOutput();
            else output({ type: 'agent_settled' });
          }
        });
      `;
      const env: Record<string, string | undefined> = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      fixture.packageToken = opts.env.CINDY_PI_PACKAGE_MANAGEMENT;
      fixture.transport = actual.createPiStdioTransport({
        ...opts, binaryPath: process.execPath, args: ['-e', program], env,
      });
      return fixture.transport;
    },
  };
});

import { PiAgent } from '../index.js';
import { Session } from '../../../session.js';

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
};

describe('Pi long tool lifecycle through real stdio RPC', () => {
  let root = '';
  let session: Session | undefined;
  let descendantPid: number | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    // Only terminate the descendant created and reported by this fixture.
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      // kill() requests termination; on Windows the descendant can still hold
      // its inherited cwd open until exit completes. Confirm before deleting it.
      await vi.waitFor(() => {
        try { process.kill(descendantPid!, 0); } catch (error) {
          expect(error).toMatchObject({ code: 'ESRCH' });
          return;
        }
        throw new Error('fixture descendant has not exited');
      }, { timeout: 2000, interval: 20 });
    }
    await session?.close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    session = undefined;
    descendantPid = undefined;
    fixture.transport = null;
    fixture.child = null;
    fixture.packageToken = undefined;
  });

  async function start(
    fakeClock = false,
    overrides: Partial<AgentDeps> = {},
    sessionOpts: Partial<Parameters<PiAgent['startSession']>[0]> = {},
  ) {
    root = mkdtempSync(path.join(tmpdir(), 'pi-long-tool-'));
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'fixture', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(root, 'pi'), logger,
      resolvePiAgentHome: () => root,
      resolvePiGatewayModelApi: () => 'openai-responses',
      capabilityAdditions: { availableModels: [
        { id: 'm', displayName: 'fixture', contextWindow: 200000, efforts: [], defaultEffort: null },
      ] },
    };
    const agent = new PiAgent({ ...deps, ...overrides });
    const handle = await agent.startSession({ sessionId: 'long-tool', workingDir: root, model: 'm', ...sessionOpts });
    const transport = fixture.transport!;
    const nativeFrames: string[] = [];
    transport.onLine(line => {
      const frame = JSON.parse(line);
      nativeFrames.push(frame.type);
      if (frame.type === 'fixture_descendant') descendantPid = frame.pid;
    });
    const events: AgentEvent[] = [];
    if (fakeClock) vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    session = new Session({
      id: 'long-tool', agentKind: 'pi', workDir: root, handle,
      capabilities: agent.capabilities, logger,
    });
    session.onEvent(event => events.push(event));
    await session.send('Build the fixture');
    await vi.waitFor(() => expect(events.some(event => event.type === 'tool_use')).toBe(true));
    return { events, transport, handle, nativeFrames };
  }

  it('keeps a quiet live tool running and delivers its result, usage and terminal without another send', async () => {
    const { events, transport, handle } = await start(true);
    // Twenty minutes without model tokens or tool output is not evidence of
    // failure. Stay within the native bash tool's supported 30-minute budget.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(handle.isTurnRunning?.()).toBe(true);
    expect(events.some(event => event.type === 'done' || event.type === 'error')).toBe(false);
    await transport.writeLine(JSON.stringify({ type: 'fixture_finish' }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
    expect(events.find(event => event.type === 'tool_result_full')?.data).toMatchObject({ fullText: 'fixture build complete' });
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({
      result: 'Build finished.', status: 'completed', usage: {
        inputTokens: 10, outputTokens: 3, turnDurationMs: expect.any(Number),
      },
    });
    const usage = (events.find(event => event.type === 'done')!.data as {
      usage: { turnDurationMs: number; durationMs?: number };
    }).usage;
    expect(usage.turnDurationMs).toBeGreaterThanOrEqual(20 * 60_000);
    // Tool wall time must not be charged as model generation time/TPS.
    expect(usage.durationMs).toBeUndefined();
    expect(session!.isTurnRunning()).toBe(false);
  });

  it('reports executor exit while a build descendant still holds the RPC pipes open', async () => {
    const { events, transport } = await start();
    await transport.writeLine(JSON.stringify({ type: 'fixture_exit_with_descendant' }));
    await vi.waitFor(() => expect(descendantPid).toBeTypeOf('number'));
    await vi.waitFor(() => expect(() => process.kill(transport.pid!, 0)).toThrow());
    await vi.waitFor(() => expect(events.some(event => event.type === 'error')).toBe(true), { timeout: 2000 });
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({
      isTerminal: true, message: expect.stringContaining('code=23'),
    });
    // Failure of Pi does not prove the build stopped or succeeded.
    expect(() => process.kill(descendantPid!, 0)).not.toThrow();
    expect(events.some(event => event.type === 'tool_result_full')).toBe(false);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
  });

  it('reports ordinary RPC process exit during a tool', async () => {
    const { events, transport } = await start();
    await transport.writeLine(JSON.stringify({ type: 'fixture_exit' }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'error')).toBe(true));
  });

  it('does not invent a lost tool result when Pi settles with its final answer', async () => {
    const { events, transport } = await start();
    await transport.writeLine(JSON.stringify({ type: 'fixture_finish', omit: 'tool_execution_end' }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
    expect(events.some(event => event.type === 'tool_result_full')).toBe(false);
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({ result: 'Build finished.' });
    expect(session!.isTurnRunning()).toBe(false);
    // The missing result is an upstream evidence gap; executor-exit handling
    // must not replay the build or fabricate its output to fill that gap.
  });

  it('distinguishes missing message_end from a missing agent_settled', async () => {
    const { events, transport } = await start();
    await transport.writeLine(JSON.stringify({ type: 'fixture_finish', omit: 'message_end' }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({
      result: '', silentStop: true, usage: { outputTokens: 0 },
    });
    expect(events.some(event => event.type === 'tool_result_full')).toBe(true);
    expect(session!.isTurnRunning()).toBe(false);
  });

  it('leaves a missing settled frame to the existing bounded Session watchdog', async () => {
    const { events, transport } = await start(true);
    await transport.writeLine(JSON.stringify({ type: 'fixture_finish', omit: 'agent_settled' }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'text')).toBe(true));
    expect(session!.isTurnRunning()).toBe(true);
    expect(events.some(event => event.type === 'done')).toBe(false);
    await vi.advanceTimersByTimeAsync(45 * 60_000 + 1);
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ reason: 'turn_no_event_timeout' });
  });

  it('settles definite RPC EOF promptly without replaying the accepted build or inventing its result', async () => {
    const { events, transport, nativeFrames } = await start();
    const write = vi.spyOn(transport, 'writeLine');
    const exit = vi.fn();
    transport.onClose(exit);
    let executorAliveAtDisconnect = false;
    transport.onDisconnect?.(() => {
      try {
        process.kill(transport.pid!, 0);
        executorAliveAtDisconnect = true;
      } catch { /* The assertion below must distinguish EOF from process exit. */ }
    });
    await transport.writeLine(JSON.stringify({ type: 'fixture_lose_rpc' }));
    await vi.waitFor(() => expect(nativeFrames).toContain('fixture_rpc_losing'));
    await vi.waitFor(() => expect(events.some(event => event.type === 'error')).toBe(true), { timeout: 2000 });
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({
      isTerminal: true, reason: 'pi-rpc-disconnected',
      message: expect.stringContaining('tool outcome is unknown'),
    });
    expect(events.some(event => event.type === 'tool_result_full')).toBe(false);
    expect(executorAliveAtDisconnect).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(write.mock.calls.map(([line]) => JSON.parse(line).type)).toEqual(['fixture_lose_rpc']);
  });

  it('preserves the completed result when settled is followed by RPC EOF', async () => {
    const { events, transport } = await start();
    await transport.writeLine(JSON.stringify({ type: 'fixture_finish', eof: true }));
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({
      status: 'completed', result: 'Build finished.', usage: { outputTokens: 3 },
    });
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.find(event => event.type === 'tool_result_full')?.data).toMatchObject({ fullText: 'fixture build complete' });
  });

  it('preserves tool result, final answer and usage drained after stdin EPIPE', async () => {
    const { events, transport } = await start(true);
    // Put the command in the real pipe before fencing writes. Its response
    // reaches the real stdout reader only after the injected input error.
    const finishing = transport.writeLine(JSON.stringify({ type: 'fixture_finish' }));
    fixture.child!.stdin!.emit('error', new Error('EPIPE'));
    expect(transport.isClosed()).toBe(true);
    await finishing;
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
    expect(events.find(event => event.type === 'tool_result_full')?.data).toMatchObject({ fullText: 'fixture build complete' });
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({
      status: 'completed', result: 'Build finished.', usage: { inputTokens: 10, outputTokens: 3 },
    });
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it.each(['stdin-completed', 'stdout-completed', 'cancelled'] as const)('fences the next user/continuation send after %s while executor exit is unconfirmed', async (outcome) => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const { events, transport, handle } = await start(true, { mutatePiManagedPackage });
    const child = fixture.child!;
    // Deterministically keep exit confirmation pending on every OS, including
    // Windows where SIGTERM cannot be ignored by the child. Own the cleanup.
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => true);
    try {
      if (outcome === 'cancelled') {
        await transport.writeLine(JSON.stringify({ type: 'fixture_lose_rpc' }));
        await vi.waitFor(() => expect(transport.isClosed()).toBe(true));
        await handle.abort();
      } else {
        const finishing = transport.writeLine(JSON.stringify({ type: 'fixture_finish', eof: outcome === 'stdout-completed' }));
        if (outcome === 'stdin-completed') child.stdin!.emit('error', new Error('EPIPE'));
        await finishing;
      }
      await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
      await vi.waitFor(() => expect(transport.isClosed()).toBe(true));
      expect(session!.getStatus()).toBe('active');
      expect(handle.isTurnRunning?.()).toBe(true);
      expect(session!.isTurnRunning()).toBe(true);
      const generation = session!.getTurnGeneration();
      const send = vi.spyOn(handle, 'send');
      const write = vi.spyOn(transport, 'writeLine');
      await expect(session!.send('A new user message')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
      await expect(session!.sendHostTurnContinuation('Continue without replaying the build')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
      expect(send).not.toHaveBeenCalled();
      // Direct adapter consumers must also receive a known-undispatched
      // rejection, not an ambiguous send that force-closes Session.
      await expect(handle.send({ type: 'user', content: 'Direct follow-up' })).rejects.toBeInstanceOf(TurnDispatchRejectedError);
      // Cleanup fencing is not steer admission. The established no-active-turn
      // error lets the input coordinator retain ordinary input for rebuild.
      await expect(session!.steer('Ordinary composer steer')).rejects.toThrow(/no active .*turn/i);
      const command = 'pi install npm:fixture-extension';
      await expect(session!.steer(command, {
        [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'desktop' }, rawChannelText: command },
      })).rejects.toThrow(/no active .*turn/i);
      await expect(handle.steer({ type: 'user', content: command }, {
        [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'desktop' }, rawChannelText: command },
      })).rejects.toThrow(/no active .*turn/i);
      expect(mutatePiManagedPackage).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(session!.getTurnGeneration()).toBe(generation);
      await vi.advanceTimersByTimeAsync(250);
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(events.find(event => event.type === 'done')?.data).toMatchObject({
        status: outcome === 'cancelled' ? 'cancelled' : 'completed',
        ...(outcome === 'cancelled' ? {} : { result: 'Build finished.', usage: { outputTokens: 3 } }),
      });
    } finally {
      kill.mockRestore();
      child.kill('SIGTERM');
    }
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(session!.isTurnRunning()).toBe(false);
  });

  it('rechecks steer availability after asynchronous preparation before any host-owned mutation', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const { events, transport, handle } = await start(true, { mutatePiManagedPackage });
    await transport.writeLine(JSON.stringify({ type: 'fixture_finish' }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
    const write = vi.spyOn(transport, 'writeLine');
    const command = 'pi install npm:fixture-extension';
    const steering = handle.steer({ type: 'user', content: command }, {
      [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'desktop' }, rawChannelText: command },
    });
    // steer passed its initial guard and yielded in buildPiPrompt.
    fixture.child!.stdin!.emit('error', new Error('EPIPE'));
    await expect(steering).rejects.toThrow(/no active .*turn/i);
    expect(mutatePiManagedPackage).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
  });

  it('rejects unavailable steer without claiming an unsettled build already finished', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const { events, transport } = await start(true, { mutatePiManagedPackage });
    fixture.child!.stdin!.emit('error', new Error('EPIPE'));
    const write = vi.spyOn(transport, 'writeLine');
    const command = 'pi install npm:fixture-extension';
    await expect(session!.steer(command, {
      [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'desktop' }, rawChannelText: command },
    })).rejects.toThrow('Pi RPC unavailable before steer dispatch');
    expect(mutatePiManagedPackage).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'done' || event.type === 'error')).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({
      reason: 'pi-rpc-disconnected', isTerminal: true,
    });
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  it.each(['during-mutation', 'during-receipt-write'])('keeps an accepted host steer mutation non-replayable when RPC fails %s', async (boundary) => {
    const mutatePiManagedPackage = vi.fn(async () => {
      if (boundary === 'during-mutation') fixture.child!.stdin!.emit('error', new Error('EPIPE'));
      return { changed: true };
    });
    const { events, transport } = await start(true, { mutatePiManagedPackage });
    const write = vi.spyOn(transport, 'writeLine');
    if (boundary === 'during-receipt-write') {
      write.mockImplementationOnce(async () => {
        fixture.child!.stdin!.emit('error', new Error('EPIPE'));
        throw new Error('fixture receipt write EPIPE');
      });
    }
    const command = 'pi install npm:fixture-extension';
    await expect(session!.steer(command, {
      [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'desktop' }, rawChannelText: command },
    })).resolves.toBeUndefined();
    expect(mutatePiManagedPackage).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(events.some(event => event.type === 'text'
      && (event.data as { text?: string }).text?.includes('npm:fixture-extension'))).toBe(true));
    expect(write.mock.calls.map(([line]) => JSON.parse(line).type)).toEqual(
      boundary === 'during-mutation' ? [] : ['steer'],
    );
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(mutatePiManagedPackage).toHaveBeenCalledOnce();
  });

  it.each(['cindy:request-preferences', 'cindy:pi-package'])('fences an unterminated EOF %s tail before responses or host mutations', async (title) => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const { transport, nativeFrames } = await start(true, { mutatePiManagedPackage }, {
      permissionMode: 'bypassPermissions',
    });
    expect(fixture.packageToken).toBeTypeOf('string');
    const write = vi.spyOn(transport, 'writeLine');
    const frame = { type: 'extension_ui_request', id: 'eof-request', method: 'input', title,
      placeholder: JSON.stringify(title === 'cindy:pi-package'
        ? { action: 'install', source: 'npm:fixture-extension', token: fixture.packageToken }
        : { provider: 'cindy', model: 'm' }) };
    await transport.writeLine(JSON.stringify({ type: 'fixture_eof_tail', frame }));
    await vi.waitFor(() => expect(nativeFrames).toContain('extension_ui_request'));
    expect(mutatePiManagedPackage).not.toHaveBeenCalled();
    expect(write.mock.calls.map(([line]) => JSON.parse(line).type)).toEqual(['fixture_eof_tail']);
    expect(transport.isClosed()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
  });

  it('rejects a known-undispatched send when pipes disappear after Session reserves the next turn', async () => {
    const { events, transport } = await start(true);
    await transport.writeLine(JSON.stringify({ type: 'fixture_finish' }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
    expect(session!.isTurnRunning()).toBe(false);
    const generation = session!.getTurnGeneration();
    const write = vi.spyOn(transport, 'writeLine');
    let verdict: unknown;
    const sending = session!.send('A new user message', {
      afterTurnReserved: async () => { fixture.child!.stdin!.emit('error', new Error('EPIPE')); },
    }).then(result => { verdict = { result }; }, error => { verdict = { error }; });
    await vi.waitFor(() => expect(verdict).toBeDefined());
    await sending;
    expect(verdict).toEqual({ result: { accepted: false, reason: 'provider-rejected-before-dispatch' } });
    expect(session!.getTurnGeneration()).toBe(generation);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('rechecks RPC availability after asynchronous prompt preparation without creating a phantom pending turn', async () => {
    const { events, transport } = await start(true);
    await transport.writeLine(JSON.stringify({ type: 'fixture_finish' }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
    const generation = session!.getTurnGeneration();
    const write = vi.spyOn(transport, 'writeLine');
    const onTranscriptUserEntry = vi.fn();
    const unsubscribe = transport.onLine(line => {
      const frame = JSON.parse(line);
      if (frame.type === 'response' && frame.command === 'get_entries') {
        fixture.child!.stdin!.emit('error', new Error('EPIPE'));
      }
    });
    try {
      await expect(session!.send('A new user message', { onTranscriptUserEntry })).resolves.toEqual({
        accepted: false, reason: 'provider-rejected-before-dispatch',
      });
    } finally { unsubscribe(); }
    expect(onTranscriptUserEntry).not.toHaveBeenCalled();
    expect(write.mock.calls.map(([line]) => JSON.parse(line).type)).toEqual(['get_entries']);
    expect(session!.getTurnGeneration()).toBe(generation);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it.each(['abort', 'requestGracefulStop'] as const)('keeps %s cancelled when Stop arrives inside the EOF confirmation window', async (stopMethod) => {
    const { events, transport, handle } = await start(true);
    await transport.writeLine(JSON.stringify({ type: 'fixture_lose_rpc' }));
    await vi.waitFor(() => expect(transport.isClosed()).toBe(true));
    expect(events.some(event => event.type === 'error')).toBe(false);
    const write = vi.spyOn(transport, 'writeLine');
    await handle[stopMethod]!();
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({ status: 'cancelled' });
  });

  it.each(['abort', 'requestGracefulStop'] as const)('retains %s cancellation when its write fails as the pipe disconnects', async (stopMethod) => {
    const { events, transport, handle } = await start(true);
    const write = vi.spyOn(transport, 'writeLine').mockImplementationOnce(async () => {
      fixture.child!.stdin!.emit('error', new Error('EPIPE'));
      throw new Error('fixture abort write EPIPE');
    });
    const stopping = handle[stopMethod]!();
    if (stopMethod === 'requestGracefulStop') {
      await expect(stopping).rejects.toThrow('fixture abort write EPIPE');
    } else {
      await stopping;
    }
    expect(write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({ status: 'cancelled' });
  });

  it.each([false, true])('does not inherit the previous retry failure before a new prompt agent_start (Stop: %s)', async (stop) => {
    const { events, transport, nativeFrames, handle } = await start(true);
    await transport.writeLine(JSON.stringify({ type: 'fixture_retry_exhausted_then_next_prompt_eof' }));
    await vi.waitFor(() => expect(nativeFrames).toContain('agent_settled'));
    await vi.waitFor(() => expect(session!.isTurnRunning()).toBe(false));
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    const turnBoundary = events.length;
    await session!.send('Start a new fixture build');
    await vi.waitFor(() => expect(transport.isClosed()).toBe(true));
    expect(nativeFrames.filter(type => type === 'agent_start')).toHaveLength(1);
    // A pending accepted prompt is still unsettled even before agent_start.
    // Steer must not tell the coordinator this generation already finished.
    const write = vi.spyOn(transport, 'writeLine');
    await expect(session!.steer('Do not replay this pending build')).rejects.toThrow(
      'Pi RPC unavailable before steer dispatch',
    );
    expect(write).not.toHaveBeenCalled();
    if (stop) await handle.abort();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    const nextTurnEvents = events.slice(turnBoundary);
    if (stop) {
      expect(nextTurnEvents.some(event => event.type === 'error')).toBe(false);
      expect(nextTurnEvents.find(event => event.type === 'done')?.data).toMatchObject({ status: 'cancelled' });
    } else {
      expect(nextTurnEvents.filter(event => event.type === 'error')).toHaveLength(1);
      expect(nextTurnEvents.find(event => event.type === 'error')?.data).toMatchObject({ reason: 'pi-rpc-disconnected', isTerminal: true });
    }
    expect(nextTurnEvents.some(event => event.type === 'tool_result_full')).toBe(false);
  });

  it('does not replace exhausted native retry with a second RPC-loss error', async () => {
    const { events, transport } = await start();
    await transport.writeLine(JSON.stringify({ type: 'fixture_retry_exhausted_eof' }));
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ reason: 'pi-gateway-drop' });
  });

  it('keeps Stop cancelled when RPC disappears without a settled frame', async () => {
    const { events, transport } = await start();
    await transport.writeLine(JSON.stringify({ type: 'fixture_eof_on_abort' }));
    const write = vi.spyOn(transport, 'writeLine');
    await session!.abort();
    await vi.waitFor(() => expect(session!.getStatus()).toBe('closed'));
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({ status: 'cancelled' });
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(write.mock.calls.map(([line]) => JSON.parse(line).type)).toEqual(['abort']);
  });

  it('honors Stop without issuing another prompt or reviving the tool', async () => {
    const { events, transport } = await start();
    const write = vi.spyOn(transport, 'writeLine');
    await session!.abort();
    await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({ status: 'cancelled' });
    expect(write.mock.calls.map(([line]) => JSON.parse(line).type)).toEqual(['abort']);
    expect(session!.isTurnRunning()).toBe(false);
  });
});
