import { useWallpaperBackground } from '../../../src/renderer/hooks/useWallpaperBackground';
import { Sidebar } from '../../../src/renderer/components/sidebar/Sidebar';
import { FeatureSidebarSlotProvider } from '../../../src/renderer/features/feature-context';
import { ctx, mountPage, subscription } from '../../ui-page/harness';

function Specimen() {
  const hidden = ctx.case === 'hidden';
  const peek = ctx.case === 'peek';
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
    {/* A neutral native-backdrop stand-in exposes missing paint without a real desktop. */}
    <div style={{ position: 'fixed', inset: 0, zIndex: -4, background: '#808080' }} />
    <div className="relative flex h-screen text-foreground">
      <Sidebar
        isCollapsed={hidden || peek}
        isRail={ctx.case === 'rail'}
        width={260}
        peekState={peek ? 'pinning' : null}
        peekDrawerProps={peek ? {
          'data-sidebar-peek-drawer': '',
          onMouseEnter: () => {},
          onMouseLeave: () => {},
        } : undefined}
      />
      <main className="bg-content-area min-w-0 flex-1 p-8">
        <p>Sidebar divider</p>
      </main>
    </div>
  </FeatureSidebarSlotProvider>;
}

void mountPage({
  host: {
    theme: { setSidebarWidth: () => {} },
    getFullscreenState: async () => false,
    onFullscreenChange: subscription('fullscreen'),
  },
  render: () => <Specimen />,
});
