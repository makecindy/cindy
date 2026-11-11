import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerManagedSidecarQuitHook, spawnManagedSidecar, stopManagedSidecar } from '../ollamaSidecar.js';
import { startOfficialOllamaApp, type OllamaRuntimeDeps } from '../ollamaRuntime.js';
import { OllamaHttpError } from '../ollamaClient.js';

function childProcess() {
  return Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
      return true;
    }),
  });
}

afterEach(() => stopManagedSidecar());

describe('managed Ollama process lifetime', () => {
  // Production start + spawn boundaries, unit tier: two existing sessions can probe
  // a stopped service concurrently. A delayed failure must not kill the process
  // another caller has already made ready. Previous tests covered only one caller.
  it('preserves a ready service when another caller receives a stale failed probe', async () => {
    const child = childProcess();
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    const localAppData = 'C:\\test-data';
    const binary = path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe');
    const runtime: Omit<OllamaRuntimeDeps, 'fetchImpl'> = {
      platform: 'win32',
      arch: 'x64',
      env: { LOCALAPPDATA: localAppData },
      appExists: file => file === binary,
      spawnSidecar: file => spawnManagedSidecar(file, spawnImpl as unknown as typeof spawn),
      sleep: async () => undefined,
    };
    let rejectDelayedProbe!: (error: Error) => void;
    const delayedProbe = new Promise<Response>((_, reject) => { rejectDelayedProbe = reject; });
    const ready = () => new Response(JSON.stringify({ version: '0.32.14' }));
    const slow = startOfficialOllamaApp({
      ...runtime,
      fetchImpl: vi.fn().mockImplementationOnce(() => delayedProbe).mockImplementation(async () => ready()),
    });
    const fast = await startOfficialOllamaApp({
      ...runtime,
      fetchImpl: vi.fn().mockRejectedValueOnce(new OllamaHttpError('refused', 'down'))
        .mockImplementation(async () => ready()),
    });
    expect(fast.kind).toBe('ready');
    expect(child.kill).not.toHaveBeenCalled();
    rejectDelayedProbe(new OllamaHttpError('refused', 'down'));
    expect((await slow).kind).toBe('ready');
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  // PR #9420: one cancelled readiness waiter must not stop another session's sidecar.
  // Unit tier, real runtime + process ownership; suspend one poll while the other succeeds.
  it('cancels only its readiness wait while another caller uses the shared process', async () => {
    const child = childProcess();
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    const controller = new AbortController();
    let entered!: () => void;
    const polling = new Promise<void>((resolve) => { entered = resolve; });
    const localAppData = 'C:\\test-data';
    const binary = path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe');
    const runtime: Omit<OllamaRuntimeDeps, 'fetchImpl'> = {
      platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: localAppData },
      appExists: file => file === binary,
      spawnSidecar: file => spawnManagedSidecar(file, spawnImpl as unknown as typeof spawn),
    };
    const cancelled = startOfficialOllamaApp({
      ...runtime, signal: controller.signal,
      fetchImpl: async () => { throw new OllamaHttpError('refused', 'down'); },
      sleep: () => { entered(); return new Promise(() => undefined); },
    });
    const result = expect(cancelled).rejects.toThrow('aborted');
    await polling;
    let otherEntered!: () => void;
    const otherPolling = new Promise<void>((resolve) => { otherEntered = resolve; });
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => { ready = resolve; });
    const other = startOfficialOllamaApp({
      ...runtime,
      sleep: () => { otherEntered(); return readiness; },
      fetchImpl: vi.fn().mockRejectedValueOnce(new OllamaHttpError('refused', 'down'))
        .mockImplementation(async () => new Response(JSON.stringify({ version: '0.32.14' }))),
    });
    await otherPolling;
    controller.abort();
    await result;
    expect(child.kill).not.toHaveBeenCalled();
    ready();
    const next = await other;
    expect(next.kind).toBe('ready');
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  // PR #9420 P2: a reused child can exit after its listener has gone away.
  // Unit tier, real runtime + sidecar owner; previous tests only retried in a later call.
  it.each(['exit', 'signal'] as const)('recovers a reused child after %s within both pending readiness calls', async (reason) => {
    const first = childProcess();
    const replacement = childProcess();
    const spawnImpl = vi.fn().mockReturnValueOnce(first).mockReturnValue(replacement);
    const binary = path.join('runtime', 'Programs', 'Ollama', 'ollama.exe');
    spawnManagedSidecar(binary, spawnImpl as unknown as typeof spawn);
    let clock = 0;
    let sleepers = 0;
    let bothWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { bothWaiting = resolve; });
    const runtime: OllamaRuntimeDeps = {
      platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: 'runtime' },
      appExists: file => file === binary,
      spawnSidecar: file => spawnManagedSidecar(file, spawnImpl as unknown as typeof spawn),
      now: () => clock, startTimeoutMs: 4_000,
      sleep: async (ms) => {
        // Both calls must reuse the original child before it exits; otherwise
        // a later initial spawn could conceal a missing retry in the first call.
        if (++sleepers <= 2) {
          if (sleepers === 2) bothWaiting();
          await waiting;
        }
        clock += ms;
        if (reason === 'exit') first.exitCode = 0;
        else first.signalCode = 'SIGTERM';
        first.emit('exit', first.exitCode, first.signalCode);
      },
      fetchImpl: async () => {
        if (spawnImpl.mock.calls.length < 2) throw new OllamaHttpError('refused', 'down');
        return new Response(JSON.stringify({ version: '0.32.14' }));
      },
    };
    const results = await Promise.all([startOfficialOllamaApp(runtime), startOfficialOllamaApp(runtime)]);
    expect(results.map(result => result.kind)).toEqual(['ready', 'ready']);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(first.kill).not.toHaveBeenCalled();
    expect(replacement.kill).not.toHaveBeenCalled();
  });

  // A readiness retry must not replace a live child, undo Stop, ignore cancellation,
  // or repeatedly spawn a crashing binary. Virtual time keeps the original budget observable.
  it.each(['live', 'stop', 'cancel', 'crash-loop'] as const)('bounds readiness recovery for %s', async (scenario) => {
    const children: ReturnType<typeof childProcess>[] = [];
    const spawnImpl = vi.fn(() => {
      const child = childProcess();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const binary = path.join('runtime', 'Programs', 'Ollama', 'ollama.exe');
    spawnManagedSidecar(binary, spawnImpl as unknown as typeof spawn);
    const controller = new AbortController();
    let clock = 0;
    const pending = startOfficialOllamaApp({
      platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: 'runtime' },
      appExists: file => file === binary,
      spawnSidecar: file => spawnManagedSidecar(file, spawnImpl as unknown as typeof spawn),
      signal: controller.signal, now: () => clock, startTimeoutMs: 1_600,
      sleep: async (ms) => {
        clock += ms;
        if (scenario === 'live') return;
        if (scenario === 'stop') stopManagedSidecar();
        const child = children[children.length - 1]!;
        child.exitCode = 1;
        child.emit('exit', 1, null);
        if (scenario === 'cancel') controller.abort();
      },
      fetchImpl: async () => { throw new OllamaHttpError('refused', 'down'); },
    });
    if (scenario === 'cancel') await expect(pending).rejects.toThrow('aborted');
    else expect((await pending).kind).toBe('stopped');
    expect(spawnImpl).toHaveBeenCalledTimes(scenario === 'crash-loop' ? 2 : 1);
    expect(clock).toBe(scenario === 'cancel' ? 400 : 1_600);
    if (scenario !== 'stop') for (const child of children) expect(child.kill).not.toHaveBeenCalled();
  });

  // Reusing a live child must not prevent recovery after a genuine exit or stop.
  it.each(['exit', 'stop', 'signal'] as const)('allows a replacement after %s without losing it to an old exit event', (reason) => {
    const first = childProcess();
    const replacement = childProcess();
    const spawnImpl = vi.fn().mockReturnValueOnce(first).mockReturnValue(replacement);
    const start = () => spawnManagedSidecar('/runtime/ollama', spawnImpl as unknown as typeof spawn);
    start();
    if (reason === 'stop') stopManagedSidecar();
    else if (reason === 'exit') first.exitCode = 1;
    else first.signalCode = 'SIGTERM';
    expect(start()).toBe(replacement);
    first.emit('exit', first.exitCode, first.signalCode);
    expect(start()).toBe(replacement);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });
});

describe('registerManagedSidecarQuitHook', () => {
  it('registers the stop hook only once', () => {
    const register = vi.fn();
    registerManagedSidecarQuitHook(register);
    registerManagedSidecarQuitHook(register);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(expect.any(Function));
  });
});
