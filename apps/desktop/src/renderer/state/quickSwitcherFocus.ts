import { useSyncExternalStore } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from '@/features/cc-agent/lib/projectGrouping';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

interface QuickSwitcherFocus {
  kind: 'project' | 'session';
  route: string;
  session: Session | null;
  project: ProjectNode | null;
  nonce: number;
  owner: DataOwnerGeneration;
}
let current: QuickSwitcherFocus | null = null;
let nonce = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => current;

/** Navigation-only visibility override. Never writes sidebar preferences or archive state. */
export function requestQuickSwitcherFocus(
  input: Pick<QuickSwitcherFocus, 'kind' | 'route' | 'session' | 'project'>,
): void {
  current = { ...input, nonce: ++nonce, owner: getDataOwnerGeneration() };
  listeners.forEach((listener) => listener());
}
export function clearQuickSwitcherFocus(): void {
  if (!current) return;
  current = null;
  listeners.forEach((listener) => listener());
}
export function clearQuickSwitcherFocusOutsideRoute(pathname: string): void {
  if (current && current.route !== pathname) clearQuickSwitcherFocus();
}
export function patchQuickSwitcherFocusSession(
  deviceId: string | undefined,
  sessionId: string,
  patch: Partial<Session>,
): void {
  const session = current?.session;
  if (
    !current ||
    !session ||
    !isDataOwnerGenerationCurrent(current.owner) ||
    session.id !== sessionId ||
    session.deviceLinkDeviceId !== deviceId
  )
    return;
  if (
    !['title', 'status', 'workingDir', 'workspaceKind', 'remoteHostId', 'pinnedAt'].some(
      (key) => key in patch,
    )
  )
    return;
  if (
    patch.status === 'deleted' ||
    'workingDir' in patch ||
    'workspaceKind' in patch ||
    'remoteHostId' in patch
  ) {
    clearQuickSwitcherFocus();
    return;
  }
  current = { ...current, session: { ...session, ...patch } };
  listeners.forEach((listener) => listener());
}
export function useQuickSwitcherFocus(): QuickSwitcherFocus | null {
  const focus = useSyncExternalStore(subscribe, snapshot, snapshot);
  return focus && isDataOwnerGenerationCurrent(focus.owner) ? focus : null;
}
