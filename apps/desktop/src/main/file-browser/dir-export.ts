/**
 * dir-export — 远程文件夹下载的被控端执行体(remote-op `exportDirStart` / `exportDirStatus`)。
 *
 * 打包 + 传输是分钟级长任务,与 exportFile 同样走两段式:Start 立即回 transferId,
 * 后台先把目录打成 tar(dir-archive.ts),再按 2GB 分段推给发起下载的控制端——
 * 每段先试直连附件,不行回落 OSS,与跨电脑复制任务同一套传输(sendParts)。
 * 控制端轮询 Status 拿进度,终态带回分段引用,由控制端取件、解包。
 *
 * 生命周期:
 *  - 临时 tar 与分段都在被控端临时目录下的任务专属目录里,终态即删;
 *  - 控制端超过 ABANDON_MS 没来问进度(断线、关窗、退出)视为放弃,中止打包 / 传输;
 *  - 终态 job 保留一段时间,让回包丢失后的重查仍拿到同一结果(与 exportFile 同理)。
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  buildAttachmentOssRef,
  parsePeerAttachmentRef,
  FILE_PEER_MAX_BYTES,
  type MigrationFile,
  type MigrationFileRef,
} from '@cindy/device-link';

import { app } from 'electron';

import { remoteInvoke } from '../device-link/index.js';
import { tryUploadPeerAttachment } from '../device-link/filePeer.js';
import { MAX_MEDIA_BYTES, removeRemote, uploadLocalFile } from '../device-link/mediaTransfer.js';
import { createLogger } from '../logger.js';
import { packDirectory } from './dir-archive.js';
import { sendParts } from '../task-migration/transferParts.js';

const log = createLogger('file-browser/dir-export');

const JOB_LINGER_MS = 10 * 60 * 1000;
const ABANDON_MS = 2 * 60 * 1000;

export interface DirExportStatus {
  state: 'packing' | 'sending' | 'done' | 'error';
  /** 打包阶段已写出的 tar 字节。 */
  packed: number;
  /** 传输阶段已送出的字节;total 为 tar 总大小(打包完成前为 0)。 */
  sent: number;
  total: number;
  /** 读不出而跳过的条目数。 */
  skipped: number;
  /** 已推给控制端的分段(含失败终态):控制端放弃下载时据此清掉已收到的直连分段。 */
  parts: MigrationFileRef[];
  file?: MigrationFile;
  message?: string;
}

interface Job extends DirExportStatus {
  polledAt: number;
  abort: AbortController;
}

export interface DirExportDeps {
  /** 本任务专属临时目录的父目录(app temp)。 */
  tempRoot(): string;
  /** 把一段文件推给 controller:先直连,不行回落 OSS;返回分段引用。 */
  sendPart(
    controller: string,
    file: string,
    onProgress: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<MigrationFileRef & { ossKey?: string }>;
  removeRemote(key: string): void;
  maxPartBytes: number;
}

const jobs = new Map<string, Job>();

function finish(id: string, job: Job, patch: Partial<DirExportStatus>): void {
  Object.assign(job, patch);
  const timer = setTimeout(() => jobs.delete(id), JOB_LINGER_MS);
  timer.unref?.();
}

/** 开始导出 `dir`(调用方已完成 workdir 授权与 realpath 越界校验)。 */
export function startDirExport(dir: string, controller: string, deps: DirExportDeps): string {
  const id = `dir_${randomUUID()}`;
  const job: Job = {
    state: 'packing',
    packed: 0,
    sent: 0,
    total: 0,
    skipped: 0,
    parts: [],
    polledAt: Date.now(),
    abort: new AbortController(),
  };
  jobs.set(id, job);
  const watchdog = setInterval(() => {
    if (Date.now() - job.polledAt > ABANDON_MS) job.abort.abort();
  }, ABANDON_MS / 4);
  watchdog.unref?.();
  void runDirExport(job, dir, controller, deps)
    .then((file) => finish(id, job, { state: 'done', file }))
    .catch((err) => {
      log.warn('dir export failed', { id, aborted: job.abort.signal.aborted }, err);
      const message = err instanceof Error ? err.message || err.name : String(err);
      finish(id, job, { state: 'error', message });
    })
    .finally(() => clearInterval(watchdog));
  return id;
}

/** 幂等读取进度;顺带刷新「控制端仍在等」的心跳。 */
export function getDirExportStatus(id: string): DirExportStatus | null {
  const job = jobs.get(id);
  if (!job) return null;
  job.polledAt = Date.now();
  const { state, packed, sent, total, skipped, parts, file, message } = job;
  return { state, packed, sent, total, skipped, parts: [...parts], file, message };
}

async function runDirExport(
  job: Job,
  dir: string,
  controller: string,
  deps: DirExportDeps,
): Promise<MigrationFile> {
  const signal = job.abort.signal;
  const temp = await fsp.mkdtemp(path.join(deps.tempRoot(), 'cindy-dir-export-'));
  const uploaded: string[] = [];
  try {
    const archive = path.join(temp, 'archive.tar');
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        job.packed += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(
      packDirectory(dir, () => job.skipped++),
      count,
      createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    job.total = (await fsp.stat(archive)).size;
    job.state = 'sending';
    const space = await fsp.statfs(temp);
    const partBytes = Math.floor(Math.min(deps.maxPartBytes, (space.bavail * space.bsize) / 4));
    let completed = 0;
    const file = await sendParts(
      archive,
      partBytes,
      async (part) => {
        const ref = await deps.sendPart(
          controller,
          part,
          (bytes) => (job.sent = completed + bytes),
          signal,
        );
        if (ref.ossKey) uploaded.push(ref.ossKey);
        const done = { ref: ref.ref, size: ref.size, sha256: ref.sha256 };
        job.parts.push(done);
        completed += ref.size;
        job.sent = completed;
        return done;
      },
      signal,
    );
    uploaded.length = 0; // 交给控制端取件后删除
    return file;
  } finally {
    for (const key of uploaded) deps.removeRemote(key);
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 生产依赖:直连附件优先,回落 OSS(与跨电脑复制任务的分段发送同语义)。 */
export function createDirExportDeps(): DirExportDeps {
  return {
    tempRoot: () => app.getPath('temp'),
    maxPartBytes: Math.min(FILE_PEER_MAX_BYTES, MAX_MEDIA_BYTES),
    removeRemote: (key) => void removeRemote(key).catch(() => undefined),
    sendPart: async (controller, file, onProgress, signal) => {
      const peer = await tryUploadPeerAttachment(
        controller,
        file,
        'application/x-tar',
        (deviceId, channel, args) => remoteInvoke(deviceId, channel, args),
        onProgress,
        signal,
      );
      if (peer) {
        const parsed = parsePeerAttachmentRef(peer);
        if (!parsed) throw new Error('DIR_EXPORT_TRANSFER_FAILED');
        return { ref: peer, size: parsed.size, sha256: parsed.sha256 };
      }
      onProgress(0); // 回落 OSS:本段重新计数
      const up = await uploadLocalFile(file, {
        maxBytes: (await fsp.stat(file)).size,
        onProgress,
        signal,
      });
      return {
        ref: buildAttachmentOssRef({ ossKey: up.key, size: up.size, sha256: up.sha256 }),
        size: up.size,
        sha256: up.sha256,
        ossKey: up.key,
      };
    },
  };
}

export const __dirExportTesting = { jobs, ABANDON_MS };
