/**
 * host-daemons/ipc —— 「本机常驻」清单的 IPC 面。
 *
 * 授权边界与 process-monitor 一致：
 *  - 只对 Cindy 自有顶层 renderer 开放（`assertTrustedAppRendererEvent`）。
 *  - 停止/删除不信 renderer：重新扫描计划任务、重算归属，只有本功能登记过的条目
 *    才可操作；`\Microsoft\*` 永久拒绝。
 *  - 返回体里的启动命令含绝对路径（本清单的用途就是「脚本在哪、怎么恢复」），
 *    因此只本机、只可信 renderer、不进日志；远程会话没有这条 IPC。
 */

import { ipcMain } from 'electron';

import {
  HOST_DAEMONS_DELETE_CHANNEL,
  HOST_DAEMONS_LIST_CHANNEL,
  HOST_DAEMONS_RUN_CHANNEL,
  HOST_DAEMONS_STOP_CHANNEL,
  type HostDaemonsSnapshot,
} from '../../shared/hostDaemons.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { HostDaemonActionError, type HostDaemonsService } from './service.js';

const log = createLogger('host-daemons');

export interface HostDaemonsIpcOptions {
  /** 首次调用时构造；生产装配见 bootstrap-electron.ts。 */
  getService: () => HostDaemonsService;
}

let registered = false;

function toIpcError(error: unknown): never {
  if (error instanceof HostDaemonActionError) {
    if (error.code === 'NOT_FOUND') throwIpcError('NOT_FOUND', 'host daemon not found');
    if (error.code === 'UNSUPPORTED') {
      throwIpcError('PRECONDITION_FAILED', 'host daemons are Windows only');
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

  const registerAction = (channel: string, run: (service: HostDaemonsService, id: string) => Promise<void>) => {
    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      assertTrustedAppRendererEvent(event);
      const request = requireObject(rawRequest, 'request');
      const id = requireString(request.id, 'id');
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
}
