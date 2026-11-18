import { useSyncExternalStore } from 'react';
import type { ProjectNode } from '@/features/cc-agent/lib/projectGrouping';

export interface HeaderProjectMenu {
  project: ProjectNode;
  anchor: HTMLButtonElement;
}

// The header owns the trigger, while the sidebar owns the project catalogue and actions.
let request: HeaderProjectMenu | null = null;
let settingsProject: ProjectNode | null = null;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setHeaderProjectMenu(next: HeaderProjectMenu | null) {
  request = next;
  for (const listener of listeners) listener();
}
export function useHeaderProjectMenu() {
  return useSyncExternalStore(subscribe, () => request);
}

// Keep the settings owner mounted after the header dropdown closes.
export function setProjectSettings(next: ProjectNode | null) {
  settingsProject = next;
  for (const listener of listeners) listener();
}
export function useProjectSettings() {
  return useSyncExternalStore(subscribe, () => settingsProject);
}
