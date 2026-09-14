/**
 * Regression coverage for Plugin settings guest layout ownership and fresh-page lifecycle.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  dataOwnerId: 'owner-a' as string | null,
}));

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostSettingsWebview } from '../GhostSettingsWebview';
import {
  __resetGhostSettingsHeightCacheForTest,
  loadGhostSettingsHeight,
  saveGhostSettingsHeight,
} from '../ghostSettingsHeight';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

beforeEach(() => {
  authState.mode = 'cloud';
  authState.dataOwnerId = 'owner-a';
  localStorage.clear();
  __resetGhostSettingsHeightCacheForTest();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderSettings(settingsHeight?: number, measuredHeight?: number) {
  const capturePage = vi.fn();
  const executeJavaScript = vi
    .fn()
    .mockImplementation((script: unknown) =>
      Promise.resolve(
        measuredHeight !== undefined && String(script).includes('var bottom=r.bottom')
          ? measuredHeight
          : String(script).includes('scrolled:')
            ? { scrolled: false, dirty: false }
            : undefined,
      ),
    );
  const originalCreateElement = document.createElement.bind(document);

  vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    const element = originalCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'webview') {
      Object.assign(element, {
        executeJavaScript,
        insertCSS: vi.fn().mockResolvedValue('theme-css'),
        removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
        capturePage,
      });
    }
    return element;
  }) as typeof document.createElement);

  const ghost = {
    enabled: true,
    dir: '/tmp/example',
    manifest: {
      id: 'example-settings-layout',
      name: 'Example',
      version: '1.0.0',
      settingsHtml: 'settings.html',
      settingsHeight,
    },
  } as InstalledGhost;

  const view = render(<GhostSettingsWebview ghost={ghost} />);
  const webview = view.container.querySelector('webview');
  if (!webview) throw new Error('Expected settings webview');
  webview.dispatchEvent(new Event('dom-ready'));

  const host = view.container.querySelector<HTMLElement>('[data-ghost-webview]');
  if (!host) throw new Error('Expected settings webview host');

  return { capturePage, executeJavaScript, ghost, host, view, webview };
}

describe('GhostSettingsWebview layout ownership', () => {
  it('does not inject responsive width rules into fixed-height guests', async () => {
    const { executeJavaScript, host } = renderSettings(360);

    await waitFor(() => expect(executeJavaScript).toHaveBeenCalledWith('void 0'));
    expect(
      executeJavaScript.mock.calls.some(([script]) => String(script).includes('__xdt_settings_w')),
    ).toBe(false);
    expect(host.classList.contains('overflow-hidden')).toBe(false);
  });

  it('keeps responsive containment for auto-height guests', async () => {
    const { executeJavaScript, host } = renderSettings();

    await waitFor(() =>
      expect(
        executeJavaScript.mock.calls.some(([script]) =>
          String(script).includes('__xdt_settings_w'),
        ),
      ).toBe(true),
    );
    const responsiveScript = executeJavaScript.mock.calls
      .map(([script]) => String(script))
      .find((script) => script.includes('__xdt_settings_w'));
    expect(responsiveScript).toContain('box-sizing:border-box!important');
    expect(responsiveScript).toContain('min-width:0!important');
    expect(responsiveScript).toContain('max-width:100%!important');
    expect(host.classList.contains('overflow-hidden')).toBe(true);
  });

  it('recreates settings WebView when owner changes for the same ghostId', () => {
    const { ghost, view, webview: ownerAWebview } = renderSettings();

    authState.dataOwnerId = 'owner-b';
    view.rerender(<GhostSettingsWebview ghost={ghost} />);

    const ownerBWebview = view.container.querySelector('webview');
    expect(ownerBWebview).not.toBeNull();
    expect(ownerBWebview).not.toBe(ownerAWebview);
  });

  it('does not reuse owner A measured height for owner B first frame', async () => {
    const { ghost, host: ownerAHost, view } = renderSettings(undefined, 432);
    await waitFor(() => expect(ownerAHost.style.height).toBe('432px'));

    authState.dataOwnerId = 'owner-b';
    view.rerender(<GhostSettingsWebview ghost={ghost} />);

    const ownerBHost = view.container.querySelector<HTMLElement>('[data-ghost-webview]');
    expect(ownerBHost).not.toBeNull();
    expect(ownerBHost?.style.height).toBe('160px');
  });

  it.each([
    ['version', false], ['version', true], ['id', false], ['id', true],
  ] as const)('resets guest state when %s changes in place (cached: %s)', async (field, cached) => {
    const { ghost, host, view, webview } = renderSettings(undefined, 432);
    await waitFor(() => expect(host.style.height).toBe('432px'));
    const updated = {
      ...ghost,
      manifest: { ...ghost.manifest, [field]: field === 'version' ? '2.0.0' : 'another-plugin' },
    };
    if (cached) {
      saveGhostSettingsHeight('owner-a', updated.manifest.id, updated.manifest.version, 240);
    }

    view.rerender(<GhostSettingsWebview ghost={updated} />);

    expect(webview.isConnected).toBe(false);
    expect(view.container.querySelector('webview')).not.toBe(webview);
    // 新 guest 尚未 dom-ready，首帧也不能复用旧组件的高度。
    expect(view.container.querySelector<HTMLElement>('[data-ghost-webview]')?.style.height)
      .toBe(cached ? '240px' : '160px');
  });

  it('reopens a fresh guest with height-only spacing, without replaying or capturing old UI', async () => {
    vi.useFakeTimers();
    const legacyKey = 'ghostSettings.snapshot.v2.owner-a:example-settings-layout';
    localStorage.setItem(
      legacyKey,
      JSON.stringify({
        height: 432,
        version: '1.0.0',
        dataUrl: 'data:image/png;base64,stale-nickname-and-open-menu',
      }),
    );
    const { capturePage, ghost, host, view, webview } = renderSettings(undefined, 432);
    expect(host.style.height).toBe('432px');
    expect(host.querySelector('img')).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(capturePage).not.toHaveBeenCalled();
    view.unmount();

    const reopened = render(<GhostSettingsWebview ghost={ghost} />);
    const freshGuest = reopened.container.querySelector('webview');
    expect(freshGuest).not.toBe(webview);
    expect(webview.isConnected).toBe(false);
    expect(
      reopened.container.querySelector<HTMLElement>('[data-ghost-webview]')?.style.height,
    ).toBe('432px');
    expect(reopened.container.querySelector('img')).toBeNull();
    freshGuest?.dispatchEvent(new Event('dom-ready'));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(capturePage).not.toHaveBeenCalled();
  });

  it('does not persist an asynchronous measurement after its guest is unmounted', async () => {
    const { executeJavaScript, ghost, view } = renderSettings();
    let finishMeasurement!: (height: number) => void;
    const pendingHeight = new Promise<number>((resolve) => {
      finishMeasurement = resolve;
    });
    executeJavaScript.mockImplementation((script: unknown) =>
      String(script).includes('var bottom=r.bottom') ? pendingHeight : Promise.resolve(undefined),
    );
    await waitFor(() =>
      expect(
        executeJavaScript.mock.calls.some(([script]) =>
          String(script).includes('var bottom=r.bottom'),
        ),
      ).toBe(true),
    );
    view.unmount();
    await act(async () => {
      finishMeasurement(432);
    });
    expect(
      loadGhostSettingsHeight('owner-a', ghost.manifest.id, ghost.manifest.version),
    ).toBeNull();
  });
});
