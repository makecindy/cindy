import { useRef, useState } from 'react';
import { ContentHeaderSlot } from '../../../src/renderer/components/layout/ContentHeader';
import { useSidebarResize } from '../../../src/renderer/hooks/useSidebarResize';
import { useWallpaperBackground } from '../../../src/renderer/hooks/useWallpaperBackground';
import { Sidebar } from '../../../src/renderer/components/sidebar/Sidebar';
import { FeatureSidebarSlotProvider, useOwnTopNavScrollableRows } from '../../../src/renderer/features/feature-context';
import { ctx, mountPage, subscription } from '../../ui-page/harness';

function InboxOwner() {
  useOwnTopNavScrollableRows(true);
  return null;
}

function EmptyRoute() {
  const containerRef = useRef<HTMLElement>(null);
  const [ownerVisible, setOwnerVisible] = useState(true);
  const top = ctx.case === 'empty-top';
  return <div className="flex min-w-0 flex-1" style={{ flexDirection: top ? 'column' : 'row' }}>
    {ownerVisible && ctx.case !== 'empty-direct' && <div data-owning-pane className="shrink-0 bg-sidebar"
      style={top ? { height: 120 } : { width: 100 }}>Adjacent pane</div>}
    <main ref={containerRef} data-empty-route className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-content-area">
      <ContentHeaderSlot containerRef={containerRef} sidebarVisible sidebarWidth={260}
        showCollapsedActions={false} isSidebarRail={false} rightSidebarAvailable={false}>
        <div data-full-page-content className="flex-1">Full-page route</div>
      </ContentHeaderSlot>
      <button data-ui-page-control data-toggle-owner onClick={() => setOwnerVisible(!ownerVisible)}>
        Toggle adjacent pane
      </button>
    </main>
  </div>;
}

function Specimen() {
  const hidden = ctx.case === 'hidden';
  const peek = ctx.case === 'peek' || ctx.case === 'inbox-peek';
  const draggable = ctx.case === 'inbox-resize';
  const [rail, setRail] = useState(false);
  const resize = useSidebarResize({ railMode: rail, onRailModeChange: setRail });
  const wallpaper = ctx.case === 'wallpaper';
  const visibility = ctx.case === 'transparent' ? 1 : wallpaper || ctx.case === 'half' ? 0.5 : 0;
  useWallpaperBackground({
    background: wallpaper ? 'linear-gradient(#808080, #808080)' : undefined,
    // Mirrors WallpaperSettingsProvider: 0% keeps the original backdrop.
    desktopBackground: !wallpaper && visibility > 0,
    visibility,
    blur: 0,
    reducedMotion: true,
  });
  return <FeatureSidebarSlotProvider isCollapsed={hidden}>
    {ctx.case.startsWith('inbox-') && <InboxOwner />}
    {/* A neutral native-backdrop stand-in exposes missing paint without a real desktop. */}
    <div style={{ position: 'fixed', inset: 0, zIndex: -4, background: '#808080' }} />
    <div className="relative flex h-screen text-foreground">
      <Sidebar
        isCollapsed={hidden || peek}
        isRail={ctx.case === 'rail' || rail}
        width={draggable ? resize.width : ctx.case === 'inbox-wide' ? 360 : 260}
        isDragging={draggable && resize.isDragging}
        onDragStart={draggable ? resize.handleDragStart : undefined}
        onResetWidth={draggable ? resize.resetWidth : undefined}
        peekState={peek ? 'pinning' : null}
        peekDrawerProps={peek ? {
          'data-sidebar-peek-drawer': '',
          onMouseEnter: () => {},
          onMouseLeave: () => {},
        } : undefined}
      />
      {ctx.case.startsWith('empty-') ? <EmptyRoute /> : <main className="bg-content-area min-w-0 flex-1 p-8">
        <p>Sidebar divider</p>
      </main>}
    </div>
  </FeatureSidebarSlotProvider>;
}

if (ctx.case.startsWith('inbox-')) {
  localStorage.setItem('sidebar-width', '260');
  localStorage.setItem('sidebar.taskListMode', 'tasks');
  localStorage.setItem('featureIntro.taskInbox.seen', '1');
}

const zoomed = ctx.case.startsWith('empty-') ||
  (ctx.case.startsWith('inbox-') && ctx.case !== 'inbox-normal');
const windowZoom = ctx.case === 'inbox-zoom-70' ? 0.7 : zoomed ? 0.5 : 1;

void mountPage({
  host: {
    appearanceSettings: {
      getSync: () => ({ windowZoom }),
      onChanged: subscription('appearance'),
    },
    theme: { setSidebarWidth: () => {} },
    getFullscreenState: async () => false,
    onFullscreenChange: subscription('fullscreen'),
  },
  render: () => <Specimen />,
});
