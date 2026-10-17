import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useGhostMainViews } from '@/cindy-brain/ghostMainViews';
import { GhostPanelError, GhostWebviewBody } from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import {
  CONTENT_HEADER_HEIGHT_PX,
  useIsContentHeaderHidden,
} from '@/components/layout/ContentHeader';
import { WINDOW_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';

/** Route boundary that resolves only an approved, enabled manifest main-view entry. */
export function GhostMainViewHost() {
  const { ghostId = '' } = useParams<{ ghostId: string }>();
  const navigate = useNavigate();
  const { routeCapable } = useGhostMainViews();
  const item = routeCapable.find((candidate) => candidate.instanceId === ghostId);
  const runtimeState = useGhostRuntimeState(
    item ? item.instanceId : ghostId,
  );
  const isContentHeaderHidden = useIsContentHeaderHidden();
  const { isFullscreen } = useMacFullscreen();

  useEffect(() => {
    if (!item) navigate('/plugins', { replace: true });
  }, [item, navigate]);

  if (!item) return <div className="h-full w-full bg-content-area" />;

  const { manifest, installedGhost } = item;
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  return (
    <section
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-content-area"
      aria-label={item.title}
    >
      {/* Replace a hidden header's drag area only outside fullscreen. A fullscreen
          window cannot be dragged, and the band would waste webview height.
          The shared header owns rail no-drag holes. */}
      {isContentHeaderHidden && !isFullscreen && (
        <div
          aria-hidden="true"
          data-testid="ghost-main-view-drag-band"
          className="shrink-0"
          style={{ height: CONTENT_HEADER_HEIGHT_PX, ...WINDOW_DRAG_STYLE }}
        />
      )}
      {broken ? (
        <GhostPanelError ghost={installedGhost} state={runtimeState} />
      ) : (
        <GhostWebviewBody key={installedGhostStoragePart(installedGhost)} ghost={installedGhost} html={manifest.mainView?.html} />
      )}
    </section>
  );
}
