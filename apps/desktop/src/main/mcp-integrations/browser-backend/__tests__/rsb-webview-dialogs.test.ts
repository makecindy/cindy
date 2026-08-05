import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { RsbWebviewDialogs } from '../rsb-webview-dialogs.js';

function dialogHarness() {
  let attached = false;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Page.enable' || method === 'Page.handleJavaScriptDialog') return {};
    throw new Error(`unexpected command: ${method}`);
  });
  const electronDebugger = {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    sendCommand,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    },
  };
  const wc = {
    debugger: electronDebugger,
    once: vi.fn(),
  } as unknown as WebContents;
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners.get('message') ?? []) {
      listener({}, method, params);
    }
  };
  return { wc, emit, electronDebugger, sendCommand };
}

describe('RsbWebviewDialogs', () => {
  it('reports and accepts a pending prompt', async () => {
    const harness = dialogHarness();
    const dialogs = new RsbWebviewDialogs({ warn: vi.fn() });
    await dialogs.observe(harness.wc);
    harness.emit('Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'Enter a name',
      defaultPrompt: 'Cindy',
    });

    const pending = dialogs.pending(harness.wc);
    expect(pending).toMatchObject({
      type: 'prompt',
      message: 'Enter a name',
      defaultValue: 'Cindy',
    });

    await expect(
      dialogs.respond(harness.wc, {
        dialogId: pending?.id,
        accept: true,
        promptText: 'New name',
      }),
    ).resolves.toMatchObject({
      id: pending?.id,
      accepted: true,
    });
    expect(harness.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', {
      accept: true,
      promptText: 'New name',
    });
    harness.emit('Page.javascriptDialogClosed', {
      result: true,
      userInput: 'New name',
    });
    expect(dialogs.pending(harness.wc)).toBeUndefined();
  });

  it('rejects a stale id without responding to a different dialog', async () => {
    const harness = dialogHarness();
    const dialogs = new RsbWebviewDialogs({ warn: vi.fn() });
    await dialogs.observe(harness.wc);
    harness.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Continue?',
    });

    await expect(
      dialogs.respond(harness.wc, {
        dialogId: 'stale-dialog',
        accept: false,
        timeoutMs: 50,
      }),
    ).rejects.toThrow('is no longer pending');
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Page.handleJavaScriptDialog',
      expect.anything(),
    );
  });

  it('resolves a one-shot opening watcher and allows cancellation', async () => {
    const harness = dialogHarness();
    const dialogs = new RsbWebviewDialogs({ warn: vi.fn() });
    await dialogs.observe(harness.wc);

    const opening = dialogs.watchOpening(harness.wc);
    harness.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'Saved',
    });
    await expect(opening.opened).resolves.toMatchObject({
      type: 'alert',
      message: 'Saved',
    });

    const cancelled = dialogs.watchOpening(harness.wc);
    cancelled.cancel();
    harness.emit('Page.javascriptDialogClosed', {});
    expect(dialogs.pending(harness.wc)).toBeUndefined();
  });

  it('records auto-closed dialogs and arms the next response', async () => {
    const harness = dialogHarness();
    const dialogs = new RsbWebviewDialogs({ warn: vi.fn() });
    await dialogs.observe(harness.wc);
    harness.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Continue?',
    });
    harness.emit('Page.javascriptDialogClosed', {
      result: false,
      userInput: '',
    });
    const first = dialogs.recent(harness.wc);
    expect(first).toMatchObject({
      type: 'confirm',
      message: 'Continue?',
      closedBy: 'auto',
    });

    const deferred = await dialogs.respond(harness.wc, {
      dialogId: first?.id,
      accept: true,
    });
    expect(deferred).toMatchObject({
      id: first?.id,
      deferred: true,
    });

    const armed = dialogs.armNext(harness.wc, { accept: true });
    harness.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Continue again?',
    });
    await expect(armed.response).resolves.toMatchObject({
      type: 'confirm',
      message: 'Continue again?',
      closedBy: 'armed',
    });
    expect(harness.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', {
      accept: true,
    });
  });

  it('does not let an undirected response consume a stale recent dialog', async () => {
    const harness = dialogHarness();
    const dialogs = new RsbWebviewDialogs({ warn: vi.fn() });
    await dialogs.observe(harness.wc);
    harness.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Old dialog',
    });
    harness.emit('Page.javascriptDialogClosed', {
      result: false,
      userInput: '',
    });

    await expect(
      dialogs.respond(harness.wc, {
        accept: true,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('no page dialog is pending');

    const armed = dialogs.armNext(harness.wc, { accept: true });
    harness.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Fresh dialog',
    });
    await expect(armed.response).resolves.toMatchObject({
      message: 'Fresh dialog',
      closedBy: 'armed',
    });
  });

  it('keeps a prepared response active beyond the regular action timeout', async () => {
    vi.useFakeTimers();
    try {
      const harness = dialogHarness();
      const dialogs = new RsbWebviewDialogs({ warn: vi.fn() });
      await dialogs.observe(harness.wc);

      const armed = dialogs.armNext(harness.wc, { accept: true });
      await vi.advanceTimersByTimeAsync(60_001);
      harness.emit('Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Continue later?',
      });

      await expect(armed.response).resolves.toMatchObject({
        type: 'confirm',
        message: 'Continue later?',
        closedBy: 'armed',
      });
      expect(harness.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', {
        accept: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches only debugger sessions it owns', async () => {
    const owned = dialogHarness();
    const ownedDialogs = new RsbWebviewDialogs({ warn: vi.fn() });
    await ownedDialogs.observe(owned.wc);
    ownedDialogs.dispose();
    expect(owned.electronDebugger.detach).toHaveBeenCalledTimes(1);

    const shared = dialogHarness();
    shared.electronDebugger.attach();
    const sharedDialogs = new RsbWebviewDialogs({ warn: vi.fn() });
    await sharedDialogs.observe(shared.wc);
    sharedDialogs.dispose();
    expect(shared.electronDebugger.detach).toHaveBeenCalledTimes(0);
  });
});
