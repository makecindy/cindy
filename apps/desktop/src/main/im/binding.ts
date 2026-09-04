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

import { eq } from 'drizzle-orm';

import type {
  BindingChangeEvent,
  BindingChangeListener,
  BindingStore,
  IdentityKey,
} from '@cindy/im';

import { getDbClient } from '../localDb/client/current';
import { imBindings } from '../localDb/schema';
import { createLogger } from '../logger';

const log = createLogger('im:binding');

function keyOf(id: IdentityKey): string {
  // NUL 分隔(渠道 id 不可能含 \0, 无碰撞);scopeKey 是 thread 能力渠道的
  // 会话维度(slack thread root ts), 无 thread 渠道(feishu)恒缺省 = ''。
  return [id.channel, id.botContextId, id.userId, id.scopeKey ?? ''].join('\u0000');
}

export interface BindingAttachResult {
  displaced: {
    identity: IdentityKey;
    attachedViaCardMessageId: string | null;
  } | null;
}

export class SqliteBindingStore implements BindingStore<string> {
  /** identity-key (string) → desktop sessionId */
  private readonly forward = new Map<string, string>();
  /** desktop sessionId → identity (反向索引, 给"收回"按钮反查用) */
  private readonly reverse = new Map<string, IdentityKey>();
  /**
   * identity-key → attach 时的卡片 messageId(thread 模型的锚点/root 卡)。
   * 重复接管替换流程用它反查旧接管的锚点卡好收口文案;DB 列
   * attachedViaCardMessageId 本来就有, 这里只是内存镜像。
   */
  private readonly attachCardIds = new Map<string, string>();
  private readonly listeners = new Set<BindingChangeListener<string>>();
  private preloaded = false;
  /** Serialize persisted writes with their matching in-memory index updates. */
  private mutationQueue: Promise<void> = Promise.resolve();

  preload(): Promise<void> {
    return this.enqueueMutation(async () => {
      if (this.preloaded) return;
      // 走 DbClient async 代理: MR2.2 后 main 侧 _drizzle 在 worker takeover
      // 时被释放, getDrizzle() 会抛 'localDb not ready'。代理把 query 转发给
      // worker 内的真 better-sqlite3 实例, await 已经是 await Promise(原 await
      // sync value 是 no-op, 现在变成真 async, 调用形态不变)。
      const dbClient = getDbClient();
      const rows = await dbClient.drizzle.select().from(imBindings);
      const winnersByTarget = new Map<
        string,
        { identity: IdentityKey; attachedAt: number; cardMessageId: string | null }
      >();
      const staleIdentities: IdentityKey[] = [];

      for (const row of rows) {
        const id: IdentityKey = {
          channel: row.channel,
          botContextId: row.botContextId,
          userId: row.userId,
          // '' = 无 scope(feishu);非空 = slack thread root ts
          ...(row.scopeKey ? { scopeKey: row.scopeKey } : {}),
        };

        // Older builds allowed multiple identities to point at one desktop
        // session even though the session has only one interaction listener.
        // Recover deterministically by keeping the most recent takeover and
        // deleting stale rows before opening the ingress gate.
        const existing = winnersByTarget.get(row.targetSessionId);
        const candidateWins =
          !existing ||
          row.attachedAt > existing.attachedAt ||
          (row.attachedAt === existing.attachedAt && keyOf(id) > keyOf(existing.identity));
        if (candidateWins) {
          if (existing) staleIdentities.push(existing.identity);
          winnersByTarget.set(row.targetSessionId, {
            identity: id,
            attachedAt: row.attachedAt,
            cardMessageId: row.attachedViaCardMessageId,
          });
        } else {
          staleIdentities.push(id);
        }
      }

      // Publish a complete winner snapshot before the best-effort persisted
      // repair. If cleanup fails, initialization may continue, but ingress
      // still routes through the deterministic winners instead of an empty
      // runtime index. A later preload retry rebuilds these maps from its
      // freshly selected snapshot before attempting cleanup again.
      this.forward.clear();
      this.reverse.clear();
      this.attachCardIds.clear();
      for (const [sessionId, winner] of winnersByTarget) {
        const k = keyOf(winner.identity);
        this.forward.set(k, sessionId);
        this.reverse.set(sessionId, winner.identity);
        if (winner.cardMessageId) {
          this.attachCardIds.set(k, winner.cardMessageId);
        }
      }
      if (staleIdentities.length > 0) {
        await dbClient.tx('im.deleteBindings', {
          identities: staleIdentities.map((identity) => ({
            channel: identity.channel,
            botContextId: identity.botContextId,
            userId: identity.userId,
            scopeKey: identity.scopeKey ?? '',
          })),
        });
      }
      this.preloaded = true;
      log.info(
        `preload loaded ${winnersByTarget.size} im_bindings` +
          (staleIdentities.length > 0
            ? ` (removed ${staleIdentities.length} stale takeover(s))`
            : ''),
      );
    });
  }

