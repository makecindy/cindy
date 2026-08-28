/**
 * dispatchSendClear.test.ts
 * ---------------------------------------------------------------------------
 * Regression: sent transcript bubbles must not overlap the live composer.
 *
 * ChatInput now clears the click-time draft *before* awaiting onSend. Local
 * enqueue / effort / slash / auth can take long enough for the optimistic
 * user bubble to appear; waiting until onSend settles left the same text in
 * both places. A rejected send restores the snapshot.
 */

import { describe, it, expect, vi } from 'vitest';

interface DispatchSendDeps {
  getText: () => string;
  hasAttachments: boolean;
  disabled: boolean;
  onSend: (text: string) => boolean | void | Promise<boolean | void>;
  clearContent: () => void;
  clearFiles: () => void;
  restoreContent: () => void;
}

async function dispatchSendLogic(deps: DispatchSendDeps): Promise<void> {
  if (deps.disabled) return;
  const text = deps.getText();
  if (!text && !deps.hasAttachments) return;
  deps.clearContent();
  deps.clearFiles();
  let result: boolean | void;
  try {
    result = await deps.onSend(text);
  } catch {
    deps.restoreContent();
    return;
  }
  if (result === false) {
    deps.restoreContent();
  }
}

describe('dispatchSend clear-content contract', () => {
  const makeDeps = (overrides: Partial<DispatchSendDeps> = {}): DispatchSendDeps => ({
    getText: () => 'hello world',
    hasAttachments: false,
    disabled: false,
    onSend: vi.fn(),
    clearContent: vi.fn(),
    clearFiles: vi.fn(),
    restoreContent: vi.fn(),
    ...overrides,
  });

  it('clears editor before onSend returns void (normal send)', async () => {
    const deps = makeDeps({ onSend: vi.fn(() => undefined) });
    await dispatchSendLogic(deps);
    expect(deps.onSend).toHaveBeenCalledWith('hello world');
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.clearFiles).toHaveBeenCalledTimes(1);
    expect(deps.restoreContent).not.toHaveBeenCalled();
  });

  it('clears editor when onSend returns true', async () => {
    const deps = makeDeps({ onSend: vi.fn(() => true) });
    await dispatchSendLogic(deps);
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.clearFiles).toHaveBeenCalledTimes(1);
    expect(deps.restoreContent).not.toHaveBeenCalled();
  });

  it('clears immediately, then restores when onSend returns false', async () => {
    const deps = makeDeps({ onSend: vi.fn(() => false) });
    await dispatchSendLogic(deps);
    expect(deps.onSend).toHaveBeenCalledWith('hello world');
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.clearFiles).toHaveBeenCalledTimes(1);
    expect(deps.restoreContent).toHaveBeenCalledTimes(1);
  });

  it('clears immediately, then restores when onSend throws', async () => {
    const deps = makeDeps({
      onSend: vi.fn(() => {
        throw new Error('rejected');
      }),
    });
    await dispatchSendLogic(deps);
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.restoreContent).toHaveBeenCalledTimes(1);
  });

  it('clears before a slow onSend resolves so the bubble cannot overlap', async () => {
    let resolveSend!: (value: boolean) => void;
    const order: string[] = [];
    const deps = makeDeps({
      clearContent: vi.fn(() => {
        order.push('clear');
      }),
      onSend: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            order.push('onSend-started');
            resolveSend = resolve;
          }),
      ),
    });
    const done = dispatchSendLogic(deps);
    expect(order).toEqual(['clear', 'onSend-started']);
    resolveSend(true);
    await done;
    expect(deps.restoreContent).not.toHaveBeenCalled();
  });

  it('does not send when disabled', async () => {
    const deps = makeDeps({ disabled: true });
    await dispatchSendLogic(deps);
    expect(deps.onSend).not.toHaveBeenCalled();
    expect(deps.clearContent).not.toHaveBeenCalled();
  });

  it('does not send when text is empty and no attachments', async () => {
    const deps = makeDeps({ getText: () => '', hasAttachments: false });
    await dispatchSendLogic(deps);
    expect(deps.onSend).not.toHaveBeenCalled();
    expect(deps.clearContent).not.toHaveBeenCalled();
  });

  it('sends when text is empty but has attachments', async () => {
    const deps = makeDeps({ getText: () => '', hasAttachments: true, onSend: vi.fn() });
    await dispatchSendLogic(deps);
    expect(deps.onSend).toHaveBeenCalledWith('');
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.clearFiles).toHaveBeenCalledTimes(1);
  });

  it('clears editor for slash commands (onSend returns void)', async () => {
    const deps = makeDeps({ getText: () => '/clear', onSend: vi.fn() });
    await dispatchSendLogic(deps);
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.restoreContent).not.toHaveBeenCalled();
  });

  it('restores editor when workingDir is missing (simulated via return false)', async () => {
    const deps = makeDeps({
      getText: () => 'some user input',
      onSend: vi.fn(() => false),
    });
    await dispatchSendLogic(deps);
    expect(deps.onSend).toHaveBeenCalledWith('some user input');
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.restoreContent).toHaveBeenCalledTimes(1);
  });

  it('restores editor when API key is missing (simulated via return false)', async () => {
    const deps = makeDeps({
      getText: () => 'important message',
      onSend: vi.fn(() => false),
    });
    await dispatchSendLogic(deps);
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.restoreContent).toHaveBeenCalledTimes(1);
  });
});
