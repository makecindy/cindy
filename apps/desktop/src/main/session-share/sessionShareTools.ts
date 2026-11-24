import { constants as fsConstants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { LiziMcpSessionContext, SessionShareCallbacks } from '@cindy/mcps';
import { GHOST_HANDOFF_MAX_BYTES_PER_FILE, type GhostHandoffFile } from '../../shared/ghost.js';
import { readBoundedFileNoFollow, readToLength } from '../utils/readBoundedFile.js';
import type { SessionShareExportOptions, SessionShareExportOutcome } from './sessionShareExport.js';
import type { CommitShareImportOptions, CommitShareImportResult, InspectResult } from './sessionShareImport.js';

/** The packer caps unpacked content at 256 MiB; this only bounds reading back its own output. */
const PRESET_EXPORT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Case-preserving comparison of canonical paths; only a Windows drive letter is normalised (as in
 * readBoundedFile.ts), because directories with per-directory case sensitivity can differ by case.
 */
function sameRealPathExactCase(a: string, b: string): boolean {
  const drive = (value: string) => process.platform === 'win32'
    ? value.replace(/^([A-Za-z]):/, (_, letter: string) => `${letter.toLowerCase()}:`)
    : value;
  return drive(a) === drive(b);
}

const EXCLUSIVE_CREATE = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);

function dedupeExportName(fileName: string, n: number): string {
  if (n === 0) return fileName;
  const ext = path.extname(fileName);
  return `${fileName.slice(0, fileName.length - ext.length)} (${n})${ext}`;
}

/** dev/ino of 0 (some SMB/FUSE volumes) cannot prove a path still names our file. */
function hasVerifiableIdentity(stat: BigIntStats): boolean {
  return stat.dev !== 0n && stat.ino !== 0n;
}

/**
 * The single cleanup path. While our handle is open, empty the file through it (that reaches the
 * created file even if its folder was moved), then close. Remove the path only when it still
 * provably names our file; with an unverifiable identity, remove it only if it is still empty.
 */
async function discardExportFile(handle: FileHandle | null, target: string, created: BigIntStats | null): Promise<void> {
  if (handle) {
    if (created) await handle.truncate(0).catch(() => {});
    await handle.close().catch(() => {});
  }
  if (!created) return;
  const current = await fs.lstat(target, { bigint: true }).catch(() => null);
  if (!current?.isFile()) return;
  const ours = hasVerifiableIdentity(created)
    ? current.dev === created.dev && current.ino === created.ino
    : current.size === 0n;
  if (ours) await fs.unlink(target).catch(() => {});
}

/**
 * Writes an export into the owner-approved folder. Invariants (#12461):
 * - creates a new file directly in `directory` (O_EXCL, no link following); never overwrites, adds " (n)";
 * - async I/O only, so a slow volume never blocks Main;
 * - fails closed where file identity cannot be verified (dev/ino of 0);
 * - while still holding the handle, after writing: the path names the created file and `directory`
 *   still resolves to itself (case preserved); otherwise the bytes are emptied through the handle;
 * - the caller's authorization is checked again after close, immediately before success.
 * Out of scope: the folder being moved by the same user in the instant between close and that
 * last check while authorization is also revoked (they could move the finished file anyway).
 */
export async function writeExportFileExclusive(
  directory: string, fileName: string, bytes: Uint8Array, assertCurrent: () => void,
): Promise<string | null> {
  const resolvesToItself = async () => sameRealPathExactCase(await fs.realpath(directory).catch(() => ''), directory);
  for (let n = 0; n < 1000; n++) {
    assertCurrent();
    if (!await resolvesToItself()) return null;
    const name = dedupeExportName(fileName, n);
    const target = path.join(directory, name);
    let handle: FileHandle | null;
    try {
      handle = await fs.open(target, EXCLUSIVE_CREATE, 0o666);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return null;
    }
    let created: BigIntStats | null = null;
    let committed = false;
    try {
      created = await handle.stat({ bigint: true });
      if (!created.isFile() || !hasVerifiableIdentity(created)) return null;
      assertCurrent();
      await handle.writeFile(bytes);
      const onDisk = await fs.lstat(target, { bigint: true });
      if (!onDisk.isFile() || onDisk.dev !== created.dev || onDisk.ino !== created.ino || !await resolvesToItself()) return null;
      const open = handle;
      handle = null;
      await open.close();
      assertCurrent();
      committed = true;
      return name;
    } catch {
      return null;
    } finally {
      if (!committed) await discardExportFile(handle, target, created);
    }
  }
  return null;
}

