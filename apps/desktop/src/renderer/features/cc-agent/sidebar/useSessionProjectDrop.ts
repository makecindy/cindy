import { useCallback, useEffect, useRef, useSyncExternalStore, type DragEvent } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from '../lib/projectGrouping';
import {
  getActiveSessionDrag,
  hasSplitGroupSessionType,
  SPLIT_GROUP_SESSION_MIME,
  subscribeSessionDrag,
} from '../splitGroupDnd';
import { resolveSessionProjectDrop } from './sessionProjectDrop';
import type { SessionMoveTarget } from './sessionMoveTarget';

const DROP_SELECTOR = '[data-session-project-drop], [data-session-dialogue-drop]';
export const PROJECT_DROP_HOVER_MS = 600;
export const PROJECT_DROP_CLASS =
  'data-[session-project-drop-active=true]:bg-sidebar-item-hover data-[session-project-drop-active=true]:ring-1 data-[session-project-drop-active=true]:ring-inset data-[session-project-drop-active=true]:ring-[var(--focus-ring-soft)]';

interface Options {
  getSession(id: string): Session | undefined;
  getProject(key: string): ProjectNode | undefined;
  expandProject(key: string): void;
  onMoveSession(id: string, target: SessionMoveTarget): void;
}

/** Capture task drops before native pinned sorting; ordinary project sorting is left untouched. */
export function useSessionProjectDrop(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const drag = useSyncExternalStore(subscribeSessionDrag, getActiveSessionDrag, () => null);
  const highlighted = useRef<HTMLElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    highlighted.current?.removeAttribute('data-session-project-drop-active');
    highlighted.current = null;
  }, []);
  useEffect(() => {
    if (!drag) clear();
  }, [drag, clear]);
  useEffect(() => clear, [clear]);

  const resolve = (event: DragEvent<HTMLElement>) => {
    const source = getActiveSessionDrag();
    if (!source || !hasSplitGroupSessionType(event.dataTransfer.types)) return null;
    const session = latest.current.getSession(source.sessionId);
    if (!session || (session.deviceLinkDeviceId ?? null) !== source.deviceId) return null;
    const element =
      event.target instanceof Element ? event.target.closest<HTMLElement>(DROP_SELECTOR) : null;
    if (!element || !event.currentTarget.contains(element)) return null;
    const key = element.dataset.sessionProjectDrop;
    const project = key === undefined ? undefined : latest.current.getProject(key);
    const dialogueDevice = element.dataset.sessionDialogueDrop;
    const target = project
      ? { kind: 'project' as const, project }
      : dialogueDevice !== undefined
        ? {
            kind: 'dialogue' as const,
            deviceId: dialogueDevice === 'source' ? undefined : dialogueDevice || null,
          }
        : null;
    const move = target ? resolveSessionProjectDrop(session, target) : null;
    return move ? { element, session, move, project } : null;
  };

  const onDragOverCapture = (event: DragEvent<HTMLElement>) => {
    const result = resolve(event);
    if (!result) {
      clear();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (highlighted.current === result.element) return;
    clear();
    highlighted.current = result.element;
    result.element.setAttribute('data-session-project-drop-active', 'true');
    if (result.project) {
      const key = result.project.projectKey;
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        if (getActiveSessionDrag()) latest.current.expandProject(key);
      }, PROJECT_DROP_HOVER_MS);
    }
  };
  const onDropCapture = (event: DragEvent<HTMLElement>) => {
    const result = resolve(event);
    clear();
    if (!result || event.dataTransfer.getData(SPLIT_GROUP_SESSION_MIME) !== result.session.id)
      return;
    event.preventDefault();
    event.stopPropagation();
    latest.current.onMoveSession(result.session.id, result.move);
  };
  const onDragLeaveCapture = (event: DragEvent<HTMLElement>) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      clear();
  };
  const draggedSession = drag ? options.getSession(drag.sessionId) : undefined;
  const showDialogueDrop =
    draggedSession && resolveSessionProjectDrop(draggedSession, { kind: 'dialogue' }) !== null;
  return { onDragOverCapture, onDropCapture, onDragLeaveCapture, showDialogueDrop };
}
