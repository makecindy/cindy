/**
 * Regression coverage for Plugin settings guest layout ownership.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostSettingsWebview } from '../GhostSettingsWebview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function renderSettings(settingsHeight?: number) {
  const executeJavaScript = vi.fn().mockResolvedValue(undefined);
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
        capturePage: vi.fn(),
      });
    }
    return element;
  }) as typeof document.createElement);

  const ghost = {
    enabled: true,
    dir: '/tmp/example',
    manifest: {
      id: 'example.settings-layout',
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

  return { executeJavaScript, host };
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
});
