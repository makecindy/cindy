import { t } from '../i18n.desktop.js';
import { assessGhostHostSetupRequirements as assess } from './ghostHostSetupRequirementsCore.js';
export type { GhostHostSetupRequirementProbes } from './ghostHostSetupRequirementsCore.js';
export function assessGhostHostSetupRequirements(...args: [Parameters<typeof assess>[0], Parameters<typeof assess>[1]]) {
  return assess(...args, t);
}
