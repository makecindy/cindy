/** 分享者的私人备注，按账号与成员隔离；不进入分享服务、日志或受邀者目录。 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  normalizeProviderShareMemberNote,
  PROVIDER_SHARE_MEMBER_NOTE_MAX_LENGTH,
} from '../../shared/providerShareMemberNote.js';

interface MemberNotes {
  notes: Record<string, string>;
}

export function createProviderShareMemberNotesStore(options: {
  filePath: () => string;
  scopeKey: () => string;
}) {
  const store = createOverrideSettingsFile<MemberNotes>({
    ...options,
    defaults: () => ({ notes: {} }),
    normalize(raw) {
      const notes = (raw as Partial<MemberNotes> | null)?.notes;
      return {
        notes: Object.fromEntries(
          Object.entries(notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : {})
            .filter(
              ([id, note]) =>
                id.length > 0 &&
                id.length <= 128 &&
                typeof note === 'string' &&
                note.length <= PROVIDER_SHARE_MEMBER_NOTE_MAX_LENGTH,
            )
            .map(([id, note]) => [id, normalizeProviderShareMemberNote(note)]),
        ),
      };
    },
    log: createLogger('provider-share:member-notes'),
    label: 'provider-share-member-notes',
    maxBytes: 1024 * 1024,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });
  return {
    read(): Record<string, string> {
      store.invalidateIfChanged();
      return store.read().notes;
    },
    async set(memberId: string, note: string, assertCurrent: () => void): Promise<void> {
      assertCurrent();
      try {
        await store.updateAtomic(({ value }) => {
          assertCurrent();
          const notes = { ...value.notes };
          if (note) notes[memberId] = note;
          else delete notes[memberId];
          return { notes };
        });
      } catch {
        throwIpcError('PRECONDITION_FAILED', 'Could not save provider share member note');
      }
      assertCurrent();
    },
  };
}

export const providerShareMemberNotes = createProviderShareMemberNotesStore({
  filePath: () => ownerScopedUserDataPath('provider-share-member-notes.json'),
  scopeKey: () => {
    captureProviderManagementScope();
    return activeOwnerScopeKey();
  },
});
