import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppshotCaptureResult } from '../../../shared/appshots.js';
import { AppshotCaptureError } from '../coordinator.js';
import {
  createAppshotPublisher,
  registerAppshotIpc,
  type AppshotIpcCoordinator,
  type AppshotIpcMain,
} from '../ipc.js';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const result: AppshotCaptureResult = {
  captureId: 'capture-1',
  image: {
    url: 'cindy-media://blobs/example.png',
    filename: 'example.png',
    size: 9,
    mimeType: 'image/png',
  },
  metadata: {
    schemaVersion: 1,
    captureId: 'capture-1',
    capturedAt: '2026-08-06T01:02:03.000Z',
    applicationName: 'Example App',
    bundleIdentifier: null,
    windowTitle: null,
    accessibilityText: null,
    accessibilityTruncated: false,
  },
};

function createHarness() {
  const handlers = new Map<string, Handler>();
  const order: string[] = [];
  const coordinator: AppshotIpcCoordinator = {
    capture: vi.fn(async () => result),
    listPending: vi.fn(() => [result]),
    ack: vi.fn(() => true),
  };
  const ipcMain: AppshotIpcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
  };
  const assertTrustedSender = vi.fn((event: unknown) => {
    order.push('trusted');
    if (event === 'untrusted') throw new Error('[PERMISSION_DENIED] untrusted');
  });
  registerAppshotIpc({ ipcMain, coordinator, assertTrustedSender });
  return { handlers, coordinator, assertTrustedSender, order };
}

function handler(harness: ReturnType<typeof createHarness>, channel: string): Handler {
  const registered = harness.handlers.get(channel);
  if (!registered) throw new Error(`missing handler ${channel}`);
  return registered;
}

describe('Appshot Main IPC boundary', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('registers all local appshot handlers', () => {
    expect([...harness.handlers.keys()]).toEqual([
      'appshots:capture',
      'appshots:list-pending',
      'appshots:ack',
    ]);
  });

  it.each([
    ['appshots:capture', ['extra']],
    ['appshots:list-pending', ['extra']],
    ['appshots:ack', []],
    ['appshots:ack', ['capture-1', 'extra']],
  ])('checks trusted sender before validating arguments for %s', async (channel, args) => {
    await expect(handler(harness, channel)('untrusted', ...args)).rejects.toThrow(
      '[PERMISSION_DENIED] untrusted',
    );
    expect(harness.assertTrustedSender).toHaveBeenCalledTimes(1);
  });

  it('rejects extra capture and list arguments without invoking the coordinator', async () => {
    await expect(handler(harness, 'appshots:capture')('trusted', 'extra')).rejects.toThrow(
      '[INVALID_PARAMS]',
    );
    await expect(handler(harness, 'appshots:list-pending')('trusted', 'extra')).rejects.toThrow(
      '[INVALID_PARAMS]',
    );
    expect(harness.coordinator.capture).not.toHaveBeenCalled();
    expect(harness.coordinator.listPending).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ['capture-1', 'extra'],
    [''],
    ['   '],
    ['x'.repeat(257)],
    [42],
  ])('rejects malformed ack arguments %#', async (...args: unknown[]) => {
    await expect(handler(harness, 'appshots:ack')('trusted', ...args)).rejects.toThrow(
      '[INVALID_PARAMS]',
    );
    expect(harness.coordinator.ack).not.toHaveBeenCalled();
  });

  it('captures successfully and maps stable failures without exposing raw errors', async () => {
    await expect(handler(harness, 'appshots:capture')('trusted')).resolves.toEqual({ accepted: true });
    vi.mocked(harness.coordinator.capture).mockRejectedValueOnce(
      Object.assign(new Error('secret native detail'), { code: 'no-window' }),
    );

    const rejection = (handler(harness, 'appshots:capture')('trusted') as Promise<unknown>)
      .catch((error: unknown) => error);
    await expect(rejection).resolves.toMatchObject({ message: '[INTERNAL] Appshot capture failed: no-window' });
    await expect(rejection).resolves.not.toMatchObject({ message: expect.stringContaining('secret') });
  });

  it('maps capture-in-progress to PRECONDITION_FAILED', async () => {
    vi.mocked(harness.coordinator.capture).mockRejectedValueOnce(
      new AppshotCaptureError('capture-in-progress'),
    );

    await expect(handler(harness, 'appshots:capture')('trusted')).rejects.toThrow(
      '[PRECONDITION_FAILED] Appshot capture failed: capture-in-progress',
    );
  });

  it('returns defensive pending data and acknowledges one validated capture id', async () => {
    const listed = await handler(harness, 'appshots:list-pending')('trusted') as AppshotCaptureResult[];
    listed[0].metadata.applicationName = 'mutated';
    listed[0].image.filename = 'mutated.png';
    expect(result.metadata.applicationName).toBe('Example App');
    expect(result.image.filename).toBe('example.png');

    await expect(handler(harness, 'appshots:ack')('trusted', 'capture-1')).resolves.toEqual({
      acknowledged: true,
    });
    expect(harness.coordinator.ack).toHaveBeenCalledWith('capture-1');
  });
});

describe('Appshot outbound publisher', () => {
  it('sends only to a live trusted main window and focuses after send', () => {
    const order: string[] = [];
    const win = { isDestroyed: () => false };
    const publish = createAppshotPublisher({
      getMainWindow: () => win,
      isTrustedWindow: () => true,
      send: (_window, channel, payload) => {
        expect(channel).toBe('appshots:captured');
        expect(payload).toEqual(result);
        order.push('send');
      },
      focus: () => order.push('focus'),
    });

    publish(result);
    expect(order).toEqual(['send', 'focus']);
  });

  it.each([
    ['missing', null, true],
    ['destroyed', { isDestroyed: () => true }, true],
    ['untrusted', { isDestroyed: () => false }, false],
  ])('does not send or focus for a %s window', (_label, win, trusted) => {
    const send = vi.fn();
    const focus = vi.fn();
    const publish = createAppshotPublisher({
      getMainWindow: () => win,
      isTrustedWindow: () => trusted,
      send,
      focus,
    });

    publish(result);
    expect(send).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not focus when outbound send fails', () => {
    const focus = vi.fn();
    const publish = createAppshotPublisher({
      getMainWindow: () => ({ isDestroyed: () => false }),
      isTrustedWindow: () => true,
      send: () => { throw new Error('renderer unavailable'); },
      focus,
    });

    expect(() => publish(result)).toThrow('renderer unavailable');
    expect(focus).not.toHaveBeenCalled();
  });
});
