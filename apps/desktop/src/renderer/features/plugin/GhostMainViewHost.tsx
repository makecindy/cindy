import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useGhostMainViews } from '@/cindy-brain/ghostMainViews';
import { GhostPanelError, GhostWebviewBody } from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';

/** Route boundary that resolves only an approved, enabled manifest main-view entry. */
export function GhostMainViewHost() {
  const { ghostId = '' } = useParams<{ ghostId: string }>();
  const navigate = useNavigate();
  const { routeCapable } = useGhostMainViews();
  const item = routeCapable.find((candidate) => candidate.ghostId === ghostId);
  const runtimeState = useGhostRuntimeState(ghostId);

  useEffect(() => {
    if (!item) navigate('/plugins', { replace: true });
  }, [item, navigate]);

  if (!item) return <div className="h-full w-full bg-content-area" />;

  const { manifest } = item;
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  return (
    <section
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-content-area"
      aria-label={item.title}
    >
      {broken ? (
        <GhostPanelError manifest={manifest} state={runtimeState} />
      ) : (
        <GhostWebviewBody key={manifest.id} manifest={manifest} html={manifest.mainView?.html} />
      )}
    </section>
  );
}
