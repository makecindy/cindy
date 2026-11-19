/**
 * Plugin icons where idle task identity is monochrome (sidebar rows, task lists).
 *
 * Built-in Agent marks are single-colour glyphs that take the row's state colour: grey when idle,
 * the selected row's foreground, Thinking Orange while running. A plugin's own icon keeps its own
 * colours while running and breathing, and turns monochrome only when not running (2026-11-19 user
 * decisions: idle tasks should be grey rather than a blue whale, while running tasks should breathe
 * in the plugin's own colours). An idle icon whose shape sits on a transparent background is drawn
 * as a silhouette filled with the surrounding neutral text colour; an icon with an opaque
 * background would turn into a filled block, so it is shown in greyscale instead. Each icon is
 * measured once and remembered.
 */
import { useEffect, useReducer } from 'react';

const SAMPLE_SIZE = 32;
/** Share of fully transparent pixels from which the icon reads as a shape on a clear background. */
const MIN_TRANSPARENT_SHARE = 0.3;
/** Share of solid pixels needed for the silhouette to show anything. */
const MIN_SOLID_SHARE = 0.05;

const measured = new Map<string, boolean>();
const waiting = new Map<string, Set<() => void>>();

/**
 * Whether RGBA pixels (4 values per pixel) describe a shape on a transparent background. A
 * rounded-square app icon is transparent only in its corners and stays a greyscale image.
 */
export function isSilhouetteIcon(rgba: ArrayLike<number>): boolean {
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return false;
  let clear = 0;
  let solid = 0;
  for (let index = 3; index < pixels * 4; index += 4) {
    const alpha = rgba[index] ?? 0;
    if (alpha < 16) clear += 1;
    else if (alpha >= 128) solid += 1;
  }
  return clear / pixels >= MIN_TRANSPARENT_SHARE && solid / pixels >= MIN_SOLID_SHARE;
}

function measure(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(false);
      return;
    }
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          resolve(false);
          return;
        }
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        resolve(isSilhouetteIcon(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data));
      } catch {
        resolve(false);
      }
    };
    image.onerror = () => resolve(false);
    image.src = dataUrl;
  });
}

/** true = draw as a silhouette; false = greyscale image; null = not measured yet (greyscale meanwhile). */
export function usePluginIconSilhouette(dataUrl: string | undefined): boolean | null {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!dataUrl || measured.has(dataUrl)) return;
    const notify = () => rerender();
    const listeners = waiting.get(dataUrl);
    if (listeners) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    }
    const fresh = new Set([notify]);
    waiting.set(dataUrl, fresh);
    void measure(dataUrl).then((silhouette) => {
      measured.set(dataUrl, silhouette);
      waiting.delete(dataUrl);
      for (const listener of fresh) listener();
    });
    return () => {
      fresh.delete(notify);
    };
  }, [dataUrl]);
  return dataUrl ? (measured.get(dataUrl) ?? null) : null;
}

/** Tests only: record a measurement (jsdom cannot decode images or read canvas pixels). */
export function rememberPluginIconSilhouetteForTests(dataUrl: string, silhouette: boolean): void {
  measured.set(dataUrl, silhouette);
}
