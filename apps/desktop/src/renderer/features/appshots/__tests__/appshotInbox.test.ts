// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import type { AppshotCaptureResult } from '../../../../shared/appshots';
import { act, renderHook } from '@testing-library/react';
import { useAttachments } from '@/hooks/useAttachments';
import { getDraft } from '@/lib/composerDraftStore';
import {
  installAppshotInbox,
  routeAppshotCapture,
  toAppshotAttachment,
  appshotThumbnailLabel,
  canCaptureAppshotFromComposer,
  type AppshotRouteContext,
} from '../appshotInbox';

const result: AppshotCaptureResult = {
  captureId: 'capture-1',
  image: {
    url: 'xdt-image://session/capture-1.png',
    filename: 'Cindy — Draft.png',
    size: 1234,
    mimeType: 'image/png',
  },
  metadata: {
    schemaVersion: 1,
    captureId: 'capture-1',
    capturedAt: '2026-08-06T01:02:03.000Z',
    applicationName: 'Cindy',
    bundleIdentifier: 'com.xd.cindy',
    windowTitle: 'Draft',
    accessibilityText: 'Button: Send',
    accessibilityTruncated: false,
  },
};

function context(overrides: Partial<AppshotRouteContext> = {}): AppshotRouteContext {
  return {
    route: {
      writable: true,
      local: true,
      agentKind: 'codex',
      sessionId: 'session-1',
    },
    getDraft: vi.fn(() => ({
      text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] }] },
      attachments: [],
      quotes: [{ id: 'quote-1' } as never],
      browserComments: [{ id: 'comment-1' } as never],
    })),
    saveDraft: vi.fn(),
    patchDraft: vi.fn(),
    navigate: vi.fn(),
    ...overrides,
  };
}

