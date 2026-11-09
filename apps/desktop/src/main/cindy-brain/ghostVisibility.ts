import { t } from '../i18n.js';
import { createGhostVisibility } from './ghostVisibilityCore.js';
export type { GhostVisibilityResult, GhostVisibilityDeps } from './ghostVisibilityCore.js';
export const { preferLatestLocalOrPublicGhosts, classifyGhostVisibility, classifyInstalledGhostVisibility } = createGhostVisibility(t);
