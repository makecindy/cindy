/**
 * host-daemons/ipc —— 「本机常驻」清单的 IPC 面。
 *
 * 授权边界与 process-monitor 一致：
 *  - 只对 Cindy 自有顶层 renderer 开放（`assertTrustedAppRendererEvent`）。
 *  - 停止/删除不信 renderer：重新扫描本机常驻、重算归属，只有本功能登记过的条目
 *    才可操作；`\Microsoft\*` 永久拒绝。
 *  - 返回体里的启动命令含绝对路径（本清单的用途就是「脚本在哪、怎么恢复」），
 *    因此只本机、只可信 renderer、不进日志；远程会话没有这条 IPC。
 *
 * 读写分开（工程规范 §8.2 / §8.3）：list 只读，不写台账。归属核对由 main 自己的
 * 后台任务推进：面板可见时 renderer 订阅，main 按服务给的间隔一轮一轮做，每轮
 * 结束推一条变化通知；面板不可见或窗口销毁就停。renderer 不直接调用 refresh。
 */

import { BrowserWindow, ipcMain, type WebContents } from 'electron';

import {
  HOST_DAEMONS_CHANGED_EVENT,
  HOST_DAEMONS_DELETE_CHANNEL,
  HOST_DAEMONS_LIST_CHANNEL,
  HOST_DAEMONS_RUN_CHANNEL,
  HOST_DAEMONS_STOP_CHANNEL,
  HOST_DAEMONS_SUBSCRIBE_CHANNEL,
  HOST_DAEMONS_UNSUBSCRIBE_CHANNEL,
  type HostDaemonsRefreshResult,
  type HostDaemonsSnapshot,
} from '../../shared/hostDaemons.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { HostDaemonActionError, type HostDaemonsService } from './service.js';

const log = createLogger('host-daemons');

/** 推进失败后的重试间隔：稍后再试，不空转。 */
const RETRY_FLOOR_MS = 15_000;

export interface HostDaemonsIpcOptions {
  /** 首次调用时构造；生产装配见 bootstrap-electron.ts。 */
  getService: () => HostDaemonsService;
  /** 预热窗口可以保留订阅，但不允许它触发后台推进或接收清单。缺省 = 都允许。 */
  allowsRefresh?: (sender: WebContents) => boolean;
  /** 仅测试用：推进一轮；缺省调服务的 refresh()。 */
  refresh?: () => Promise<HostDaemonsRefreshResult>;
}

let registered = false;

function toIpcError(error: unknown): never {
  if (error instanceof HostDaemonActionError) {
    if (error.code === 'NOT_FOUND') throwIpcError('NOT_FOUND', 'host daemon not found');
    if (error.code === 'UNSUPPORTED') {
      throwIpcError('PRECONDITION_FAILED', 'host daemons are not available here');
    }
    if (error.code === 'NOT_STOPPABLE') {
      throwIpcError('PRECONDITION_FAILED', 'host daemon cannot be stopped on its own');
    }
    throwIpcError('PRECONDITION_FAILED', 'host daemon is not owned by Cindy');
  }
  throwIpcError('INTERNAL', 'host daemon action failed');
}

