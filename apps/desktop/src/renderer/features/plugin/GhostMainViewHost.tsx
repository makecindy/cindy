import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useGhostMainViews } from '@/cindy-brain/ghostMainViews';
import { GhostPanelError, GhostWebviewBody } from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';

/** Route boundary that resolves only an approved, enabled manifest main-view entry. */
export function GhostMainViewHost() {
  const { ghostId = '' } = useParams<{ ghostId: string }>();
  const navigate = useNavigate();
  const { routeCapable } = useGhostMainViews();
  const byInstance = routeCapable.find((candidate) => candidate.instanceId === ghostId);
  const byGhostId = routeCapable.filter((candidate) => candidate.ghostId === ghostId);
  const item = byInstance ?? (byGhostId.length === 1 ? byGhostId[0] : undefined);
  const runtimeState = useGhostRuntimeState(
    item ? item.instanceId : ghostId,
  );

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
      {broken ? (
        <GhostPanelError ghost={installedGhost} state={runtimeState} />
      ) : (
        <GhostWebviewBody key={installedGhostStoragePart(installedGhost)} ghost={installedGhost} html={manifest.mainView?.html} />
      )}
    </section>
  );
}
