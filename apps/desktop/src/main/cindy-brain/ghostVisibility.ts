import { t } from '../i18n.js';
import { classifyGhostVisibility as classify, classifyInstalledGhostVisibility as classifyInstalled, type GhostVisibilityDeps as SharedDeps } from '@cindy/plugin-runtime/ghostVisibility';
import type { InstalledGhost } from '../../shared/ghost.js';
export type { GhostVisibilityResult } from '@cindy/plugin-runtime/ghostVisibility';
export type GhostVisibilityDeps = Omit<SharedDeps, 'translate'>;
export function classifyGhostVisibility(id: string, workdir: string | null, deps: GhostVisibilityDeps, namespace?: string | null) {
  return classify(id, workdir, { ...deps, translate: t }, namespace);
}
export function classifyInstalledGhostVisibility(target: InstalledGhost, workdir: string | null, deps: GhostVisibilityDeps) {
  return classifyInstalled(target, workdir, { ...deps, translate: t });
}
