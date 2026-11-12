// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_COMMENT_COMMAND_RESULT_CHANNEL,
  BROWSER_COMMENT_CANCEL_PENDING_CHANNEL,
  BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
  BROWSER_COMMENT_ENTER_MODE_CHANNEL,
  BROWSER_COMMENT_EXIT_MODE_CHANNEL,
  BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL,
  type BrowserCommentCommandEnvelope,
  type BrowserCommentCommandResult,
} from '../../shared/browserComment';

import '../browserCommentPreload';

type IpcHandler = (event: unknown, payload: unknown) => void;

const ipcMocks = vi.hoisted(() => ({
  listeners: new Map<string, IpcHandler>(),
  sendToHost: vi.fn(),
}));

let latestOverlayShadow: ShadowRoot | null = null;
const originalElementsFromPoint = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');

vi.mock('electron', () => ({
  ipcRenderer: {
    on: vi.fn((channel: string, handler: IpcHandler) => {
      ipcMocks.listeners.set(channel, handler);
    }),
    sendToHost: ipcMocks.sendToHost,
  },
}));

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
    ipcMocks.sendToHost.mockReset();
    latestOverlayShadow = null;
    window.getSelection()?.removeAllRanges();
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

  afterEach(async () => {
    // Keep the preload's IPC registration for the file, but dispose each mode
    // through the same command used by the browser host before restoring spies.
    dispatchCommand(BROWSER_COMMENT_EXIT_MODE_CHANNEL, { requestId: 'cleanup-mode' });
    await expectCommandResult('cleanup-mode', true);
    expect(latestOverlayShadow?.host.isConnected ?? false).toBe(false);
    document.body.replaceChildren();
    if (originalElementsFromPoint) {
      Object.defineProperty(document, 'elementsFromPoint', originalElementsFromPoint);
    } else {
      Reflect.deleteProperty(document, 'elementsFromPoint');
    }
    vi.restoreAllMocks();
  });

  it('acknowledges enter and exit only after the guest command succeeds', async () => {
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
    dispatchCommand(BROWSER_COMMENT_ENTER_MODE_CHANNEL, {
      requestId: 'enter-invalid',
      payload: { markerNumber: 0 },
    });

    expect(await expectCommandResult('enter-invalid', false)).toMatchObject({
      command: BROWSER_COMMENT_ENTER_MODE_CHANNEL,
    });
  });

  it('rejects screenshot preparation when there is no pending marker', async () => {
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

  // #9639: enter-mode must leave an input surface and visible annotations even
  // when the page rejects inline stylesheets. jsdom cannot enforce CSP or hit
  // testing; remove the stylesheet here and check the production DOM/CSSOM path.
  // Real Chromium geometry, CSP and trusted mouse input are tested separately.
  it('keeps selection and cancellation usable without an inline stylesheet', async () => {
    const target = document.createElement('button');
    target.textContent = 'Save';
    document.body.appendChild(target);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [target]),
    });
    dispatchCommand(BROWSER_COMMENT_ENTER_MODE_CHANNEL, {
      requestId: 'enter-without-stylesheet', payload: { markerNumber: 1 },
    });
    await expectCommandResult('enter-without-stylesheet', true);
    latestOverlayShadow?.querySelectorAll('style').forEach((style) => style.remove());
    const blocker = latestOverlayShadow!.querySelector<HTMLElement>('.blocker')!;
    expect(getComputedStyle(blocker).position).toBe('fixed');
    expect(getComputedStyle(blocker).pointerEvents).toBe('auto');

    blocker.dispatchEvent(new MouseEvent('click', { clientX: 20, clientY: 30 }));
    expect(ipcMocks.sendToHost).toHaveBeenCalledWith(
      BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
      expect.objectContaining({ kind: 'element', targetLabel: 'Save' }),
    );
    const marker = latestOverlayShadow!.querySelector<HTMLElement>('.marker')!;
    expect(getComputedStyle(marker).position).toBe('absolute');
    expect(getComputedStyle(marker).width).toBe('22px');
    dispatchCommand(BROWSER_COMMENT_CANCEL_PENDING_CHANNEL, { requestId: 'cancel-without-stylesheet' });
    await expectCommandResult('cancel-without-stylesheet', true);
    expect(marker.isConnected).toBe(false);
    expect(getComputedStyle(blocker).cursor).toBe('crosshair');
    blocker.dispatchEvent(new MouseEvent('mousedown', { shiftKey: true, clientX: 20, clientY: 30 }));
    blocker.dispatchEvent(new MouseEvent('mousemove', { shiftKey: true, clientX: 80, clientY: 90 }));
    blocker.dispatchEvent(new MouseEvent('mouseup', { shiftKey: true, clientX: 80, clientY: 90 }));
    const box = latestOverlayShadow!.querySelector<HTMLElement>('.region-box')!;
    expect(getComputedStyle(box).position).toBe('absolute');
    expect(getComputedStyle(box).width).toBe('60px');
    expect(ipcMocks.sendToHost).toHaveBeenCalledWith(
      BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
      expect.objectContaining({ kind: 'region', region: { x: 20, y: 30, width: 60, height: 60 } }),
    );
  });
});
