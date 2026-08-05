/**
 * registerFileBrowserIpc — main-side handlers for the workdir file-browser.
 *
 * Registers invoke handlers + 1 push channel:
 *
 *   maker:file-browser:list-dir       readdir one layer (lazy expansion)
 *   maker:file-browser:read-file      read text content (≤2 MiB)
 *   maker:file-browser:stat           cheap size+mtime for unrenderable card
 *   maker:file-browser:write/create/rename/delete   编辑与文件结构操作
 *   maker:file-browser:start-watch    arm watcher for a workdir
 *   maker:file-browser:stop-watch     tear it down
 *   maker:file-browser:event (push)   fs change events for active watchers
 *
 * 每个 handler 按 `remoteHostId` 双路由:空 = 本地 fs(scanner 直调,零变化);
 * 非空 = SSH remote 会话,经 RemoteFileBrowserManager 转发到远端 file-service
 * daemon(@cindy/remote-file-service),语义与本地逐字节一致(daemon 打包同一份
 * @cindy/file-browser-core)。Path traversal 两侧都在 scanner 层拦
 * (`assertInsideWorkdir` + realpath symlink 检查)。本地 watcher 状态在
 * watcherManager;远程 watch 桥接见 remote-watch.ts。
 */

import { ipcMain, BrowserWindow } from 'electron';
import {
  createFile,
  createFolder,
  deleteEntry,
  listAllFiles,
  listDir,
  loadIgnoreMatcher,
  readFile,
  renameEntry,
  setFileBrowserCoreLoggerFactory,
  statEntry,
  writeFile,
} from '@cindy/file-browser-core';

import { promises as fsPromises } from 'node:fs';

import { DL_MEDIA_FETCH_CHANNEL, FILE_BROWSER_REMOTE_OP_CHANNEL } from '@cindy/device-link';

import { createLogger } from '../logger.js';
import { getRipgrepBinaryPath } from '../maker-host/runtime-configs.js';
import { remoteInvoke } from '../device-link/index.js';
import { downloadToFile, removeRemote } from '../device-link/mediaTransfer.js';
import { fetchRemoteFileToCache, findStaleCached, isInsideCacheDir, putCachedContent, sweepCacheOnStartup } from './remote-file-cache.js';
import { fetchChatFile, statChatFile, type ChatFileDeps, type ChatFileFetchArgs } from './chat-file.js';
import { makeSshChunkExecutor } from './ssh-media.js';
import { getRemoteFileBrowser } from './remote-deps.js';
import { getRemoteWatchRegistry } from './remote-watch.js';
import { throwRemoteFsIpcError } from './remote.js';
import { watcherManager, type FileTreeEvent } from './watcher.js';

const log = createLogger('file-browser/ipc');

export const FILE_BROWSER_INVOKE = {
  /** 大文件取回:>2MiB inline 上限的远程文件拉到本地缓存(SSH 分片 / device OSS)。 */
  FETCH_REMOTE: 'maker:file-browser:fetch-remote',
  /** 读缓存副本内容(cached 态的应用内文本预览;路径限缓存目录内)。 */
  READ_CACHED: 'maker:file-browser:read-cached',
  /** 远程小文件读成功后的写穿(断线兜底对大小文件语义一致)。 */
  CACHE_PUT: 'maker:file-browser:cache-put',
  LIST_DIR: 'maker:file-browser:list-dir',
  /** 项目级文件名扁平列表(走 ripgrep `--files` honor .gitignore),给 RSB 快速
   *  文件筛选 / Cmd+P 风格 fuzzy finder 用。详见 listAllFiles.ts。 */
  LIST_ALL: 'maker:file-browser:list-all',
  READ_FILE: 'maker:file-browser:read-file',
  WRITE_FILE: 'maker:file-browser:write-file',
  CREATE_FILE: 'maker:file-browser:create-file',
  CREATE_FOLDER: 'maker:file-browser:create-folder',
  RENAME_ENTRY: 'maker:file-browser:rename-entry',
  DELETE_ENTRY: 'maker:file-browser:delete-entry',
  STAT: 'maker:file-browser:stat',
  START_WATCH: 'maker:file-browser:start-watch',
  STOP_WATCH: 'maker:file-browser:stop-watch',
  /** 聊天流文件类交互的远程取回(fetch-到缓存-再操作,见 chat-file.ts)。 */
  CHAT_FILE_FETCH: 'maker:chat-file:fetch',
  /** 聊天流文件 chip 点亮预检(远端精确 stat,见 chat-file.ts statChatFile)。 */
  CHAT_FILE_STAT: 'maker:chat-file:stat',
} as const;