  /**
   * Drop account-scoped in-memory indexes without touching persisted rows.
   * The next logged-in account must preload from its own DbClient rather than
   * inheriting the previous account's bindings or the `preloaded` sentinel.
   */
  resetRuntime(): void {
    this.forward.clear();
    this.reverse.clear();
    this.attachCardIds.clear();
    this.preloaded = false;
    log.info('runtime binding indexes reset');
  }

  get(identity: IdentityKey): string | null {
    return this.forward.get(keyOf(identity)) ?? null;
  }

  findByTarget(value: string): IdentityKey | null {
    return this.reverse.get(value) ?? null;
  }

  /** attach 时记录的卡片 messageId(thread 锚点/root 卡);未记录返 null。 */
  getAttachCardMessageId(identity: IdentityKey): string | null {
    return this.attachCardIds.get(keyOf(identity)) ?? null;
  }

  /**
   * 当前所有被任何 IM 接管的 sessionId 快照 — sidebar 用这个一次性拿到所有
   * 需要在 SessionItem 渲染"接管中"icon 的 session, 避免每行 IPC 查 binding。
   * O(n) 拷贝, n 通常 ≤ 单位数 (一个 owner 同时只接管几个 session)。
   */
  listAttachedTargets(): string[] {
    return Array.from(this.reverse.keys());
  }

  /**
   * 列出某 (channel, bot, user) 名下的全部 binding(含各 scopeKey)。
   * thread 多重接管的 /exctr 全退用 — n 极小(单用户同时接管数), O(n) 扫
   * reverse 即可, 不另建索引。
   */
  listByIdentity(
    channel: string,
    botContextId: string,
    userId: string,
  ): Array<{ identity: IdentityKey; targetSessionId: string }> {
    const out: Array<{ identity: IdentityKey; targetSessionId: string }> = [];
    for (const [sessionId, id] of this.reverse) {
      if (id.channel === channel && id.botContextId === botContextId && id.userId === userId) {
        out.push({ identity: id, targetSessionId: sessionId });
      }
    }
    return out;
  }

  attach(
    identity: IdentityKey,
    value: string,
    options?: { attachedViaCardMessageId?: string },
  ): Promise<void> {
    return this.attachWithResult(identity, value, options).then(() => undefined);
  }

