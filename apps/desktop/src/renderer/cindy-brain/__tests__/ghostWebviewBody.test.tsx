/** @vitest-environment jsdom */

import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../ghostPanelTheme', () => ({
  createGhostThemeInjector: () => ({
    inject: vi.fn(),
    onDomReady: vi.fn(),
    dispose: vi.fn(),
  }),
  observeHostTheme: () => vi.fn(),
}));

import { GhostWebviewBody } from '../ghostPanelBody';
import type { GhostManifest } from '../../../shared/ghost';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'workspace',
  name: 'Workspace',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  slots: ['main-view'],
  minCindyVersion: '1.2.3',
  mainView: { html: 'main-view.html' },
};

describe('GhostWebviewBody', () => {
  it('keeps the existing per-plugin partition and approved cindy-ghost entry shape', async () => {
    const { container } = render(
      <GhostWebviewBody ghost={{ manifest, dir: '/plugins/workspace' }} html={manifest.mainView?.html} />,
    );

    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull());
    const webview = container.querySelector('webview');
    expect(webview?.getAttribute('partition')).toBe('cindy-ghost-workspace');
    expect(webview?.getAttribute('src')).toBe('cindy-ghost://workspace/main-view.html');
    expect(webview?.hasAttribute('preload')).toBe(false);
  });

  it('shows the recoverable error state when the main document fails to load', async () => {
    const { container, getByRole } = render(
      <GhostWebviewBody ghost={{ manifest, dir: '/plugins/workspace' }} html={manifest.mainView?.html} />,
    );
    const webview = await waitFor(() => {
      const node = container.querySelector('webview');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });

    const event = new Event('did-fail-load') as Electron.DidFailLoadEvent;
    Object.defineProperties(event, {
      errorCode: { value: -6 },
      isMainFrame: { value: true },
    });
    fireEvent(webview, event);

    expect(getByRole('button', { name: 'settings.ghosts.panelError.reload' })).toBeTruthy();
    expect(container.querySelector('webview')).toBeNull();
  });

  it('ignores aborted navigation and subframe load failures', async () => {
    const { container, queryByRole } = render(
      <GhostWebviewBody ghost={{ manifest, dir: '/plugins/workspace' }} html={manifest.mainView?.html} />,
    );
    const webview = await waitFor(() => {
      const node = container.querySelector('webview');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });

    for (const [errorCode, isMainFrame] of [
      [-3, true],
      [-6, false],
    ] as const) {
      const event = new Event('did-fail-load') as Electron.DidFailLoadEvent;
      Object.defineProperties(event, {
        errorCode: { value: errorCode },
        isMainFrame: { value: isMainFrame },
      });
      fireEvent(webview, event);
    }

    expect(queryByRole('button', { name: 'settings.ghosts.panelError.reload' })).toBeNull();
    expect(container.querySelector('webview')).toBe(webview);
  });

  it('keeps in-place namespaced plugins on the original partition', async () => {
    const inPlace = {
      ...manifest,
      id: 'xd-feishu',
      settingsHtml: 'settings.html',
    } satisfies GhostManifest;
    const { container } = render(
      <GhostWebviewBody
        ghost={{ manifest: inPlace, namespace: 'xd', dir: '/userData/cindy-brain/xd-feishu' }}
        html={inPlace.settingsHtml}
      />,
    );
    const webview = await waitFor(() => {
      const node = container.querySelector('webview');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(webview.getAttribute('partition')).toBe('cindy-ghost-xd-feishu');
    expect(webview.getAttribute('src')).toBe('cindy-ghost://xd-feishu/settings.html');
  });

  it('uses the namespaced storage part when the install directory is under _ns', async () => {
    const orgManifest = { ...manifest, id: 'helper' } satisfies GhostManifest;
    const { container } = render(
      <GhostWebviewBody
        ghost={{ manifest: orgManifest, namespace: 'acme', dir: '/userData/cindy-brain/_ns/acme/helper' }}
        html={orgManifest.mainView?.html}
      />,
    );
    const webview = await waitFor(() => {
      const node = container.querySelector('webview');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(webview.getAttribute('partition')).toBe('cindy-ghost-_ns__acme__helper');
    expect(webview.getAttribute('src')).toBe('cindy-ghost://helper/main-view.html');
  });
});
