import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseBlobUrl, resolveSafe, getBlobsRoot } from '../cindy-media/blobStore.desktop.js';
import { sessionCanRead, type LedgerDb } from '../cindy-media/ledger.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { BOT_AVATAR_MAX_BYTES } from '../../shared/botAvatarValue.js';
import { prepareTeammateAvatarImage, type TeammateAvatarCrop } from '../teammateAvatarImage.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Managed sources are read on this task's computer and checked against its media ledger. */
export async function readTeammateAvatarSource(sessionId: string, imageSource: string, db: LedgerDb, assertCurrent: () => void): Promise<Buffer> {
  assertCurrent();
  const blob = parseBlobUrl(imageSource);
  if (!blob || !(await sessionCanRead(blob.hash, sessionId, db)))
    throwIpcError('NOT_FOUND', '当前任务无法读取这张受管图片');
  assertCurrent();
  const root = await fs.realpath(getBlobsRoot());
  const read = await readBoundedFileNoFollow(resolveSafe(imageSource).absPath, BOT_AVATAR_MAX_BYTES, { containWithin: root, nonBlocking: true });
  assertCurrent();
  if (!read || createHash('sha256').update(read).digest('hex') !== blob.hash)
    throwIpcError('INVALID_PARAMS', '图片内容无效或已变化，请重新选择');
  return read;
}

export function createBotAvatarService(deps: {
  /** Source admission (owner/group/task authority), refreshed before the local commit. */
  admit(callerSessionId: string): Promise<{ assertCurrent(): void; assertCommit?(): void; refresh(): Promise<void> }>;
  readSource(callerSessionId: string, imageSource: string, assertCurrent: () => void): Promise<Buffer>;
  /** Real local target adapter. It must check version+avatar in the profile transaction. */
  setLocal(input: { botId: string; image: { buffer: Buffer; mimeType: string }; expectedVersion: number; expectedAvatar: string;
    assertCurrent(): void; assertCommit?(): void; beforeCommit(): Promise<void> }): Promise<{ avatar: string; profileVersion: number; synchronization?: 'complete' | 'unconfirmed'; warning?: string }>;
}) {
  return async (input: {
    callerSessionId: string; target: string; imageSource: string;
    expectedVersion: number; expectedAvatar: string; crop?: TeammateAvatarCrop;
  }) => {
    const admission = await deps.admit(input.callerSessionId);
    admission.assertCurrent();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.target))
      throwIpcError('INVALID_PARAMS', '请选择本机伙伴的 botId');
    const bytes = await deps.readSource(input.callerSessionId, input.imageSource, admission.assertCurrent);
    const image = await prepareTeammateAvatarImage(bytes, { crop: input.crop });
    await admission.refresh();
    admission.assertCurrent();
    const args = {
      expectedVersion: input.expectedVersion,
      expectedAvatar: input.expectedAvatar,
      image,
    };
    const value = await deps.setLocal({ ...args, botId: input.target, assertCurrent: admission.assertCurrent, assertCommit: admission.assertCommit, beforeCommit: admission.refresh });
    admission.assertCurrent();
    return { target: input.target, ...value, imageFormat: '256px-png' as const };
  };
}
