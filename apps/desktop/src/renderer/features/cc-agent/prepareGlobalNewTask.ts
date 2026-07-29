import { getDraftPresence } from '@/lib/composerDraftStore';
import { patchDraft } from '@/state/newMakerDraft';

import { NEW_MAKER_DRAFT_KEY } from './newMakerDraftKeys';

/**
 * Reset only workspace-scoped state for a fresh global New Task. A real
 * unsent draft keeps its original workspace so navigation never discards or
 * silently retargets user input.
 */
export function prepareGlobalNewTask(): 'fresh' | 'resume-draft' {
  if (getDraftPresence(NEW_MAKER_DRAFT_KEY)) return 'resume-draft';
  patchDraft({
    workingDir: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    extraDirs: [],
  });
  return 'fresh';
}