export const FILE_BROWSER_PUSH = {
  EVENT: 'maker:file-browser:event',
  /** 大文件取回进度(仅发给发起窗口):{ workdir, relPath, received, total }。 */
  TRANSFER: 'maker:file-browser:transfer',
} as const;

/**
 * 所有 file-browser IPC 参数共享的远程标记:非空 = session 绑定 SSH remote
 * host,workdir 是远端路径,操作经 RemoteFileBrowserManager 转发到远端
 * file-service daemon;空/缺省 = 本地 fs(原有路径,零变化)。renderer 从
 * session.remoteHostId 透传,不做任何判断——local vs remote 的分支只发生在
 * 本文件的 handler 里。
 */
interface RemoteRoutedArgs {
  remoteHostId?: string | null;
}

interface ListDirArgs extends RemoteRoutedArgs {
  workdir: string;
  /** workdir-relative POSIX path; '' for root */
  relPath?: string;
  /** default true — Unity .meta files cut ~47% of typical entries */
  hideMetaFiles?: boolean;
  /** Doc mode: only `.md` files + dirs that contain `.md` descendants. */
  docMode?: boolean;
}

interface ReadFileArgs extends RemoteRoutedArgs {
  workdir: string;
  relPath: string;
}

interface WriteFileArgs extends RemoteRoutedArgs {
  workdir: string;
  relPath: string;
  content: string;
}

interface MutateEntryArgs extends RemoteRoutedArgs {
  workdir: string;
  relPath: string;
}

interface RenameEntryArgs extends RemoteRoutedArgs {
  workdir: string;
  fromRel: string;
  toRel: string;
}

interface StatArgs extends RemoteRoutedArgs {
  workdir: string;
  relPath: string;
}

interface WatchArgs extends RemoteRoutedArgs {
  workdir: string;
  hideMetaFiles?: boolean;
}

/**
 * device-link remote-op 调用 + 信封解包:remoteInvoke 返回 InvokeResultPayload
 * ({ok,result}|{ok:false,error}),handler 的真实返回值在 result 里——renderer
 * 通路由 ipc.ts 解包,main 直调必须自己解,否则读信封字段恒错(真机实踩)。
 */
async function deviceOpInvoke<T>(deviceId: string, opArgs: Record<string, unknown>): Promise<T> {
  const payload = await remoteInvoke(deviceId, FILE_BROWSER_REMOTE_OP_CHANNEL, [opArgs]);
  if (!payload.ok) {
    throw new Error(`[${payload.error.code}] ${payload.error.message}`);
  }
  return payload.result as T;
}

/**
 * 大文件取回编排:按 transport 选 executor,经 remote-file-cache 落盘去重。
 * 不放 handler 内联是为了可测(依赖均为模块单例,单测用 __testing 注入)。
 */
