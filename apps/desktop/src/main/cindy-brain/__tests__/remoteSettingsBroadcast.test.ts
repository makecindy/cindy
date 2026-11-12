import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformWithEsbuild } from 'vite';
import { describe, expect, it, vi } from 'vitest';

describe('original settings BroadcastChannel transport', () => {
  it('runs the built script without Main helpers and preserves subscribe, reply and close', async () => {
    const source = await readFile(
      new URL('../remoteSettingsBroadcast.ts', import.meta.url),
      'utf8',
    );
    const built = await transformWithEsbuild(source, 'remoteSettingsBroadcast.ts', {
      target: 'es2020',
      format: 'cjs',
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
    });
    const module = { exports: {} as { remoteSettingsBroadcastScript(endpoint: string): string } };
    runInNewContext(built.code, { module, exports: module.exports });
    const window = {} as { BroadcastChannel: typeof BroadcastChannel };
    const commands: Array<Record<string, unknown>> = [];
    const timers: Array<() => void> = [];
    const events: Array<{ channel: string; sequence: number; data: unknown }> = [];
    let failPoll = false;
    runInNewContext(module.exports.remoteSettingsBroadcastScript('/fixture-bridge'), {
      window,
      EventTarget,
      MessageEvent,
      DOMException,
      structuredClone,
      setTimeout: (callback: () => void) => timers.push(callback),
      fetch: async (_path: string, init: { body: string }) => {
        const command = JSON.parse(init.body);
        commands.push(command);
        return {
          ok: !(failPoll && command.kind === 'poll'),
          json: async () => (command.kind === 'poll' ? { events: events.splice(0) } : {}),
        };
      },
    });
    const channel = new window.BroadcastChannel('settings');
    const onmessage = vi.fn(),
      listener = vi.fn();
    channel.onmessage = onmessage;
    channel.addEventListener('message', listener);
    channel.postMessage({ op: 'status' });
    await vi.waitFor(() =>
      expect(commands).toContainEqual({
        kind: 'post',
        channel: 'settings',
        data: { op: 'status' },
      }),
    );
    expect(commands[0]).toEqual({ kind: 'subscribe', channels: ['settings'] });
    events.push({ channel: 'settings', sequence: 1, data: { saved: true } });
    timers.shift()!();
    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledTimes(1));
    expect(onmessage.mock.calls[0][0].data).toEqual({ saved: true });
    expect(listener).toHaveBeenCalledTimes(1);
    const onmessageerror = vi.fn(),
      errorListener = vi.fn();
    channel.onmessageerror = onmessageerror;
    channel.addEventListener('messageerror', errorListener);
    failPoll = true;
    timers.shift()!();
    await vi.waitFor(() => expect(errorListener).toHaveBeenCalledTimes(1));
    expect(onmessageerror).toHaveBeenCalledTimes(1);
    const sameName = new window.BroadcastChannel('settings');
    channel.close();
    await Promise.resolve();
    expect(commands).not.toContainEqual({ kind: 'unsubscribe', channel: 'settings' });
    sameName.close();
    await vi.waitFor(() =>
      expect(commands).toContainEqual({ kind: 'unsubscribe', channel: 'settings' }),
    );
    expect(() => channel.postMessage({ late: true })).toThrow('Channel closed');
  });
});
