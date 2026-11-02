/**
 * The files beside an own skill's SKILL.md move with the companion (cloud-companions.md §2). The
 * bytes are room files uploaded as the owner, so any of the owner's computers can read them
 * without a message showing them in the chat; one small list per skill records which is which.
 * Older versions ignore this key and keep moving SKILL.md alone.
 */
import type { BotSkillFile } from '../maker-ipc/botSkillFiles.js';
import type { CompanionRoomDownload } from './materialize.js';
import { canonicalJson, COMPANION_SKILL_FILES_PREFIX, COMPANION_SKILL_PREFIX, COMPANION_VALUE_MAX_BYTES, type CompanionPreferenceValue } from './uploader.js';
import { chatRejection, errorCode, isTransientAttachmentFailure, type CompanionLog } from './types.js';

/** An empty file has no bytes to upload: its mediaId is empty and the restore creates it. */
export type CompanionSkillFile = BotSkillFile & { mediaId: string };
export interface CompanionSkillFiles {
  files: CompanionSkillFile[];
  /** Files that exist but never reached the cloud: not a deletion, on any computer. */
  omitted: string[];
  /** The list does not name everything, so nothing can be removed because of it. */
  truncated: boolean;
}
/** What a take-over learned is missing from the cloud; this computer passes it on until it has the file. */
export type CompanionSkillFileGaps = Record<string, {
  omitted: string[];
  truncated?: boolean | undefined;
  /** An older copy kept here because the cloud's version did not arrive (path → sha256): not news until edited. */
  stale?: Record<string, string> | undefined;
}>;

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
  const omitted = Array.isArray(raw.omitted) ? raw.omitted.filter((item): item is string => typeof item === 'string') : [];
  return { files, omitted, truncated: raw.truncated === true || files.length !== raw.files.length };
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
  gaps?: CompanionSkillFileGaps;
  /** The uploads and gaps still in use after this pass; anything else is forgotten. */
  retain: (media: Record<string, string>, gaps: CompanionSkillFileGaps) => void;
  log?: CompanionLog;
}): Promise<CompanionPreferenceValue[]> {
  const inUse: Record<string, string> = {};
  const gaps: CompanionSkillFileGaps = {};
  let storageMissing = !deps.upload;
  let retried = false;
  const seen = new Set<string>();
  const resolved: CompanionPreferenceValue[] = [];
  const list = (key: string, slug: string, files: CompanionSkillFile[], omitted: string[], truncated: boolean, stale: Record<string, string> = {}): CompanionPreferenceValue => {
    // One value has to hold the list: what does not fit stays behind, like any other unsendable file.
    // Counted per entry: this runs every upload cycle on the main process, however long the list.
    const bytes = (item: unknown) => Buffer.byteLength(canonicalJson(item)) + 1;
    let size = bytes({ slug, files: [], omitted: [], truncated: true })
      + files.reduce((sum, file) => sum + bytes(file), 0) + omitted.reduce((sum, path) => sum + bytes(path), 0);
    while (size > COMPANION_VALUE_MAX_BYTES) {
      const dropped = files.pop();
      if (dropped) { omitted.push(dropped.path); size += bytes(dropped.path) - bytes(dropped); }
      else { size -= bytes(omitted.pop()); truncated = true; }
    }
    if (omitted.length || truncated) {
      gaps[slug] = { omitted: omitted.filter(path => stale[path] || !seen.has(`${slug}/${path}`)), ...(truncated ? { truncated } : {}),
        ...(Object.keys(stale).length ? { stale } : {}) };
    }
    return { key, value: { slug, files, ...(omitted.length ? { omitted } : {}), ...(truncated ? { truncated } : {}) } };
  };
  for (const entry of values) {
    if (!entry.localFiles) { resolved.push(entry); continue; }
    const slug = entry.key.slice(COMPANION_SKILL_FILES_PREFIX.length);
    for (const file of entry.localFiles) seen.add(`${slug}/${file.path}`);
    const files: CompanionSkillFile[] = [];
    const omitted = (deps.gaps?.[slug]?.omitted ?? []).filter(path => !seen.has(`${slug}/${path}`));
    const stale: Record<string, string> = {};
    let retry = false;
    for (const { absolutePath, ...file } of entry.localFiles) {
      if (deps.gaps?.[slug]?.stale?.[file.path] === file.sha256) { stale[file.path] = file.sha256; omitted.push(file.path); continue; }
      let mediaId = file.size === 0 ? '' : deps.known(file.sha256) ?? inUse[file.sha256];
      if (mediaId === undefined && !storageMissing) {
        try {
          mediaId = await deps.upload!({ name: file.path.split('/').pop()!, size: file.size, path: absolutePath, sha256: file.sha256 });
        } catch (error) {
          // A server without file storage refuses every file; asking once per pass is enough.
          if (chatRejection(error, 503, 'MEDIA_STORAGE_UNAVAILABLE')) storageMissing = true;
          else if (isTransientAttachmentFailure(error)) { retry = true; break; }
          deps.log?.warn('Companion skill file not uploaded', { code: errorCode(error) });
        }
      }
      if (mediaId === undefined) { omitted.push(file.path); continue; }
      if (mediaId) inUse[file.sha256] = mediaId;
      files.push({ ...file, mediaId });
    }
    if (retry) { retried = true; resolved.push({ key: entry.key, value: null, unread: true }); continue; }
    resolved.push(list(entry.key, slug, files, omitted, deps.gaps?.[slug]?.truncated === true, stale));
  }
  // Every file of this skill stayed behind: without a list the next take-over would delete them there.
  for (const [slug, gap] of Object.entries(deps.gaps ?? {})) {
    const key = `${COMPANION_SKILL_FILES_PREFIX}${slug}`;
    if (resolved.some(entry => entry.key === key) || !values.some(entry => entry.key === `${COMPANION_SKILL_PREFIX}${slug}`)) continue;
    resolved.push(list(key, slug, [], [...gap.omitted], gap.truncated === true));
  }
  if (!retried) deps.retain(inUse, gaps);
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
