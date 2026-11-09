import { t } from '../i18n.desktop.js';
import { executeGhostSetupInlineSubmission as execute, type GhostSetupInlineExecutorDeps as CoreDeps } from './ghostSetupInlineExecutorCore.js';
export type GhostSetupInlineExecutorDeps = Omit<CoreDeps, 'translate'>;
export function executeGhostSetupInlineSubmission(deps: GhostSetupInlineExecutorDeps, args: Parameters<typeof execute>[1]) {
  return execute({ ...deps, translate: t }, args);
}
