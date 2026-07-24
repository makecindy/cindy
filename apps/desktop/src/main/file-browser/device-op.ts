/**
 * device-op — device-link 远程文件浏览的被控端执行层。
 *
 * 控制端经隧道 `deviceLink.invoke(deviceId, 'file-browser:remote-op', [args])`
 * 到达这里(invoke-registry 捕获本文件注册的 ipcMain.handle;本机 renderer
 * 不调用该 channel)。单聚合 channel 的取舍见 @cindy/device-link allowlist.ts
 * 的准入注释:老被控端 CHANNEL_NOT_ALLOWED = 能力全无,控制端渲染"设备版本
 * 过旧"占位。
 *
 * 安全:
 *  - workdir 先经 `checkRemoteWorkingDir` 探测被控端本地可访问性,再结合已有
 *    SSH session 的 remoteHostId 解析唯一执行端点。本地与 SSH 同时命中或
 *    多个 SSH host 命中时显式拒绝,不猜测执行位置。
 *  - 路径穿越在 scanner 层拦(assertInsideWorkdir + realpath),与本地一致。
 *
 * 嵌套(device-link 套 SSH):本地探测即使失败或超时,唯一 SSH 归属仍经
 * RemoteFileBrowserManager 二跳到 SSH daemon,
 * 控制端免费获得二级转发(写进 PR 测试路径)。
 *
 * oversize:readFile 结果超 relay 帧限(MAX_FRAME_BYTES=2MiB)前主动预判,
 * 回结构化 `{ ok:false, code:'OVERSIZE', stat }`,对齐本地 read-file 的
 * 不可预览占位卡语义,绝不裸炸 FRAME_TOO_LARGE。
 *
 * gzip(应用层压缩,协议零改动):新控制端经 `caps` op 探测能力后,writeFile
 * 大内容以 `contentGz`(gzip+base64)发送、readFile 带 `acceptGzip` 请求编码
 * 返回;老端组合全部自动降级为明文(未知 op / 未知字段被确定性拒绝或忽略)。
 * 见 renderer 的 fileBrowserTransport 与本文件 encodeReadFileResult。
 *
 * watch:不走本 channel——控制端订阅 `fs-watch:<workdir>` topic,subscriptions
 * 数据层的 subscribed/released 钩子驱动本文件的 watch 引擎启停(订阅即
 * watch;断链清理/重连重放天然覆盖)。事件经 pushToTopicSubscribers 推回。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';
import { eq, isNotNull, and } from 'drizzle-orm';
import {
  listAllFiles,
  listDir,
  loadIgnoreMatcher,
  readFile,
  writeFile,
  createFile,
  createFolder,
  renameEntry,
  deleteEntry,
  statEntry,
  RipgrepSearcher,
  type SearchEvent,
  type SearchMatch,
} from '@cindy/file-browser-core';
import {
  FILE_BROWSER_EVENT_CHANNEL,
  FILE_BROWSER_REMOTE_OP_CHANNEL,
  parseFsWatchTopic,
} from '@cindy/device-link';
import { WorkdirWatchManager } from '@cindy/remote-file-service';

import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import {
  checkRemoteWorkingDir,
  remoteWorkingDirRejectionToIpcError,
  type RemoteWorkingDirCheckResult,
} from '../device-link/remote-workdir-guard.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { uploadLocalFile } from '../device-link/mediaTransfer.js';
import { pushToTopicSubscribers } from '../device-link/dispatch.js';
import * as subscriptions from '../device-link/subscriptions.js';
import { getRipgrepBinaryPath } from '../maker-host/runtime-configs.js';
import { getRemoteFileBrowser } from './remote-deps.js';
import { generateFileThumbnail } from './thumbnail.js';

const log = createLogger('file-browser/device-op');

/**
 * readFile 内容的 device-link 上限。量纲必须与帧限一致:relay 单帧
 * MAX_FRAME_BYTES=2MiB 按 **UTF-8 字节**判(见 @cindy/device-link client),
 * 而 content.length 是 UTF-16 码元——中文 1 字符 = 3 字节、JSON 转义(引号 /
 * 反斜杠 / 换行)还会再膨胀,按字符数预判会放行必超帧的内容(core readFile
 * 按 2MiB 字节截断,≥2MiB 的中文文件恰好全量踩中)。用 JSON.stringify 后的
 * 字节数精确覆盖两种膨胀,再给 envelope 留余量。超出回 OVERSIZE(带 stat
 * 供占位卡),不截断——半个文件比明确的"文件过大"更糟。
 */
const DEVICE_READ_MAX_JSON_BYTES = 1_800_000;

