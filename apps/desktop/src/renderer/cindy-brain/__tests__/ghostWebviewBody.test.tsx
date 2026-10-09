/** @vitest-environment jsdom */

import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => vi.unstubAllGlobals());

  it.each(['panel.html', 'main-view.html'])('recreates %s on a same-version receipt replacement', (html) => {
    const ghost = { manifest, dir: '/plugins/workspace', approval: { state: 'approved' as const, revision: 'receipt-a' } };
    const { container, rerender } = render(<GhostWebviewBody ghost={ghost} html={html} />);
    const original = container.querySelector('webview');
    rerender(<GhostWebviewBody ghost={{ ...ghost, approval: { state: 'approved', revision: 'receipt-b' } }} html={html} />);
    const replacement = container.querySelector('webview');
    expect(replacement).not.toBe(original);
    expect(original?.isConnected).toBe(false);
    expect(replacement?.getAttribute('src')).toBe('cindy-ghost://workspace/' + html);
    rerender(<GhostWebviewBody ghost={{ ...ghost, approval: { state: 'approved', revision: 'receipt-b' } }} html={html} />);
    expect(container.querySelector('webview')).toBe(replacement);
  });

  it.each([
    ['/plugins/workspace', undefined, 'workspace'],
    ['/plugins/workspace', null, 'workspace'],
    ['/plugins/workspace', 'acme', 'workspace'],
    ['/plugins/_ns/acme/workspace', 'acme', '_ns__acme__workspace'],
  ] as const)('passes the physical instance for context menus at %s', async (dir, namespace, instanceId) => {
    const resolvePanelMedia = vi.fn(async () => { throw new Error('not-owned'); });
    vi.stubGlobal('electronAPI', { ghosts: { resolvePanelMedia } });
    const { container } = render(
      <GhostWebviewBody ghost={{ manifest, dir, ...(namespace === undefined ? {} : { namespace }) }} html={manifest.mainView?.html} />,
    );
    const webview = container.querySelector('webview') as HTMLElement;
    const uri = 'cindy-ghost://workspace/media/' + 'a'.repeat(64) + '.png';
    const event = new Event('context-menu');
    Object.defineProperty(event, 'params', { value: { mediaType: 'image', srcURL: uri, x: 10, y: 20 } });
    fireEvent(webview, event);
    await waitFor(() => expect(resolvePanelMedia).toHaveBeenCalledExactlyOnceWith(uri, 'menu', instanceId));
  });

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

  it('isolates an in-place namespaced plugin from a later root partition', async () => {
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
    expect(webview.getAttribute('partition')).toBe('cindy-ghost-_ns__xd__xd-feishu');
    expect(webview.getAttribute('src')).toBe('cindy-ghost://xd-feishu/settings.html');
  });

  it('remounts a live panel when an in-place install gains a namespace', async () => {
    const root = { manifest, dir: '/plugins/workspace' };
    const { container, rerender } = render(
      <GhostWebviewBody ghost={root} html={manifest.mainView?.html} />,
    );
    const previous = container.querySelector('webview');
    expect(previous?.getAttribute('partition')).toBe('cindy-ghost-workspace');

    rerender(<GhostWebviewBody ghost={{ ...root, namespace: 'acme' }} html={manifest.mainView?.html} />);
    const current = container.querySelector('webview');
    expect(current).not.toBe(previous);
    expect(current?.getAttribute('partition')).toBe('cindy-ghost-_ns__acme__workspace');
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