async function fetchRemoteBigFile(
  args: {
    workdir: string;
    relPath: string;
    size: number;
    mtimeMs: number;
    remoteHostId?: string | null;
    deviceId?: string | null;
  },
  onProgress: (received: number, total: number, phase?: 'upload' | 'download') => void,
): Promise<string> {
  if (!args.workdir || !args.relPath || !Number.isFinite(args.size)) {
    throw new Error('bad fetch-remote args');
  }
  if (args.deviceId) {
    const deviceId = args.deviceId;
    return fetchRemoteFileToCache(
      {
        transport: 'device',
        endpointId: deviceId,
        workdir: args.workdir,
        relPath: args.relPath,
        size: args.size,
        mtimeMs: args.mtimeMs,
      },
      async (destPath, progress) => {
        // 两段式:Start 立即回 transferId(上传在被控端后台跑,2GB 分钟级,
        // 单次 invoke 的 30s 超时罩不住),轮询 Status 到终态再下载。
        progress(0, args.size);
        const start = await deviceOpInvoke<{ ok: boolean; transferId?: string; message?: string }>(
          deviceId,
          { op: 'exportFileStart', workdir: args.workdir, relPath: args.relPath },
        );
        if (!start?.ok || !start.transferId) {
          throw new Error(start?.message ?? 'exportFileStart failed on remote device');
        }
        const deadline = Date.now() + 30 * 60_000;
        let key: string | null = null;
        // relay 瞬断容忍:被控端的上传不依赖 relay(直连 OSS),断的只是"问进度"
        // 这条线。瞬态错误(断链/超时/重连中)继续轮询,连续 20 次(约 40s)才
        // 放弃——双实例测试环境的 relay 抢占和生产网络抖动都盖得住。
        let transientFails = 0;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          if (Date.now() > deadline) throw new Error('remote upload timed out (30min)');
          let st: { ok: boolean; state?: string; key?: string; message?: string; uploaded?: number };
          try {
            st = await deviceOpInvoke<{
              ok: boolean;
              state?: string;
              key?: string;
              message?: string;
              uploaded?: number;
            }>(
              deviceId,
              { op: 'exportFileStatus', workdir: args.workdir, transferId: start.transferId },
            );
            transientFails = 0;
          } catch (err) {
            const msg = String(err);
            const transient = /connection lost|NOT_CONNECTED|LINK_NOT_OPEN|INVOKE_TIMEOUT|DEVICE_OFFLINE/i.test(msg);
            if (transient && ++transientFails <= 20) {
              log.debug('exportFileStatus transient failure, retrying', { fails: transientFails, msg });
              continue;
            }
            throw err;
          }
          if (!st?.ok) throw new Error(st?.message ?? 'exportFileStatus failed');
          if (st.state === 'error') throw new Error(st.message ?? 'remote upload failed');
          if (st.state === 'done' && st.key) {
            key = st.key;
            break;
          }
          // 上传阶段:被控端回报真实已上传字节(phase=upload,renderer 分相显示)。
          progress(Math.min(st.uploaded ?? 0, args.size), args.size, 'upload');
        }
        const res = { key };
        // …再流式直下到随机 part 文件，并由字节计数回调持续上报下载进度。
        try {
          await downloadToFile(res.key, destPath, undefined, (downloaded) => {
            progress(Math.min(downloaded, args.size), args.size, 'download');
          });
          progress(args.size, args.size, 'download');
        } finally {
          void removeRemote(res.key);
        }
      },
      onProgress,
    );
  }
  if (args.remoteHostId) {
    const hostId = args.remoteHostId;
    // 分片执行体抽在 ssh-media.ts 与聊天媒体管线共享(同缓存、同容错语义)。
    const mgr = getRemoteFileBrowser();
    return fetchRemoteFileToCache(
      {
        transport: 'ssh',
        endpointId: hostId,
        workdir: args.workdir,
        relPath: args.relPath,
        size: args.size,
        mtimeMs: args.mtimeMs,
      },
      makeSshChunkExecutor(
        (h, method, params) => mgr.request(h, method, params as never) as never,
        hostId,
        args.workdir,
        args.relPath,
      ),
      onProgress,
    );
  }
  throw new Error('fetch-remote requires remoteHostId or deviceId');
}

/**
 * Register all file-browser IPC handlers. Idempotent — safe to call once
 * during bootstrap. The handlers themselves are stateless beyond the
 * watcherManager singleton.
 */
