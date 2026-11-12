/**
 * im/shared/imOutboxWiring.ts
 * ---------------------------------------------------------------------------
 * 把持久出箱接到某个渠道适配器上。宿主侧只提供三件渠道事实:
 *  - 当前连接属于哪个 bot(`botId`)、哪个稳定账号代次;
 *  - 分项投递能力(`transport`), 以及媒体总仓地址解析;
 *  - 凭证是否已被清掉(`isUnbound`)。
 *
 * 所有记录都在**账号隔离**目录下、按 bot 分文件, 于是"账号 + bot + 目标"三重
 * 隔离由文件名与记录字段共同保证。注意: **`idle` 不等于解绑** —— 退出、断线、
 * 未配置凭证都会落 `idle`, 只有凭证确实被清掉(`isUnbound()`)才删除待发记录; 否则
 * 退出即删, 重启补发永远不会发生。完整语义见 `attachOutboxLifecycle`。
 */
import { createHash } from 'node:crypto';

import type { ImFinalOutput } from '@cindy/im';

import { dataOwnerStorageKey, getActiveAppSession } from '../../appSessionState';
import { createLogger } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import {
  createImOutbox,
  createImOutboxDelivery,
  type ImOutboxCommitOutcome,
  type ImOutboxDelivery,
  type ImOutboxStore,
  type ImOutboxTransport,
} from './imOutbox';

const log = createLogger('im:outbox');

export interface ChannelOutboxOptions {
  channel: 'wecom';
  /** 当前连接所属 bot(未连接/无凭证时返回空串)。 */
  botId: () => string;
  /** 分项投递能力; 未连接时可以返回 null。 */
  transport: () => ImOutboxTransport | null;
  /** cindy-media 地址 → 绝对路径。 */
  resolveMediaUrl?: (url: string) => string | null;
  /** 该目标是否仍属于当前连接(bot 未变)。 */
  isCurrentTarget?: (target: string) => boolean;
  /**
   * 自定义 store 工厂(缺省按文件路径创建)。宿主/测试可注入自己的实现; 生命周期
   * 约定不变: 同身份重建只重读文件, 不删除已完成的 checkpoint。
   */
  createStore?: (args: { channel: 'wecom'; filePath: string }) => ImOutboxStore;
}

