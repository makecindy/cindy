import { t } from '../i18n.js';
import { executeGhostSetupInlineSubmission as execute, type GhostSetupInlineExecutorDeps as SharedDeps } from '@cindy/plugin-runtime/ghostSetupInlineExecutor';
export type GhostSetupInlineExecutorDeps = Omit<SharedDeps, 'translate'>;
export function executeGhostSetupInlineSubmission(deps: GhostSetupInlineExecutorDeps, args: Parameters<typeof execute>[1]) { return execute({ ...deps, translate: t }, args); }
