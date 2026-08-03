/**
 * registerSearchIpc — main-side IPC for project-wide text search.
 *
 *   maker:search:start   (invoke)  → 启动一次搜索, 返回 { searchId }
 *   maker:search:cancel  (invoke)  → 取消指定 searchId
 *   maker:search:event   (push)    → match / end / error 流式事件
 *
 * 设计:
 *  - 每个 BrowserWindow 拥有自己的 RipgrepSearcher 实例(隔离 + 清理简单)。
 *  - 同一 window 同时只允许一个 active search: start 时如果还有上一次没结束的,
 *    先 cancel 掉再启新 search(避免抖动期累积僵尸 rg)。
 *  - window 关闭时 cancelAll() 清干净所有 rg 子进程。
 */

import { ipcMain, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import { RipgrepSearcher, type SearchEvent } from '@cindy/file-browser-core';

import { createLogger } from '../../logger.js';
import { getRipgrepBinaryPath } from '../../maker-host/runtime-configs.js';
import { getRemoteFileBrowser } from '../remote-deps.js';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

const log = createLogger('file-browser/search');

export const SEARCH_INVOKE = {
  START: IPC_CHANNELS.MAKER_EXTRA.SEARCH_START,
  CANCEL: IPC_CHANNELS.MAKER_EXTRA.SEARCH_CANCEL,
} as const;

export const SEARCH_PUSH = {
  EVENT: IPC_CHANNELS.MAKER_EXTRA.SEARCH_EVENT,
} as const;

interface StartArgs {
  workdir: string;
  query: string;
  caseSensitive: boolean;
  maxMatches: number;
  /** 非空 = SSH remote 会话。P3 接远端 rg 之前 main 直接拒绝(renderer 已隐藏入口,这里兜底)。 */
  remoteHostId?: string | null;
}

interface CancelArgs {
  searchId: string;
  /** 与 StartArgs 对齐:远程搜索的 cancel 要路由回同一 host 的 daemon。 */
  remoteHostId?: string | null;
}

interface PerWindow {
  searcher: RipgrepSearcher;
  /** 当前 active searchId,新 search 来时先 cancel 它(单 active 策略)。 */
  activeId: string | null;
}

/**
 * Per-window state. Window 销毁时被 'closed' 事件清理。
 */
const perWindow = new WeakMap<WebContents, PerWindow>();
/** 跟踪所有挂过 closed 监听的 window,避免重复挂(BrowserWindow 没有 once 语义保护)。 */
const wiredWindows = new Set<number>();

function getOrCreate(wc: WebContents): PerWindow {
  let entry = perWindow.get(wc);
  if (entry) return entry;

  const rgPath = getRipgrepBinaryPath();
  const searcher = new RipgrepSearcher({ rgPath, logger: log });

  // 任何 search event(match/end/error) 都直接转发到该 window。
  searcher.on('event', (evt: SearchEvent) => {
    if (wc.isDestroyed()) return;
    wc.send(SEARCH_PUSH.EVENT, evt);
    // end/error 时清掉 activeId(让下次 start 不会去 cancel 已结束的)。
    if (evt.type !== 'match' && entry && entry.activeId === evt.searchId) {
      entry.activeId = null;
    }
  });

  entry = { searcher, activeId: null };
  perWindow.set(wc, entry);

  // 一次性挂 closed 监听:window 关闭时停掉所有 rg 子进程。
  const win = BrowserWindow.fromWebContents(wc);
  if (win && !wiredWindows.has(win.id)) {
    wiredWindows.add(win.id);
    win.once('closed', () => {
      const e = perWindow.get(wc);
      if (e) {
        e.searcher.cancelAll();
        perWindow.delete(wc);
      }
      wiredWindows.delete(win.id);
    });
  }

  return entry;
}

export function registerSearchIpc(): void {
  ipcMain.handle(SEARCH_INVOKE.START, async (event, args: StartArgs) => {
    if (!args || typeof args.query !== 'string' || args.query.length === 0) {
      return { ok: false as const, message: 'empty query' };
    }
    if (!args.workdir) {
      return { ok: false as const, message: 'workdir required' };
    }
    if (args.remoteHostId) {
      // 远程搜索:daemon 内 spawn 远端 rg,match/end/error 经 event 帧流回,
      // 这里转发到发起 window(与本地 RipgrepSearcher 的事件形状完全一致,
      // renderer 无感)。终态(end/error)自动退订。
      const hostId = args.remoteHostId;
      const wc = event.sender;
      const mgr = getRemoteFileBrowser();
      // 监听必须先于 searchStart 挂上:秒回/空结果的搜索,daemon 可能在
      // searchStart 响应同一 stdout chunk 里就吐出 match/end 事件——await 续体
      // 里才挂监听会丢首批事件甚至丢 end(renderer 卡在 searching)。启动窗口
      // 内(searchId 未知)先缓冲,拿到 id 后过滤回放。
      let searchId: string | null = null;
      let finished = false;
      const buffered: SearchEvent[] = [];
      const forward = (data: SearchEvent): void => {
        if (!wc.isDestroyed()) wc.send(SEARCH_PUSH.EVENT, data);
        if (data.type !== 'match') {
          finished = true;
          off();
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
        forward(data);
      });
      try {
        const r = await mgr.request(hostId, 'searchStart', {
          workdir: args.workdir,
          query: args.query,
          caseSensitive: args.caseSensitive,
          maxMatches: args.maxMatches,
        });
        searchId = r.searchId;
        // 启动窗口内缓冲到的本次事件不能从这里 push——renderer 要等本响应
        // 返回后才知道 searchId、才能设置过滤键,先推必被当 stale 丢弃。
        // 改为随响应带回,由 renderer 设完过滤键后自行回放。
        const replay = buffered.filter((d) => d.searchId === searchId);
        buffered.length = 0;
        if (replay.some((d) => d.type !== 'match')) {
          // 缓冲里已含终态:该搜索不会再有后续事件,退订。
          finished = true;
          off();
        }
        log.debug('remote search started', { hostId, searchId, queryLen: args.query.length, replay: replay.length });
        return { ok: true as const, searchId, replay };
      } catch (err) {
        off();
        log.warn('remote search start failed', { hostId, error: String(err) });
        // code 透传(FileServiceRpcError.code,如 RG_UNAVAILABLE),renderer 按码
        // 映射友好文案;message 保留原始描述兜底。
        return {
          ok: false as const,
          message: String(err),
          code: (err as Error & { code?: string }).code,
        };
      }
    }
    const entry = getOrCreate(event.sender);
    // 单 active 策略:有正在跑的就先取消。
    if (entry.activeId) {
      entry.searcher.cancel(entry.activeId);
      entry.activeId = null;
    }
    const searchId = entry.searcher.start({
      workdir: args.workdir,
      query: args.query,
      caseSensitive: args.caseSensitive,
      maxMatches: args.maxMatches,
    });
    entry.activeId = searchId;
    log.debug('search started', {
      searchId,
      workdir: args.workdir,
      queryLen: args.query.length,
      caseSensitive: args.caseSensitive,
    });
    return { ok: true as const, searchId };
  });

  ipcMain.handle(SEARCH_INVOKE.CANCEL, async (event, args: CancelArgs) => {
    if (!args?.searchId) return { ok: true as const };
    if (args.remoteHostId) {
      try {
        await getRemoteFileBrowser().request(args.remoteHostId, 'searchCancel', {
          searchId: args.searchId,
        });
      } catch (err) {
        // cancel 尽力而为:通道断了 daemon 进程也一并没了,rg 无孤儿。
        log.debug('remote search cancel failed', { error: String(err) });
      }
      return { ok: true as const };
    }
    const entry = perWindow.get(event.sender);
    if (!entry) return { ok: true as const };
    entry.searcher.cancel(args.searchId);
    if (entry.activeId === args.searchId) entry.activeId = null;
    return { ok: true as const };
  });

  log.info('search IPC registered');
}

export type { SearchEvent, SearchMatch, SearchEnd, SearchError, SubmatchSpan } from '@cindy/file-browser-core';
