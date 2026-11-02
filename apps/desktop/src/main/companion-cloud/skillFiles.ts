/**
 * The files beside an own skill's SKILL.md move with the companion (cloud-companions.md §2). The
 * bytes are room files uploaded as the owner, so any of the owner's computers can read them
 * without a message showing them in the chat; one small list per skill records which is which.
 * Older versions ignore this key and keep moving SKILL.md alone.
 */
import type { BotSkillFile } from '../maker-ipc/botSkillFiles.js';
import type { CompanionRoomDownload } from './materialize.js';
import { canonicalJson, COMPANION_SKILL_FILES_PREFIX, COMPANION_VALUE_MAX_BYTES, type CompanionPreferenceValue } from './uploader.js';
import { chatRejection, errorCode, isTransientAttachmentFailure, type CompanionLog } from './types.js';

export type CompanionSkillFile = BotSkillFile & { mediaId: string };
export interface CompanionSkillFiles {
  files: CompanionSkillFile[];
  /** Files the home could not send: the list is incomplete, so nothing is removed because of it. */
  omitted: number;
}

const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

export function parseCompanionSkillFiles(value: unknown): CompanionSkillFiles | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.files)) return null;
  const files = raw.files.flatMap((entry): CompanionSkillFile[] => {
    const file = record(entry);
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string' || typeof file.mediaId !== 'string'
      || typeof file.size !== 'number') return [];
    return [{ path: file.path, size: file.size, sha256: file.sha256, mediaId: file.mediaId, ...(file.executable === true ? { executable: true as const } : {}) }];
  });
  return { files, omitted: (typeof raw.omitted === 'number' ? raw.omitted : 0) + raw.files.length - files.length };
}

/**
 * Turns the skill folders the host listed into the values to upload, sending what the room does
 * not have yet. A failure that may pass leaves that skill's cloud list as it is (and holds a
 * hand-over); one that will not pass drops the file, because a move works without it today.
 */
export async function resolveCompanionSkillFiles(values: CompanionPreferenceValue[], deps: {
  /** Room file already uploaded for this content. */
  known: (sha256: string) => string | undefined;
  upload?: (file: { name: string; size: number; path: string; sha256: string }) => Promise<string>;
  /** The uploads in use after this pass; anything else is forgotten. */
  retain: (media: Record<string, string>) => void;
  log?: CompanionLog;
}): Promise<CompanionPreferenceValue[]> {
  const inUse: Record<string, string> = {};
  let storageMissing = !deps.upload;
  const resolved: CompanionPreferenceValue[] = [];
  for (const entry of values) {
    if (!entry.localFiles) { resolved.push(entry); continue; }
    const files: CompanionSkillFile[] = [];
    let omitted = 0;
    let retry = false;
    for (const { absolutePath, ...file } of entry.localFiles) {
      let mediaId = deps.known(file.sha256) ?? inUse[file.sha256];
      if (!mediaId && !storageMissing) {
        try {
          mediaId = await deps.upload!({ name: file.path.split('/').pop()!, size: file.size, path: absolutePath, sha256: file.sha256 });
        } catch (error) {
          // A server without file storage refuses every file; asking once per pass is enough.
          if (chatRejection(error, 503, 'MEDIA_STORAGE_UNAVAILABLE')) storageMissing = true;
          else if (isTransientAttachmentFailure(error)) { retry = true; break; }
          deps.log?.warn('Companion skill file not uploaded', { code: errorCode(error) });
        }
      }
      if (!mediaId) { omitted += 1; continue; }
      inUse[file.sha256] = mediaId;
      files.push({ ...file, mediaId });
    }
    if (retry) { resolved.push({ key: entry.key, value: null, unread: true }); continue; }
    const slug = entry.key.slice(COMPANION_SKILL_FILES_PREFIX.length);
    // One value has to hold the list: what does not fit stays behind, like any other unsendable file.
    while (Buffer.byteLength(canonicalJson({ slug, files, omitted })) > COMPANION_VALUE_MAX_BYTES) { files.pop(); omitted += 1; }
    resolved.push({ key: entry.key, value: { slug, files, ...(omitted ? { omitted } : {}) } });
  }
  if (!resolved.some(entry => entry.unread && entry.key.startsWith(COMPANION_SKILL_FILES_PREFIX))) deps.retain(inUse);
  return resolved;
}

/** A skill file's bytes on this computer: null when it will never come, thrown when it may still. */
export function companionSkillFileFetch(roomId: string, files: CompanionSkillFile[], download: CompanionRoomDownload, log?: CompanionLog) {
  const media = new Map(files.map(file => [file.path, file.mediaId]));
  return async (file: BotSkillFile): Promise<string | null> => {
    try { return (await download(roomId, media.get(file.path)!)).path; } catch (error) {
      if (isTransientAttachmentFailure(error)) throw error;
      log?.warn('Companion skill file unavailable', { code: errorCode(error) });
      return null;
    }
  };
}
