import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, assertTrustedAppRendererEvent } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  assertTrustedAppRendererEvent: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent,
}));

import {
  RESOURCE_USAGE_WINDOW_CLOSE_CHANNEL,
  RESOURCE_USAGE_WINDOW_OPEN_CHANNEL,
  RESOURCE_USAGE_WINDOW_PRESENTATION_READY_CHANNEL,
  RESOURCE_USAGE_WINDOW_RENDERER_READY_CHANNEL,
} from '../../../shared/resourceUsageWindow.js';
import type { ResourceUsageWindowController } from '../controller.js';
import { registerResourceUsageWindowIpc } from '../ipc.js';

function makeController() {
  return {
    open: vi.fn(),
    close: vi.fn(),
    markRendererReady: vi.fn(),
    markPresentationReady: vi.fn(),
  } as unknown as ResourceUsageWindowController & {
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    markRendererReady: ReturnType<typeof vi.fn>;
    markPresentationReady: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  handlers.clear();
  assertTrustedAppRendererEvent.mockClear();
});

describe('resource-usage-window IPC', () => {
  it('guards and delegates open and close', () => {
    const controller = makeController();
    registerResourceUsageWindowIpc({ controller });
    const event = { sender: { id: 1 } };

    handlers.get(RESOURCE_USAGE_WINDOW_OPEN_CHANNEL)?.(event);
    handlers.get(RESOURCE_USAGE_WINDOW_CLOSE_CHANNEL)?.(event);

    expect(assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(1, event);
    expect(assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(2, event);
    expect(controller.open).toHaveBeenCalledWith(event.sender);
    expect(controller.close).toHaveBeenCalledWith(event.sender);
  });

  it('passes both Electron-owned readiness senders after the trusted-page guard', () => {
    const controller = makeController();
    registerResourceUsageWindowIpc({ controller });
    const sender = { id: 7 };
    const event = { sender };

    handlers.get(RESOURCE_USAGE_WINDOW_RENDERER_READY_CHANNEL)?.(event);
    handlers.get(RESOURCE_USAGE_WINDOW_PRESENTATION_READY_CHANNEL)?.(event);

    expect(assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(1, event);
    expect(assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(2, event);
    expect(controller.markRendererReady).toHaveBeenCalledWith(sender);
    expect(controller.markPresentationReady).toHaveBeenCalledWith(sender);
  });
});
