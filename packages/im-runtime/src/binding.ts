export type { IdentityKey } from '@cindy/im';
import type {
  BindingChangeEvent,
  BindingChangeListener,
  BindingStore,
  IdentityKey,
} from "@cindy/im";
import type { Logger } from "@cindy/maker-core";
export interface ImBindingRow {
  channel: string;
  botContextId: string;
  userId: string;
  scopeKey: string;
  targetSessionId: string;
  attachedAt: number;
  attachedViaCardMessageId: string | null;
}
export interface ImBindingStorage {
  list(): Promise<ImBindingRow[]>;
  deleteIdentities(identities: IdentityKey[]): Promise<void>;
  replace(row: ImBindingRow): Promise<void>;
  deleteTarget(sessionId: string): Promise<void>;
}
export interface ImBindingHost {
  log: Pick<Logger, "info" | "debug" | "warn">;
  captureStorage(): ImBindingStorage;
}
export function imBindingKey(id: IdentityKey): string {
  // NUL 分隔(渠道 id 不可能含 \0, 无碰撞);scopeKey 是 thread 能力渠道的
  // 会话维度(slack thread root ts), 无 thread 渠道(feishu)恒缺省 = ''。
  return [id.channel, id.botContextId, id.userId, id.scopeKey ?? ""].join(
    "\u0000",
  );
}

export interface BindingAttachResult {
  displaced: {
    identity: IdentityKey;
    attachedViaCardMessageId: string | null;
  } | null;
}

