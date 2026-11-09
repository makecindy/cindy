import { useEffect, useMemo, useRef } from 'react';
import { McpAppCard } from '@/components/chat/McpAppCard';
import { getApprovedGhostHostUi, type InstalledGhost } from '../../shared/ghost';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { pluginUiDraftSnapshot, pluginUiSelection, subscribePluginUiDraft } from './pluginUiContext';

/** All placements share the standard presenter and its visible-View lifetime. */
export function PluginUiView({ ghost, viewId, sessionId: requestedSessionId, input, context, onUnavailable }: {
  ghost: InstalledGhost; viewId: string; sessionId: string | null; context?: Record<string, unknown> | (() => Record<string, unknown>);
  input?: Record<string, unknown>;
  onUnavailable?(): void;
}) {
  const host = getApprovedGhostHostUi(ghost);
  const view = host?.views?.find(view => view.id === viewId);
  const sessionId = view?.scope === 'task' ? requestedSessionId : null;
  const instanceId = installedGhostStoragePart(ghost);
  const contextRef = useRef(context); contextRef.current = context;
  const inputRef = useRef(input); inputRef.current = input;
  const listeners = useRef(new Set<() => void>());
  useEffect(() => { for (const changed of listeners.current) changed(); }, [context, input]);
  const hasDraft = host?.capabilities?.includes('draft') === true;
  const hasContext = host?.capabilities?.includes('context') === true;
  const contextSource = useMemo(() => ({
    read: () => ({
      input: inputRef.current ?? {},
      ...(hasContext && sessionId !== null ? { context: { sessionId, ...(typeof contextRef.current === 'function' ? contextRef.current() : contextRef.current) }, selection: pluginUiSelection(sessionId) } : {}),
      ...(hasDraft && sessionId !== null ? { draft: pluginUiDraftSnapshot(sessionId) } : {}),
    }),
    subscribe(changed: () => void) {
      listeners.current.add(changed);
      const stopDraft = hasDraft && sessionId !== null ? subscribePluginUiDraft(sessionId, changed) : undefined;
      // No document listener is installed by capability declarations alone.
      let lastSelection = sessionId === null ? '' : pluginUiSelection(sessionId);
      const selection = () => {
        const next = sessionId === null ? '' : pluginUiSelection(sessionId);
        if (next !== lastSelection) { lastSelection = next; changed(); }
      };
      if (hasContext && sessionId !== null) document.addEventListener('selectionchange', selection);
      return () => { listeners.current.delete(changed); stopDraft?.(); document.removeEventListener('selectionchange', selection); };
    },
  }), [sessionId, hasContext, hasDraft]);
  if (!ghost.enabled || !view || ghost.uiCapabilityApproved !== true) return null;
  return <McpAppCard key={`${instanceId}:${viewId}:${ghost.approval.state === 'approved' ? ghost.approval.revision : ''}`}
    source={{ instanceId, viewId }} contextSource={contextSource} onUnavailable={onUnavailable}
    sessionId={view.scope === 'task' ? sessionId : null} clientId={`${instanceId}:${viewId}`}
    title={view.title} plugin={{ trust: ghost.trust?.level }} />;
}
