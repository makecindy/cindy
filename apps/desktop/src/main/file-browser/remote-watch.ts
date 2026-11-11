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

/**
 * daemon 侧的消费者身份。同一 (host, workdir) 会被 device-link 的 fs-watch 同时
 * 订阅(被控端把它转发给控制端);两边各自登记过滤需求,daemon 取可见性并集,
 * 而不是后到的 watchStart 把先到的 matcher 覆盖掉。
 */
const WATCH_CONSUMER_ID = 'desktop-tree';

interface RegistryEntry {
  /** 结构化保存 host / workdir：引用计数扫描不再拆 `${windowId}::${host}::${workdir}`
   *  —— workdir 里合法出现 `::` 时（如 `/srv/foo::bar`），拆分会截断路径，扫描就
   *  认不出另一个窗口在看同一 workdir，停一个窗口会误发 watchStop 把另一个也停掉
   *  （评审 P1）。 */
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
    return `${windowId}::${hostId}::${workdir}`;
  }

  /** 幂等:同 (window, host, workdir) 重复 start 直接 no-op。 */
  async start(
    window: BrowserWindow,
    hostId: string,
    workdir: string,
    opts: { hideMetaFiles?: boolean; showIgnoredDirs?: boolean },
    onEvent: (event: FileTreeEvent) => void,
  ): Promise<void> {
    const k = this.key(window.id, hostId, workdir);
    if (this.entries.has(k)) return;

    // daemon 侧 watchStart 拿的是同一组过滤开关:开关变了由 renderer 的 store
    // 重建驱动 stop→start(daemon 自身也会在选项变化时重建 matcher)。
    const watchOpts = {
      workdir,
      hideMetaFiles: opts.hideMetaFiles ?? true,
      showIgnoredDirs: opts.showIgnoredDirs === true,
      consumerId: WATCH_CONSUMER_ID,
    };

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
        .request(hostId, 'watchStart', watchOpts)
        .catch((err) => log.warn('watch replay failed', { hostId, workdir, error: String(err) }));
    });
    const entry: RegistryEntry = { hostId, workdir, offEvent, offReconnect };
    this.entries.set(k, entry);

    window.once('closed', () => {
      void this.stop(window.id, hostId, workdir);
    });

    try {
      await this.mgr.request(hostId, 'watchStart', watchOpts);
      log.info('remote watch started', { hostId, workdir, windowId: window.id });
    } catch (err) {
      // 启动失败(host 不可达等):清掉本次注册,renderer 靠聚焦刷新兜底。
      //
      // 只回收**本次 start 装上的那条**:切「显示被忽略的目录」会在同一个 key
      // 上 stop→start,而两个 RPC 都是异步的。旧 start 若在新 start 装上替换
      // 注册之后才 reject,无条件 delete 会把新注册变成孤儿 —— 之后 stop() 直接
      // 提前返回,新注册的事件/重连 listener 泄漏,daemon 侧 watch 也不会停,
      // 反复切换会累积重复订阅。
      if (this.entries.get(k) === entry) this.entries.delete(k);
      offEvent();
      offReconnect();
      // 本地最后一个订阅者也没能站起来:撤回 daemon 侧的 consumer 注册。
      //
      // 为什么必须补这一发:同 (host, workdir) 的多个窗口共用一个 consumerId,
      // 而 stop 侧有引用计数(还有别窗在 watch 就不发 watchStop)。两个替换 start
      // 同时失败时,本地条目全被删、daemon 侧却留着注册与重建出来的 watcher ——
      // 没有任何客户端再去 stop 它(评审 P1),它还会抬高 device-link 的可见性
      // 并集。只在确认本地再无同 (host, workdir) 条目时才发:还有别的窗口在
      // watch(或它的 start 正在飞,条目已先入表)时不能撤。
      const stillLocal = [...this.entries.values()].some(
        (e) => e.hostId === hostId && e.workdir === workdir,
      );
      if (!stillLocal) {
        void this.mgr
          .request(hostId, 'watchStop', { workdir, consumerId: WATCH_CONSUMER_ID })
          .catch(() => undefined);
      }
      throw err;
    }
  }

  async stop(windowId: number, hostId: string, workdir: string): Promise<void> {
    const k = this.key(windowId, hostId, workdir);
    const entry = this.entries.get(k);
    if (!entry) return;
    this.entries.delete(k);
    entry.offEvent();
    entry.offReconnect();
    // 同 host 其它 window/workdir 还在 watch 时不能全局 watchStop;仅当这是该
    // (host, workdir) 的最后一个订阅者才让 daemon 停 watch。
    const stillWatching = [...this.entries.values()].some(
      (e) => e.hostId === hostId && e.workdir === workdir,
    );
    if (!stillWatching) {
      await this.mgr
        .request(hostId, 'watchStop', { workdir, consumerId: WATCH_CONSUMER_ID })
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
