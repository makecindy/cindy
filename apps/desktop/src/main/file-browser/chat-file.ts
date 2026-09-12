import { copyFile, writeFile } from 'node:fs/promises';
/**
 * chat-file.ts — 聊天流文件类交互的远程取回编排(`maker:chat-file:fetch` 的业务体)。
 * ---------------------------------------------------------------------------
 * 聊天消息里的文件 chip / 文本预览 / "打开文件" / "打开所在目录" 在远程会话
 * (device-link / SSH)下不能拿远端绝对路径直打本机文件系统(轻则 not found,
 * 重则误开本机同路径文件)。本模块把「远端绝对路径 → 本地缓存副本」收口成单一
 * 编排点,renderer 拿到 cachePath 后的所有本机操作(openPath / showItemInFolder /
 * copyMediaToClipboard / READ_CACHED 文本预览)都对缓存副本进行。
 *
 * 分流规则(与 DESIGN 决策 D4 一致):
 *   - ssh  + workdir 内 → file-service stat + 分片拉取(与侧边栏共享缓存桶);
 *   - ssh  + workdir 外 → OUTSIDE_WORKDIR(file-service 铁律,本期明确占位);
 *   - device + workdir 内 → 被控端 stat + exportFile 两段式(OSS 中转);
 *   - device + workdir 外 → media:fetch 任意绝对路径通道(xdt-file://?path=)
 *     上 OSS 后直下落缓存(identity 无 mtime,以 path+size 去重)。
 *
 * abs→rel 换算只在这里做一次(单一实现点):POSIX 与 Windows(device 被控端
 * 可能是 Windows)两种风格按 workdir 形态判定;`..` 段一律拒绝。
 *
 * 依赖全部注入(ChatFileDeps),单测不触 electron / SSH / relay;生产默认值由
 * index.ts 注册处组装。
 */

import { toWorkdirRel } from '../../shared/workdirPath.js';
import type { FetchProgressFn, RemoteFileIdentity } from './remote-file-cache.js';
import { fetchRemoteFileToCache, findStaleCached } from './remote-file-cache.js';

// abs→rel 换算已抽到 shared/workdirPath(renderer 目录 chip 定位共用),
// re-export 维持既有引用面(单测 / index.ts)。
export { toWorkdirRel } from '../../shared/workdirPath.js';

/** 聊天文件取回的远程来源(local 不进本模块——renderer 侧直接走本机路径)。 */
export type ChatFileOrigin =
  { kind: 'device'; deviceId: string } | { kind: 'ssh'; remoteHostId: string };

export interface ChatFileFetchArgs {
  origin: ChatFileOrigin;
  /** 会话工作目录(远端机器上的绝对路径;device 被控端可能是 Windows 风格)。 */
  workdir: string;
  /** 目标文件在远端机器上的绝对路径。 */
  absPath: string;
}

/**
 * 返回形态走规则 13 的 `{success}` 例外:失败时 renderer 需要按 code 分流降级
 * UX(workdir 外占位 / 不存在 / 可重试失败),throw 编码反而丢结构。
 */
export type ChatFileFetchResult =
  | { ok: true; cachePath: string; stale: boolean; size: number }
  | {
      ok: false;
      code: 'BAD_ARGS' | 'OUTSIDE_WORKDIR' | 'NOT_FOUND' | 'FETCH_FAILED';
      message?: string;
    };

