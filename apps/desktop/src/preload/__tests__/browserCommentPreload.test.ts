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
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 80,
      bottom: 48,
      width: 70,
      height: 28,
      toJSON() {
        return {};
      },
    } as DOMRect);
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((elt: Element) => {
      const resolved = computedStyle(elt);
      if (elt !== target) return resolved;
      return new Proxy(resolved, {
        get(style, prop, receiver) {
          if (
            prop === 'borderTopLeftRadius' ||
            prop === 'borderTopRightRadius' ||
            prop === 'borderBottomRightRadius' ||
            prop === 'borderBottomLeftRadius'
          ) {
            return '12px';
          }
          return Reflect.get(style, prop, receiver);
        },
      });
    });
    blocker?.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 30 }),
    );
    const hoverChip = latestOverlayShadow?.querySelector<HTMLElement>('.hover-chip');
    expect(hoverChip?.style.display).toBe('flex');
    expect(hoverChip?.textContent).toContain('button');
    expect(hoverChip?.textContent).toContain('Save');
    expect(
      latestOverlayShadow?.querySelector<HTMLElement>('.highlight')?.style.borderRadius,
    ).toContain('12px');

    blocker?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 30 }),
    );
    await vi.waitFor(() => {
      expect(ipcMocks.sendToHost).toHaveBeenCalledWith(
        BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
        expect.objectContaining({
          markerNumber: 1,
          point: { x: 76, y: 24 },
        }),
      );
    });
    const marker = latestOverlayShadow?.querySelector<HTMLElement>('.marker.draft');
    expect(marker?.style.left).toBe('76px');
    expect(marker?.style.top).toBe('24px');

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
    expect(latestOverlayShadow?.querySelector<HTMLElement>('.hover-chip')?.style.display).toBe(
      'none',
    );
  });

  it('uses a comment cursor and switches to crosshair only while Shift is held', async () => {
    await loadPreload();
    dispatchCommand(BROWSER_COMMENT_ENTER_MODE_CHANNEL, {
      requestId: 'enter-cursor',
      payload: { markerNumber: 1 },
    });
    await expectCommandResult('enter-cursor', true);

    const blocker = latestOverlayShadow?.querySelector<HTMLElement>('.blocker');
    expect(blocker?.classList.contains('is-region')).toBe(false);
    expect(blocker?.classList.contains('is-pending')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    expect(blocker?.classList.contains('is-region')).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    expect(blocker?.classList.contains('is-region')).toBe(false);
  });
});
