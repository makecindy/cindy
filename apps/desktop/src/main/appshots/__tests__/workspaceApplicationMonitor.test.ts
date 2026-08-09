import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { MacWorkspaceApplicationMonitor } from '../workspaceApplicationMonitor.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fakeProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn();
  return process;
}

describe('MacWorkspaceApplicationMonitor', () => {
  it('publishes authoritative bundle-id snapshots from the long-running workspace event process', () => {
    const child = fakeProcess();
    const onSnapshot = vi.fn();
    const monitor = new MacWorkspaceApplicationMonitor({
      spawnListener: () => child,
      readSnapshot: async () => [],
      onSnapshot,
    });

    monitor.start();
    child.stdout.emit('data', Buffer.from('{"type":"snapshot","bundleIds":["com.openai.codex"]}\n'));
    expect(monitor.state()).toEqual(new Set(['com.openai.codex']));
    expect(onSnapshot).toHaveBeenCalledWith(new Set(['com.openai.codex']));

    monitor.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.stdout.emit('data', Buffer.from('{"type":"snapshot","bundleIds":[]}\n'));
    expect(monitor.state()).toEqual(new Set(['com.openai.codex']));
  });

  it('keeps refresh single-flight and ignores an older fallback snapshot after a workspace event', async () => {
    const child = fakeProcess();
    const fallback = deferred<readonly string[]>();
    const readSnapshot = vi.fn(() => fallback.promise);
    const monitor = new MacWorkspaceApplicationMonitor({
      spawnListener: () => child,
      readSnapshot,
      onSnapshot: vi.fn(),
    });
    monitor.start();

    const first = monitor.refresh();
    const second = monitor.refresh();
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    child.stdout.emit('data', Buffer.from('{"type":"snapshot","bundleIds":["com.openai.codex"]}\n'));
    fallback.resolve([]);
    await Promise.all([first, second]);

    expect(monitor.state()).toEqual(new Set(['com.openai.codex']));
  });

  it('preserves the last state after malformed output or listener failure', () => {
    const child = fakeProcess();
    const monitor = new MacWorkspaceApplicationMonitor({
      spawnListener: () => child,
      readSnapshot: async () => [],
      onSnapshot: vi.fn(),
    });
    monitor.start();
    child.stdout.emit('data', Buffer.from('{"type":"snapshot","bundleIds":["com.openai.codex"]}\n'));
    child.stdout.emit('data', Buffer.from('not-json\n'));
    child.emit('close', 1);
    expect(monitor.state()).toEqual(new Set(['com.openai.codex']));
  });

  it('tolerates null bundle entries emitted by the JXA bridge', async () => {
    const child = fakeProcess();
    const onSnapshot = vi.fn();
    const monitor = new MacWorkspaceApplicationMonitor({
      spawnListener: () => child,
      readSnapshot: vi.fn(async () => [
        'com.openai.codex',
        null as unknown as string,
        '',
      ]),
      onSnapshot,
    });

    monitor.start();
    child.stdout.emit(
      'data',
      Buffer.from('{"type":"snapshot","bundleIds":["com.openai.codex",null,123,""]}\n'),
    );
    expect(monitor.state()).toEqual(new Set(['com.openai.codex']));

    await monitor.refresh();
    expect(monitor.state()).toEqual(new Set(['com.openai.codex']));
    expect(onSnapshot).toHaveBeenLastCalledWith(new Set(['com.openai.codex']));

    monitor.stop();
  });

  it('restarts the workspace listener after an unexpected exit and only parses stdout', () => {
    const firstChild = fakeProcess();
    const secondChild = fakeProcess();
    const children = [firstChild, secondChild];
    let restart: (() => void) | undefined;
    const onSnapshot = vi.fn();
    const monitor = new MacWorkspaceApplicationMonitor({
      spawnListener: vi.fn(() => children.shift()!),
      readSnapshot: async () => [],
      onSnapshot,
      scheduleRestart: (callback) => { restart = callback; },
    });

    monitor.start();
    firstChild.stdout.emit('data', Buffer.from('{"type":"snapshot","bundleIds":["com.openai.codex"]}\n'));
    firstChild.stderr.emit('data', Buffer.from('diagnostic output without a newline'));
    firstChild.emit('close', 1);
    expect(restart).toBeTypeOf('function');
    restart?.();
    expect(children).toHaveLength(0);
    secondChild.stdout.emit('data', Buffer.from('{"type":"snapshot","bundleIds":[]}\n'));

    expect(onSnapshot).toHaveBeenLastCalledWith(new Set());
    expect(monitor.state()).toEqual(new Set());
  });
});
