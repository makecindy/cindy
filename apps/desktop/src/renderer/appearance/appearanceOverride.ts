import { useSyncExternalStore } from 'react';

import type { WallpaperId } from '@/../shared/appearanceSettings';

/**
 * A temporary, in-memory appearance for the current view, such as the theme and wallpaper
 * a user chose for one teammate. It never touches the saved theme (`theme.familyId`) or
 * `appearance-settings.json`: leaving the view clears it and the saved choice shows again.
 *
 * One owner at a time. A split layout can mount several views; the focused one sets the
 * override, and a background view clearing its own token cannot remove the focused one's.
 */
export interface AppearanceOverride {
  familyId?: string;
  wallpaperId?: WallpaperId;
}

let current: { owner: symbol; value: AppearanceOverride } | null = null;
const listeners = new Set<() => void>();

function sameOverride(a: AppearanceOverride | null, b: AppearanceOverride | null): boolean {
  return a?.familyId === b?.familyId && a?.wallpaperId === b?.wallpaperId;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function getAppearanceOverride(): AppearanceOverride | null {
  return current?.value ?? null;
}

/** Set (or with `null`, release) the override held by `owner`. */
export function setAppearanceOverride(owner: symbol, value: AppearanceOverride | null): void {
  const empty = !value || (value.familyId === undefined && value.wallpaperId === undefined);
  if (empty) {
    if (current?.owner !== owner) return;
    current = null;
    notify();
    return;
  }
  const previous = current?.value ?? null;
  current = { owner, value: { ...value } };
  if (!sameOverride(previous, current.value)) notify();
}

export function onAppearanceOverrideChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearanceOverrideFamilyId(): string | null {
  return useSyncExternalStore(onAppearanceOverrideChange, () => current?.value.familyId ?? null);
}

export function useAppearanceOverrideWallpaperId(): WallpaperId | null {
  return useSyncExternalStore(onAppearanceOverrideChange, () => current?.value.wallpaperId ?? null);
}

export function __resetAppearanceOverrideForTest(): void {
  current = null;
  listeners.clear();
}
