/**
 * Shared message-composer geometry, in points. `pillHeight` is also the floating
 * new-task button's size: the button sits on the composer's resting line and the
 * compact pill is exactly as tall, so the circle only stretches sideways.
 */
export const composerGeometry = { cornerRadius: 30, horizontalInset: 16, keyboardGap: 8, restingGap: 8, pillHeight: 55 } as const;

export interface ComposerMorphOrigin {
  id: string; x: number; y: number; width: number; height: number;
  windowWidth: number; windowHeight: number;
}

function usableOrigin(origin: ComposerMorphOrigin | null, width: number, height: number): origin is ComposerMorphOrigin {
  return !!origin && Math.abs(origin.windowWidth - width) < 1 && Math.abs(origin.windowHeight - height) < 1
    && origin.width > 0 && origin.height > 0 && origin.y >= 0 && origin.y + origin.height <= height;
}

export function composerRestingBottom(origin: ComposerMorphOrigin | null, width: number, height: number, safeBottom: number): number {
  if (usableOrigin(origin, width, height)) return height - origin.y - origin.height;
  return safeBottom + composerGeometry.restingGap;
}

/** The compact composer pill matches the new-task button, so the button only stretches sideways into it. */
export function composerPillHeight(origin: ComposerMorphOrigin | null, width: number, height: number): number {
  return usableOrigin(origin, width, height) ? origin.height : composerGeometry.pillHeight;
}

export function composerBottomContentPadding(desiredBottom: number, layerBottom: number, innerPadding: number): number {
  return Math.max(0, desiredBottom - layerBottom - innerPadding);
}
