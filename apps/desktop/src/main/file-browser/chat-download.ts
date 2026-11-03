/**
 * chat-download — 远程任务聊天里文件 / 文件夹的「下载到本地」(`maker:chat-file:download`)。
 * ---------------------------------------------------------------------------
 * 统一落到系统「下载」文件夹,重名时自动加编号,返回最终路径供 renderer 在文件
 * 管理器中定位:
 *   - 文件:复用 chat-file.ts 的取回链路(含断线历史副本兜底),再从缓存复制出来;
 *   - 文件夹 + device:被控端打包并分段推送(dir-export.ts),本端收齐后解包;
 *     旧被控端不声明 `dirExport` 能力 → REMOTE_UNSUPPORTED(提示更新,不退回逐个文件);
 *   - 文件夹 + ssh:远端 `tar` 直接流过 SSH exec 通道,本端边收边解包。
 * 文件与文件夹都先落到「下载」文件夹里的隐藏暂存目录,完整成功后先以排他方式占住
 * 最终名字再改名进去,失败即清掉暂存——不留半截内容,并发下载同名项也不会互相覆盖。
 */

import { constants, createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import type { MigrationFile, MigrationFileRef } from '@cindy/device-link';

import { sanitizeSaveFileName } from '../cindy-brain/dirDeposit.js';
import { assertDiskCapacity } from '../task-migration/resources.js';
import { receiveParts } from '../task-migration/transferParts.js';
import type { ChatFileDeps, ChatFileFetchArgs, ChatFileFetchResult } from './chat-file.js';
import { toWorkdirRel } from './chat-file.js';
import { isWorkdirRoot } from '../../shared/workdirPath.js';
import { isTransientDeviceExportStatusError } from './device-export-status-error.js';
import { extractDirectoryArchive } from './dir-archive.js';
import type { DirExportStatus } from './dir-export.js';
import type { FetchProgressFn } from './remote-file-cache.js';

export type ChatDownloadPhase = 'pack' | 'upload' | 'download' | 'extract';
export type ChatDownloadProgress = (
  received: number,
  total: number,
  phase: ChatDownloadPhase,
) => void;

export type ChatDownloadResult =
  | { ok: true; path: string; stale: boolean; skipped: number }
  | {
      ok: false;
      code: Exclude<ChatFileFetchResult, { ok: true }>['code'] | 'REMOTE_UNSUPPORTED' | 'NO_SPACE';
      message?: string;
    };

export interface SshTarStream {
  stream: Readable;
  /** 远端 tar 退出码(通道异常为 null)。 */
  done: Promise<number | null>;
  stderr(): string;
  kill(): void;
}

/** 发起方已消失(窗口关闭 / 渲染进程崩溃):停止轮询与传输,不再落盘。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('DOWNLOAD_CANCELLED');
}

export interface ChatDownloadDeps extends Pick<ChatFileDeps, 'sshStat' | 'deviceStat'> {
  downloadsDir(): string;
  fetchFile(
    args: ChatFileFetchArgs,
    onProgress: FetchProgressFn,
    signal?: AbortSignal,
  ): Promise<ChatFileFetchResult>;
  deviceOp<T>(deviceId: string, args: Record<string, unknown>): Promise<T>;
  /** 取一段被控端推来的引用(直连收件箱移出 / OSS 下载后删除)到 destination。 */
  receivePart(
    deviceId: string,
    part: MigrationFileRef,
    destination: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /** 放弃一段不会再取的引用(直连收件箱删除 / OSS 对象删除),best-effort。 */
  discardPart(deviceId: string, part: MigrationFileRef): Promise<void>;
  /** 在 SSH 远端以 `absDir` 为根打 tar 并流回。 */
  sshTar(hostId: string, absDir: string): Promise<SshTarStream>;
  pollMs?: number;
}

const POLL_MS = 1500;
const MAX_TRANSIENT_POLL_FAILURES = 20;

function errorCode(err: unknown): Exclude<ChatDownloadResult, { ok: true }>['code'] {
  const message = String(err);
  if (/REMOTE_UNSUPPORTED/.test(message)) return 'REMOTE_UNSUPPORTED';
  if (/MIGRATION_NO_SPACE|ENOSPC/.test(message)) return 'NO_SPACE';
  return 'FETCH_FAILED';
}

/** 第 n 个重名在扩展名前插 " (n)"(`Game.app` → `Game (1).app`)。 */
function candidateName(name: string, n: number): string {
  if (n === 0) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/**
 * 把暂存内容改名为「下载」文件夹里的最终名字。先排他创建同名占位(文件 `wx` / 目录
 * mkdir)原子占住名字,再 rename 覆盖占位:并发下载或其他程序同时建同名项时只会
 * 让出编号,不会覆盖已有内容。
 */
async function placeEntry(
  source: string,
  dir: string,
  name: string,
  directory: boolean,
): Promise<string> {
  for (let n = 0; ; n++) {
    const target = path.join(dir, candidateName(name, n));
    try {
      if (directory) await fsp.mkdir(target);
      else await fsp.writeFile(target, '', { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      // Windows 不允许 rename 覆盖目录:撤掉占位再改名(窗口极短)。
      if (directory && process.platform === 'win32') await fsp.rmdir(target);
      await fsp.rename(source, target);
      return target;
    } catch (err) {
      await (directory ? fsp.rmdir(target) : fsp.rm(target, { force: true })).catch(
        () => undefined,
      );
      throw err;
    }
  }
}

function isRef(value: unknown): value is MigrationFileRef {
  const r = value as MigrationFileRef;
  return (
    !!r &&
    typeof r.ref === 'string' &&
    r.ref.length <= 4096 &&
    Number.isSafeInteger(r.size) &&
    r.size >= 0 &&
    typeof r.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(r.sha256)
  );
}

function parseExportedFile(value: unknown): MigrationFile | null {
  if (isRef(value)) return value;
  const v = value as { size?: unknown; parts?: unknown };
  if (!v || !Number.isSafeInteger(v.size) || !Array.isArray(v.parts) || v.parts.length > 10_000)
    return null;
  if (!v.parts.every(isRef)) return null;
  const parts = v.parts as MigrationFileRef[];
  const size = parts.reduce((sum, p) => sum + p.size, 0);
  return size === v.size ? { size, parts } : null;
}

async function downloadDeviceDirectory(
  deviceId: string,
  workdir: string,
  relPath: string,
  staging: string,
  root: string,
  onProgress: ChatDownloadProgress,
  deps: ChatDownloadDeps,
  signal?: AbortSignal,
): Promise<number> {
  const caps = await deps
    .deviceOp<{ dirExport?: boolean }>(deviceId, { op: 'caps', workdir })
    .catch(() => null);
  if (caps?.dirExport !== true) throw new Error('REMOTE_UNSUPPORTED');
  const start = await deps.deviceOp<{ ok: boolean; transferId?: string; message?: string }>(
    deviceId,
    { op: 'exportDirStart', workdir, relPath },
  );
  if (!start?.ok || !start.transferId) throw new Error(start?.message ?? 'exportDirStart failed');
  // 被控端已推来的分段:下载失败时逐个放弃,不让直连分段在收件箱里滞留。
  const known = new Map<string, MigrationFileRef>();
  const taken = new Set<string>();
  const remember = (parts: unknown) => {
    if (Array.isArray(parts)) for (const p of parts) if (isRef(p)) known.set(p.ref, p);
  };
  try {
    const status = await waitDirExport(
      deviceId,
      workdir,
      start.transferId,
      remember,
      onProgress,
      deps,
      signal,
    );
    const file = parseExportedFile(status.file);
    if (!file) throw new Error('invalid exported file');
    remember('parts' in file ? file.parts : [file]);
    const archive = path.join(staging, 'archive.tar');
    let received = 0;
    await receiveParts(file, archive, async (part, destination) => {
      throwIfAborted(signal);
      await deps.receivePart(
        deviceId,
        part,
        destination,
        (bytes) => onProgress(received + bytes, file.size, 'download'),
        signal,
      );
      taken.add(part.ref);
      received += part.size;
    });
    throwIfAborted(signal);
    onProgress(0, file.size, 'extract');
    await assertDiskCapacity([{ path: staging, bytes: file.size }]);
    return (await extractDirectoryArchive(createReadStream(archive), root)) + status.skipped;
  } catch (err) {
    for (const [ref, part] of known)
      if (!taken.has(ref)) await deps.discardPart(deviceId, part).catch(() => undefined);
    throw err;
  }
}

/** 轮询被控端导出到 done;每次回包里已推送的分段交给 remember。 */
async function waitDirExport(
  deviceId: string,
  workdir: string,
  transferId: string,
  remember: (parts: unknown) => void,
  onProgress: ChatDownloadProgress,
  deps: ChatDownloadDeps,
  signal?: AbortSignal,
): Promise<DirExportStatus> {
  for (let transient = 0; ;) {
    await new Promise((r) => setTimeout(r, deps.pollMs ?? POLL_MS));
    // 停止轮询后,被控端 2 分钟内自行中止打包 / 推送。
    throwIfAborted(signal);
    let status: (DirExportStatus & { ok: boolean }) | undefined;
    try {
      status = await deps.deviceOp(deviceId, { op: 'exportDirStatus', workdir, transferId });
      transient = 0;
    } catch (err) {
      // relay 瞬断只影响「问进度」,被控端的打包与推送照常进行。
      if (isTransientDeviceExportStatusError(err) && ++transient <= MAX_TRANSIENT_POLL_FAILURES)
        continue;
      throw err;
    }
    if (!status?.ok) throw new Error(status?.message ?? 'exportDirStatus failed');
    remember(status.parts);
    if (status.state === 'error') throw new Error(status.message ?? 'remote export failed');
    if (status.state === 'packing') onProgress(status.packed, 0, 'pack');
    else onProgress(status.sent, status.total, 'upload');
    if (status.state === 'done') return status;
  }
}

async function downloadSshDirectory(
  hostId: string,
  absDir: string,
  root: string,
  onProgress: ChatDownloadProgress,
  deps: ChatDownloadDeps,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const tar = await deps.sshTar(hostId, absDir);
  const onAbort = () => tar.stream.destroy(new Error('DOWNLOAD_CANCELLED'));
  signal?.addEventListener('abort', onAbort, { once: true });
  let received = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      onProgress(received, 0, 'download');
      done(null, chunk);
    },
  });
  let skipped: number;
  try {
    skipped = await extractDirectoryArchive(tar.stream.pipe(count), root);
  } catch (err) {
    tar.kill();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const code = await tar.done;
  if (code === 0) return skipped;
  // 没有退出码 = 通道异常关闭(断线等):流可能恰好停在条目边界、解包不报错,但内容
  // 缺了未知部分,一律失败。tar 读不了个别文件时仍写出其余内容并以非零退出码结束,
  // 只要收到过内容就按「部分跳过」处理;一个字节都没有(目录不存在、没装 tar)才算失败。
  if (code === null || received === 0) {
    throw new Error(`remote tar failed (${code}): ${tar.stderr()}`);
  }
  return skipped + 1;
}

/** 下载主编排。所有失败都折叠成结构化 code,不 throw。 */
export async function downloadChatEntry(
  args: ChatFileFetchArgs,
  onProgress: ChatDownloadProgress,
  deps: ChatDownloadDeps,
  signal?: AbortSignal,
): Promise<ChatDownloadResult> {
  const { origin, workdir, absPath } = args ?? ({} as ChatFileFetchArgs);
  if (
    !workdir ||
    !absPath ||
    !origin ||
    (origin.kind !== 'device' && origin.kind !== 'ssh') ||
    (origin.kind === 'device' && !origin.deviceId) ||
    (origin.kind === 'ssh' && !origin.remoteHostId)
  ) {
    return { ok: false, code: 'BAD_ARGS' };
  }
  // 引用的正好是工作目录本身时按目录下载(toWorkdirRel 对根返回 null)。
  const isRoot = isWorkdirRoot(workdir, absPath);
  const relPath = isRoot ? '' : toWorkdirRel(workdir, absPath);
  let isDirectory = isRoot;
  if (relPath) {
    try {
      const stat =
        origin.kind === 'ssh'
          ? await deps.sshStat(origin.remoteHostId, workdir, relPath)
          : await deps.deviceStat(origin.deviceId, workdir, relPath);
      isDirectory = stat.type === 'directory';
    } catch {
      // 不存在 / 链路断:交给文件取回链路给出 NOT_FOUND 或历史副本兜底。
    }
  }
  const name = sanitizeSaveFileName(absPath.split(/[\\/]/).filter(Boolean).pop());
  const downloads = deps.downloadsDir();

  let staging: string | null = null;
  try {
    if (!isDirectory) {
      const fetched = await deps.fetchFile(
        args,
        (received, total, phase) => onProgress(received, total, phase ?? 'download'),
        signal,
      );
      if (!fetched.ok) return fetched;
      throwIfAborted(signal);
      await fsp.mkdir(downloads, { recursive: true });
      staging = await fsp.mkdtemp(path.join(downloads, '.cindy-download-'));
      const copy = path.join(staging, 'file');
      await fsp.copyFile(fetched.cachePath, copy, constants.COPYFILE_FICLONE);
      throwIfAborted(signal);
      const target = await placeEntry(copy, downloads, name, false);
      return { ok: true, path: target, stale: fetched.stale, skipped: 0 };
    }
    await fsp.mkdir(downloads, { recursive: true });
    staging = await fsp.mkdtemp(path.join(downloads, '.cindy-download-'));
    const root = path.join(staging, 'root');
    await fsp.mkdir(root);
    const skipped =
      origin.kind === 'ssh'
        ? await downloadSshDirectory(
            origin.remoteHostId,
            path.posix.join(workdir, relPath ?? ''),
            root,
            onProgress,
            deps,
            signal,
          )
        : await downloadDeviceDirectory(
            origin.deviceId,
            workdir,
            relPath ?? '',
            staging,
            root,
            onProgress,
            deps,
            signal,
          );
    throwIfAborted(signal);
    const target = await placeEntry(root, downloads, name, true);
    return { ok: true, path: target, stale: false, skipped };
  } catch (err) {
    return { ok: false, code: errorCode(err), message: String(err) };
  } finally {
    if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
