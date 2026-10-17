import type { AndroidInstallPhase } from './androidInstallController';

/** What the single Android update card shows for each installer phase. No React/native imports. */
export interface AndroidUpdatePresentation {
  /** Bordered explanation block between the release notes and the actions. */
  note: 'permission' | 'denied' | 'error' | null;
  /** Download / installer handoff progress; value null means the size is unknown. */
  progress: { value: number | null; label: 'downloading' | 'installing' } | null;
  ready: boolean;
  /** Right-hand filled action; null while a download is running (only Cancel remains). */
  primary: { label: 'updateNow' | 'grantAndUpdate' | 'grantAgain' | 'install' | 'retry'; busy: boolean } | null;
  dismiss: 'later' | 'cancel';
  /** The browser download stays reachable whenever the in-app path needs a decision. */
  browser: boolean;
}

export function presentAndroidUpdate(phase: AndroidInstallPhase, progress: number | null): AndroidUpdatePresentation {
  const base: AndroidUpdatePresentation = { note: null, progress: null, ready: false, primary: null, dismiss: 'later', browser: false };
  switch (phase) {
    case 'offer':
      return { ...base, primary: { label: 'updateNow', busy: false } };
    case 'permission':
      return { ...base, primary: { label: 'updateNow', busy: true } };
    case 'permission-required':
      return { ...base, note: 'permission', primary: { label: 'grantAndUpdate', busy: false }, browser: true };
    case 'permission-denied':
      return { ...base, note: 'denied', primary: { label: 'grantAgain', busy: false }, browser: true };
    case 'downloading':
      return { ...base, progress: { value: progress, label: 'downloading' }, dismiss: 'cancel' };
    case 'installing':
      return { ...base, progress: { value: 1, label: 'installing' }, dismiss: 'cancel' };
    case 'ready':
      return { ...base, ready: true, primary: { label: 'install', busy: false }, browser: true };
    case 'error':
      return { ...base, note: 'error', primary: { label: 'retry', busy: false }, browser: true };
    case 'idle':
      return base;
  }
}

/** translateX range for the unknown-size sweep; held at the start of the track when not animating. */
export function indeterminateSweepRange(animating: boolean, segment: number, width: number): [number, number] {
  return animating ? [-segment, width] : [0, 0];
}