/** The two callers share native package services; only their file handoff differs. */
export function createSessionShareToolCallbacks(ports: {
  capture(context: LiziMcpSessionContext): Promise<{ pluginId?: string; assertCurrent(): void }>;
  exportShare(options: SessionShareExportOptions): Promise<SessionShareExportOutcome>;
  inspectShare(filePath: string, approvedBytes?: Buffer): Promise<InspectResult>;
  commitShare(options: CommitShareImportOptions, assertCurrent: () => void): Promise<CommitShareImportResult>;
  cancelDraft(draftId: string): void;
  chooseExportPath(sessionId: string): Promise<string | null>;
  /**
   * Owner-chosen folder for Agent exports — the canonical path recorded when it was approved — and
   * the file name to use; null = ask with the dialog. Throws EXPORT_DIRECTORY_UNAVAILABLE when the
   * setting exists but cannot be used.
   */
  presetExportDestination(sessionId: string): Promise<{ directory: string; fileName: string } | null>;
  openImportWizard(filePath: string): void;
  handoff(): {
    import(instance: string, files: Array<{ name: string; bytes: Uint8Array }>, assertCurrent: () => void): Promise<Array<Pick<GhostHandoffFile, 'ref' | 'name' | 'size' | 'sha256'>>>;
    open(instance: string, ref: string): Promise<{ filePath: string; file: FileHandle; info: Pick<GhostHandoffFile, 'size' | 'sha256'> } | null>;
    touch(instance: string, refs: readonly string[]): Promise<void>;
  };
}): SessionShareCallbacks {
  const fail = (error: unknown) => {
    const value = error as { code?: unknown; message?: unknown } | null;
    const candidate = typeof value?.code === 'string' ? value.code : value?.message;
    const known = new Set(['PERMISSION_DENIED', 'INVALID_ARGS', 'UNSUPPORTED_CAPABILITY', 'HANDOFF_UNAVAILABLE',
      'HANDOFF_TOO_LARGE', 'HOST_NOT_READY', 'NOT_FOUND', 'PRECONDITION_FAILED', 'SHARE_EXPORT_FAILED', 'SHARE_IMPORT_FAILED',
      'SHARE_FILE_INVALID', 'SHARE_VERSION_UNSUPPORTED', 'SHARE_CONFLICT', 'SHARE_WORKTREE_NOT_GIT', 'SHARE_WORKTREE_FAILED',
      'EXPORT_DIRECTORY_UNAVAILABLE']);
    const errorCode = typeof candidate === 'string' && known.has(candidate) ? candidate : 'SHARE_TRANSFER_FAILED';
    const hints: Record<string, string> = {
      HANDOFF_UNAVAILABLE: 'Obtain a new file through the existing authorized handoff flow.',
      HANDOFF_TOO_LARGE: 'The package exceeds the existing 64 MiB handoff limit. Export without media or use the native export UI.',
      SHARE_CONFLICT: 'The package conflicts with an existing task. Replace it only when the owner intends to overwrite.',
      PERMISSION_DENIED: 'The caller or account changed. Check the current task state before retrying.',
      EXPORT_DIRECTORY_UNAVAILABLE: 'The export folder set in Settings → Storage could not be written. Ask the owner to check or change it there.',
    };
    return { ok: false as const, errorCode, message: hints[errorCode] ?? `Native task transfer failed (${errorCode}). Check the source and current task state before retrying.` };
  };
  const agentPath = (context: LiziMcpSessionContext, value: string) => {
    if (!context.sessionId || !path.isAbsolute(context.workingDir) || value.includes('\0')) throw new Error('INVALID_ARGS');
    return path.resolve(context.workingDir, value);
  };
  return {
    export: async (params, context) => {
      let temporary: string | undefined;
      try {
        const scope = await ports.capture(context);
        scope.assertCurrent();
        if (context.remoteHostId || params.sessionId.includes('::')) throw new Error('UNSUPPORTED_CAPABILITY');
        let targetPath: string | null;
        // An owner-chosen folder skips the dialog. The packer still writes only into a
        // private temporary folder; the result is then created in the chosen folder
        // without overwriting or following links (#9979 kept caller paths out).
        const preset = scope.pluginId ? null : await ports.presetExportDestination(params.sessionId);
        scope.assertCurrent();
        // The approved location must still be its own canonical path: a folder or ancestor later
        // replaced by a symlink or junction would otherwise redirect the export.
        if (preset && !sameRealPathExactCase(await fs.realpath(preset.directory).catch(() => ''), preset.directory)) {
          throw new Error('EXPORT_DIRECTORY_UNAVAILABLE');
        }
        if (scope.pluginId || preset) {
          temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-task-export-')));
          targetPath = path.join(temporary, 'task.cshare');
        } else targetPath = await ports.chooseExportPath(params.sessionId);
        scope.assertCurrent();
        if (!targetPath) return { ok: true, scope: 'local', status: 'canceled' };
        const result = await ports.exportShare({ sessionId: params.sessionId, targetPath, excludeMedia: params.excludeMedia });
        scope.assertCurrent();
        if (result.status === 'oversize') return { ok: true, scope: 'local', status: 'oversize',
          total_bytes: result.totalBytes, media_bytes: result.mediaBytes, limit_bytes: result.limitBytes };
        const summary = { ok: true as const, scope: 'local', status: 'ok', fidelity: result.fidelity,
          unpacked_bytes: result.unpackedBytes, missing_transcript_count: result.missingTranscripts.length,
          media_missing: result.mediaMissing, media_dropped: result.mediaDropped, orca_workers: result.orcaWorkers };
        if (preset) {
          const packed = await readBoundedFileNoFollow(targetPath, PRESET_EXPORT_MAX_BYTES,
            { containWithin: temporary!, verifyContentStability: true });
          scope.assertCurrent();
          if (!packed) throw new Error('SHARE_EXPORT_FAILED');
          const written = await writeExportFileExclusive(preset.directory, preset.fileName, packed, scope.assertCurrent);
          if (!written) {
            scope.assertCurrent();
            throw new Error('EXPORT_DIRECTORY_UNAVAILABLE');
          }
          return { ...summary, file_path: path.join(preset.directory, written) };
        }
        if (!scope.pluginId) return { ...summary, file_path: result.filePath };
        const bytes = await readBoundedFileNoFollow(targetPath, GHOST_HANDOFF_MAX_BYTES_PER_FILE,
          { containWithin: temporary!, verifyContentStability: true });
        scope.assertCurrent();
        if (!bytes) throw new Error('HANDOFF_TOO_LARGE');
        const [file] = await ports.handoff().import(scope.pluginId, [{ name: 'task.cshare', bytes }], scope.assertCurrent);
        scope.assertCurrent();
        return { ...summary, attachment_ref: file.ref, name: file.name, size: file.size, sha256: file.sha256 };
      } catch (error) { return fail(error); }
      finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}); }
    },
    import: async (params, context) => {
      let draftId: string | undefined;
      let opened: { file: FileHandle; filePath: string; info: Pick<GhostHandoffFile, 'size' | 'sha256'> } | null = null;
      try {
        const scope = await ports.capture(context);
        scope.assertCurrent();
        if (context.remoteHostId) throw new Error('UNSUPPORTED_CAPABILITY');
        let filePath: string;
        let approvedBytes: Buffer | undefined;
        if (scope.pluginId) {
          if (!params.attachmentRef || params.filePath !== undefined || params.workingDir !== undefined) throw new Error('INVALID_ARGS');
          opened = await ports.handoff().open(scope.pluginId, params.attachmentRef);
          scope.assertCurrent();
          if (!opened) throw new Error('HANDOFF_UNAVAILABLE');
          filePath = opened.filePath;
          if (opened.info.size > GHOST_HANDOFF_MAX_BYTES_PER_FILE) throw new Error('HANDOFF_TOO_LARGE');
          approvedBytes = await readToLength(opened.file, opened.info.size);
          scope.assertCurrent();
          if (approvedBytes.byteLength !== opened.info.size || (await opened.file.stat()).size !== opened.info.size ||
            createHash('sha256').update(approvedBytes).digest('hex') !== opened.info.sha256) throw new Error('HANDOFF_UNAVAILABLE');
        } else {
          if (!params.filePath || params.attachmentRef !== undefined) throw new Error('INVALID_ARGS');
          filePath = agentPath(context, params.filePath);
        }
        const inspected = approvedBytes ? await ports.inspectShare(filePath, approvedBytes) : await ports.inspectShare(filePath);
        draftId = inspected.draftId;
        scope.assertCurrent();
        if (scope.pluginId) {
          await ports.handoff().touch(scope.pluginId, [params.attachmentRef!]);
          scope.assertCurrent();
        }
        if (inspected.encrypted || inspected.preview.workspaceKind === 'project' && !params.workingDir) {
          ports.openImportWizard(filePath);
          return { ok: true, scope: 'local', status: 'awaiting_user',
            reason: inspected.encrypted ? 'password_required' : 'working_directory_required' };
        }
        const result = await ports.commitShare({ draftId, overwrite: params.overwrite, useWorktree: params.useWorktree,
          workingDir: params.workingDir ? agentPath(context, params.workingDir) : undefined }, scope.assertCurrent);
        scope.assertCurrent();
        return { ok: true, scope: 'local', status: 'imported', session_id: result.sessionId,
          fidelity: result.fidelity, notes: result.notes, orca_workers: result.orcaWorkers };
      } catch (error) { return fail(error); }
      finally {
        if (draftId) ports.cancelDraft(draftId);
        await opened?.file.close().catch(() => {});
      }
    },
  };
}