  /**
   * Same mutation as attach(), plus the target owner actually displaced from
   * inside the serialized operation. Card cleanup callers must use this result
   * instead of a pre-attach reverse-index snapshot.
   */
  attachWithResult(
    identity: IdentityKey,
    value: string,
    options?: { attachedViaCardMessageId?: string },
  ): Promise<BindingAttachResult> {
    return this.enqueueMutation(async () => {
      const now = Date.now();
      const dbClient = getDbClient();
      const identityKey = keyOf(identity);
      const displacedIdentity = this.reverse.get(value);
      const displaced =
        displacedIdentity !== undefined && keyOf(displacedIdentity) !== identityKey
        ? {
            identity: displacedIdentity,
            attachedViaCardMessageId:
              this.attachCardIds.get(keyOf(displacedIdentity)) ?? null,
          }
        : null;

      // 同一 identity 的旧 target 与同一 target 的旧 identity 必须在一个 worker
      // transaction 里替换。新 INSERT 失败时 SQLite 会恢复旧 binding；因此内存
      // 索引和 interaction listener 也仍保持旧接管，不会出现两边都失效的窗口。
      const oldSessionId = this.forward.get(identityKey);
      await dbClient.tx('im.replaceBinding', {
        channel: identity.channel,
        botContextId: identity.botContextId,
        userId: identity.userId,
        scopeKey: identity.scopeKey ?? '',
        targetSessionId: value,
        attachedAt: now,
        attachedViaCardMessageId: options?.attachedViaCardMessageId ?? null,
      });

      // 持久化成功后再更新内存
      if (oldSessionId && oldSessionId !== value) {
        const reverseIdentity = this.reverse.get(oldSessionId);
        if (reverseIdentity && keyOf(reverseIdentity) === identityKey) {
          this.reverse.delete(oldSessionId);
        }
      }
      if (displaced) {
        const displacedKey = keyOf(displaced.identity);
        this.forward.delete(displacedKey);
        this.attachCardIds.delete(displacedKey);
      }
      this.forward.set(identityKey, value);
      this.reverse.set(value, identity);
      if (options?.attachedViaCardMessageId) {
        this.attachCardIds.set(identityKey, options.attachedViaCardMessageId);
      } else {
        this.attachCardIds.delete(identityKey);
      }

      log.info(
        `attach channel=${identity.channel} bot=...${identity.botContextId.slice(-6)} ` +
          `user=...${identity.userId.slice(-8)} → session=...${value.slice(-8)}` +
          (oldSessionId && oldSessionId !== value
            ? ` (replaced old session=...${oldSessionId.slice(-8)})`
            : ''),
      );
      // prevValue 给 listener 区分"新 attach"vs"同 identity 切换 target"用,
      // 后者 channel cleanup 需要先清理旧 session 上挂的 hook。
      if (displaced) {
        this.emit({ identity: displaced.identity, value: null, prevValue: value });
      }
      this.emit({ identity, value, prevValue: oldSessionId ?? null });
      return { displaced };
    });
  }

  detach(identity: IdentityKey): Promise<void> {
    return this.detachIfTarget(identity).then(() => undefined);
  }

  /**
   * Detach only while the identity still owns the expected target. Persisted
   * deletion is target-wide so stale duplicate owners left by a failed preload
   * repair cannot resurrect after the visible winner is revoked.
   */
  detachIfTarget(
    identity: IdentityKey,
    expectedTargetSessionId?: string,
  ): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const k = keyOf(identity);
      const oldSessionId = this.forward.get(k);
      if (!oldSessionId) {
        log.debug(
          `detach noop (not attached) channel=${identity.channel} user=...${identity.userId.slice(-8)}`,
        );
        return false;
      }
      if (expectedTargetSessionId && oldSessionId !== expectedTargetSessionId) {
        log.debug(
          `detach noop (target changed) channel=${identity.channel} ` +
            `expected=...${expectedTargetSessionId.slice(-8)} actual=...${oldSessionId.slice(-8)}`,
        );
        return false;
      }
      const db = getDbClient().drizzle;
      await db
        .delete(imBindings)
        .where(eq(imBindings.targetSessionId, oldSessionId));
      this.forward.delete(k);
      const reverseIdentity = this.reverse.get(oldSessionId);
      if (reverseIdentity && keyOf(reverseIdentity) === k) {
        this.reverse.delete(oldSessionId);
      }
      this.attachCardIds.delete(k);

      log.info(
        `detach channel=${identity.channel} bot=...${identity.botContextId.slice(-6)} ` +
          `user=...${identity.userId.slice(-8)} (was session=...${oldSessionId.slice(-8)})`,
      );
      // prevValue 必须带上 — channel cleanup (e.g. detachFeishuFromSession) 需要
      // 它来定位 in-process state 是哪个 session 的; 否则就得反向 import。
      this.emit({ identity, value: null, prevValue: oldSessionId });
      return true;
    });
  }

  /**
   * Mirror a detach that was committed by another localDb transaction. The
   * expected target check preserves a newer concurrent takeover; this method
   * intentionally performs no second database write.
   */
  applyPersistedDetach(identity: IdentityKey, expectedTargetSessionId: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const k = keyOf(identity);
      const oldSessionId = this.forward.get(k);
      if (oldSessionId !== expectedTargetSessionId) return false;
      this.forward.delete(k);
      const reverseIdentity = this.reverse.get(oldSessionId);
      if (reverseIdentity && keyOf(reverseIdentity) === k) {
        this.reverse.delete(oldSessionId);
      }
      this.attachCardIds.delete(k);
      this.emit({ identity, value: null, prevValue: oldSessionId });
      return true;
    });
  }

  onChange(listener: BindingChangeListener<string>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: BindingChangeEvent<string>): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`binding onChange listener threw (non-fatal): ${msg}`);
      }
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
