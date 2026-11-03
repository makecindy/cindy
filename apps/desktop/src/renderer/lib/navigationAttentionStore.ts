import { useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

export interface NavigationAttentionCounts { tasks: number; teammates: number }
const EMPTY: NavigationAttentionCounts = { tasks: 0, teammates: 0 };
let counts = EMPTY;
let owner = getDataOwnerGeneration();
const listeners = new Set<() => void>();
const snapshot = () => isDataOwnerGenerationCurrent(owner) ? counts : EMPTY;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function publishNavigationAttention(next: NavigationAttentionCounts): void {
  const changed = !isDataOwnerGenerationCurrent(owner) || counts.tasks !== next.tasks || counts.teammates !== next.teammates;
  owner = getDataOwnerGeneration();
  counts = next;
  if (changed) listeners.forEach(listener => listener());
}
export function useNavigationAttention(): NavigationAttentionCounts {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
