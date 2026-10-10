/**
 * useFileContent — fetches one file's contents via main IPC.
 *
 * Three terminal states for a (workdir, relPath) pair:
 *   - { kind: 'text', content, truncated, size, mtimeMs }    — readable text
 *   - { kind: 'binary', stat }                                — render placeholder
 *   - { kind: 'error', message }                              — generic failure
 *
 * Cache 策略 (lib/fileContentCache.ts):
 *   - 模块级 LRU, 按 (workdir, relPath) key, 命中即同步 setState 不发 IPC。
 *   - chokidar 'change'/'unlink' 事件 → 主动 invalidate, 保证下次切回时拿
 *     磁盘最新; refresh() 也会 invalidate (用户保存后让 onSaved 回调显式刷)。
 *   - 容量: 8 条 / 16 MiB, 防止用户在 50+ 文件之间切换时 heap 阶梯式涨。
 *   - binary / error / loading 不入 cache。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { observeFileTransferProgress } from '@/lib/fileTransferProgress';
import { fileBrowserApiFor, onFileTreeEventFor } from '@/lib/fileBrowserTransport';
import {
  getCachedFileContent,
  invalidateCachedFile,
  invalidateWorkdirCache,
  setCachedFileContent,
} from '../lib/fileContentCache';

const log = createLogger('useFileContent');

interface FileStat {
  relPath: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

export type FileContent =
  | {
      kind: 'text';
      content: string;
      relPath: string;
      size: number;
      mtimeMs: number;
      truncated: boolean;
    }
  | { kind: 'binary'; stat: FileStat }
  /** 远程文本文件超出传输上限(device-link 帧限预判):渲染"文件过大"占位卡。 */
  | { kind: 'oversize'; stat: FileStat }
  /** 大文件取回进行中(SSH 分片 / device OSS):渲染进度。 */
  | { kind: 'fetching'; received: number; total: number; phase?: 'upload' | 'download' }
  /** 大文件已取回到本地缓存:占位卡 + 「在系统中打开」(cachePath 是本地文件)。
   *  stale = 实时取回失败后回落的历史副本(可能不是远端最新版),UI 需标注。 */
  | { kind: 'cached'; stat: FileStat; cachePath: string; stale?: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'loading' }
  | { kind: 'empty' };

export interface UseFileContentReturn {
  content: FileContent;
  /** Force a refetch of the current (workdir, relPath). Used after save. */
  refresh: () => void;
  /**
   * 用调用方已经握有的 fresh content 同步把 cache + state 推到 text 分支,
   * 不发 IPC、不进 loading 中间态。专为 save-after 场景:editor 里的 next
   * 内容已经写到磁盘,根本没必要再读回来 —— 走 refresh() 会因为先 invalidate
   * cache 再 effect 重跑命中 miss、setState({ kind: 'loading' }) 闪一帧空白。
   */
  setLocal: (data: {
    content: string;
    size: number;
    mtimeMs: number;
    truncated: boolean;
  }) => void;
}

export interface FileContentState {
  workdir: string;
  relPath: string | null;
  content: FileContent;
}

function isContentForRelPath(content: FileContent, relPath: string): boolean {
  switch (content.kind) {
    case 'text':
      return content.relPath === relPath;
    case 'binary':
    case 'oversize':
    case 'cached':
      return content.stat.relPath === relPath;
    case 'loading':
    case 'fetching':
    case 'error':
      return true;
    case 'empty':
      return false;
  }
}

export function getVisibleFileContentState(
  state: FileContentState,
  workdir: string,
  relPath: string | null,
): FileContent {
  if (!workdir || !relPath) return { kind: 'empty' };
  if (
    state.workdir === workdir &&
    state.relPath === relPath &&
    isContentForRelPath(state.content, relPath)
  ) {
    return state.content;
  }
  return { kind: 'loading' };
}

/**
 * @param remoteHostId 非空 = SSH remote 会话:readFile/stat 经 main 路由到远端
 *   file-service。cache key 不区分 remote(workdir 是远端绝对路径,与本地路径
 *   天然不撞);remote 下无 chokidar 事件,cache 失效靠 refresh()/setLocal()。
 */