export function registerFileBrowserIpc(): void {
  // file-browser-core 是宿主无关的共享包(也跑在远端 file-service daemon 里),
  // 日志设施由宿主注入——desktop 侧接统一 logger(规则 12),scope 与抽包前一致。
  setFileBrowserCoreLoggerFactory(createLogger);

  // 缓存启动清扫(残留 .part + 超容量 LRU),异步不阻塞注册。
  void sweepCacheOnStartup();

  // ── 大文件取回:>2MiB inline 上限的远程文件拉到本地缓存 ────────────────
  // ssh backend = daemon readFileChunk 分片循环(bytes 走 SSH 直连);
  // device backend = 被控端 exportFile 上 OSS → 本端流式直下(bytes 不经 relay)。
  // 进度经 FILE_BROWSER_PUSH.TRANSFER 发回发起窗口(~10Hz 节流)。
  ipcMain.handle(
    FILE_BROWSER_INVOKE.FETCH_REMOTE,
    async (
      event,
      args: {
        workdir: string;
        relPath: string;
        size: number;
        mtimeMs: number;
        remoteHostId?: string | null;
        deviceId?: string | null;
      },
    ) => {
      const wc = event.sender;
      let lastPush = 0;
      const onProgress = (received: number, total: number, phase?: 'upload' | 'download') => {
        const now = Date.now();
        if (now - lastPush < 100 && received < total) return;
        lastPush = now;
        if (!wc.isDestroyed()) {
          wc.send(FILE_BROWSER_PUSH.TRANSFER, {
            workdir: args.workdir,
            relPath: args.relPath,
            received,
            total,
            phase: phase ?? 'download',
          });
        }
      };
      try {
        const cachePath = await fetchRemoteBigFile(args, onProgress);
        return { ok: true as const, cachePath, stale: false };
      } catch (err) {
        // 断线兜底:取回失败但本地有该路径的历史副本 → 降级展示(可能非最新)。
        const transport = args.deviceId ? ('device' as const) : ('ssh' as const);
        const endpointId = args.deviceId ?? args.remoteHostId ?? '';
        if (endpointId) {
          const stalePath = await findStaleCached({
            transport,
            endpointId,
            workdir: args.workdir,
            relPath: args.relPath,
          }).catch(() => null);
          if (stalePath) {
            log.info('fetch-remote failed, serving stale cache', { relPath: args.relPath });
            return { ok: true as const, cachePath: stalePath, stale: true };
          }
        }
        log.warn('fetch-remote failed', { args: { ...args }, error: String(err) });
        return { ok: false as const, message: String(err) };
      }
    },
  );

  // ── 聊天流文件取回:远端绝对路径 → 本地缓存副本(chat-file.ts 编排)────
  // 进度沿用 FILE_BROWSER_PUSH.TRANSFER,relPath 键固定用原始 absPath(renderer
  // 不做 abs→rel,单一实现点在 main;订阅方按 absPath 过滤)。
  const chatFileDeps: ChatFileDeps = {
    sshStat: (hostId, workdir, relPath) =>
      getRemoteFileBrowser().request(hostId, 'stat', { workdir, relPath }) as Promise<{
        type: 'file' | 'directory';
        size: number;
        mtimeMs: number;
      }>,
    deviceStat: (deviceId, workdir, relPath) =>
      deviceOpInvoke<{ type: 'file' | 'directory'; size: number; mtimeMs: number }>(deviceId, {
        op: 'stat',
        workdir,
        relPath,
      }),
    fetchBigFile: fetchRemoteBigFile,
    deviceMediaFetch: async (deviceId, url) => {
      const res = await remoteInvoke(deviceId, DL_MEDIA_FETCH_CHANNEL, [{ url }]);
      if (!res.ok) {
        throw new Error(`media:fetch ${res.error?.code ?? 'FAIL'}: ${res.error?.message ?? ''}`);
      }
      return res.result as { ossKey: string; size: number };
    },
    downloadToFile,
    removeRemote: (key) => void removeRemote(key),
    fetchToCache: fetchRemoteFileToCache,
    findStale: findStaleCached,
  };
  ipcMain.handle(FILE_BROWSER_INVOKE.CHAT_FILE_FETCH, async (event, args: ChatFileFetchArgs) => {
    const wc = event.sender;
    let lastPush = 0;
    const onProgress = (received: number, total: number, phase?: 'upload' | 'download') => {
      const now = Date.now();
      if (now - lastPush < 100 && received < total) return;
      lastPush = now;
      if (!wc.isDestroyed()) {
        wc.send(FILE_BROWSER_PUSH.TRANSFER, {
          workdir: args?.workdir ?? '',
          relPath: args?.absPath ?? '',
          received,
          total,
          phase: phase ?? 'download',
        });
      }
    };
    const result = await fetchChatFile(args, onProgress, chatFileDeps);
    if (!result.ok) {
      log.warn('chat-file fetch failed', { code: result.code, absPath: args?.absPath, message: result.message });
    }
    return result;
  });

  // chip 点亮预检:远端精确 stat,verdict 见 statChatFile 注释。查询型接口,
  // 任何异常都折叠进 verdict(unknown),不 throw。
  ipcMain.handle(FILE_BROWSER_INVOKE.CHAT_FILE_STAT, async (_event, args: ChatFileFetchArgs) => {
    try {
      return { verdict: await statChatFile(args, chatFileDeps) };
    } catch (err) {
      log.warn('chat-file stat failed', { absPath: args?.absPath, error: String(err) });
      return { verdict: 'unknown' as const };
    }
  });

  // 远程小文件写穿:fire-and-forget,内容上限 2.5MB(inline 路径本身 ≤2MiB)。
  ipcMain.handle(
    FILE_BROWSER_INVOKE.CACHE_PUT,
    async (
      _event,
      args: {
        workdir: string;
        relPath: string;
        size: number;
        mtimeMs: number;
        content: string;
        remoteHostId?: string | null;
        deviceId?: string | null;
      },
    ) => {
      const endpointId = args?.deviceId ?? args?.remoteHostId;
      if (!endpointId || !args.workdir || !args.relPath) return { ok: false as const };
      if (typeof args.content !== 'string' || args.content.length > 2_621_440) {
        return { ok: false as const };
      }
      await putCachedContent(
        {
          transport: args.deviceId ? 'device' : 'ssh',
          endpointId,
          workdir: args.workdir,
          relPath: args.relPath,
          size: args.size,
          mtimeMs: args.mtimeMs,
        },
        args.content,
      );
      return { ok: true as const };
    },
  );

  // 读缓存副本内容(cached 态的应用内文本预览)。路径必须在缓存目录内。
  ipcMain.handle(
    FILE_BROWSER_INVOKE.READ_CACHED,
    async (_event, args: { cachePath: string }) => {
      if (!args?.cachePath || !isInsideCacheDir(args.cachePath)) {
        return { ok: false as const, message: 'path outside cache dir' };
      }
      try {
        const st = await fsPromises.stat(args.cachePath);
        const CAP = 32 * 1024 * 1024;
        const handle = await fsPromises.open(args.cachePath, 'r');
        try {
          const buf = Buffer.alloc(Math.min(st.size, CAP));
          // fs.read 可能短读,循环读满(同 file-browser-core readFileChunk 教训:
          // 单次 read 短读会让尾部残留 0x00,这里还会被误判成二进制)。
          let filled = 0;
          while (filled < buf.length) {
            const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
            if (bytesRead === 0) break;
            filled += bytesRead;
          }
          if (buf.subarray(0, Math.min(filled, 4096)).includes(0)) {
            return { ok: true as const, kind: 'binary' as const };
          }
          return {
            ok: true as const,
            kind: 'text' as const,
            content: buf.subarray(0, filled).toString('utf8'),
            truncated: st.size > CAP,
          };
        } finally {
          await handle.close();
        }
      } catch (err) {
        return { ok: false as const, message: String(err) };
      }
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.LIST_DIR,
    async (_event, args: ListDirArgs) => {
      if (args.remoteHostId) {
        try {
          const { entries } = await getRemoteFileBrowser().request(args.remoteHostId, 'listDir', {
            workdir: args.workdir,
            relPath: args.relPath ?? '',
            hideMetaFiles: args.hideMetaFiles ?? true,
            docMode: args.docMode,
          });
          return entries;
        } catch (err) {
          log.warn('remote list-dir failed', { hostId: args.remoteHostId, error: String(err) });
          throwRemoteFsIpcError(err);
        }
      }
      const matcher = await loadIgnoreMatcher(args.workdir, {
        hideMetaFiles: args.hideMetaFiles ?? true,
        honorVcsIgnore: false,
      });
      return listDir(args.workdir, args.relPath ?? '', matcher, {
        docMode: args.docMode,
      });
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.LIST_ALL,
    async (_event, args: { workdir: string; cap?: number } & RemoteRoutedArgs) => {
      if (args.remoteHostId) {
        // 远端 daemon 内 spawn 远端 rg;远端无 rg 时 daemon 返回 BAD_REQUEST,
        // 走同款空 fallback(renderer 渲染"未索引"占位),不 throw。
        try {
          return await getRemoteFileBrowser().request(args.remoteHostId, 'listAllFiles', {
            workdir: args.workdir,
            cap: args.cap,
          });
        } catch (err) {
          log.warn('remote list-all failed', { hostId: args.remoteHostId, error: String(err) });
          // RG_UNAVAILABLE 透传稳定 token(renderer 按码映射"远端无 ripgrep"文案),
          // 其余保留原始描述进通用"索引失败"占位。
          const code = (err as Error & { code?: string }).code;
          return {
            files: [] as string[],
            truncated: false,
            elapsedMs: 0,
            error: code === 'RG_UNAVAILABLE' ? 'RG_UNAVAILABLE' : String(err),
          };
        }
      }
      try {
        const rgPath = getRipgrepBinaryPath();
        return await listAllFiles({ workdir: args.workdir, rgPath, cap: args.cap });
      } catch (err) {
        log.warn('list-all failed', { workdir: args.workdir, error: String(err) });
        // 查询型 handler:rg 跑挂 / 二进制缺失等情况下,renderer 仍需要一个合法
        // 空结果 fallback 渲染("没索引到文件"占位),所以返回 success:false 而不
        // 是 throw(规则 13 例外条款,跟 LIST_AGENT_SKILLS 同模式)。
        return {
          files: [] as string[],
          truncated: false,
          elapsedMs: 0,
          error: String(err),
        };
      }
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.READ_FILE,
    async (_event, args: ReadFileArgs) => {
      try {
        const data = args.remoteHostId
          ? await getRemoteFileBrowser().request(args.remoteHostId, 'readFile', {
              workdir: args.workdir,
              relPath: args.relPath,
            })
          : await readFile(args.workdir, args.relPath);
        return { ok: true as const, data };
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        // BINARY_FILE is the expected "not previewable" path — surface it
        // explicitly so the renderer can show the unrenderable placeholder
        // without log spam. 远程侧 daemon 透传同一 code(FileServiceRpcError)。
        if (code === 'BINARY_FILE') {
          return { ok: false as const, code: 'BINARY_FILE' as const };
        }
        log.warn('read-file failed', { args, error: String(err) });
        return {
          ok: false as const,
          code: 'READ_FAILED' as const,
          message: String(err),
        };
      }
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.STAT,
    async (_event, args: StatArgs) => {
      if (args.remoteHostId) {
        try {
          return await getRemoteFileBrowser().request(args.remoteHostId, 'stat', {
            workdir: args.workdir,
            relPath: args.relPath,
          });
        } catch (err) {
          throwRemoteFsIpcError(err);
        }
      }
      return statEntry(args.workdir, args.relPath);
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.WRITE_FILE,
    async (_event, args: WriteFileArgs) => {
      try {
        const result = args.remoteHostId
          ? await getRemoteFileBrowser().request(args.remoteHostId, 'writeFile', {
              workdir: args.workdir,
              relPath: args.relPath,
              content: args.content,
            })
          : await writeFile(args.workdir, args.relPath, args.content);
        return { ok: true as const, ...result };
      } catch (err) {
        log.warn('write-file failed', { relPath: args.relPath, error: String(err) });
        return { ok: false as const, message: String(err) };
      }
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.CREATE_FILE,
    async (_event, args: MutateEntryArgs) => {
      try {
        const stat = args.remoteHostId
          ? await getRemoteFileBrowser().request(args.remoteHostId, 'createFile', {
              workdir: args.workdir,
              relPath: args.relPath,
            })
          : await createFile(args.workdir, args.relPath);
        return { ok: true as const, stat };
      } catch (err) {
        log.warn('create-file failed', { relPath: args.relPath, error: String(err) });
        return { ok: false as const, message: String(err) };
      }
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.CREATE_FOLDER,
    async (_event, args: MutateEntryArgs) => {
      try {
        const stat = args.remoteHostId
          ? await getRemoteFileBrowser().request(args.remoteHostId, 'createFolder', {
              workdir: args.workdir,
              relPath: args.relPath,
            })
          : await createFolder(args.workdir, args.relPath);
        return { ok: true as const, stat };
      } catch (err) {
        log.warn('create-folder failed', { relPath: args.relPath, error: String(err) });
        return { ok: false as const, message: String(err) };
      }
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.RENAME_ENTRY,
    async (_event, args: RenameEntryArgs) => {
      try {
        const stat = args.remoteHostId
          ? await getRemoteFileBrowser().request(args.remoteHostId, 'renameEntry', {
              workdir: args.workdir,
              fromRel: args.fromRel,
              toRel: args.toRel,
            })
          : await renameEntry(args.workdir, args.fromRel, args.toRel);
        return { ok: true as const, stat };
      } catch (err) {
        log.warn('rename-entry failed', {
          fromRel: args.fromRel,
          toRel: args.toRel,
          error: String(err),
        });
        return { ok: false as const, message: String(err) };
      }
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.DELETE_ENTRY,
    async (_event, args: MutateEntryArgs) => {
      try {
        if (args.remoteHostId) {
          await getRemoteFileBrowser().request(args.remoteHostId, 'deleteEntry', {
            workdir: args.workdir,
            relPath: args.relPath,
          });
        } else {
          await deleteEntry(args.workdir, args.relPath);
        }
        return { ok: true as const };
      } catch (err) {
        log.warn('delete-entry failed', { relPath: args.relPath, error: String(err) });
        return { ok: false as const, message: String(err) };
      }
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.START_WATCH,
    async (event, args: WatchArgs) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) throw new Error('no window for sender');
      if (args.remoteHostId) {
        // 远程:daemon 内 fs.watch(recursive),fileTree 事件帧经注册表转发成
        // 与本地完全同形的 FILE_BROWSER_PUSH.EVENT;失败不 throw(renderer 靠
        // 聚焦刷新兜底,watch 是增强不是硬依赖)。
        try {
          await getRemoteWatchRegistry(getRemoteFileBrowser()).start(
            window,
            args.remoteHostId,
            args.workdir,
            { hideMetaFiles: args.hideMetaFiles ?? true },
            (fsEvent) => {
              if (window.isDestroyed()) return;
              window.webContents.send(FILE_BROWSER_PUSH.EVENT, fsEvent);
            },
          );
        } catch (err) {
          log.warn('remote start-watch failed', { hostId: args.remoteHostId, error: String(err) });
        }
        return { ok: true };
      }
      await watcherManager.start(
        window,
        args.workdir,
        { hideMetaFiles: args.hideMetaFiles ?? true },
        (fsEvent: FileTreeEvent) => {
          if (window.isDestroyed()) return;
          window.webContents.send(FILE_BROWSER_PUSH.EVENT, fsEvent);
        },
      );
      return { ok: true };
    },
  );

  ipcMain.handle(
    FILE_BROWSER_INVOKE.STOP_WATCH,
    async (event, args: WatchArgs) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return { ok: true };
      if (args.remoteHostId) {
        await getRemoteWatchRegistry(getRemoteFileBrowser()).stop(
          window.id,
          args.remoteHostId,
          args.workdir,
        );
        return { ok: true };
      }
      await watcherManager.stop(window.id, args.workdir);
      return { ok: true };
    },
  );

  log.info('file-browser IPC registered');
}

export type { DirEntry, FileReadResult, FileStat } from '@cindy/file-browser-core';
export type { FileTreeEvent, FileTreeEventType } from './watcher.js';
