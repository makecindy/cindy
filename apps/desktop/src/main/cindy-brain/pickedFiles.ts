import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireGhostDepositLock } from './ghostDepositQuota.js';
import { GHOST_CINDY_DEPOSIT_MAX_BYTES, GHOST_CINDY_DEPOSIT_QUOTA_BYTES, type GhostPipePickResult } from '../../shared/ghost.js';
import { sniffMediaMime, additionalMp3BytesNeeded } from '../cindy-media/sniffMediaMime.js';
import { supportedMime } from '../cindy-media/blobStore.js';
import { validateLibraryRelPath, DEFAULT_LIBRARY_LIMITS } from './libraryVault.js';

type Failure = Extract<GhostPipePickResult, { ok: false }>;
type Success = Extract<GhostPipePickResult, { ok: true }>;
export interface PickedFilesDeps {
  tempRoot: string;
  usageBytes(ghostId: string): Promise<number>;
  deposit(ghostId: string, filePath: string, mimeType: string, assertCurrent: () => void): Promise<{ url: string }>;
  importLibrary(ghostId: string, input: { path: string; source: AsyncIterable<Uint8Array>; totalBytes: number; assertCurrent(): void; onProgress(bytes: number, total?: number): void }): Promise<{ ok: true; ref: string; sha256: string } | { ok: false; message: string }>;
  progress?(ghostId: string, callId?: string): (bytes: number | undefined, total: number | undefined, message: string) => void;
}

/** Reserve the UUID prefix and at least one filename character before opening a picker. */
export function pickedFileNameBudget(directory: string): number {
  // The shared safe-path contract caps ASCII segments at 64 and the full path at 256.
  const budget = Math.min(64, 256 - directory.length - 1);
  return budget > 42 && !validateLibraryRelPath(`${directory}/${'x'.repeat(43)}`) ? budget : 0;
}

/** Bytes flow from one held file handle into Host staging, never through the plugin runtime. */
export async function importPickedFiles(deps: PickedFilesDeps, ghostId: string, paths: string[], input: {
  into: 'media' | 'library'; path?: string; callId?: string; assertCurrent(): void;
}): Promise<GhostPipePickResult> {
  if (paths.length > 32) return { ok: false, errorCode: 'INVALID_REQUEST', message: '一次最多选择 32 个文件' };
  const directory = input.path ?? 'imports';
  const nameBudget = pickedFileNameBudget(directory);
  if (input.into === 'library' && !nameBudget) return { ok: false, errorCode: 'INVALID_REQUEST', message: 'Library 目标目录不合法或无法容纳导入文件名' };
  const files: NonNullable<Success['files']> = [];
  const progress = deps.progress?.(ghostId, input.callId);
  let completed = 0;
  let index = 0;
  const failure = (error: Failure): Failure => {
    // Never return old-owner refs after cancellation or an account/install change.
    input.assertCurrent();
    return { ...error, files, failedFile: { index, name: path.basename(paths[index]!) } };
  };
  try {
    for (; index < paths.length; index++) {
      const sourcePath = paths[index]!;
      input.assertCurrent();
      const source = await fs.open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await source.stat();
        input.assertCurrent();
        if (!stat.isFile()) return failure({ ok: false, errorCode: 'INVALID_REQUEST', message: '只能选择普通文件' });
        const limit = input.into === 'media' ? GHOST_CINDY_DEPOSIT_MAX_BYTES : DEFAULT_LIBRARY_LIMITS.streamMaxTotalBytes;
        if (stat.size > limit) return failure({ ok: false, errorCode: 'TOO_LARGE', message: '文件超出导入上限', limitBytes: limit });
        let prefix = Buffer.alloc(Math.min(stat.size, 65536));
        await source.read(prefix, 0, prefix.length, 0);
        const mp3ProbeBytes = additionalMp3BytesNeeded(prefix);
        if (mp3ProbeBytes !== null && mp3ProbeBytes > prefix.length && mp3ProbeBytes <= stat.size) {
          prefix = Buffer.alloc(mp3ProbeBytes);
          await source.read(prefix, 0, prefix.length, 0);
        }
        const mediaMime = sniffMediaMime(prefix);
        const mimeType = mediaMime ?? (prefix.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : 'application/octet-stream');
        const name = path.basename(sourcePath);
        let read = 0;
        async function* chunks() {
          for await (const chunk of source.createReadStream({ start: 0, autoClose: false, emitClose: false })) {
            input.assertCurrent();
            read += chunk.byteLength;
            if (read > stat.size) throw new Error('FILE_CHANGED');
            yield chunk as Buffer;
          }
          if (read !== stat.size) throw new Error('FILE_CHANGED');
        }
        if (input.into === 'library') {
          // Reserve both the 64-character segment and the remaining full-path budget for the 42-character prefix.
          // The original display name is returned separately, unchanged.
          const safeName = `file-${randomUUID()}-${name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-(nameBudget - 42)).replace(/[.]+$/, '')}`;
          const saved = await deps.importLibrary(ghostId, { path: `${directory}/${safeName}`, source: chunks(), totalBytes: stat.size,
            assertCurrent: input.assertCurrent, onProgress: bytes => progress?.(completed + bytes, undefined, '正在导入文件') });
          if (!saved.ok) return failure({ ok: false, errorCode: 'INTERNAL', message: saved.message });
          files.push({ name, size: stat.size, mimeType, ref: saved.ref, sha256: saved.sha256 });
        } else {
          if (!mediaMime || !supportedMime(mediaMime)) return failure({ ok: false, errorCode: 'UNSUPPORTED', message: '媒体库只收按字节识别的图片、视频、音频或 glb' });
          const release = await acquireGhostDepositLock(ghostId);
          try {
            input.assertCurrent();
            const used = await deps.usageBytes(ghostId);
            input.assertCurrent();
            if (used + stat.size > GHOST_CINDY_DEPOSIT_QUOTA_BYTES) return failure({ ok: false, errorCode: 'TOO_LARGE', message: '插件媒体寄存已达配额', limitBytes: GHOST_CINDY_DEPOSIT_QUOTA_BYTES });
            const temp = await fs.mkdtemp(path.join(deps.tempRoot, 'cindy-pick-'));
            try {
              const staging = path.join(temp, 'media');
              const out = await fs.open(staging, 'wx', 0o600);
              try {
                for await (const chunk of chunks()) {
                  await out.writeFile(chunk);
                  progress?.(completed + read, undefined, '正在导入文件');
                }
              } finally { await out.close(); }
              input.assertCurrent();
              const staged = await fs.open(staging, 'r');
              try {
                const actualPrefix = Buffer.alloc(prefix.length);
                await staged.read(actualPrefix, 0, actualPrefix.length, 0);
                if (sniffMediaMime(actualPrefix) !== mediaMime) throw new Error('FILE_CHANGED');
              } finally { await staged.close(); }
              const saved = await deps.deposit(ghostId, staging, mediaMime, input.assertCurrent);
              files.push({ name, size: stat.size, mimeType, ref: saved.url });
            } finally { await fs.rm(temp, { recursive: true, force: true }); }
          } finally { release(); }
        }
        completed += stat.size;
        input.assertCurrent();
      } finally { await source.close(); }
    }
    return { ok: true, name: files[0]?.name ?? '', files };
  } catch {
    return failure({ ok: false, errorCode: 'INTERNAL', message: '文件导入失败，请检查文件后重试' });
  } finally { progress?.(undefined, undefined, '文件导入结束'); }
}