export function useFileContent(
  workdir: string,
  relPath: string | null,
  remoteHostId: string | null = null,
  deviceId: string | null = null,
): UseFileContentReturn {
  const [state, setState] = useState<FileContentState>({
    workdir: '',
    relPath: null,
    content: { kind: 'empty' },
  });
  // refresh 计数器:bump 一次触发下面 effect 重跑(包含 IPC 重读)。
  const [refreshTick, setRefreshTick] = useState(0);

  // 内容缓存的作用域键:远程会话必须把传输端点编进 key——不同 SSH 主机 /
  // 被控设备可能暴露相同绝对路径 workdir,仅按 workdir|relPath 会串缓存
  // (A 机的内容渲染成 B 机的文件,保存时反向覆写)。本地会话保持裸 workdir。
  const contentCacheScope = deviceId
    ? `dev:${deviceId}|${workdir}`
    : remoteHostId
      ? `ssh:${remoteHostId}|${workdir}`
      : workdir;

  useEffect(() => {
    if (!workdir || !relPath) {
      setState({ workdir, relPath: null, content: { kind: 'empty' } });
      return;
    }
    // Cache 命中 → 同步 setState, 不进入 loading 中间态, 不发 IPC。
    // 切 tab 来回点的"瞬切"体验全靠这条; refresh()/chokidar evict 后会回退
    // 到 miss 路径, 触发真 IPC 拿最新。
    const cached = getCachedFileContent(contentCacheScope, relPath);
    if (cached) {
      setState({ workdir, relPath, content: cached });
      return;
    }

    let cancelled = false;
    let transferProgress: ReturnType<typeof observeFileTransferProgress> | undefined;
    setState({ workdir, relPath, content: { kind: 'loading' } });

    void (async () => {
      try {
        // 大文件取回(>2MiB inline 上限):进度态 → 本地缓存 → cached 卡;
        // 失败回落 fallback(SSH=截断文本仍可看,device=oversize 占位)。
        const startBigFetch = async (
          size: number,
          mtimeMs: number,
          fallback: FileContent,
        ): Promise<void> => {
          setState({ workdir, relPath, content: { kind: 'fetching', received: 0, total: size } });
          const progress = observeFileTransferProgress((e) => {
            if (cancelled) return;
            // 打包 / 解包阶段只出现在文件夹下载(relPath 键为远端绝对路径),这里收不到。
            if (e.phase === 'pack' || e.phase === 'extract') return;
            setState({
              workdir,
              relPath,
              content: { kind: 'fetching', received: e.received, total: e.total, phase: e.phase },
            });
          });
          transferProgress = progress;
          try {
            const res = await window.electronAPI.fileBrowser.fetchRemote({
              workdir,
              relPath,
              size,
              mtimeMs,
              remoteHostId,
              deviceId,
              requestId: progress.requestId,
            });
            if (cancelled) return;
            if (res.ok) {
              setState({
                workdir,
                relPath,
                content: {
                  kind: 'cached',
                  stat: { relPath, type: 'file', size, mtimeMs },
                  cachePath: res.cachePath,
                  stale: res.stale === true,
                },
              });
            } else {
              log.warn('fetchRemote failed, falling back', { relPath, message: res.message });
              setState({ workdir, relPath, content: fallback });
            }
          } finally {
            progress.dispose();
          }
        };

        const result = await fileBrowserApiFor(deviceId).readFile({ workdir, relPath, remoteHostId });
        if (cancelled) return;
        if (result.ok) {
          if (result.data.truncated && (remoteHostId || deviceId)) {
            // 远程截断文本:自动取回完整文件(本地会话维持原截断视图,不取)。
            await startBigFetch(result.data.size, result.data.mtimeMs, {
              kind: 'text',
              content: result.data.content,
              relPath: result.data.relPath,
              size: result.data.size,
              mtimeMs: result.data.mtimeMs,
              truncated: true,
            });
            return;
          }
          setCachedFileContent(contentCacheScope, {
            content: result.data.content,
            relPath: result.data.relPath,
            size: result.data.size,
            mtimeMs: result.data.mtimeMs,
            truncated: result.data.truncated,
          });
          if (remoteHostId || deviceId) {
            // 远程小文件写穿磁盘缓存(fire-and-forget):断线兜底对大小文件
            // 语义一致——大文件靠取回缓存,小文件靠这里。
            void window.electronAPI.fileBrowser.cachePut({
              workdir,
              relPath,
              size: result.data.size,
              mtimeMs: result.data.mtimeMs,
              content: result.data.content,
              remoteHostId,
              deviceId,
            });
          }
          setState({
            workdir,
            relPath,
            content: {
              kind: 'text',
              content: result.data.content,
              relPath: result.data.relPath,
              size: result.data.size,
              mtimeMs: result.data.mtimeMs,
              truncated: result.data.truncated,
            },
          });
          return;
        }
        if (result.code === 'OVERSIZE' && result.stat) {
          // 超帧限的大文件:走取回管线;失败回落"文件过大"占位卡。
          await startBigFetch(result.stat.size, result.stat.mtimeMs, {
            kind: 'oversize',
            stat: result.stat,
          });
          return;
        }
        if (result.code === 'BINARY_FILE') {
          // Need stat for the placeholder card (size + mtime).
          try {
            const stat = await fileBrowserApiFor(deviceId).stat({ workdir, relPath, remoteHostId });
            if (cancelled) return;
            if (remoteHostId || deviceId) {
              // 远程二进制(图片/视频/任意文件):走取回管线,缓存副本可预览
              // (图片/PDF/视频)或占位卡本地打开;失败回落远程占位。
              await startBigFetch(stat.size, stat.mtimeMs, { kind: 'binary', stat });
              return;
            }
            setState({ workdir, relPath, content: { kind: 'binary', stat } });
          } catch (err) {
            if (!cancelled)
              setState({ workdir, relPath, content: { kind: 'error', message: String(err) } });
          }
          return;
        }
        setState({
          workdir,
          relPath,
          content: {
            kind: 'error',
            message: ('message' in result ? result.message : undefined) ?? 'read failed',
          },
        });
      } catch (err) {
        log.warn('readFile threw', err);
        if (cancelled) return;
        // 远程读失败(断线等):尝试用本地历史缓存副本兜底展示(main 侧按路径
        // 身份前缀捞最近副本;size/mtime 传 0,identity 校验由 stale 分支跳过)。
        if (remoteHostId || deviceId) {
          try {
            const res = await window.electronAPI.fileBrowser.fetchRemote({
              workdir,
              relPath,
              size: 0,
              mtimeMs: 0,
              remoteHostId,
              deviceId,
            });
            if (!cancelled && res.ok) {
              setState({
                workdir,
                relPath,
                content: {
                  kind: 'cached',
                  stat: { relPath, type: 'file', size: 0, mtimeMs: 0 },
                  cachePath: res.cachePath,
                  // 断线兜底捞的历史副本,一律按 stale 标注
                  stale: true,
                },
              });
              return;
            }
          } catch {
            // 兜底失败 → 落原错误态
          }
        }
        if (!cancelled) setState({ workdir, relPath, content: { kind: 'error', message: String(err) } });
      }
    })();

    return () => {
      cancelled = true;
      transferProgress?.dispose();
    };
  }, [workdir, relPath, remoteHostId, deviceId, refreshTick]);

  // listener 拿当前 relPath 的最新值, 但不进 effect deps —— 不能因为切文件就
  // 重新订阅 chokidar(那会丢掉订阅期间的事件)。
  const relPathRef = useRef(relPath);
  useEffect(() => {
    relPathRef.current = relPath;
  }, [relPath]);

  // 静默重读的端点保鲜:同 workdir+relPath 跨端点切换时,in-flight 重读的
  // 续体仅靠 relPathRef 判不出"端点已变",旧端点的字节会被写进新端点的
  // 视图与缓存桶(后续保存 = 覆写错机器)。
  const contentCacheScopeRef = useRef(contentCacheScope);
  useEffect(() => {
    contentCacheScopeRef.current = contentCacheScope;
  }, [contentCacheScope]);

  // chokidar push events → cache evict + 当前文件静默重读。
  //   - 任何文件被改 / 被删 都要 invalidate 该 entry, 否则下次切回时仍然看到
  //     stale 内容 (跟 useFileTree 同样的设计教训, listener 全程一根)。
  //   - 改动的恰好是当前打开的文件 → 后台直接重读, 拿到结果再 setState 推新
  //     内容。**不进 loading 中间态**, 否则用户视觉上会闪一帧空白(VSCode 标准
  //     体验是"agent 改完文件, 预览区无感更新")。
  //   - 原子替换写入在 macOS 上可能表现为 delete + create, 所以 add 也要按
  //     当前文件内容变更处理。
  //   - 'unlink' 暂不主动改 state — 让用户继续看到旧内容直到他主动切走, 比
  //     "突然弹错误卡片"更符合 VSCode 行为。
  useEffect(() => {
    if (!workdir) return;
    // 三路事件同形:本地 / SSH(main 桥接 daemon 帧)走 fileBrowser.onEvent,
    // device-link 走 onRemotePush 过滤 —— transport 统一,按 workdir 过滤后
    // 逻辑与本地完全一致。
    const off = onFileTreeEventFor(deviceId, (event) => {
      if (event.workdir !== workdir) return;
      const contentMayHaveChanged = event.type === 'add' || event.type === 'change';
      if (contentMayHaveChanged || event.type === 'unlink') {
        invalidateCachedFile(contentCacheScope, event.relPath);
      }
      if (contentMayHaveChanged && event.relPath === relPathRef.current) {
        const targetRelPath = event.relPath;
        void (async () => {
          try {
            const result = await fileBrowserApiFor(deviceId).readFile({
              workdir,
              relPath: targetRelPath,
              remoteHostId,
            });
            // race 守卫:重读期间用户可能切走了(文件或端点), ref 已变就丢弃。
            if (relPathRef.current !== targetRelPath) return;
            if (contentCacheScopeRef.current !== contentCacheScope) return;
            if (!result.ok) {
              // BINARY_FILE 等罕见状态:就保留当前显示, 不主动降级。
              return;
            }
            setCachedFileContent(contentCacheScope, {
              content: result.data.content,
              relPath: result.data.relPath,
              size: result.data.size,
              mtimeMs: result.data.mtimeMs,
              truncated: result.data.truncated,
            });
            setState({
              workdir,
              relPath: targetRelPath,
              content: {
                kind: 'text',
                content: result.data.content,
                relPath: result.data.relPath,
                size: result.data.size,
                mtimeMs: result.data.mtimeMs,
                truncated: result.data.truncated,
              },
            });
          } catch (err) {
            log.warn('silent re-read on change failed', err);
          }
        })();
      }
    });
    return off;
  }, [workdir, remoteHostId, deviceId, contentCacheScope]);

  // workdir 切换 → 旧 workdir 的 entry 一次性扔掉, 防长期累积。
  // 注意 cleanup 才扔: 当前 workdir 可能和上一渲染相等(Strict Mode 双调用),
  // 仅在 effect 真正卸载 (workdir 变了 / 组件 unmount) 时清, 不会误伤。
  useEffect(() => {
    if (!workdir) return;
    return () => invalidateWorkdirCache(contentCacheScope);
  }, [workdir, contentCacheScope]);

  const refresh = useCallback(() => {
    // 显式 invalidate 当前文件 + bump tick 触发 effect 重跑 → 走 miss 路径。
    if (relPath) invalidateCachedFile(contentCacheScope, relPath);
    setRefreshTick((t) => t + 1);
    // contentCacheScope 必须进 deps:同 workdir 跨端点切换时闭包若滞留旧
    // scope,invalidate/写入会落进别的端点的缓存桶(串内容 + 反向覆写)。
  }, [contentCacheScope, relPath]);

  const setLocal = useCallback(
    (data: { content: string; size: number; mtimeMs: number; truncated: boolean }) => {
      if (!relPath) return;
      setCachedFileContent(contentCacheScope, {
        content: data.content,
        relPath,
        size: data.size,
        mtimeMs: data.mtimeMs,
        truncated: data.truncated,
      });
      setState({
        workdir,
        relPath,
        content: {
          kind: 'text',
          content: data.content,
          relPath,
          size: data.size,
          mtimeMs: data.mtimeMs,
          truncated: data.truncated,
        },
      });
    },
    [contentCacheScope, workdir, relPath],
  );

  return {
    content: getVisibleFileContentState(state, workdir, relPath),
    refresh,
    setLocal,
  };
}