/** content 序列化进 invoke-result 帧后是否会逼近帧限(≤2MiB 字符串一次 stringify 开销可忽略)。 */
function exceedsFrameBudget(content: string): boolean {
  return Buffer.byteLength(JSON.stringify(content), 'utf8') > DEVICE_READ_MAX_JSON_BYTES;
}

const gzipAsync = promisify(gzipCb);
const gunzipAsync = promisify(gunzipCb);

/**
 * contentGz 解压输出上限:被写入内容本受 core writeFile 的 2MiB 上限约束,
 * 给足余量后拒绝更大的解压结果——gzip 可 1000:1 膨胀,不设上限的话一个几 KB
 * 的 gzip bomb 能在被控端一次性分配到 node 默认 ~2GB,是解压炸弹向量。
 * 超限由 zlib 直接报错,走与损坏 contentGz 同一条结构化错误路径。
 */
const CONTENT_GZ_MAX_DECODED_BYTES = 4 * 1024 * 1024;

/**
 * readFile 出口的按需 gzip 编码(本地与 SSH 二跳分支共用)。
 *
 * 明文不超帧 → 原样返回(小文件不压,省 CPU 且响应形状对老控制端无歧义);
 * 超帧且控制端声明 acceptGzip → gzip+base64,编码后仍在预算内则以
 * `contentEncoding:'gzip'` 返回——CJK 大文档的可编辑上限由此从明文 JSON
 * 膨胀撞线(~1.5MB)提升到 core 读取截断上限(2MiB);编码后仍超(不可压缩
 * 内容)→ 维持 OVERSIZE 占位语义。老控制端不带 acceptGzip,永远走明文/OVERSIZE。
 */
async function encodeReadFileResult(
  data: { relPath: string; content: string; size: number; mtimeMs: number; truncated?: boolean },
  acceptGzip: boolean | undefined,
): Promise<unknown> {
  if (!exceedsFrameBudget(data.content)) {
    return { ok: true as const, data };
  }
  if (acceptGzip === true) {
    const gzB64 = (await gzipAsync(Buffer.from(data.content, 'utf8'))).toString('base64');
    if (!exceedsFrameBudget(gzB64)) {
      return {
        ok: true as const,
        data: { ...data, content: gzB64, contentEncoding: 'gzip' as const },
      };
    }
  }
  return {
    ok: false as const,
    code: 'OVERSIZE' as const,
    stat: { relPath: data.relPath, type: 'file' as const, size: data.size, mtimeMs: data.mtimeMs },
  };
}

/** searchCollect 收集上限:500 条 match × ~200B ≈ 100KB,离帧限很远。 */
const SEARCH_COLLECT_MAX_MATCHES = 500;
const SEARCH_COLLECT_TIMEOUT_MS = 20_000;

interface RemoteOpArgs {
  op: string;
  workdir: string;
  relPath?: string;
  fromRel?: string;
  toRel?: string;
  content?: string;
  /** writeFile 内容的 gzip+base64 形态(与 content 互斥;控制端仅在 caps 探测确认后发)。 */
  contentGz?: string;
  /** readFile:控制端声明可接受 gzip 编码返回(老被控端忽略此字段,无害)。 */
  acceptGzip?: boolean;
  hideMetaFiles?: boolean;
  docMode?: boolean;
  cap?: number;
  query?: string;
  caseSensitive?: boolean;
  maxMatches?: number;
  transferId?: string;
}

