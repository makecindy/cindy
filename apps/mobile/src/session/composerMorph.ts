import { useSyncExternalStore } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { composerGeometry, composerPillHeight, composerRestingBottom, type ComposerMorphOrigin } from './composerGeometry';

let geometry: ComposerMorphOrigin | null = null;
const listeners = new Set<() => void>();
const entries = new Map<string, { origin: ComposerMorphOrigin; at: number }>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function rememberComposerGeometry(origin: ComposerMorphOrigin) {
  if (!origin || ![origin.x, origin.y, origin.width, origin.height, origin.windowWidth, origin.windowHeight].every(Number.isFinite)) return;
  if (geometry && ['x', 'y', 'width', 'height', 'windowWidth', 'windowHeight'].every(key => geometry![key as keyof ComposerMorphOrigin] === origin[key as keyof ComposerMorphOrigin])) return;
  geometry = origin;
  listeners.forEach(listener => listener());
}
export function rememberComposerEntry(origin: ComposerMorphOrigin): string {
  rememberComposerGeometry(origin);
  entries.clear();
  entries.set(origin.id, { origin, at: Date.now() });
  return origin.id;
}
export function readComposerEntry(id: string | undefined): ComposerMorphOrigin | null {
  const value = id ? entries.get(id) : undefined;
  return value && Date.now() - value.at < 2500 ? value.origin : null;
}
export function useComposerDock() {
  const origin = useSyncExternalStore(subscribe, () => geometry);
  const window = useWindowDimensions();
  const safe = useSafeAreaInsets();
  return {
    // iOS composer dock: new task, existing task and partner chat share the
    // new-task button's resting line, pill height and keyboard gap.
    enabled: Platform.OS === 'ios',
    restingBottom: composerRestingBottom(origin, window.width, window.height, safe.bottom),
    keyboardGap: composerGeometry.keyboardGap,
    pillHeight: composerPillHeight(origin, window.width, window.height),
  };
}
