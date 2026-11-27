import { t } from '../i18n.desktop.js';
import { createGhostVisibility } from './ghostVisibility.js';
export type { GhostVisibilityResult, GhostVisibilityDeps } from './ghostVisibility.js';
export const { preferLatestLocalOrPublicGhosts, classifyGhostVisibility, classifyInstalledGhostVisibility } = createGhostVisibility(t);
