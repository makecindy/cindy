/**
 * Speed curve for held-stick scrolling.
 *
 * Lives in shared/ because both halves need it: the main process normalises the
 * raw stick distance into an intensity, and the renderer turns that intensity
 * into pixels per frame.
 */

/** Below this the stick is treated as centred; matches the direction threshold. */
export const WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE = 0.5;

/** Pixels per second at the lightest push that still registers. */
const MIN_SCROLL_SPEED = 90;
/** Pixels per second with the stick pushed all the way. */
const MAX_SCROLL_SPEED = 2600;

/**
 * Map raw stick distance onto 0–1 across the usable travel.
 *
 * The stick only registers past the activation point, so without this the
 * lightest possible push would already start at half speed.
 */
export function normalizeJoystickIntensity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  const usable =
    (distance - WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE) /
    (1 - WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE);
  return Math.max(0, Math.min(1, usable));
}

/**
 * Scroll speed in pixels per second for a given intensity.
 *
 * Squared rather than linear: most of the travel stays slow enough to place a
 * message precisely, and full deflection is what gets you across a long
 * conversation quickly.
 */
export function joystickScrollSpeed(intensity: number): number {
  if (!Number.isFinite(intensity) || intensity <= 0) return 0;
  const clamped = Math.min(1, intensity);
  return MIN_SCROLL_SPEED + (MAX_SCROLL_SPEED - MIN_SCROLL_SPEED) * clamped * clamped;
}

/**
 * How far to scroll this frame.
 *
 * Driven by the real time since the last frame so the speed stays the same
 * whether the renderer is hitting 120fps or dropping frames.
 */
export function joystickScrollDelta(intensity: number, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  // A long gap (tab was backgrounded) must not teleport the view.
  const cappedMs = Math.min(elapsedMs, 100);
  return (joystickScrollSpeed(intensity) * cappedMs) / 1000;
}