describe('Appshot renderer inbox', () => {
  it('uses application and window title for Appshot thumbnail labels, with safe fallbacks', () => {
    expect(appshotThumbnailLabel(result.metadata, 'Window.png')).toBe('Cindy · Draft');
    expect(
      appshotThumbnailLabel({ ...result.metadata, windowTitle: null }, 'Window.png'),
    ).toBe('Cindy');
    expect(
      appshotThumbnailLabel({ ...result.metadata, applicationName: '' }, 'Window.png'),
    ).toBe('Draft');
  });

  it('only enables a composer capture for local unlocked macOS Codex contexts', () => {
    expect(
      canCaptureAppshotFromComposer({
        platform: 'darwin',
        sessionId: 'codex-session',
        runtimeAgentKind: 'codex',
        vendorKey: 'cc',
        remoteHostId: null,
        deviceLinkDeviceId: undefined,
        composerMutationLocked: false,
      }),
    ).toBe(true);
    expect(
      canCaptureAppshotFromComposer({
        platform: 'darwin',
        sessionId: 'claude-session',
        runtimeAgentKind: 'cc',
        vendorKey: 'codex',
        remoteHostId: null,
        deviceLinkDeviceId: undefined,
        composerMutationLocked: false,
      }),
    ).toBe(false);
    expect(
      canCaptureAppshotFromComposer({
        platform: 'darwin',
        sessionId: undefined,
        runtimeAgentKind: undefined,
        vendorKey: 'codex',
        remoteHostId: null,
        deviceLinkDeviceId: undefined,
        composerMutationLocked: false,
      }),
    ).toBe(true);
    expect(
      canCaptureAppshotFromComposer({
        platform: 'darwin',
        sessionId: 'codex-session',
        runtimeAgentKind: 'codex',
        vendorKey: 'codex',
        remoteHostId: 'ssh-1',
        deviceLinkDeviceId: undefined,
        composerMutationLocked: false,
      }),
    ).toBe(false);
  });

  it('keeps Appshot metadata while New Maker rehomes cached draft images', () => {
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'cc-agent', 'NewMakerDraftRoute.tsx'),
      'utf8',
    );
    const helper = source.slice(
      source.indexOf('async function rehomeDraftAttachments('),
      source.indexOf('function getCurrentRoutePath()'),
    );
    expect(helper).toContain('return { ...f, url: cached.url, base64: undefined };');
    expect(helper).toContain('return { ...f, url: meta.url };');
  });

  it('converts a managed capture into a normal image attachment with Appshot metadata', () => {
    expect(toAppshotAttachment(result)).toEqual({
      id: 'capture-1',
      name: 'Cindy — Draft.png',
      path: 'appshot://capture-1',
      ext: '.png',
      size: 1234,
      category: 'image',
      mimeType: 'image/png',
      url: 'xdt-image://session/capture-1.png',
      originalName: 'Cindy — Draft.png',
      appshot: result.metadata,
    });
  });

  it('adds a managed Appshot without recaching and deduplicates its capture id', () => {
    const { result: hook } = renderHook(() => useAttachments('session-appshot'));
    act(() => {
      hook.current.addAppshot(result);
      hook.current.addAppshot(result);
    });
    expect(hook.current.attachments).toEqual([
      expect.objectContaining({
        id: 'capture-1',
        path: 'appshot://capture-1',
        url: 'xdt-image://session/capture-1.png',
        appshot: result.metadata,
      }),
    ]);
    expect(getDraft('session-appshot')?.attachments).toEqual(hook.current.attachments);
  });

  it('appends to the current writable local Codex draft and preserves draft fields', async () => {
    const current = context();
    await routeAppshotCapture(result, current);

    expect(current.saveDraft).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        text: expect.any(Object),
        quotes: expect.any(Array),
        browserComments: expect.any(Array),
        attachments: [expect.objectContaining({ id: 'capture-1' })],
      }),
    );
    expect(current.navigate).not.toHaveBeenCalled();
  });

  it('falls back to a clean Codex New Maker draft for a non-Codex or non-local route', async () => {
    const current = context({
      route: {
        writable: true,
        local: false,
        agentKind: 'cc',
        sessionId: 'claude-session',
        remoteHostId: 'ssh-1',
        deviceLinkDeviceId: 'device-1',
      },
    });
    await routeAppshotCapture(result, current);

    expect(current.saveDraft).toHaveBeenCalledWith(
      '__new_maker_draft__',
      expect.objectContaining({
        attachments: [expect.objectContaining({ id: 'capture-1' })],
        text: expect.any(Object),
        quotes: expect.any(Array),
        browserComments: expect.any(Array),
      }),
    );
    expect(current.patchDraft).toHaveBeenCalledWith({
      vendor: 'codex',
      workingDir: null,
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
      extraDirs: [],
    });
    expect(current.navigate).toHaveBeenCalledWith('/cc-agent/new');
  });

  it('does not duplicate an Appshot already present in the draft', async () => {
    const current = context({
      getDraft: vi.fn(() => ({
        text: null,
        attachments: [toAppshotAttachment(result)],
      })),
    });
    await routeAppshotCapture(result, current);

    expect(current.saveDraft).not.toHaveBeenCalled();
  });

  it('routes before acknowledging, and leaves a failed capture pending', async () => {
    const order: string[] = [];
    const onCaptured = vi.fn();
    const api = {
      listPending: vi.fn(async () => [result]),
      onCaptured: vi.fn((callback: (value: AppshotCaptureResult) => void) => {
        onCaptured.mockImplementation(callback);
        return () => undefined;
      }),
      ack: vi.fn(async () => {
        order.push('ack');
        return { acknowledged: true };
      }),
    };
    const route = vi.fn(async () => {
      order.push('route');
    });
    const inbox = installAppshotInbox({ api, route });
    await inbox.ready;

    expect(order).toEqual(['route', 'ack']);
    expect(route).toHaveBeenCalledTimes(1);
    expect(api.ack).toHaveBeenCalledWith('capture-1');

    onCaptured(result);
    await inbox.flush();
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge when routing fails, so a later event can recover it', async () => {
    let attempts = 0;
    const api = {
      listPending: vi.fn(async () => []),
      onCaptured: vi.fn((callback: (value: AppshotCaptureResult) => void) => {
        api.callback = callback;
        return () => undefined;
      }),
      ack: vi.fn(async () => ({ acknowledged: true })),
      callback: undefined as ((value: AppshotCaptureResult) => void) | undefined,
    };
    const route = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('draft write failed');
    });
    const inbox = installAppshotInbox({ api, route });
    await inbox.ready;
    api.callback?.(result);
    await inbox.flush();
    expect(api.ack).not.toHaveBeenCalled();
    api.callback?.(result);
    await inbox.flush();
    expect(api.ack).toHaveBeenCalledWith('capture-1');
  });

  it('keeps a capture pending when the Main ack reports that it was not acknowledged', async () => {
    let acknowledge = false;
    const api = {
      listPending: vi.fn(async () => []),
      onCaptured: vi.fn((callback: (value: AppshotCaptureResult) => void) => {
        api.callback = callback;
        return () => undefined;
      }),
      ack: vi.fn(async () => ({ acknowledged: acknowledge })),
      callback: undefined as ((value: AppshotCaptureResult) => void) | undefined,
    };
    const inbox = installAppshotInbox({
      api,
      route: vi.fn(async () => true),
    });
    await inbox.ready;
    api.callback?.(result);
    await inbox.flush();
    expect(api.ack).toHaveBeenCalledTimes(1);
    acknowledge = true;
    api.callback?.(result);
    await inbox.flush();
    expect(api.ack).toHaveBeenCalledTimes(2);
  });
});
