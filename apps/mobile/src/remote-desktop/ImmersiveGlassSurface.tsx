import { ImmersivePlainSurface } from "./ImmersivePlainSurface";

/** Backing of the immersive preview controls; this file is the one without glass. */
export function useImmersiveGlass(): boolean {
  return false;
}

export const ImmersiveGlassSurface = ImmersivePlainSurface;
