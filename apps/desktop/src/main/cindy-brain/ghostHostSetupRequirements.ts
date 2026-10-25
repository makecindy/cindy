import { t } from '../i18n.js';
import { assessGhostHostSetupRequirements as assess, type GhostHostSetupRequirementProbes } from '@cindy/plugin-runtime/ghostHostSetupRequirements';
import type { GhostManifest } from '../../shared/ghost.js';
export type { GhostHostSetupRequirementProbes } from '@cindy/plugin-runtime/ghostHostSetupRequirements';
export function assessGhostHostSetupRequirements(manifest: GhostManifest, probes: GhostHostSetupRequirementProbes) {
  return assess(manifest, probes, t);
}
