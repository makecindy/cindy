import { queueItemVisibleText } from '@cindy/maker-shared/queue';

/**
 * 共享任务访客只能直接访问被共享的这一个任务（docs/product-rules/shared-task-mode.md）。
 * 消息来源（agentMeta.origin）里指向房主其它任务或伙伴的身份——来源任务 id、标题、
 * 伙伴 id / 名字、Orca 发送方任务——都不属于访客可见范围，投递给访客前一律剥掉。
 * 任务来源降级为不带身份的 `{ kind: 'session' }`，访客端显示不可点击的「由其他任务发送」。
 *
 * `agentFacingWireContent` 是主机内部的 Agent 原文副本（只用于上下文溢出后重放），
 * 可能带「[来自 X 的补充]」这类来源前缀；访客端从不使用，一律不下发。
 */
export function redactMessageOriginForSharedGuest(agentMeta: unknown): unknown {
  if (!agentMeta || typeof agentMeta !== 'object' || Array.isArray(agentMeta)) return agentMeta;
  const meta = agentMeta as Record<string, unknown>;
  const { agentFacingWireContent: _wire, ...rest } = meta;
  const hadWire = 'agentFacingWireContent' in meta;
  const origin = meta.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    return hadWire ? rest : agentMeta;
  }
  const kind = (origin as { kind?: unknown }).kind;
  if (kind === 'session') return { ...rest, origin: { kind: 'session' } };
  if (kind === 'orca' && 'senderSessionId' in origin) {
    const { senderSessionId: _, ...orcaRest } = origin as Record<string, unknown>;
    return { ...rest, origin: orcaRest };
  }
  return hadWire ? rest : agentMeta;
}

/** 对单条消息行套用 {@link redactMessageOriginForSharedGuest}；无需改动时返回原引用。 */
export function redactMessageRowForSharedGuest<T>(message: T): T {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  const agentMeta = redactMessageOriginForSharedGuest(record.agentMeta);
  return agentMeta === record.agentMeta ? message : ({ ...record, agentMeta } as T);
}

/**
 * 排队条目的访客视图。任务来源条目里，发给 Agent 的 `text` 与 `origin.displayText`
 * 可能带来源身份（如伙伴补充的「[来自 X 的补充]」前缀），访客只能拿到落库可见正文
 * （`persistedContent`，带附件时是 `{text, images, files}` 信封里的 text）；来源降级为
 * 不带 id / 标题 / 伙伴的任务来源。Orca 来源去掉发送方任务 id。无需改动时返回原引用。
 */
export function redactQueueItemForSharedGuest<T>(item: T): T {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const entry = item as Record<string, unknown>;
  const origin = entry.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return item;
  const typed = origin as Record<string, unknown>;
  if (typed.kind === 'session') {
    const visible = queueItemVisibleText(entry);
    return {
      ...entry,
      text: visible,
      origin: { kind: 'session', senderSessionId: '', displayText: visible },
    } as T;
  }
  if (typed.kind === 'orca' && 'senderSessionId' in typed) {
    const { senderSessionId: _, ...rest } = typed;
    return { ...entry, origin: rest } as T;
  }
  return item;
}

/**
 * 排队快照（maker:input:projection 推送 / maker:input:get-projection 读取）的访客视图：
 * 待发送队列与失败恢复项（`recovery.item`）里的每个条目都经
 * {@link redactQueueItemForSharedGuest}。无需改动时返回原引用。
 */
export function redactInputProjectionForSharedGuest<T>(projection: T): T {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return projection;
  const record = projection as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };
  if (Array.isArray(record.pendingQueue)) {
    const pendingQueue = record.pendingQueue.map((item: unknown) =>
      redactQueueItemForSharedGuest(item),
    );
    if (pendingQueue.some((item, index) => item !== (record.pendingQueue as unknown[])[index])) {
      next.pendingQueue = pendingQueue;
      changed = true;
    }
  }
  const recovery = record.recovery;
  if (recovery && typeof recovery === 'object' && !Array.isArray(recovery) && 'item' in recovery) {
    const item = (recovery as { item: unknown }).item;
    const redacted = redactQueueItemForSharedGuest(item);
    if (redacted !== item) {
      next.recovery = { ...(recovery as Record<string, unknown>), item: redacted };
      changed = true;
    }
  }
  return changed ? (next as T) : projection;
}

/** 推往共享任务访客的单帧 payload：按 channel 套用对应的来源脱敏。 */
export function redactSharedGuestPush(channel: string, payload: unknown): unknown {
  if (channel === 'maker:input:projection') return redactInputProjectionForSharedGuest(payload);
  if (
    channel !== 'local-db:messages:created' ||
    !payload ||
    typeof payload !== 'object' ||
    !('message' in payload)
  ) {
    return payload;
  }
  const message = (payload as { message: unknown }).message;
  const redacted = redactMessageRowForSharedGuest(message);
  return redacted === message
    ? payload
    : { ...(payload as Record<string, unknown>), message: redacted };
}
