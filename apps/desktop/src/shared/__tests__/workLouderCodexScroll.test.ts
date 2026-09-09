import { describe, expect, it } from 'vitest';

import {
  WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE,
  joystickScrollDelta,
  joystickScrollSpeed,
  normalizeJoystickIntensity,
} from '../workLouderCodexScroll';

describe('normalizeJoystickIntensity', () => {
  it('starts from zero at the activation point, not half speed', () => {
    // The stick only registers past the activation distance; without remapping,
    // the lightest usable push would already be halfway up the curve.
    expect(normalizeJoystickIntensity(WORKLOUDER_JOYSTICK_ACTIVATION_DISTANCE)).toBe(0);
    expect(normalizeJoystickIntensity(1)).toBe(1);
  });

  it('clamps anything below the activation point or past full travel', () => {
    expect(normalizeJoystickIntensity(0)).toBe(0);
    expect(normalizeJoystickIntensity(0.2)).toBe(0);
    expect(normalizeJoystickIntensity(1.5)).toBe(1);
    expect(normalizeJoystickIntensity(Number.NaN)).toBe(0);
  });
});

describe('joystickScrollSpeed', () => {
  it('is nothing at rest and fastest at full deflection', () => {
    expect(joystickScrollSpeed(0)).toBe(0);
    expect(joystickScrollSpeed(1)).toBeGreaterThan(joystickScrollSpeed(0.5));
  });

  it('keeps most of the travel slow so a light push can place a message', () => {
    // Squared, not linear: half deflection is well under half speed.
    const half = joystickScrollSpeed(0.5);
    const full = joystickScrollSpeed(1);
    expect(half).toBeLessThan(full * 0.4);
  });
});

describe('joystickScrollDelta', () => {
  it('scales with elapsed time so speed holds when frames drop', () => {
    const oneFrame = joystickScrollDelta(1, 16);
    const twoFrames = joystickScrollDelta(1, 32);
    expect(twoFrames).toBeCloseTo(oneFrame * 2, 5);
  });

  it('caps a long gap so a backgrounded tab does not teleport the view', () => {
    const capped = joystickScrollDelta(1, 5_000);
    expect(capped).toBe(joystickScrollDelta(1, 100));
  });

  it('moves nothing without time or pressure', () => {
    expect(joystickScrollDelta(1, 0)).toBe(0);
    expect(joystickScrollDelta(0, 16)).toBe(0);
    expect(joystickScrollDelta(1, Number.NaN)).toBe(0);
  });
});
