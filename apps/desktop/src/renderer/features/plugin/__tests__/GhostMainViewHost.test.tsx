/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  ghostId: 'workspace',
  routeCapable: [] as Array<Record<string, unknown>>,
  runtimeState: 'running',
  registerSidebar: vi.fn(),
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  dataOwnerId: 'owner-a' as string | null,
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ ghostId: mocks.ghostId }),
}));
vi.mock('@/cindy-brain/ghostMainViews', () => ({
  useGhostMainViews: () => ({ declared: [], routeCapable: mocks.routeCapable, sidebarVisible: [] }),
}));
vi.mock('@/cindy-brain/runtimeStates', () => ({
  useGhostRuntimeState: () => mocks.runtimeState,
}));
vi.mock('@/cindy-brain/ghostPanelBody', () => ({
  GhostWebviewBody: ({ html }: { html?: string }) => <div data-testid="webview">{html}</div>,
  GhostPanelError: ({ state }: { state: string }) => <div data-testid="error">{state}</div>,
}));
vi.mock('@/features/cc-agent/useRegisterCCAgentSidebar', () => ({
  useRegisterCCAgentSidebar: () => mocks.registerSidebar(),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: mocks.mode, dataOwnerId: mocks.dataOwnerId }),
}));

import { GhostMainViewFeatureLayout } from '../GhostMainViewFeatureLayout';
import { GhostMainViewHost } from '../GhostMainViewHost';

const manifest = {
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

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.registerSidebar.mockReset();
  mocks.ghostId = 'workspace';
  mocks.runtimeState = 'running';
  mocks.mode = 'cloud';
  mocks.dataOwnerId = 'owner-a';
  mocks.routeCapable = [
    {
      ghostId: 'workspace',
      title: 'Workspace',
      manifest,
      installedGhost: {
        manifest,
        dir: '/plugins/workspace',
        enabled: true,
        approval: { state: 'approved', revision: 'revision' },
      },
    },
  ];
});

describe('GhostMainViewHost', () => {
  it('loads only the entry resolved from the route-capable manifest', () => {
    render(<GhostMainViewHost />);
    expect(screen.getByTestId('webview').textContent).toBe('main-view.html');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('replaces an unavailable route with the Plugin page before mounting a webview', () => {
    mocks.routeCapable = [];
    render(<GhostMainViewHost />);
    expect(screen.queryByTestId('webview')).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith('/plugins', { replace: true });
  });

  it('unmounts the webview and replaces the route when capability is revoked in place', () => {
    const { rerender } = render(<GhostMainViewHost />);
    expect(screen.getByTestId('webview')).toBeTruthy();

    mocks.routeCapable = [];
    rerender(<GhostMainViewHost />);

    expect(screen.queryByTestId('webview')).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith('/plugins', { replace: true });
  });

  it.each(['crashed', 'fused'])('reuses the existing %s recovery state', (state) => {
    mocks.runtimeState = state;
    render(<GhostMainViewHost />);
    expect(screen.getByTestId('error').textContent).toBe(state);
    expect(screen.queryByTestId('webview')).toBeNull();
  });

  it('remounts the approved view after runtime recovery', () => {
    mocks.runtimeState = 'crashed';
    const { rerender } = render(<GhostMainViewHost />);
    expect(screen.getByTestId('error')).toBeTruthy();

    mocks.runtimeState = 'running';
    rerender(<GhostMainViewHost />);

    expect(screen.queryByTestId('error')).toBeNull();
    expect(screen.getByTestId('webview').textContent).toBe('main-view.html');
  });

  it('registers the shared CC Agent sidebar on cold main-view entry', () => {
    render(<GhostMainViewFeatureLayout />);
    expect(mocks.registerSidebar).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('webview')).toBeTruthy();
  });

  it('recreates the main-view host when the data owner changes', () => {
    const { rerender } = render(<GhostMainViewFeatureLayout />);
    const ownerAWebview = screen.getByTestId('webview');

    mocks.dataOwnerId = 'owner-b';
    rerender(<GhostMainViewFeatureLayout />);

    expect(screen.getByTestId('webview')).not.toBe(ownerAWebview);
  });
});
