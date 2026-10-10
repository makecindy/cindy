import { readMessageSourceGroup } from '@cindy/maker-shared/message-source';
import { queueItemVisibleText } from '@cindy/maker-shared/queue';

const HOOK_SCHEDULE_ID_PREFIX = 'hook:';

const GUEST_HIDDEN_META_KEYS = ['botTaskCoordinationInput', 'agentFacingWireContent', 'sourceDevice', 'sourcePlugin', 'sourceGroup'] as const;

function redactOriginForSharedGuest(origin: Record<string, unknown>): Record<string, unknown> | null {
  if (origin.kind === 'session') return { kind: 'session' };
  if (origin.kind === 'scheduler') {
    // Hook 渠道消息复用 scheduler 形态（scheduleId 为 `hook:<连接>`）：只保留 `hook:` 前缀，
    // 访客端据此仍显示渠道而不是「由自动化发送」，连接 id 与名字不下发。
    if (typeof origin.scheduleId === 'string' && origin.scheduleId.startsWith(HOOK_SCHEDULE_ID_PREFIX)) {
      return origin.scheduleId === HOOK_SCHEDULE_ID_PREFIX && Object.keys(origin).length === 2
        ? null
        : { kind: 'scheduler', scheduleId: HOOK_SCHEDULE_ID_PREFIX };
    }
    return Object.keys(origin).some((key) => key !== 'kind') ? { kind: 'scheduler' } : null;
  }
  if (origin.kind === 'orca' && 'senderSessionId' in origin) {
    const orcaRest = { ...origin };
    delete orcaRest.senderSessionId;
    return orcaRest;
  }
  return null;
}

/**
 * 共享任务访客只能直接访问被共享的这一个任务（docs/product-rules/shared-task-mode.md）。
 * 消息来源（agentMeta.origin）里指向房主其它任务或伙伴的身份——来源任务 id、标题、
 * 伙伴 id / 名字、Orca 发送方任务——都不属于访客可见范围，投递给访客前一律剥掉。
 * 任务来源降级为不带身份的 `{ kind: 'session' }`，访客端显示不可点击的「由其他任务发送」；
 * 自动化来源只保留 `{ kind: 'scheduler' }`（去掉 scheduleId / scheduleName / runId），
 * 访客端显示不可点击的「由自动化发送」；Hook 渠道消息只保留 `scheduleId: 'hook:'`，
 * 访客端仍显示渠道。
 *
 * 房主的设备（sourceDevice）与插件（sourcePlugin）同样不属于访客可见范围，一律不下发。
 * `agentFacingWireContent` 是主机内部的 Agent 原文副本（只用于上下文溢出后重放），
 * 访客端从不使用，一律不下发。
 */
export function redactMessageOriginForSharedGuest(agentMeta: unknown): unknown {
  if (!agentMeta || typeof agentMeta !== 'object' || Array.isArray(agentMeta)) return agentMeta;
  const meta = agentMeta as Record<string, unknown>;
  const hidden = GUEST_HIDDEN_META_KEYS.some((key) => key in meta);
  const rest: Record<string, unknown> = { ...meta };
  for (const key of GUEST_HIDDEN_META_KEYS) delete rest[key];
  const origin = meta.origin;
  const redactedOrigin = origin && typeof origin === 'object' && !Array.isArray(origin)
    ? redactOriginForSharedGuest(origin as Record<string, unknown>)
    : null;
  if (redactedOrigin) return { ...rest, origin: redactedOrigin };
  return hidden ? rest : agentMeta;
}

/** 对单条消息行套用 {@link redactMessageOriginForSharedGuest}；无需改动时返回原引用。 */
export function redactMessageRowForSharedGuest<T>(message: T): T {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  let agentMeta = redactMessageOriginForSharedGuest(record.agentMeta);
  // Preserve independent reply visibility without disclosing source identity
  // or sealing unrelated prose in the canonical model turn.
  if (record.role === 'assistant' && readMessageSourceGroup(record.agentMeta)) {
    agentMeta = { ...(agentMeta as Record<string, unknown>), explicitDelivery: true };
  }
  return agentMeta === record.agentMeta ? message : ({ ...record, agentMeta } as T);
}

/**
 * 排队条目的访客视图。任务来源条目里，发给 Agent 的 `text` 与 `origin.displayText`
 * 可能带来源身份，访客只能拿到落库可见正文（`persistedContent`，带附件时是
 * `{text, images, files}` 信封里的 text）；来源降级为不带 id / 标题 / 伙伴的任务来源。
 * 自动化来源只保留 kind（Hook 渠道只保留 `hook:` 前缀），`text` 换成可见正文；Orca 来源
 * 去掉发送方任务 id；房主的设备 / 插件来源不下发。
 * 无需改动时返回原引用。
 */
export function redactQueueItemForSharedGuest<T>(item: T): T {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const original = item as Record<string, unknown>;
  let entry = original;
  if ('sourceDevice' in entry || 'sourcePlugin' in entry || 'botTaskCoordination' in entry) {
    entry = { ...entry };
    delete entry.sourceDevice;
    delete entry.sourcePlugin;
    delete entry.botTaskCoordination;
  }
  const origin = entry.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    return (entry === original ? item : entry) as T;
  }
  const typed = origin as Record<string, unknown>;
  if (typed.kind === 'session') {
    const visible = queueItemVisibleText(entry);
    return {
      ...entry,
      text: visible,
      origin: { kind: 'session', senderSessionId: '', displayText: visible },
    } as T;
  }
  const redactedOrigin = redactOriginForSharedGuest(typed);
  if (typed.kind === 'scheduler') {
    // 自动化条目的 `text` 是发给 Agent 的原文，带 `[Scheduled run context]`（含自动化名字与
    // schedule_id）等只给 Agent 的内容；访客只拿落库可见正文。
    const visible = queueItemVisibleText(entry);
    if (visible !== entry.text || redactedOrigin) {
      return { ...entry, text: visible, ...(redactedOrigin ? { origin: redactedOrigin } : {}) } as T;
    }
  }
  if (redactedOrigin) return { ...entry, origin: redactedOrigin } as T;
  return (entry === original ? item : entry) as T;
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
