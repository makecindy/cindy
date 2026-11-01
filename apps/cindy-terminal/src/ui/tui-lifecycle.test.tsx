/** Production entry: runTui must settle and close its client when its terminal
 * disappears, without invoking service/task stop. The renderer tests cover
 * keyboard actions, not the outer waitUntilExit lifecycle. Minimal failure:
 * stdin closes while the renderer is waiting. Tier: unit, in-memory renderer;
 * actual PTY hangup is verified separately in the Linux integration harness. */
import { describe, expect, it, vi } from 'vitest';
import type { TerminalClient } from '../contracts.js';

const renderer = vi.hoisted(() => ({ finish: () => {}, unmount: vi.fn(), cleanup: vi.fn() }));
vi.mock('ink', async importOriginal => ({
  ...await importOriginal<typeof import('ink')>(),
  render: () => {
    const exited = new Promise<void>(resolve => { renderer.finish = resolve; });
    renderer.unmount.mockImplementation(() => renderer.finish());
    return { waitUntilExit: () => exited, unmount: renderer.unmount, cleanup: renderer.cleanup };
  },
}));
import { runTui } from './tui.js';

describe('foreground terminal lifetime', () => {
  it.each(['end', 'close'] as const)('detaches on stdin %s without stopping background work', async event => {
    const close = vi.fn(), invoke = vi.fn();
    const client = { close, invoke, subscribe: () => () => {} } as TerminalClient;
    const listeners = process.stdin.listenerCount(event);
    const running = runTui(client, { locale: 'en' });
    try {
      process.stdin.emit(event);
      await Promise.resolve();
      expect(close).toHaveBeenCalledOnce();
      expect(await running).toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
      expect(process.stdin.listenerCount(event)).toBe(listeners);
    } finally {
      renderer.finish();
      await running;
    }
  });
  it('cleans up a dead output terminal without an unhandled EIO', async () => {
    const close=vi.fn(),invoke=vi.fn();
    const client={close,invoke,subscribe:()=>()=>{}} as TerminalClient;
    const listeners=process.stdout.listenerCount('error');
    const running=runTui(client,{locale:'en'});
    try {
      process.stdout.emit('error',Object.assign(new Error('write EIO'),{code:'EIO'}));
      await running;
      expect(close).toHaveBeenCalledOnce();
      expect(invoke).not.toHaveBeenCalled();
      expect(process.stdout.listenerCount('error')).toBe(listeners);
    } finally { renderer.finish();await running; }
  });
});
