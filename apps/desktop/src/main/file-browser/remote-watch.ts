/**
 * remote-watch — SSH remote 会话的文件监听桥(P4)。
 *
 * 职责:把远端 daemon 的 fileTree event 帧接到本地 FILE_BROWSER_PUSH.EVENT
 * 推送链上,renderer 的 useFileTree / useFileContent 消费到的事件形状与本地
 * watcher 完全一致(按 workdir 过滤),无需分支。
 *
 * 生命周期(对齐本地 watcherManager 的 per window × workdir 语义):
 *  - start:daemon watchStart + 订阅该 host 的 fileTree 事件(按 workdir 过滤
 *    后转发给 onEvent)+ 订阅 host 重连钩子。
 *  - 断链重建:daemon 进程死了 watch 状态一起消失;manager 的 onHostConnected
 *    在新 daemon handshake 成功后触发,这里重放 watchStart,renderer 无感。
 *  - stop / window closed:退订 + 尽力 watchStop(通道已断则忽略)。
 */

import type { BrowserWindow } from 'electron';

import { createLogger } from '../logger.js';
import type { RemoteFileBrowserManager } from './remote.js';
import type { FileTreeEvent } from './watcher.js';

const log = createLogger('file-browser/remote-watch');

interface RegistryEntry {
  hostId: string;
  workdir: string;
  offEvent: () => void;
  offReconnect: () => void;
}

export class RemoteWatchRegistry {
  private readonly mgr: RemoteFileBrowserManager;
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(mgr: RemoteFileBrowserManager) {
    this.mgr = mgr;
  }

  private key(windowId: number, hostId: string, workdir: string): string {
    return JSON.stringify([windowId, this.mgr.normalizeHostId(hostId), workdir]);
  }

  /** 幂等:同 (window, host, workdir) 重复 start 直接 no-op。 */
  async start(
    window: BrowserWindow,
    hostId: string,
    workdir: string,
    opts: { hideMetaFiles?: boolean },
    onEvent: (event: FileTreeEvent) => void,
  ): Promise<void> {
    hostId = this.mgr.normalizeHostId(hostId);
    const k = this.key(window.id, hostId, workdir);
    if (this.entries.has(k)) return;

    const offEvent = this.mgr.onHostEvent(hostId, (evt) => {
      if (evt.event !== 'fileTree') return;
      const data = evt.data as FileTreeEvent;
      if (data.workdir !== workdir) return;
      if (window.isDestroyed()) return;
      onEvent(data);
    });
    // daemon 断链重建后 watch 状态随进程消失;重连成功即重放 watchStart。
    const offReconnect = this.mgr.onHostConnected(hostId, () => {
      void this.mgr
        .request(hostId, 'watchStart', { workdir, hideMetaFiles: opts.hideMetaFiles ?? true })
        .catch((err) => log.warn('watch replay failed', { hostId, workdir, error: String(err) }));
    });
    this.entries.set(k, { hostId, workdir, offEvent, offReconnect });

    window.once('closed', () => {
      void this.stop(window.id, hostId, workdir);
    });

    try {
      await this.mgr.request(hostId, 'watchStart', {
        workdir,
        hideMetaFiles: opts.hideMetaFiles ?? true,
      });
      log.info('remote watch started', { hostId, workdir, windowId: window.id });
    } catch (err) {
      // 启动失败(host 不可达等):清掉注册,renderer 靠聚焦刷新兜底。
      this.entries.delete(k);
      offEvent();
      offReconnect();
      throw err;
    }
  }

  async stop(windowId: number, hostId: string, workdir: string): Promise<void> {
    hostId = this.mgr.normalizeHostId(hostId);
    const k = this.key(windowId, hostId, workdir);
    const entry = this.entries.get(k);
    if (!entry) return;
    this.entries.delete(k);
    entry.offEvent();
    entry.offReconnect();
    // 同 host 其它 window/workdir 还在 watch 时不能全局 watchStop;仅当这是该
    // (host, workdir) 的最后一个订阅者才让 daemon 停 watch。
    const stillWatching = [...this.entries.values()].some(
      (candidate) => candidate.hostId === hostId && candidate.workdir === workdir,
    );
    if (!stillWatching) {
      await this.mgr
        .request(hostId, 'watchStop', { workdir })
        .catch(() => undefined); // 通道断了 daemon 也没了,无孤儿
    }
    log.info('remote watch stopped', { hostId, workdir, windowId });
  }
}

let registry: RemoteWatchRegistry | null = null;

/** 单例(依赖 remote-deps 的 manager 单例)。 */
export function getRemoteWatchRegistry(mgr: RemoteFileBrowserManager): RemoteWatchRegistry {
  if (!registry) registry = new RemoteWatchRegistry(mgr);
  return registry;
}
