import { PersistentImBindingStore } from '@cindy/im-runtime/binding';
export type { BindingAttachResult } from '@cindy/im-runtime/binding';
/**
 * main/im/binding.ts
 * ---------------------------------------------------------------------------
 * SQLite-backed implementation of `BindingStore<string>` (TValue = desktop
 * sessionId), 用于 feishu /ctr 接管流程的 identity → desktop session 路由。
 *
 * 不在 feishu/ 子目录下: binding 是 IM 渠道无关的概念, 未来 slack/discord
 * 共用同一个 store 实例 + 同一张 im_bindings 表 (PK 里有 channel 列区分)。
 *
 * 持久化:
 *   - SQLite im_bindings 表 (drizzle 定义在 localDb/schema.ts)
 *   - 进程内 Map 双向索引 (forward + reverse) 给 O(1) 同步读
 *   - preload() 在 app boot 流程 await 一次, 把全表 load 到内存
 *
 * 路由调用方:
 *   - feishu/runAgentTurn 入口: store.get(identity) → 命中走 desktop sessionId
 *
 * 写操作调用方:
 *   - cardActionHandler.handleControlSessionPick → store.attach(identity, sessionId)
 *   - cardActionHandler.handleControlNewSession → store.attach(identity, newId)
 *   - slashCommands /exitctr → executeDetach(identity, 'feishu-slash')
 *   - desktop "收回" 按钮 IPC → executeDetach(reverseLookup.identity, 'desktop-revoke')
 *
 * 失败策略: 持久化失败抛错 (caller 决定怎么处理); 内存 Map 仅在持久化成功后更新,
 * 保证两边一致。
 */

import { createImBindingStorage } from '@cindy/app-runtime/imBindingStorage';

import type { IdentityKey } from '@cindy/im';

import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';

const log = createLogger('im:binding');

export class SqliteBindingStore extends PersistentImBindingStore {
  constructor() {
    super({
      log,
      captureStorage() {
        return createImBindingStorage(getDbClient());
      },
    });
  }
}

// Singleton — 整个 main 进程共享一份 store。
export const bindingStore = new SqliteBindingStore();

/**
 * 接管 detach 的统一执行路径 — 不管谁触发 (feishu /exctr / desktop "收回"
 * 按钮 / 异常清理), 都走这一个入口。
 *
 * 这层只做两件事:
 *   1. 查 binding 是否真存在 (返回 wasAttached 给 caller 决定要不要发"已退出"
 *      通知 — 不存在的话, /exctr 应该提示"你又没接管谁")
 *   2. 调 bindingStore.detach() — 内部会持久化删除 + emit onChange event
 *
 * Channel-specific 的 in-process cleanup (取消 feishu fanout listener,
 * 还原 desktop interaction listener 等) 不在这里做 — 由 channel 模块自己
 * 在启动 wiring 阶段订阅 bindingStore.onChange, 看到 detach event (value=null
 * + prevValue=sessionId) 时清理。
 *
 * 这样:
 *   - binding.ts 完全 channel-agnostic, 不知道 'feishu' 这个名字, 不反向
 *     import feishu/* 文件, 不 dynamic-import 任何东西
 *   - 加 slack/discord 等新 channel 时只需在 main/im/index.ts 多 subscribe 一
 *     个 cleanup hook, binding.ts 一行不改
 *
 * 顺序保证: bindingStore.detach 内部是"先持久化 → 再清内存 Map → 再 emit"。
 * onChange listener 同步执行, 所以 channel cleanup 在 binding 已删之后跑 —
 * 微秒级窗口里"binding 还在但 listener 还没还原" 这种风险, 跟之前先清 hook
 * 再删 binding 是反过来的, 但分析下来无害:
 *   - feishu 这边新消息会被 messageHandler 接到 → runAgentTurn → resolveRouteTarget
 *     立刻查 binding, 已 null → 走默认 feishu_* session → 不会路由到旧 desktop
 *     session, 不会触发 SDK
 *   - 旧 session 没有新 SDK 调用 → 不会触发 permission/ask event → 不会有
 *     "interaction listener 没装" 问题
 * 所以这个新顺序实际上比之前更安全 (没有窗口期 binding 命中而 listener 缺位)。
 */
export async function executeDetach(
  identity: IdentityKey,
  source: `${string}-slash` | 'desktop-revoke',
): Promise<{ wasAttached: boolean; targetSessionId: string | null }> {
  const targetSessionId = bindingStore.get(identity);
  if (!targetSessionId) {
    return { wasAttached: false, targetSessionId: null };
  }

  try {
    const detached = await bindingStore.detachIfTarget(identity, targetSessionId);
    if (!detached) {
      return { wasAttached: false, targetSessionId: null };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`executeDetach: bindingStore.detach failed: ${msg}`);
    throw err;
  }

  log.info(
    `executeDetach done source=${source} channel=${identity.channel} ` +
      `user=...${identity.userId.slice(-8)} (was session=...${targetSessionId.slice(-8)})`,
  );
  return { wasAttached: true, targetSessionId };
}