/** 远端 stat 结果(file-service 与 device-op statEntry 同形投影)。 */
export interface ChatFileStat {
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

/** 可注入依赖(单测替换;生产默认值见 index.ts 注册处)。 */
export interface ChatFileDeps {
  /** SSH:file-service stat(workdir 相对路径)。 */
  sshStat(hostId: string, workdir: string, relPath: string): Promise<ChatFileStat>;
  /** device:被控端 stat(FILE_BROWSER_REMOTE_OP_CHANNEL op:'stat')。 */
  deviceStat(deviceId: string, workdir: string, relPath: string): Promise<ChatFileStat>;
  /** workdir 内大文件取回(fetchRemoteBigFile:ssh 分片 / device exportFile 两段式)。 */
  fetchBigFile(
    args: {
      workdir: string;
      relPath: string;
      size: number;
      mtimeMs: number;
      remoteHostId?: string | null;
      deviceId?: string | null;
    },
    onProgress: FetchProgressFn,
  ): Promise<string>;
  /** device workdir 外:被控端 media:fetch(任意绝对路径上 OSS)。 */
  deviceMediaFetch(
    deviceId: string,
    url: string,
  ): Promise<
    | { ossKey: string; size: number; inlineBase64?: string }
    | { ossKey: string; size: number; path: string; dispose(): Promise<void> }
  >;
  /** OSS 对象流式直下到本地文件。 */
  downloadToFile(
    key: string,
    destPath: string,
    expected?: undefined,
    onProgress?: (downloadedBytes: number) => void,
  ): Promise<void>;
  /** 用后删 OSS 对象(best-effort)。 */
  removeRemote(key: string): void;
  fetchToCache: typeof fetchRemoteFileToCache;
  findStale: typeof findStaleCached;
}

/** device workdir 外取件用的原始媒体 URL(被控端 mediaFetch 的 ?path= 通道)。 */
export function buildDevicePathUrl(absPath: string): string {
  return `xdt-file://local/?path=${encodeURIComponent(absPath)}`;
}

/**
 * 远端路径存在性判定(chip 点亮预检):
 *  - file      → 是文件,chip 点亮,点击走文件打开链路;
 *  - directory → 是目录,chip 点亮,点击定位进侧边栏文件浏览器;
 *  - nonfile   → 确定不可点(不存在 / SSH workdir 外),保持纯文本;
 *  - unknown   → 无法判定(链路断 / device workdir 外无 stat 通道),由 renderer
 *                乐观按文件点亮——点击链路自带 NOT_FOUND / stale 兜底。
 */
export type ChatFileStatVerdict = 'file' | 'directory' | 'nonfile' | 'unknown';

/** 错误消息 → 「确定不存在」还是「链路/未知」。传输类错误绝不能当 nonfile
 *  (会把整条消息的 chip 全灭掉,断链时连缓存副本都点不进去)。 */
function classifyStatError(err: unknown): ChatFileStatVerdict {
  const msg = String((err as Error & { code?: string })?.code ?? '') + ' ' + String(err);
  if (/ENOENT|NOT_FOUND|NO_SUCH|no such file/i.test(msg)) return 'nonfile';
  return 'unknown';
}

/**
 * chip 点亮预检主逻辑。只做精确 stat(不做远程搜索/BFS——那是本机 smart
 * resolve 的能力,远程按 workdir join 的路径判定)。
 */
export async function statChatFile(
  args: ChatFileFetchArgs,
  deps: Pick<ChatFileDeps, 'sshStat' | 'deviceStat'>,
): Promise<ChatFileStatVerdict> {
  const { origin, workdir, absPath } = args ?? ({} as ChatFileFetchArgs);
  if (!workdir || !absPath || !origin) return 'nonfile';
  const relPath = toWorkdirRel(workdir, absPath);
  if (origin.kind === 'ssh') {
    if (!origin.remoteHostId) return 'nonfile';
    // workdir 外:点击也只会得到 OUTSIDE_WORKDIR 提示,不点亮。
    if (!relPath) return 'nonfile';
    try {
      const stat = await deps.sshStat(origin.remoteHostId, workdir, relPath);
      return stat.type === 'file' ? 'file' : stat.type === 'directory' ? 'directory' : 'nonfile';
    } catch (err) {
      return classifyStatError(err);
    }
  }
  if (origin.kind !== 'device' || !origin.deviceId) return 'nonfile';
  // device workdir 外:stat 通道是 workdir 相对的,验证不了;media:fetch 全量
  // 取回只为预检太贵 → unknown(乐观点亮)。
  if (!relPath) return 'unknown';
  try {
    const stat = await deps.deviceStat(origin.deviceId, workdir, relPath);
    return stat.type === 'file' ? 'file' : stat.type === 'directory' ? 'directory' : 'nonfile';
  } catch (err) {
    return classifyStatError(err);
  }
}

/** 取回失败时按路径身份捞最近一次成功副本(断线兜底,与 FETCH_REMOTE 同语义)。 */
async function staleFallback(
  deps: ChatFileDeps,
  id: Pick<RemoteFileIdentity, 'transport' | 'endpointId' | 'workdir' | 'relPath'>,
  err: unknown,
): Promise<ChatFileFetchResult> {
  if (String(err).includes('FILE_PEER_CANCELLED'))
    return { ok: false, code: 'FETCH_FAILED', message: String(err) };
  const stalePath = await deps.findStale(id).catch(() => null);
  if (stalePath) return { ok: true, cachePath: stalePath, stale: true, size: -1 };
  return { ok: false, code: 'FETCH_FAILED', message: String(err) };
}

/**
 * 聊天文件取回主编排。见文件头分流规则;所有失败路径都返回结构化 code,
 * 不 throw(renderer 按 code 分流降级 UX)。
 */
export async function fetchChatFile(
  args: ChatFileFetchArgs,
  onProgress: FetchProgressFn,
  deps: ChatFileDeps,
): Promise<ChatFileFetchResult> {
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

  const relPath = toWorkdirRel(workdir, absPath);

  if (origin.kind === 'ssh') {
    if (!relPath) return { ok: false, code: 'OUTSIDE_WORKDIR' };
    let stat: ChatFileStat;
    try {
      stat = await deps.sshStat(origin.remoteHostId, workdir, relPath);
    } catch (err) {
      // 传输类失败(链路断)≠ 文件不存在:先按路径身份捞历史副本(断线也能
      // 打开已看过的文件),miss 才报错;真 ENOENT 直接 NOT_FOUND。
      if (classifyStatError(err) === 'nonfile') {
        return { ok: false, code: 'NOT_FOUND', message: String(err) };
      }
      return staleFallback(
        deps,
        { transport: 'ssh', endpointId: origin.remoteHostId, workdir, relPath },
        err,
      );
    }
    if (stat.type !== 'file') return { ok: false, code: 'NOT_FOUND' };
    try {
      const cachePath = await deps.fetchBigFile(
        {
          workdir,
          relPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          remoteHostId: origin.remoteHostId,
        },
        onProgress,
      );
      return { ok: true, cachePath, stale: false, size: stat.size };
    } catch (err) {
      return staleFallback(
        deps,
        { transport: 'ssh', endpointId: origin.remoteHostId, workdir, relPath },
        err,
      );
    }
  }

  // device 来源
  if (relPath) {
    let stat: ChatFileStat;
    try {
      stat = await deps.deviceStat(origin.deviceId, workdir, relPath);
    } catch (err) {
      // 同 ssh 分支:传输类 stat 失败走 stale 兜底,只有真 ENOENT 才 NOT_FOUND。
      if (classifyStatError(err) === 'nonfile') {
        return { ok: false, code: 'NOT_FOUND', message: String(err) };
      }
      return staleFallback(
        deps,
        { transport: 'device', endpointId: origin.deviceId, workdir, relPath },
        err,
      );
    }
    if (stat.type !== 'file') return { ok: false, code: 'NOT_FOUND' };
    try {
      const cachePath = await deps.fetchBigFile(
        { workdir, relPath, size: stat.size, mtimeMs: stat.mtimeMs, deviceId: origin.deviceId },
        onProgress,
      );
      return { ok: true, cachePath, stale: false, size: stat.size };
    } catch (err) {
      return staleFallback(
        deps,
        { transport: 'device', endpointId: origin.deviceId, workdir, relPath },
        err,
      );
    }
  }

  // device workdir 外:media:fetch 任意绝对路径通道。identity 无 mtime(被控端
  // 不给 stat 到 workdir 外),以 path+size 去重——同路径同大小复用缓存副本。
  // relPath 统一正斜杠(Windows 被控端反斜杠路径的 basename/展示归一)。
  const cacheRel = absPath.replace(/\\/g, '/');
  const identity: RemoteFileIdentity = {
    transport: 'device',
    endpointId: origin.deviceId,
    workdir: '',
    relPath: cacheRel,
    size: 0, // 占位;拿到 media:fetch 的 size 后重建
    mtimeMs: 0,
  };
  // 缓存命中(同 path+size)/ 并发去重 / fetchToCache 在 executor 执行前抛错时,
  // executor 都不会跑——而 media:fetch 已让被控端上传了一个新 OSS 对象
  // (xdt-file:// 通道恒新鲜上传,无去重缓存),没人消费就必须补删,否则每次
  // 命中 / 失败泄漏一个对象。uploadedKey/consumed 必须提在 try 外,catch 分支
  // 才能对"上传成功但未被消费"的错误路径做同样的 best-effort 清理。
  let uploadedKey: string | null = null;
  let consumed = false;
  try {
    const fetched = await deps.deviceMediaFetch(origin.deviceId, buildDevicePathUrl(absPath));
    if ('path' in fetched || fetched.inlineBase64 !== undefined) {
      try {
        const cachePath = await deps.fetchToCache(
          { ...identity, size: fetched.size },
          async (dest, progress) => {
            if ('path' in fetched) await copyFile(fetched.path, dest);
            else await writeFile(dest, Buffer.from(fetched.inlineBase64!, 'base64'));
            progress(fetched.size, fetched.size);
          },
          onProgress,
        );
        return { ok: true, cachePath, stale: false, size: fetched.size };
      } finally {
        if ('path' in fetched) await fetched.dispose();
      }
    }
    uploadedKey = fetched.ossKey;
    const cachePath = await deps.fetchToCache(
      { ...identity, size: fetched.size },
      async (dest, progress) => {
        consumed = true;
        progress(0, fetched.size);
        try {
          await deps.downloadToFile(fetched.ossKey, dest, undefined, (downloaded) => {
            progress(Math.min(downloaded, fetched.size), fetched.size);
          });
          progress(fetched.size, fetched.size);
        } finally {
          deps.removeRemote(fetched.ossKey);
        }
      },
      onProgress,
    );
    if (!consumed) deps.removeRemote(fetched.ossKey);
    return { ok: true, cachePath, stale: false, size: fetched.size };
  } catch (err) {
    if (uploadedKey && !consumed) deps.removeRemote(uploadedKey);
    return staleFallback(
      deps,
      { transport: 'device', endpointId: origin.deviceId, workdir: '', relPath: cacheRel },
      err,
    );
  }
}
