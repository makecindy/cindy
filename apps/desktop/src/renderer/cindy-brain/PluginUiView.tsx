import { useEffect, useMemo, useRef } from 'react';
import { McpAppCard } from '@/components/chat/McpAppCard';
import { getApprovedGhostHostUi, type InstalledGhost } from '../../shared/ghost';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { pluginUiSelection } from './pluginUiContext';
import { getStreamingMarkdownThrottleInterval } from '@/components/chat/streamingMarkdownChunks';

// Compare the projected envelope/message fields by value without serializing body strings.
function sameContext(left: unknown, right: unknown, depth = 1): boolean {
  if (Object.is(left, right)) return true;
  if (depth < 0 || !left || !right || typeof left !== 'object' || typeof right !== 'object' ||
    Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) &&
    sameContext((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth - 1));
}

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
  const hasContext = host?.capabilities?.includes('context') === true;
  const contextSource = useMemo(() => ({
    read: () => ({
      input: inputRef.current ?? {},
      ...(hasContext && sessionId !== null ? { context: { sessionId, ...(typeof contextRef.current === 'function' ? contextRef.current() : contextRef.current) }, selection: pluginUiSelection(sessionId) } : {}),
    }),
    subscribe(changed: () => void) {
      const context = () => hasContext && sessionId !== null
        ? typeof contextRef.current === 'function' ? contextRef.current() : contextRef.current : undefined;
      let previousContext = context(), previousInput = inputRef.current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const update = () => {
        const next = context(), input = inputRef.current;
        if (sameContext(previousContext, next) && sameContext(previousInput, input)) return;
        previousContext = next; previousInput = input;
        const message = next?.message as Record<string, unknown> | undefined;
        if (message?.isStreaming === true) {
          // Match the original streaming cadence, only while a presenter is subscribed.
          timer ??= setTimeout(() => { timer = undefined; changed(); },
            getStreamingMarkdownThrottleInterval(typeof message.content === 'string' ? message.content : ''));
        } else {
          clearTimeout(timer); timer = undefined; changed();
        }
      };
      listeners.current.add(update);
      // No document listener is installed by capability declarations alone.
      let lastSelection = sessionId === null ? '' : pluginUiSelection(sessionId);
      const selection = () => {
        const next = sessionId === null ? '' : pluginUiSelection(sessionId);
        if (next !== lastSelection) { lastSelection = next; changed(); }
      };
      if (hasContext && sessionId !== null) document.addEventListener('selectionchange', selection);
      return () => { clearTimeout(timer); listeners.current.delete(update); document.removeEventListener('selectionchange', selection); };
    },
  }), [sessionId, hasContext]);
  if (!ghost.enabled || !view || ghost.uiCapabilityApproved !== true) return null;
  return <McpAppCard key={`${instanceId}:${viewId}:${ghost.approval.state === 'approved' ? ghost.approval.revision : ''}`}
    source={{ instanceId, viewId }} contextSource={contextSource} onUnavailable={onUnavailable}
    sessionId={view.scope === 'task' ? sessionId : null} clientId={`${instanceId}:${viewId}`}
    title={view.title} plugin={{ trust: ghost.trust?.level }} />;
}
