/** 分享者的私人备注，按账号与成员隔离；不进入分享服务、日志或受邀者目录。 */
import { realpath } from 'node:fs/promises';
import { readBoundedFileFollowLinks } from '../utils/readBoundedFile.js';
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

const MAX_MEMBER_NOTES_BYTES = 1024 * 1024;

function normalizeMemberNotes(raw: unknown): MemberNotes {
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
}

export function createProviderShareMemberNotesStore(options: {
  filePath: () => string;
  scopeKey: () => string;
}) {
  const store = createOverrideSettingsFile<MemberNotes>({
    ...options,
    defaults: () => ({ notes: {} }),
    normalize: normalizeMemberNotes,
    log: createLogger('provider-share:member-notes'),
    label: 'provider-share-member-notes',
    maxBytes: MAX_MEMBER_NOTES_BYTES,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });
  return {
    read(): Record<string, string> {
      store.invalidateIfChanged();
      return store.read().notes;
    },
    async readStrict(): Promise<Record<string, string>> {
      const scope = options.scopeKey();
      const file = options.filePath();
      try {
        const bytes = await realpath(file)
          .then(resolved => readBoundedFileFollowLinks(resolved, MAX_MEMBER_NOTES_BYTES))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return Buffer.from('{}');
            throw error;
          });
        if (options.scopeKey() !== scope || options.filePath() !== file || !bytes) {
          throw new Error('Member note source changed or is unavailable');
        }
        const raw: unknown = JSON.parse(bytes.toString('utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('Invalid member notes');
        }
        return normalizeMemberNotes(raw).notes;
      } catch {
        throwIpcError('PRECONDITION_FAILED', 'Could not read provider share member notes');
      }
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
