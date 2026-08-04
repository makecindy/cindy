// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_COMMENT_COMMAND_RESULT_CHANNEL,
  BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
  BROWSER_COMMENT_ENTER_MODE_CHANNEL,
  BROWSER_COMMENT_EXIT_MODE_CHANNEL,
  BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL,
  type BrowserCommentCommandEnvelope,
  type BrowserCommentCommandResult,
} from '../../shared/browserComment';

type IpcHandler = (event: unknown, payload: unknown) => void;

const ipcMocks = vi.hoisted(() => ({
  listeners: new Map<string, IpcHandler>(),
  sendToHost: vi.fn(),
}));

let latestOverlayShadow: ShadowRoot | null = null;

vi.mock('electron', () => ({
  ipcRenderer: {
    on: vi.fn((channel: string, handler: IpcHandler) => {
      ipcMocks.listeners.set(channel, handler);
    }),
    sendToHost: ipcMocks.sendToHost,
  },
}));

async function loadPreload(): Promise<void> {
  vi.resetModules();
  await import('../browserCommentPreload');
}

function dispatchCommand(command: string, envelope: BrowserCommentCommandEnvelope): void {
  const handler = ipcMocks.listeners.get(command);
  if (!handler) throw new Error(`missing preload handler: ${command}`);
  handler({}, envelope);
}

async function expectCommandResult(
  requestId: string,
  ok: boolean,
): Promise<BrowserCommentCommandResult> {
  await vi.waitFor(() => {
    expect(ipcMocks.sendToHost).toHaveBeenCalledWith(
      BROWSER_COMMENT_COMMAND_RESULT_CHANNEL,
      expect.objectContaining({ requestId, ok }),
    );
  });
  const match = ipcMocks.sendToHost.mock.calls.find(
    ([channel, result]) =>
      channel === BROWSER_COMMENT_COMMAND_RESULT_CHANNEL &&
      (result as BrowserCommentCommandResult).requestId === requestId,
  );
  return match?.[1] as BrowserCommentCommandResult;
}

describe('browserCommentPreload command protocol', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    ipcMocks.listeners.clear();
    ipcMocks.sendToHost.mockReset();
    latestOverlayShadow = null;
    const attachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      const shadow = attachShadow.call(this, init);
      latestOverlayShadow = shadow;
      return shadow;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acknowledges enter and exit only after the guest command succeeds', async () => {
    await loadPreload();

    dispatchCommand(BROWSER_COMMENT_ENTER_MODE_CHANNEL, {
      requestId: 'enter-1',
      payload: { markerNumber: 1 },
    });
    expect(await expectCommandResult('enter-1', true)).toMatchObject({
      command: BROWSER_COMMENT_ENTER_MODE_CHANNEL,
    });

    dispatchCommand(BROWSER_COMMENT_EXIT_MODE_CHANNEL, {
      requestId: 'exit-1',
    });
    expect(await expectCommandResult('exit-1', true)).toMatchObject({
      command: BROWSER_COMMENT_EXIT_MODE_CHANNEL,
    });
  });

  it('rejects malformed enter commands instead of silently entering a divergent state', async () => {
    await loadPreload();

    dispatchCommand(BROWSER_COMMENT_ENTER_MODE_CHANNEL, {
      requestId: 'enter-invalid',
      payload: { markerNumber: 0 },
    });

    expect(await expectCommandResult('enter-invalid', false)).toMatchObject({
      command: BROWSER_COMMENT_ENTER_MODE_CHANNEL,
    });
  });

  it('rejects screenshot preparation when there is no pending marker', async () => {
    await loadPreload();

    dispatchCommand(BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL, {
      requestId: 'prepare-without-pending',
      payload: { validMarkerNumbers: [] },
    });

    expect(await expectCommandResult('prepare-without-pending', false)).toMatchObject({
      command: BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL,
    });
  });

  it('keeps the transparent input blocker active while preparing a pending screenshot', async () => {
    const target = document.createElement('button');
    target.textContent = 'Save';
    document.body.appendChild(target);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [target]),
    });
    await loadPreload();

    dispatchCommand(BROWSER_COMMENT_ENTER_MODE_CHANNEL, {
      requestId: 'enter-for-prepare',
      payload: { markerNumber: 1 },
    });
    await expectCommandResult('enter-for-prepare', true);

    const blocker = latestOverlayShadow?.querySelector<HTMLElement>('.blocker');
    expect(blocker).not.toBeNull();
    blocker?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 30 }),
    );
    await vi.waitFor(() => {
      expect(ipcMocks.sendToHost).toHaveBeenCalledWith(
        BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
        expect.objectContaining({ markerNumber: 1 }),
      );
    });

    dispatchCommand(BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL, {
      requestId: 'prepare-pending',
      payload: { validMarkerNumbers: [] },
    });
    await expectCommandResult('prepare-pending', true);

    expect(blocker?.style.display).not.toBe('none');
    expect(latestOverlayShadow?.querySelector<HTMLElement>('.highlight')?.style.display).toBe(
      'none',
    );
    expect(latestOverlayShadow?.querySelector<HTMLElement>('.drag-rect')?.style.display).toBe(
      'none',
    );
  });
});