export function registerHostDaemonsIpc(opts: HostDaemonsIpcOptions): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(HOST_DAEMONS_LIST_CHANNEL, async (event): Promise<HostDaemonsSnapshot> => {
    assertTrustedAppRendererEvent(event);
    try {
      return await opts.getService().list();
    } catch (err) {
      log.warn('host daemons scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throwIpcError('INTERNAL', 'host daemons scan failed');
    }
  });

  const subscribers = new Set<WebContents>();
  const destroyListeners = new WeakMap<WebContents, () => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const refresh = opts.refresh ?? (() => opts.getService().refresh());

  function refreshAllowed(wc: WebContents): boolean {
    return !opts.allowsRefresh || opts.allowsRefresh(wc);
  }

  function hasActiveSubscriber(): boolean {
    let active = false;
    for (const wc of [...subscribers]) {
      if (wc.isDestroyed()) {
        dropSubscriber(wc);
        continue;
      }
      if (refreshAllowed(wc)) active = true;
    }
    return active;
  }

  function publishChanged(): void {
    for (const wc of [...subscribers]) {
      if (wc.isDestroyed()) {
        dropSubscriber(wc);
        continue;
      }
      // 清单含启动命令与任务标题；窗口导航离开 Cindy 页面后不再推。
      if (!refreshAllowed(wc) || !isTrustedAppRendererWindow(BrowserWindow.fromWebContents(wc))) {
        continue;
      }
      try {
        wc.send(HOST_DAEMONS_CHANGED_EVENT);
      } catch {
        // 窗口可能在枚举与 send 之间被销毁。
      }
    }
  }

  function dropSubscriber(wc: WebContents): void {
    subscribers.delete(wc);
    const destroyListener = destroyListeners.get(wc);
    if (destroyListener) {
      wc.removeListener('destroyed', destroyListener);
      destroyListeners.delete(wc);
    }
    if (subscribers.size === 0) clearTimer();
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (running) return; // 上一轮没做完就不叠加
    if (!hasActiveSubscriber()) {
      clearTimer();
      return;
    }
    running = true;
    try {
      const result = await refresh();
      // 做完这一轮才看还有谁在订阅：途中全部退订就没人收到通知；途中新来的订阅者
      // 收这一条后重读，下一轮也照常续排。
      publishChanged();
      if (result.retryAfterMs !== null && hasActiveSubscriber()) schedule(result.retryAfterMs);
    } catch (err) {
      log.warn('host daemons refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // 推进失败不伪装成结论：已展示的清单继续保留，稍后再试。
      if (hasActiveSubscriber()) schedule(RETRY_FLOOR_MS);
    } finally {
      running = false;
    }
  }

  ipcMain.handle(HOST_DAEMONS_SUBSCRIBE_CHANNEL, async (event) => {
    assertTrustedAppRendererEvent(event);
    const wc = event.sender;
    if (!subscribers.has(wc)) {
      const destroyListener = () => dropSubscriber(wc);
      subscribers.add(wc);
      destroyListeners.set(wc, destroyListener);
      wc.once('destroyed', destroyListener);
    }
    // 面板打开先推进一轮再回：list 只读，首屏清单要等到这一轮的归属结果。
    // 预热窗口（allowsRefresh 为 false）只保留订阅：它不可见时渲染侧不会订阅，窗口
    // 转正时可见性翻转，渲染侧重新订阅，所以这里不为它留定时器。
    await tick();
  });

  ipcMain.handle(HOST_DAEMONS_UNSUBSCRIBE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    dropSubscriber(event.sender);
  });

  const registerAction = (channel: string, run: (service: HostDaemonsService, id: string) => Promise<void>) => {
    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      assertTrustedAppRendererEvent(event);
      const request = requireObject(rawRequest, 'request');
      const id = requireString(request.id, 'request.id');
      try {
        await run(opts.getService(), id);
      } catch (err) {
        log.warn('host daemon action failed', {
          channel,
          error: err instanceof Error ? err.message : String(err),
        });
        toIpcError(err);
      }
      return { ok: true as const };
    });
  };

  registerAction(HOST_DAEMONS_STOP_CHANNEL, (service, id) => service.stop(id));
  registerAction(HOST_DAEMONS_RUN_CHANNEL, (service, id) => service.run(id));
  registerAction(HOST_DAEMONS_DELETE_CHANNEL, (service, id) => service.remove(id));
}

/** 仅测试用：允许同一进程内重复注册。 */
export function _resetHostDaemonsIpcForTests(): void {
  registered = false;
  ipcMain.removeHandler(HOST_DAEMONS_LIST_CHANNEL);
  ipcMain.removeHandler(HOST_DAEMONS_STOP_CHANNEL);
  ipcMain.removeHandler(HOST_DAEMONS_RUN_CHANNEL);
  ipcMain.removeHandler(HOST_DAEMONS_DELETE_CHANNEL);
  ipcMain.removeHandler(HOST_DAEMONS_SUBSCRIBE_CHANNEL);
  ipcMain.removeHandler(HOST_DAEMONS_UNSUBSCRIBE_CHANNEL);
}
