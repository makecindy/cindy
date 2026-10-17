/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../../shared/ghost';
import { CONTENT_HEADER_HEIGHT_PX, ContentHeaderSlot } from '@/components/layout/ContentHeader';
import { FeatureSidebarSlotProvider } from '@/features/feature-context';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  ghostId: 'workspace',
  routeCapable: [] as Array<Record<string, unknown>>,
  runtimeState: 'running',
  registerSidebar: vi.fn(),
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  dataOwnerId: 'owner-a' as string | null,
  isMac: true,
  isFullscreen: false,
}));

vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => ({ isMac: mocks.isMac, isFullscreen: mocks.isFullscreen }),
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
  GhostWebviewBody: ({ html, ghost }: { html?: string; ghost: InstalledGhost }) => (
    <div data-testid="webview" data-dir={ghost.dir}>{html}</div>
  ),
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

function HeaderSlotView({
  sidebarVisible = true,
  isSidebarRail = false,
  rightSidebarAvailable = false,
}: {
  sidebarVisible?: boolean;
  isSidebarRail?: boolean;
  rightSidebarAvailable?: boolean;
} = {}) {
  return (
    <FeatureSidebarSlotProvider isCollapsed={!sidebarVisible}>
      <ContentHeaderSlot
        sidebarVisible={sidebarVisible}
        showCollapsedActions={!sidebarVisible}
        isSidebarRail={isSidebarRail}
        rightSidebarAvailable={rightSidebarAvailable}
      >
        <GhostMainViewHost />
      </ContentHeaderSlot>
    </FeatureSidebarSlotProvider>
  );
}

