import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_HUD_SETTINGS, type HudState, type HudSettings } from '../../../shared/hud';
let current: HudState = {
  active: false,
  capturing: false,
  passThrough: false,
  moving: false,
  layer: 1,
  settings: { ...DEFAULT_HUD_SETTINGS },
};
const listeners = new Set<() => void>();
let started = false;
let captureGeneration = 0;
let writes = Promise.resolve();
function accept(value: HudState) {
  // Observe every native push, including off/on pairs batched into one React render.
  if (
    current.active !== value.active ||
    current.settings.allowScreen !== value.settings.allowScreen
  )
    captureGeneration++;
  current = value;
  for (const listener of listeners) listener();
}
export const getHudState = () => current;
export const getHudCaptureGeneration = () => captureGeneration;
function start() {
  if (started || !window.electronAPI?.hud) return;
  started = true;
  const unsubscribe = window.electronAPI.hud.onChanged(accept);
  void window.electronAPI.hud
    .get()
    .then(accept)
    .catch(() => {
      unsubscribe();
      started = false;
    });
}
export function useHud() {
  useEffect(start, []);
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, getHudState);
}
export async function setHudPassThrough(enabled: boolean) {
  accept(await window.electronAPI.hud.setPassThrough(enabled));
}
export async function shiftHudLayer(step: -1 | 1) {
  accept(await window.electronAPI.hud.shiftLayer(step));
}
export async function setHudActive(active: boolean) {
  accept(await window.electronAPI.hud.setActive(active));
}
/** Preserve write order during slider drags and reset; main remains the source of truth. */
export function updateHudSettings(patch: Partial<HudSettings>) {
  const next = writes.then(async () => {
    accept(await window.electronAPI.hud.setSettings(patch));
  });
  writes = next.catch(() => {});
  return next;
}
export function resetHudSettings() {
  const next = writes.then(async () => {
    accept(await window.electronAPI.hud.resetSettings());
  });
  writes = next.catch(() => {});
  return next;
}