/** bot id 会进文件名, 只保留安全字符。 */
function botFileKey(botId: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(botId)) return botId;
  return `h-${createHash('sha256').update(botId, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * 稳定的账号代次标识。
 *
 * 不用 `activeOwnerScopeKey()`: 它含 `generation`, 同一账号重新提交会话就会变 ——
 * 于是“重启后补发”会把上一条记录当成别人的而丢掉。这里用账号的稳定存储键:
 * 同账号重启后照旧, 真正换账号时必然变化。
 */
function stableAccountScope(): string {
  const session = getActiveAppSession();
  return session.dataOwnerId ? `owner:${dataOwnerStorageKey(session.dataOwnerId)}` : 'local';
}

function ownerStoragePresent(): boolean {
  return Boolean(getActiveAppSession().dataOwnerId);
}

export interface ChannelOutbox {
  /** 持久受理终稿并立即尝试投递; 返回值说明真实送达边界。 */
  commit(output: ImFinalOutput): Promise<ImOutboxCommitOutcome>;
  /** 连接恢复/启动时补发。 */
  flush(): Promise<void>;
  /** 解绑/换账号: 停发送并删除当前 store 的全部记录。 */
  dropCurrentScope(): void;
  /** 只停发送(不删记录), 用于账号切换时隔离在飞的旧投递。 */
  stop(): void;
}

/**
 * 把出箱接上连接生命周期。
 *
 * 关键区分: **`idle` 不等于解绑**。
 *  - `dispose()` / 断线 / 未配置凭证 也会落 `idle`; 其中 `dispose()` 在应用退出时
 *    发生, 此时若删掉待发记录, 重启后的补发就永远不存在了。
 *  - 只有「凭证已经被清掉」才是真正的解绑 —— 由调用方用 `isUnbound()` 判定, 因为
 *    状态事件发出时凭证可能还没清完、也可能已经不在。
 *
 * 传入对象缺少 `onStatusChange` 时(旧宿主/测试替身)直接跳过。若接头时已经 connected,
 * 立即补发一次(启动时先连上后接线的顺序)。
 */
export function attachOutboxLifecycle(
  im: {
    onStatusChange?: (handler: (status: { kind: string }) => void) => () => void;
    getStatus?: () => { kind: string };
  },
  outbox: ChannelOutbox,
  isUnbound: () => boolean = () => false,
): () => void {
  const unsubscribe =
    typeof im.onStatusChange === 'function'
      ? im.onStatusChange((status) => {
          if (status.kind === 'connected') {
            void outbox.flush().catch(() => log.warn('im outbox flush failed'));
            return;
          }
          // 退出/断线保留记录; 只有凭证确实被清掉(解绑)才作废。
          if (status.kind === 'idle' && isUnbound()) outbox.dropCurrentScope();
        })
      : () => undefined;
  if (im.getStatus?.().kind === 'connected') {
    void outbox.flush().catch(() => log.warn('im outbox flush failed'));
  }
  return unsubscribe;
}

export function createChannelOutbox(options: ChannelOutboxOptions): ChannelOutbox {
  /** 缓存按「账号代次 + bot」定位: 同 bot 换账号必须换 store。 */
  let cached: { key: string; delivery: ImOutboxDelivery } | null = null;

  function stopCached(clearRecords: boolean): void {
    if (!cached) return;
    cached.delivery.stop();
    if (clearRecords) cached.delivery.dropCurrentScope();
    cached = null;
  }

  function resolve(): ImOutboxDelivery | null {
    // 先看账号是否可用, 再看记录: 登出后不能继续用上一个账号的 store。
    if (!ownerStoragePresent()) {
      stopCached(false);
      return null;
    }
    const botId = options.botId().trim();
    if (!botId) return null;
    const accountScope = stableAccountScope();
    const key = `${accountScope}|${botId}`;
    if (cached?.key === key && !cached.delivery.isStopped()) return cached.delivery;
    if (cached?.key === key) {
      // **同身份的 IO 恢复**: 实例因为 checkpoint 写失败停掉了, 但记录仍然有效 ——
      // 只停不删, 从磁盘重建(上一次成功 checkpoint 必须原样保留)。
      stopCached(false);
    } else {
      // 账号或 bot 变了: 旧 delivery 立即停发(在飞的也不能再发), 旧记录按旧身份作废。
      stopCached(true);
    }
    const filePath = ownerScopedImUserDataPath(
      'im-outbox',
      `${options.channel}-${botFileKey(botId)}.json`,
    );
    const store =
      options.createStore?.({ channel: options.channel, filePath }) ??
      createImOutbox({ channel: options.channel, filePath, log });
    const delivery = createImOutboxDelivery({
      channel: options.channel,
      store,
      botId: () => options.botId().trim(),
      accountScope: () => stableAccountScope(),
      // 绑定创建时的身份: 定时器/排队任务在换账号后醒来时必须停用, 不能拿新身份
      // 去读/清这个旧 store。
      boundAccountScope: accountScope,
      boundBotId: botId,
      transport: () => {
        const current = options.transport();
        if (!current) return null;
        return {
          prepareFinal: (output) => current.prepareFinal(output),
          deliverFinal: (output, plan, opts) => current.deliverFinal(output, plan, opts),
          commitFinal: (output) => current.commitFinal(output),
          // 连接状态能力必须透传: 出箱靠它区分“离线”与“投递失败”。
          ...(current.isConnected ? { isConnected: () => current.isConnected!() } : {}),
        };
      },
      ...(options.resolveMediaUrl ? { resolveMediaUrl: options.resolveMediaUrl } : {}),
      ...(options.isCurrentTarget
        ? {
            isCurrentTarget: (entry: { target: string }) =>
              options.isCurrentTarget!(entry.target),
          }
        : {}),
      log,
    });
    cached = { key, delivery };
    return delivery;
  }

  return {
    async commit(output) {
      const delivery = resolve();
      if (!delivery) {
        // 没有 bot/账号上下文(例如还没连接): 走渠道原有直接投递语义。
        const transport = options.transport();
        if (!transport) throw new Error('IM transport unavailable');
        return (await transport.commitFinal(output)) ?? { status: 'sent', unresolved: 0, retrying: 0 };
      }
      return delivery.commit(output);
    },
    async flush() {
      const delivery = resolve();
      if (!delivery) return;
      await delivery.flush();
    },
    dropCurrentScope() {
      // 解绑时 botId/账号可能已经变了或已清空: 先清**缓存里的那个 store**(旧身份),
      // 再清当前身份解析出的 store(两者不同时都清); 清完不留已停的缓存。
      const previous = cached;
      previous?.delivery.dropCurrentScope();
      cached = null;
      const current = resolve();
      if (current) {
        current.dropCurrentScope();
        cached = null;
      }
    },
    stop() {
      stopCached(false);
    },
  };
}