function renderInHeaderSlot(options: Parameters<typeof HeaderSlotView>[0] = {}) {
  return render(<HeaderSlotView {...options} />);
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.registerSidebar.mockReset();
  mocks.ghostId = 'workspace';
  mocks.runtimeState = 'running';
  mocks.mode = 'cloud';
  mocks.dataOwnerId = 'owner-a';
  mocks.isMac = true;
  mocks.isFullscreen = false;
  mocks.routeCapable = [
    {
      ghostId: 'workspace',
      instanceId: 'workspace',
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

  // Production entry: ContentHeaderSlot + routed GhostMainViewHost. Electron uses
  // WebkitAppRegion to register drag rectangles; a second band beneath a visible
  // header reserves an unwanted blank row. Fullscreen needs no drag owner.
  // The previous host test rendered without the shell and missed that visible-header case.
  // Minimal unit matrix: mac expanded/hidden, Windows visible, mac collapsed or rail,
  // mac with the right sidebar toggle keeping the header visible, and mac fullscreen.
  it.each([
    {
      name: 'mac expanded',
      isMac: true,
      sidebarVisible: true,
      isSidebarRail: false,
      rightSidebarAvailable: false,
      dragOwner: 'band',
    },
    {
      name: 'Windows expanded',
      isMac: false,
      sidebarVisible: true,
      isSidebarRail: false,
      rightSidebarAvailable: false,
      dragOwner: 'header',
    },
    {
      name: 'mac collapsed',
      isMac: true,
      sidebarVisible: false,
      isSidebarRail: false,
      rightSidebarAvailable: false,
      dragOwner: 'header',
    },
    {
      name: 'mac rail',
      isMac: true,
      sidebarVisible: false,
      isSidebarRail: true,
      rightSidebarAvailable: false,
      dragOwner: 'header',
    },
    {
      name: 'mac right sidebar',
      isMac: true,
      sidebarVisible: true,
      isSidebarRail: false,
      rightSidebarAvailable: true,
      dragOwner: 'header',
    },
    {
      name: 'mac fullscreen expanded',
      isMac: true,
      isFullscreen: true,
      sidebarVisible: true,
      isSidebarRail: false,
      rightSidebarAvailable: false,
      dragOwner: 'none',
    },
  ])(
    'uses the expected top window drag owner for $name',
    ({ isMac, isFullscreen, sidebarVisible, isSidebarRail, rightSidebarAvailable, dragOwner }) => {
      mocks.isMac = isMac;
      mocks.isFullscreen = isFullscreen ?? false;
      const { container } = renderInHeaderSlot({
        sidebarVisible,
        isSidebarRail,
        rightSidebarAvailable,
      });
      const header = container.querySelector('header');
      const band = screen.queryByTestId('ghost-main-view-drag-band');
      const owners = [header, band].filter((owner): owner is HTMLElement => owner != null);

      expect(header !== null).toBe(dragOwner === 'header');
      expect(band !== null).toBe(dragOwner === 'band');
      expect(owners).toHaveLength(dragOwner === 'none' ? 0 : 1);
      if (owners[0]) {
        expect(
          (owners[0].style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion,
        ).toBe('drag');
      }
      if (band) {
        expect(band.getAttribute('aria-hidden')).toBe('true');
        // The replacement reserves the same row height before the webview.
        expect(band.style.height).toBe(`${CONTENT_HEADER_HEIGHT_PX}px`);
        expect(band.nextElementSibling).toBe(screen.getByTestId('webview'));
      }
      if (dragOwner === 'none') {
        // A fullscreen window cannot be dragged; the webview should reach the top.
        const webview = screen.getByTestId('webview');
        expect(webview.parentElement?.firstElementChild).toBe(webview);
      }
    },
  );

  it('removes and restores the drag band as mac fullscreen changes in place', () => {
    const { rerender } = renderInHeaderSlot();
    const webview = screen.getByTestId('webview');
    expect(screen.getByTestId('ghost-main-view-drag-band').nextElementSibling).toBe(webview);

    mocks.isFullscreen = true;
    rerender(<HeaderSlotView />);
    expect(screen.queryByTestId('ghost-main-view-drag-band')).toBeNull();
    expect(webview.parentElement?.firstElementChild).toBe(webview);

    mocks.isFullscreen = false;
    rerender(<HeaderSlotView />);
    expect(screen.getByTestId('ghost-main-view-drag-band').nextElementSibling).toBe(webview);
  });

  it('replaces an unavailable route with the Plugin page before mounting a webview', () => {
    mocks.routeCapable = [];
    render(<GhostMainViewHost />);
    expect(screen.queryByTestId('webview')).toBeNull();
    expect(screen.queryByTestId('ghost-main-view-drag-band')).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith('/plugins', { replace: true });
  });

  it('does not resolve an absent physical route to a same-name organization instance', () => {
    mocks.routeCapable = [{
      ghostId: 'workspace',
      instanceId: '_ns__acme__workspace',
      title: 'Organization Workspace',
      manifest,
      installedGhost: {
        manifest,
        namespace: 'acme',
        dir: '/plugins/_ns/acme/workspace',
        enabled: true,
        approval: { state: 'approved', revision: 'organization-revision' },
      },
    }];
    render(<GhostMainViewHost />);

    expect(screen.queryByTestId('webview')).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith('/plugins', { replace: true });
  });

  it('leaves the route when its original instance is disabled instead of switching to its twin', () => {
    const organization = {
      ghostId: 'workspace',
      instanceId: '_ns__acme__workspace',
      title: 'Organization Workspace',
      manifest,
      installedGhost: {
        manifest,
        namespace: 'acme',
        dir: '/plugins/_ns/acme/workspace',
        enabled: true,
        approval: { state: 'approved', revision: 'organization-revision' },
      },
    };
    mocks.routeCapable.push(organization);
    const { rerender } = render(<GhostMainViewHost />);
    expect(screen.getByTestId('webview').getAttribute('data-dir')).toBe('/plugins/workspace');

    mocks.routeCapable = [organization];
    rerender(<GhostMainViewHost />);

    expect(screen.queryByTestId('webview')).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith('/plugins', { replace: true });
  });

  it.each([
    ['workspace', 'acme', '/plugins/workspace'],
    ['_ns__acme__workspace', 'acme', '/plugins/_ns/acme/workspace'],
    ['_root__workspace', null, '/plugins/_ns/_root/workspace'],
  ] as const)('opens the physical route %s without changing its namespace', (instanceId, namespace, dir) => {
    mocks.ghostId = instanceId;
    mocks.routeCapable = [{
      ghostId: 'workspace',
      instanceId,
      title: 'Workspace',
      manifest,
      installedGhost: { manifest, namespace, dir, enabled: true,
        approval: { state: 'approved', revision: 'revision' } },
    }];
    render(<GhostMainViewHost />);

    expect(screen.getByTestId('webview').getAttribute('data-dir')).toBe(dir);
    expect(mocks.navigate).not.toHaveBeenCalled();
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
    renderInHeaderSlot();
    const band = screen.getByTestId('ghost-main-view-drag-band');
    const error = screen.getByTestId('error');
    expect(band.parentElement).toBe(error.parentElement);
    expect(band.nextElementSibling).toBe(error);
    expect(error.textContent).toBe(state);
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
