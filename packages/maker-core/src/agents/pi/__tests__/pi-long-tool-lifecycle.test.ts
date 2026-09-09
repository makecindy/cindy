import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PiTransport } from '../transport.js';
import type { AgentEvent } from '../../../types/events.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const fixture = vi.hoisted(() => ({ transport: null as PiTransport | null }));

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
        const output = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
        const result = { content: [{ type: 'text', text: 'fixture build complete' }] };
        let rpcLost = false;
        const finish = (omit) => {
          if (omit !== 'tool_execution_end') output({ type: 'tool_execution_end', toolCallId: 'build-1', toolName: 'bash', result });
          if (omit !== 'message_end') output({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Build finished.' }],
            stopReason: 'stop', usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13 } } });
          if (omit !== 'agent_settled') output({ type: 'agent_settled' });
        };
        readline.createInterface({ input: process.stdin }).on('line', line => {
          const cmd = JSON.parse(line);
          if (rpcLost) return process.exit(23);
          if (cmd.type === 'fixture_finish') return finish(cmd.omit);
          if (cmd.type === 'fixture_lose_rpc') {
            rpcLost = true;
            output({ type: 'fixture_rpc_losing' });
            return process.stdout.end();
          }
          if (cmd.type === 'fixture_exit_with_descendant') {
            const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
              stdio: ['ignore', process.stdout, process.stderr], env: process.env
            });
            child.once('spawn', () => {
              output({ type: 'fixture_descendant', pid: child.pid });
              // Drain the fixture metadata before exiting, leaving both pipes
              // open in the descendant exactly as a shell/build child can.
              process.stdout.write('', () => process.exit(23));
            });
            return;
          }
          if (cmd.type === 'fixture_exit') return process.exit(23);
          output({ type: 'response', id: cmd.id, command: cmd.type, success: true,
            data: cmd.type === 'get_state'
              ? { sessionFile: '/fixture/session.jsonl', model: { id: 'm', provider: 'cindy', contextWindow: 200000 } }
              : { commands: [], entries: [] } });
          if (cmd.type === 'prompt') {
            output({ type: 'agent_start' });
            output({ type: 'tool_execution_start', toolCallId: 'build-1', toolName: 'bash', args: { command: 'fixture-build', timeout: 1800 } });
          }
          if (cmd.type === 'abort') output({ type: 'agent_settled' });
        });
      `;
      const env: Record<string, string | undefined> = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
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
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already exited */ }
    }
    await session?.close();
    if (root) rmSync(root, { recursive: true, force: true });
    session = undefined;
    descendantPid = undefined;
    fixture.transport = null;
  });

  async function start(fakeClock = false) {
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
    const agent = new PiAgent(deps);
    const handle = await agent.startSession({ sessionId: 'long-tool', workingDir: root, model: 'm' });
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

  it('distinguishes RPC EOF with a live executor from confirmed process exit', async () => {
    const { events, transport, nativeFrames } = await start(true);
    await transport.writeLine(JSON.stringify({ type: 'fixture_lose_rpc' }));
    await vi.waitFor(() => expect(nativeFrames).toContain('fixture_rpc_losing'));
    expect(() => process.kill(transport.pid!, 0)).not.toThrow();
    expect(events.some(event => event.type === 'error')).toBe(false);
    // EOF alone currently has no native executor-exit proof. Characterize the
    // existing fallback honestly; the new exit drain must not kill a live tool.
    await vi.advanceTimersByTimeAsync(45 * 60_000 + 1);
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ reason: 'turn_no_event_timeout' });
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