export class PersistentImBindingStore implements BindingStore<string> {
  constructor(private readonly host: ImBindingHost) {}
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
      const storage = this.host.captureStorage();
      const rows = await storage.list();
      const winnersByTarget = new Map<
        string,
        {
          identity: IdentityKey;
          attachedAt: number;
          cardMessageId: string | null;
        }
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
          (row.attachedAt === existing.attachedAt &&
            imBindingKey(id) > imBindingKey(existing.identity));
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
        const k = imBindingKey(winner.identity);
        this.forward.set(k, sessionId);
        this.reverse.set(sessionId, winner.identity);
        if (winner.cardMessageId) {
          this.attachCardIds.set(k, winner.cardMessageId);
        }
      }
      if (staleIdentities.length > 0) {
        await storage.deleteIdentities(staleIdentities);
      }
      this.preloaded = true;
      this.host.log.info(
        `preload loaded ${winnersByTarget.size} im_bindings` +
          (staleIdentities.length > 0
            ? ` (removed ${staleIdentities.length} stale takeover(s))`
            : ""),
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
    this.host.log.info("runtime binding indexes reset");
  }

  /** Wait for all earlier persisted mutations before retiring this owner. */
  flush(): Promise<void> {
    return this.mutationQueue;
  }

  get(identity: IdentityKey): string | null {
    return this.forward.get(imBindingKey(identity)) ?? null;
  }

  findByTarget(value: string): IdentityKey | null {
    return this.reverse.get(value) ?? null;
  }

  /** attach 时记录的卡片 messageId(thread 锚点/root 卡);未记录返 null。 */
  getAttachCardMessageId(identity: IdentityKey): string | null {
    return this.attachCardIds.get(imBindingKey(identity)) ?? null;
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
      if (
        id.channel === channel &&
        id.botContextId === botContextId &&
        id.userId === userId
      ) {
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
    return this.attachWithResult(identity, value, options).then(
      () => undefined,
    );
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
      const storage = this.host.captureStorage();
      const identityKey = imBindingKey(identity);
      const displacedIdentity = this.reverse.get(value);
      const displaced =
        displacedIdentity !== undefined &&
        imBindingKey(displacedIdentity) !== identityKey
          ? {
              identity: displacedIdentity,
              attachedViaCardMessageId:
                this.attachCardIds.get(imBindingKey(displacedIdentity)) ?? null,
            }
          : null;

      // 同一 identity 的旧 target 与同一 target 的旧 identity 必须在一个 worker
      // transaction 里替换。新 INSERT 失败时 SQLite 会恢复旧 binding；因此内存
      // 索引和 interaction listener 也仍保持旧接管，不会出现两边都失效的窗口。
      const oldSessionId = this.forward.get(identityKey);
      await storage.replace({
        channel: identity.channel,
        botContextId: identity.botContextId,
        userId: identity.userId,
        scopeKey: identity.scopeKey ?? "",
        targetSessionId: value,
        attachedAt: now,
        attachedViaCardMessageId: options?.attachedViaCardMessageId ?? null,
      });

      // 持久化成功后再更新内存
      if (oldSessionId && oldSessionId !== value) {
        const reverseIdentity = this.reverse.get(oldSessionId);
        if (reverseIdentity && imBindingKey(reverseIdentity) === identityKey) {
          this.reverse.delete(oldSessionId);
        }
      }
      if (displaced) {
        const displacedKey = imBindingKey(displaced.identity);
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

      this.host.log.info(
        `attach channel=${identity.channel} bot=...${identity.botContextId.slice(-6)} ` +
          `user=...${identity.userId.slice(-8)} → session=...${value.slice(-8)}` +
          (oldSessionId && oldSessionId !== value
            ? ` (replaced old session=...${oldSessionId.slice(-8)})`
            : ""),
      );
      // prevValue 给 listener 区分"新 attach"vs"同 identity 切换 target"用,
      // 后者 channel cleanup 需要先清理旧 session 上挂的 hook。
      if (displaced) {
        this.emit({
          identity: displaced.identity,
          value: null,
          prevValue: value,
        });
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
      const k = imBindingKey(identity);
      const oldSessionId = this.forward.get(k);
      if (!oldSessionId) {
        this.host.log.debug(
          `detach noop (not attached) channel=${identity.channel} user=...${identity.userId.slice(-8)}`,
        );
        return false;
      }
      if (expectedTargetSessionId && oldSessionId !== expectedTargetSessionId) {
        this.host.log.debug(
          `detach noop (target changed) channel=${identity.channel} ` +
            `expected=...${expectedTargetSessionId.slice(-8)} actual=...${oldSessionId.slice(-8)}`,
        );
        return false;
      }
      await this.host.captureStorage().deleteTarget(oldSessionId);
      this.forward.delete(k);
      const reverseIdentity = this.reverse.get(oldSessionId);
      if (reverseIdentity && imBindingKey(reverseIdentity) === k) {
        this.reverse.delete(oldSessionId);
      }
      this.attachCardIds.delete(k);

      this.host.log.info(
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
  applyPersistedDetach(
    identity: IdentityKey,
    expectedTargetSessionId: string,
  ): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const k = imBindingKey(identity);
      const oldSessionId = this.forward.get(k);
      if (oldSessionId !== expectedTargetSessionId) return false;
      this.forward.delete(k);
      const reverseIdentity = this.reverse.get(oldSessionId);
      if (reverseIdentity && imBindingKey(reverseIdentity) === k) {
        this.reverse.delete(oldSessionId);
      }
      this.attachCardIds.delete(k);
      this.emit({ identity, value: null, prevValue: oldSessionId });
      return true;
    });
  }

  /** A host transaction may rotate a task and detach its takeover together.
   * Hold the same mutation queue as attach/detach until that durable commit
   * finishes, then publish the matching in-memory change. A stale request
   * still commits its task transaction without revoking a newer takeover. */
  commitAndDetach<T>(
    detach: { identity: IdentityKey; targetSessionId: string } | null,
    commit: (detached: boolean) => Promise<T>,
  ): Promise<T> {
    return this.enqueueMutation(async () => {
      const detached = !!detach && this.get(detach.identity) === detach.targetSessionId;
      const result = await commit(detached);
      if (detached && detach) {
        const key = imBindingKey(detach.identity);
        this.forward.delete(key);
        this.reverse.delete(detach.targetSessionId);
        this.attachCardIds.delete(key);
        this.emit({ identity: detach.identity, value: null, prevValue: detach.targetSessionId });
      }
      return result;
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
        this.host.log.warn(
          `binding onChange listener threw (non-fatal): ${msg}`,
        );
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
