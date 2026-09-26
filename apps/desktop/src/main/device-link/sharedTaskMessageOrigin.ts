/**
 * 共享任务访客只能直接访问被共享的这一个任务（docs/product-rules/shared-task-mode.md）。
 * 消息来源（agentMeta.origin）里指向房主其它任务或伙伴的身份——来源任务 id、标题、
 * 伙伴 id / 名字、Orca 发送方任务——都不属于访客可见范围，投递给访客前一律剥掉。
 * 任务来源降级为不带身份的 `{ kind: 'session' }`，访客端显示不可点击的「由其他任务发送」。
 */
export function redactMessageOriginForSharedGuest(agentMeta: unknown): unknown {
  if (!agentMeta || typeof agentMeta !== 'object' || Array.isArray(agentMeta)) return agentMeta;
  const meta = agentMeta as Record<string, unknown>;
  const origin = meta.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return agentMeta;
  const kind = (origin as { kind?: unknown }).kind;
  if (kind === 'session') return { ...meta, origin: { kind: 'session' } };
  if (kind === 'orca' && 'senderSessionId' in origin) {
    const { senderSessionId: _, ...rest } = origin as Record<string, unknown>;
    return { ...meta, origin: rest };
  }
  return agentMeta;
}

/** 对单条消息行套用 {@link redactMessageOriginForSharedGuest}；无需改动时返回原引用。 */
export function redactMessageRowForSharedGuest<T>(message: T): T {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  const agentMeta = redactMessageOriginForSharedGuest(record.agentMeta);
  return agentMeta === record.agentMeta ? message : ({ ...record, agentMeta } as T);
}

/**
 * 排队快照（maker:input:projection 推送 / maker:input:get-projection 读取）里的来源同样
 * 脱敏：任务来源只留正文（displayText 与条目正文相同），去掉来源任务 id、标题与伙伴身份；
 * Orca 来源去掉发送方任务 id。无需改动时返回原引用。
 */
export function redactInputProjectionForSharedGuest<T>(projection: T): T {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return projection;
  const record = projection as Record<string, unknown>;
  if (!Array.isArray(record.pendingQueue)) return projection;
  let changed = false;
  const pendingQueue = record.pendingQueue.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const entry = item as Record<string, unknown>;
    const origin = entry.origin;
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return item;
    const typed = origin as Record<string, unknown>;
    if (typed.kind === 'session') {
      changed = true;
      return {
        ...entry,
        origin: { kind: 'session', senderSessionId: '', displayText: typed.displayText ?? '' },
      };
    }
    if (typed.kind === 'orca' && 'senderSessionId' in typed) {
      changed = true;
      const { senderSessionId: _, ...rest } = typed;
      return { ...entry, origin: rest };
    }
    return item;
  });
  return changed ? ({ ...record, pendingQueue } as T) : projection;
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