/** 该 workdir 在被控端的执行位置:本地 fs、二跳到 SSH remote host,或歧义拒绝。 */
type WorkdirExecution =
  | { kind: 'local' }
  | { kind: 'ssh'; hostId: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unavailable'; reason: 'unavailable' | 'timeout' };

/**
 * 判定执行位置。按 workdir 反查天然有歧义面:同一绝对路径可能同时是本地
 * 目录 + 某 SSH 会话的远端路径,或属于多个不同 SSH host 的会话——猜错端点
 * 意味着读错文件、写错机器。策略:歧义时显式拒绝(kind:'ambiguous',调用方
 * 回结构化错误),绝不静默选边。彻底解法是控制端把会话的 remoteHostId 随
 * remote-op 透传过来按端点直连,已列为后续任务(需协议两端配合)。
 * 无歧义时:本地真实目录 → local;唯一 SSH 归属 → ssh;都不命中属边缘态
 * (会话记录的目录已被删),按 local 执行让底层报 ENOENT,错误可读。
 */
async function resolveWorkdirExecution(
  workdir: string,
  localProbe: RemoteWorkingDirCheckResult,
): Promise<WorkdirExecution> {
  const isLocalDir = localProbe.allowed;
  const normalizedWorkdir = normalizeWorkingDirForStorage(workdir);
  if (!normalizedWorkdir) return { kind: 'local' };
  let sshHosts: string[] = [];
  try {
    const db = getDbClient().drizzle;
    const rows = await db
      .selectDistinct({ remoteHostId: sessions.remoteHostId })
      .from(sessions)
      .where(and(eq(sessions.workingDir, normalizedWorkdir), isNotNull(sessions.remoteHostId)));
    sshHosts = rows.map((r) => r.remoteHostId).filter((h): h is string => !!h);
  } catch (err) {
    log.warn('workdir execution lookup failed', { error: String(err) });
    if (!localProbe.allowed && (localProbe.reason === 'timeout' || localProbe.reason === 'unavailable')) {
      return { kind: 'unavailable', reason: localProbe.reason };
    }
    // 查询失败:退回本地语义(与旧行为一致);明确不存在时由底层返回可读错误。
    return { kind: 'local' };
  }
  if (isLocalDir && sshHosts.length > 0) {
    return {
      kind: 'ambiguous',
      reason: `workdir exists locally and belongs to SSH session(s) [${sshHosts.join(', ')}]`,
    };
  }
  if (sshHosts.length > 1) {
    return {
      kind: 'ambiguous',
      reason: `workdir belongs to multiple SSH hosts [${sshHosts.join(', ')}]`,
    };
  }
  if (isLocalDir) return { kind: 'local' };
  if (sshHosts.length === 1) return { kind: 'ssh', hostId: sshHosts[0] };
  if (!localProbe.allowed && (localProbe.reason === 'timeout' || localProbe.reason === 'unavailable')) {
    return { kind: 'unavailable', reason: localProbe.reason };
  }
  return { kind: 'local' };
}

function bad(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/**
 * exportFile 是分钟级长任务(2GB 上 OSS),不能塞进单次 invoke(relay 请求
 * 超时 30s)。两段式:Start 立即返回 transferId、上传后台跑;控制端轮询
 * Status 到终态。
 *
 * Status 读取必须幂等:终态回包可能在 relay 上丢失(与控制端轮询的瞬断容忍
 * 是同一故障面),控制端会重发同一 transferId 的查询——若"读到即删",重查
 * 得到 unknown transfer(非瞬时错),整次取回作废、2GB 从头再传。故终态
 * job 保留一段 TTL 后才清(进程重启表清空,控制端会得到 unknown → 报错重试,
 * 不会悬挂)。
 */
interface ExportJob {
  state: 'uploading' | 'done' | 'error';
  key?: string;
  message?: string;
  size: number;
  /** 已上传字节(uploadLocalFile 进度回调),Status 轮询带回控制端显示。 */
  uploaded: number;
}
const exportJobs = new Map<string, ExportJob>();

/** 终态 job 保留时长:覆盖控制端轮询间隔(1.5s)+ 瞬断容忍窗口(~40s)富余。 */
const EXPORT_JOB_LINGER_MS = 10 * 60 * 1000;

/** 写入终态并安排延迟清理(替代"Status 读到即删",保证重查幂等)。 */
function setExportJobTerminal(transferId: string, job: ExportJob): void {
  exportJobs.set(transferId, job);
  const timer = setTimeout(() => exportJobs.delete(transferId), EXPORT_JOB_LINGER_MS);
  timer.unref?.();
}

/** SSH 二跳的非流式搜索:searchStart + 收集事件到 end/超时,与本地 collect 同形。 */
async function sshSearchCollect(
  hostId: string,
  q: { workdir: string; query: string; caseSensitive: boolean; maxMatches: number },
): Promise<{ matches: SearchMatch[]; truncated: boolean; totalMatches: number; totalFiles: number }> {
  const mgr = getRemoteFileBrowser();
  const matches: SearchMatch[] = [];
  return await new Promise((resolve, reject) => {
    let settled = false;
    let searchId: string | null = null;
    // searchStart 响应与首批事件可能同一 stdout 批次到达:id 未知窗口内先缓冲,
    // 拿到 id 后过滤回放(与 search/index.ts 远程通路同一教训)——否则秒回/
    // 空结果的嵌套搜索会丢 end,干等 20s 超时。
    const buffered: SearchEvent[] = [];
    const finish = (payload: { truncated: boolean; totalMatches: number; totalFiles: number }): void => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve({ matches, ...payload });
    };
    const consume = (data: SearchEvent): void => {
      if (settled) return;
      if (data.type === 'match') {
        matches.push(data);
      } else if (data.type === 'end') {
        finish({ truncated: data.truncated, totalMatches: data.totalMatches, totalFiles: data.totalFiles });
      } else {
        settled = true;
        off();
        clearTimeout(timer);
        reject(new Error(data.message));
      }
    };
    const off = mgr.onHostEvent(hostId, (evt) => {
      if (evt.event !== 'search') return;
      const data = evt.data as SearchEvent;
      if (searchId === null) {
        buffered.push(data);
        return;
      }
      if (data.searchId !== searchId) return;
      consume(data);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      if (searchId) void mgr.request(hostId, 'searchCancel', { searchId }).catch(() => undefined);
      resolve({ matches, truncated: true, totalMatches: matches.length, totalFiles: 0 });
    }, SEARCH_COLLECT_TIMEOUT_MS);
    timer.unref?.();
    void mgr
      .request(hostId, 'searchStart', q)
      .then((r) => {
        searchId = r.searchId;
        // 回放启动窗口内缓冲到的本次事件(可能已含终态)。
        for (const data of buffered) {
          if (settled) break;
          if (data.searchId === searchId) consume(data);
        }
        buffered.length = 0;
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** 本地非流式搜索:RipgrepSearcher 一次性收集(控制端拿全量,伪流式回放给 UI)。 */
function localSearchCollect(q: {
  workdir: string;
  query: string;
  caseSensitive: boolean;
  maxMatches: number;
}): Promise<{ matches: SearchMatch[]; truncated: boolean; totalMatches: number; totalFiles: number }> {
  const searcher = new RipgrepSearcher({ rgPath: getRipgrepBinaryPath(), logger: log });
  const matches: SearchMatch[] = [];
  return new Promise((resolve, reject) => {
    searcher.on('event', (evt: SearchEvent) => {
      if (evt.type === 'match') {
        matches.push(evt);
      } else if (evt.type === 'end') {
        resolve({ matches, truncated: evt.truncated, totalMatches: evt.totalMatches, totalFiles: evt.totalFiles });
      } else {
        reject(new Error(evt.message));
      }
    });
    searcher.start(q);
  });
}

/**
 * remote-op 主分发。返回形状与本地同名 IPC handler 逐字段一致(listDir 返
 * entries 数组、readFile 返 {ok,...} 等),控制端 transport 零转换。
 */
async function handleRemoteOp(args: RemoteOpArgs): Promise<unknown> {
  if (!args || typeof args.op !== 'string' || typeof args.workdir !== 'string' || !args.workdir) {
    return bad('invalid remote-op args');
  }
  // 能力探测:与 workdir 无关、零 fs 访问,放在 guard 之前。老被控端没有
  // 这个分支,会走到 default 返回 `unknown op: caps`——控制端把它当确定性
  // 的"不支持压缩"信号(见 fileBrowserTransport 的 caps 缓存)。
  if (args.op === 'caps') {
    return { ok: true as const, gzip: true as const };
  }
  const guardResult = await checkRemoteWorkingDir(args.workdir);
  if (!guardResult.allowed && guardResult.reason === 'invalid') {
    const rejection = remoteWorkingDirRejectionToIpcError(guardResult.reason);
    throwIpcError(rejection.code, rejection.message);
  }

  const exec = await resolveWorkdirExecution(args.workdir, guardResult);
  const workdir = args.workdir;

  if (exec.kind === 'unavailable') {
    const rejection = remoteWorkingDirRejectionToIpcError(exec.reason);
    throwIpcError(rejection.code, rejection.message);
  }
  if (exec.kind === 'ambiguous') {
    // 端点不确定时执行任何读写都可能落在错误机器上,显式失败最安全。
    // 详细归属只写本机日志,避免把 SSH host ID 等内部路由信息带回控制端。
    log.warn('remote-op workdir endpoint ambiguous', { op: args.op, workdir, reason: exec.reason });
    throwIpcError('INVALID_PARAMS', 'Remote working directory endpoint is ambiguous.');
  }
  if (exec.kind === 'local' && !guardResult.allowed) {
    log.warn('remote-op workdir rejected by guard', {
      op: args.op,
      workdir: args.workdir,
      reason: guardResult.reason,
    });
    // throw(而非 resolve {ok:false}):经 invoke error 信封让 renderer 侧
    // reject,命中既有 catch/loadError 通路——listDir/stat 等成功形状不是
    // {ok} 的 op,resolve 错误对象会被当数据用(坏渲染且无错误提示),与
    // SSH 通道(throwRemoteFsIpcError 抛出)行为对齐。
    const rejection = remoteWorkingDirRejectionToIpcError(guardResult.reason);
    throwIpcError(rejection.code, rejection.message);
  }

  // 先完成目录授权和执行端点判定,再处理可能昂贵的压缩输入。解码后的明文
  // 同时供本地与 SSH 二跳分支使用;失败时不落任何写操作。
  let writeContent = args.content;
  if (typeof args.contentGz === 'string') {
    try {
      writeContent = (
        await gunzipAsync(Buffer.from(args.contentGz, 'base64'), {
          maxOutputLength: CONTENT_GZ_MAX_DECODED_BYTES,
        })
      ).toString('utf8');
    } catch (err) {
      log.warn('remote-op contentGz decode failed', { op: args.op, error: String(err) });
      return bad('invalid contentGz');
    }
  }

  // —— SSH 二跳:直接透传给本机的 SSH file-service 路由 ——
  if (exec.kind === 'ssh') {
    const mgr = getRemoteFileBrowser();
    const hostId = exec.hostId;
    switch (args.op) {
      case 'listDir': {
        const { entries } = await mgr.request(hostId, 'listDir', {
          workdir,
          relPath: args.relPath ?? '',
          hideMetaFiles: args.hideMetaFiles ?? true,
          docMode: args.docMode,
        });
        return entries;
      }
      case 'readFile': {
        try {
          const data = await mgr.request(hostId, 'readFile', { workdir, relPath: args.relPath ?? '' });
          return await encodeReadFileResult(data, args.acceptGzip);
        } catch (err) {
          const code = (err as Error & { code?: string }).code;
          if (code === 'BINARY_FILE') return { ok: false as const, code: 'BINARY_FILE' as const };
          return { ok: false as const, code: 'READ_FAILED' as const, message: String(err) };
        }
      }
      case 'stat':
        return mgr.request(hostId, 'stat', { workdir, relPath: args.relPath ?? '' });
      case 'writeFile': {
        const r = await mgr.request(hostId, 'writeFile', {
          workdir,
          relPath: args.relPath ?? '',
          content: writeContent ?? '',
        });
        return { ok: true as const, ...r };
      }
      case 'createFile':
        return { ok: true as const, stat: await mgr.request(hostId, 'createFile', { workdir, relPath: args.relPath ?? '' }) };
      case 'createFolder':
        return { ok: true as const, stat: await mgr.request(hostId, 'createFolder', { workdir, relPath: args.relPath ?? '' }) };
      case 'renameEntry':
        return {
          ok: true as const,
          stat: await mgr.request(hostId, 'renameEntry', {
            workdir,
            fromRel: args.fromRel ?? '',
            toRel: args.toRel ?? '',
          }),
        };
      case 'deleteEntry':
        await mgr.request(hostId, 'deleteEntry', { workdir, relPath: args.relPath ?? '' });
        return { ok: true as const };
      case 'listAllFiles':
        return mgr.request(hostId, 'listAllFiles', { workdir, cap: args.cap });
      case 'exportFileStart':
      case 'exportFileStatus':
        // 嵌套(device-link 套 SSH)的大文件导出要先经 daemon 分片拉回被控端再
        // 上传 OSS,本期不做——控制端对嵌套会话维持 OVERSIZE 占位。
        return bad('exportFile is not supported for nested SSH workdirs yet');
      case 'thumbnail':
        // 嵌套 SSH 的缩略图要先分片拉回原图再缩放,成本与收益不成比例,本期
        // 不做——控制端(手机网格)对嵌套会话回退类型占位图。
        return { ok: false as const, code: 'THUMB_UNSUPPORTED' as const, message: 'nested SSH workdir' };
      case 'searchCollect':
        return sshSearchCollect(hostId, {
          workdir,
          query: args.query ?? '',
          caseSensitive: args.caseSensitive === true,
          maxMatches: Math.min(args.maxMatches ?? SEARCH_COLLECT_MAX_MATCHES, SEARCH_COLLECT_MAX_MATCHES),
        });
      default:
        return bad(`unknown op: ${args.op}`);
    }
  }

  // —— 本地执行(被控端自身 fs)——
  switch (args.op) {
    case 'listDir': {
      const matcher = await loadIgnoreMatcher(workdir, {
        hideMetaFiles: args.hideMetaFiles ?? true,
        honorVcsIgnore: false,
      });
      return listDir(workdir, args.relPath ?? '', matcher, { docMode: args.docMode });
    }
    case 'readFile': {
      try {
        const data = await readFile(workdir, args.relPath ?? '');
        return await encodeReadFileResult(data, args.acceptGzip);
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === 'BINARY_FILE') return { ok: false as const, code: 'BINARY_FILE' as const };
        return { ok: false as const, code: 'READ_FAILED' as const, message: String(err) };
      }
    }
    case 'stat':
      return statEntry(workdir, args.relPath ?? '');
    case 'writeFile': {
      try {
        const r = await writeFile(workdir, args.relPath ?? '', writeContent ?? '');
        return { ok: true as const, ...r };
      } catch (err) {
        return bad(String(err));
      }
    }
    case 'createFile': {
      try {
        return { ok: true as const, stat: await createFile(workdir, args.relPath ?? '') };
      } catch (err) {
        return bad(String(err));
      }
    }
    case 'createFolder': {
      try {
        return { ok: true as const, stat: await createFolder(workdir, args.relPath ?? '') };
      } catch (err) {
        return bad(String(err));
      }
    }
    case 'renameEntry': {
      try {
        return { ok: true as const, stat: await renameEntry(workdir, args.fromRel ?? '', args.toRel ?? '') };
      } catch (err) {
        return bad(String(err));
      }
    }
    case 'deleteEntry': {
      try {
        await deleteEntry(workdir, args.relPath ?? '');
        return { ok: true as const };
      } catch (err) {
        return bad(String(err));
      }
    }
    case 'listAllFiles': {
      try {
        return await listAllFiles({ workdir, rgPath: getRipgrepBinaryPath(), cap: args.cap });
      } catch (err) {
        return { files: [] as string[], truncated: false, elapsedMs: 0, error: String(err) };
      }
    }
    case 'exportFileStart': {
      // 大文件导出(两段式第一段):路径安全 = statEntry(assertInsideWorkdir
      // 同源)+ realpath 兜底(挡 symlink 逃逸);上传后台跑,立即回 transferId。
      try {
        const relPath = args.relPath ?? '';
        const st = await statEntry(workdir, relPath);
        const abs = path.resolve(workdir, relPath);
        const realAbs = await fsp.realpath(abs);
        const realRoot = await fsp.realpath(workdir);
        if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
          return bad(`path escapes workdir: ${relPath}`);
        }
        const transferId = `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        exportJobs.set(transferId, { state: 'uploading', size: st.size, uploaded: 0 });
        void uploadLocalFile(realAbs, {
          onProgress: (uploadedBytes) => {
            const j = exportJobs.get(transferId);
            if (j && j.state === 'uploading') j.uploaded = uploadedBytes;
          },
        })
          .then((up) => {
            setExportJobTerminal(transferId, { state: 'done', key: up.key, size: up.size, uploaded: up.size });
          })
          .catch((err) => {
            log.warn('exportFile upload failed', { transferId, error: String(err) });
            setExportJobTerminal(transferId, { state: 'error', message: String(err), size: st.size, uploaded: 0 });
          });
        return { ok: true as const, transferId, size: st.size, mtimeMs: st.mtimeMs };
      } catch (err) {
        return bad(String(err));
      }
    }
    case 'exportFileStatus': {
      const job = exportJobs.get(args.transferId ?? '');
      if (!job) return bad(`unknown transfer: ${args.transferId ?? '<none>'}`);
      // 幂等:终态不因读取而删除(延迟清理见 setExportJobTerminal),回包丢失后重查仍拿到 done/key。
      return {
        ok: true as const,
        state: job.state,
        key: job.key,
        message: job.message,
        size: job.size,
        uploaded: job.uploaded,
      };
    }
    case 'searchCollect':
      return localSearchCollect({
        workdir,
        query: args.query ?? '',
        caseSensitive: args.caseSensitive === true,
        maxMatches: Math.min(args.maxMatches ?? SEARCH_COLLECT_MAX_MATCHES, SEARCH_COLLECT_MAX_MATCHES),
      });
    case 'thumbnail': {
      // 图片缩略图(手机网格视图):路径安全与 exportFileStart 同源
      // (statEntry 越界断言 + realpath 挡 symlink 逃逸),缩放失败一律
      // 结构化返回,由控制端静默回退类型占位图。
      try {
        const relPath = args.relPath ?? '';
        const st = await statEntry(workdir, relPath);
        if (st.type !== 'file') return { ok: false as const, code: 'THUMB_FAILED' as const, message: 'not a file' };
        const abs = path.resolve(workdir, relPath);
        const realAbs = await fsp.realpath(abs);
        const realRoot = await fsp.realpath(workdir);
        if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
          return bad(`path escapes workdir: ${relPath}`);
        }
        const thumb = await generateFileThumbnail(realAbs);
        if (!thumb.ok) return thumb;
        return { ...thumb, size: st.size, mtimeMs: st.mtimeMs };
      } catch (err) {
        return { ok: false as const, code: 'THUMB_FAILED' as const, message: String(err) };
      }
    }
    default:
      return bad(`unknown op: ${args.op}`);
  }
}

/* ============================ watch(订阅驱动) ============================ */

/**
 * fs-watch topic 的被控端 watch 引擎。
 *  - 本地 workdir:WorkdirWatchManager(fs.watch recursive;被控端 macOS /
 *    Windows / Linux 原生支持),事件 → pushToTopicSubscribers。
 *  - SSH 嵌套 workdir:经 RemoteFileBrowserManager 对该 host watchStart,
 *    fileTree 事件从 daemon 流入 onHostEvent → 同一推送出口。
 * 幂等:重复 onSubscribed 忽略;onReleased 清理对应资源。
 */
const localWatch = new WorkdirWatchManager((event) => {
  pushToTopicSubscribers(FILE_BROWSER_EVENT_CHANNEL, event);
});
const localWatchWorkdirs = new Set<string>();
const sshWatchOffs = new Map<string, () => void>();
/** 最新订阅意图；release / 立即重订阅时由正在启动的同一任务收敛到最新状态。 */
const fsWatchDesired = new Set<string>();
/** 启动窗口占位:dedup 判定与首个 await 之间的 TOCTOU 防护(见下)。 */
const fsWatchStarting = new Map<string, symbol>();

async function onFsWatchSubscribed(workdir: string): Promise<void> {
  fsWatchDesired.add(workdir);
  await startFsWatchIfDesired(workdir);
}

async function startFsWatchIfDesired(workdir: string): Promise<void> {
  if (!fsWatchDesired.has(workdir)) return;
  // dedup 必须把"正在启动"也算上:guard/exec 判定要过两个 await(后者查 DB),
  // 窗口内同 workdir 的第二次 subscribe(典型:重连 replay 撞上首次订阅)会
  // 双双通过 has 检查——SSH 嵌套分支就会重复注册 onHostEvent/onHostConnected,
  // 第二次 sshWatchOffs.set 覆盖第一对 off,泄漏的监听让 fileTree 事件双份转发、
  // released 后仍随重连反复 watchStart。同步占位挡掉并发进入。
  if (localWatchWorkdirs.has(workdir) || sshWatchOffs.has(workdir) || fsWatchStarting.has(workdir)) {
    return;
  }
  const token = Symbol(workdir);
  fsWatchStarting.set(workdir, token);
  try {
    await onFsWatchSubscribedInner(workdir, token);
  } finally {
    if (fsWatchStarting.get(workdir) === token) fsWatchStarting.delete(workdir);
  }
}

function scheduleFsWatchReconcile(workdir: string): void {
  const timer = setTimeout(() => {
    // timer 排队后可能再次 release；reconcile 只消费当前意图，绝不重新
    // 写回 desired，避免复活已释放 watcher。
    if (fsWatchDesired.has(workdir)) void startFsWatchIfDesired(workdir);
  }, 0);
  timer.unref?.();
}

function isFsWatchStartCurrent(workdir: string, token: symbol): boolean {
  return fsWatchDesired.has(workdir) && fsWatchStarting.get(workdir) === token;
}

async function onFsWatchSubscribedInner(workdir: string, token: symbol): Promise<void> {
  const guardResult = await checkRemoteWorkingDir(workdir);
  if (!isFsWatchStartCurrent(workdir, token)) return;
  if (!guardResult.allowed && guardResult.reason === 'invalid') {
    log.warn('fs-watch subscribe rejected by guard', { workdir, reason: guardResult.reason });
    return;
  }
  const exec = await resolveWorkdirExecution(workdir, guardResult);
  if (!isFsWatchStartCurrent(workdir, token)) return;
  if (exec.kind === 'unavailable') {
    log.warn('device fs-watch skipped: workdir unavailable', { workdir, reason: exec.reason });
    return;
  }
  if (exec.kind === 'ambiguous') {
    log.warn('device fs-watch skipped: workdir endpoint ambiguous', { workdir, reason: exec.reason });
    return;
  }
  if (exec.kind === 'local' && !guardResult.allowed) {
    log.warn('fs-watch subscribe rejected by guard', { workdir, reason: guardResult.reason });
    return;
  }
  if (exec.kind === 'local') {
    try {
      await localWatch.start(workdir, { hideMetaFiles: true });
      if (!isFsWatchStartCurrent(workdir, token)) {
        localWatch.stop(workdir);
        return;
      }
      localWatchWorkdirs.add(workdir);
      log.info('device fs-watch started (local)', { workdir });
    } catch (err) {
      localWatchWorkdirs.delete(workdir);
      log.warn('device fs-watch start failed', { workdir, error: String(err) });
    }
    return;
  }
  // SSH 嵌套:daemon watch + 事件转推。
  const mgr = getRemoteFileBrowser();
  const hostId = exec.hostId;
  const offEvent = mgr.onHostEvent(hostId, (evt) => {
    if (evt.event !== 'fileTree') return;
    const data = evt.data as { workdir: string };
    if (data.workdir !== workdir) return;
    pushToTopicSubscribers(FILE_BROWSER_EVENT_CHANNEL, evt.data);
  });
  const offReconnect = mgr.onHostConnected(hostId, () => {
    void mgr.request(hostId, 'watchStart', { workdir, hideMetaFiles: true }).catch(() => undefined);
  });
  let listenersDisposed = false;
  const disposeListeners = (): void => {
    if (listenersDisposed) return;
    listenersDisposed = true;
    offEvent();
    offReconnect();
  };
  const stopWatch = (): void => {
    disposeListeners();
    void mgr.request(hostId, 'watchStop', { workdir }).catch(() => undefined);
  };
  sshWatchOffs.set(workdir, stopWatch);
  try {
    await mgr.request(hostId, 'watchStart', { workdir, hideMetaFiles: true });
    const isRegistered = sshWatchOffs.get(workdir) === stopWatch;
    if (!isFsWatchStartCurrent(workdir, token) || !isRegistered) {
      if (isRegistered) sshWatchOffs.delete(workdir);
      // release 可能已在 watchStart 完成前发过 stop；完成后再发一次，保证
      // daemon 不会留下刚启动成功的 watcher。
      stopWatch();
      // release 后若已立即重新订阅，旧启动先完成清理，再从全新监听器和
      // watchStart 开始；setTimeout 确保外层 finally 已移除旧 token。
      if (fsWatchDesired.has(workdir)) {
        scheduleFsWatchReconcile(workdir);
      }
      return;
    }
    log.info('device fs-watch started (ssh nested)', { workdir, hostId });
  } catch (err) {
    const isRegistered = sshWatchOffs.get(workdir) === stopWatch;
    const isCurrent = isFsWatchStartCurrent(workdir, token);
    if (!isCurrent || !isRegistered) {
      if (isRegistered) sshWatchOffs.delete(workdir);
      disposeListeners();
      // release 后立即重订阅时，旧 watchStart 的失败不能吞掉新的订阅意图。
      if (fsWatchDesired.has(workdir)) {
        scheduleFsWatchReconcile(workdir);
      }
    }
    // 当前订阅的初次启动失败时保留 stop/reconnect 监听；host 下次连接会
    // 通过 offReconnect 对应回调重试 watchStart。
    log.warn('device fs-watch ssh start failed', { workdir, hostId, error: String(err) });
  }
}

function onFsWatchReleased(workdir: string): void {
  // guard / DB lookup / watchStart 任一 await 结束后都读取最新订阅意图；
  // 保留启动 token 可串行吸收紧随 release 到来的重订阅，避免同路径双启动。
  fsWatchDesired.delete(workdir);
  if (localWatchWorkdirs.delete(workdir)) {
    localWatch.stop(workdir);
    log.info('device fs-watch stopped (local)', { workdir });
  }
  const offSsh = sshWatchOffs.get(workdir);
  if (offSsh) {
    sshWatchOffs.delete(workdir);
    offSsh();
    log.info('device fs-watch stopped (ssh nested)', { workdir });
  }
}

/**
 * 注册 remote-op handler + fs-watch 订阅钩子。bootstrap 期调用一次
 * (在 installInvokeCapture 之后、任何 device-link 连接之前)。
 */
export function registerFileBrowserDeviceOp(): void {
  ipcMain.handle(FILE_BROWSER_REMOTE_OP_CHANNEL, async (_event, args: RemoteOpArgs) => {
    return handleRemoteOp(args);
  });

  subscriptions.setTopicsSubscribedListener((topics) => {
    for (const t of topics) {
      const workdir = parseFsWatchTopic(t);
      if (workdir) void onFsWatchSubscribed(workdir);
    }
  });
  subscriptions.setTopicsReleasedListener((topics) => {
    for (const t of topics) {
      const workdir = parseFsWatchTopic(t);
      if (workdir) onFsWatchReleased(workdir);
    }
  });

  log.info('file-browser device-op registered');
}

/** 单测入口:绕开 ipcMain 直接驱动分发与 watch 生命周期。 */
export const __deviceOpTesting = {
  handleRemoteOp,
  onFsWatchSubscribed,
  onFsWatchReleased,
};
