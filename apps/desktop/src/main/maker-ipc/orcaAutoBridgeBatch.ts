import { formatOrcaCommunicationMessage } from '@cindy/orca-workflow';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

type OrcaQueueOrigin = Extract<NonNullable<AgentInputQueuedMessage['origin']>, { kind: 'orca' }>;

/** 只有宿主盖章的系统兜底回报可合批；主动 send_to_lead / Lead 派单不命中。 */
export function isOrcaAutoBridgeQueueItem(item: AgentInputQueuedMessage): boolean {
  const origin = item.origin;
  if (!origin || origin.kind !== 'orca' || origin.autoBridge !== true) return false;
  if (item.files?.length || item.mentions?.length || item.sessionRefs?.length || item.agentReferences?.length) return false;
  return batchCount(origin) > 0;
}

function batchCount(origin: OrcaQueueOrigin): number {
  const count = origin.autoBridgeBatchCount;
  if (count === undefined) return 1;
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/** 队列项承载的兜底回报条数：已合批项为其 autoBridgeBatchCount，单条为 1。合批上限须按真实报告数累计，而非队列行数。 */
export function autoBridgeReportCount(item: AgentInputQueuedMessage): number {
  const origin = item.origin;
  if (!origin || origin.kind !== 'orca') return 1;
  const count = batchCount(origin);
  return count > 0 ? count : 1;
}

/** 不跨派发配置合批，避免后到条目的权限/模型/目录被首条静默覆盖；不确定时逐条派发。 */
export function sameAutoBridgeDispatchOptions(a: AgentInputQueuedMessage, b: AgentInputQueuedMessage): boolean {
  return a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode
    && a.workingDir === b.workingDir
    && JSON.stringify(a.createOpts) === JSON.stringify(b.createOpts)
    && JSON.stringify(a.vendorOptions) === JSON.stringify(b.vendorOptions);
}

const BATCH_HEADER = /^\[Auto-bridged batch: \d+ worker reports\]\n\n/;
// 可见正文去 worker_id 时只处理 Orca Worker 前缀行，避免误伤报告正文里偶然出现的同形文本。
const ORCA_WORKER_PREFIX_LINE = /^\[From Orca Worker[^\n]*$/gm;
const WORKER_ID_TOKEN = /\s*\(worker_id: [^)]*\)/g;

/**
 * 合批上限（均衡档）：字符预算为主、条数兜底。 Lead 长时间忙时避免 N 条兜底回报合成超大单条消息；
 * 超出上限的回报留到下一轮 drain 再合批，恢复轮间 compact 机会。队首必发（哪怕单条超预算），不截断任何单条。
 */
export const AUTO_BRIDGE_BATCH_MAX_ITEMS = 8;
export const AUTO_BRIDGE_BATCH_MAX_CHARS = 32_000;
export const AUTO_BRIDGE_BATCH_SEPARATOR = '\n\n---\n\n';
/** 批次头长度上界（按最大条数计）：合批前预估最终正文长度时计入，避免头/分隔符把字符预算撑破。 */
export const AUTO_BRIDGE_BATCH_HEADER_RESERVE = `[Auto-bridged batch: ${AUTO_BRIDGE_BATCH_MAX_ITEMS} worker reports]\n\n`.length;

/**
 * 在 coordinator 的同步合并临界区内构造批次。null 表示原条目不可合批，调用方必须保留原队列逐条派发。
 * 发给模型的 text 按原顺序保留每条 Worker 的 [From Orca Worker …(worker_id)] 前缀、状态与完整正文（供 Lead 路由）；
 * 可见/持久化正文剥掉模型向批次头与 worker_id 内部标识、保留 role 前缀以区分多 Worker（单条可见正文无 role 行）；
 * 共享访客投影同样只拿这份可见正文，看不到 worker_id。
 * 持久化仍用既有 {orcaSource,content} 信封，不新增 wire 字段。origin 保留首条 senderSessionId 作 Host 团队授权证据，
 * 批次标题由 origin.autoBridgeBatchCount 驱动，展示层不归属单个 Worker。
 */
export function buildOrcaAutoBridgeBatch(
  targets: readonly AgentInputQueuedMessage[],
): AgentInputQueuedMessage | null {
  if (targets.length < 2) return null;
  const survivor = targets[0];
  if (!survivor) return null;
  const sections: string[] = [];
  let count = 0;
  for (const target of targets) {
    if (!isOrcaAutoBridgeQueueItem(target) || target.origin?.kind !== 'orca') return null;
    if (!sameAutoBridgeDispatchOptions(survivor, target)) return null;
    const currentCount = batchCount(target.origin);
    if (currentCount <= 0) return null;
    try {
      const parsed = JSON.parse(target.persistedContent) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      if (record.orcaSource !== 'worker' || typeof record.content !== 'string') return null;
      sections.push(target.text.replace(BATCH_HEADER, ''));
      count += currentCount;
    } catch {
      return null;
    }
  }
  if (!Number.isSafeInteger(count)) return null;
  const survivorOrigin = survivor.origin;
  if (!survivorOrigin || survivorOrigin.kind !== 'orca') return null;
  const displayText = `[Auto-bridged batch: ${count} worker reports]\n\n${sections.join(AUTO_BRIDGE_BATCH_SEPARATOR)}`;
  // 兜底校验：最终条数/正文长度不得超限（正常由 coalesce 预估拦截，此处防回队再扁平的交叉输入漏网）。
  if (count > AUTO_BRIDGE_BATCH_MAX_ITEMS || displayText.length > AUTO_BRIDGE_BATCH_MAX_CHARS) return null;
  // 可见/持久化正文：剥掉模型向批次头（数量已由标题表达）并对每条前缀行剥尽 worker_id，保留 role 前缀区分多 Worker；
  // 发给模型的 text 仍保留批次头与 worker_id 供 Lead 路由。首条 senderSessionId 原样带回，仅作 Host 团队授权证据，
  // 展示/投影层按 autoBridge/autoBridgeBatchCount 提前返回，不据此把整批归到首个 Worker。
  const visibleText = displayText
    .replace(BATCH_HEADER, '')
    .replace(ORCA_WORKER_PREFIX_LINE, (line) => line.replace(WORKER_ID_TOKEN, ''));
  const persistedContent = formatOrcaCommunicationMessage('worker', visibleText);
  return {
    ...survivor,
    text: displayText,
    persistedContent,
    chatMessage: { ...survivor.chatMessage, content: persistedContent },
    origin: {
      ...survivorOrigin,
      kind: 'orca',
      senderLabel: '',
      displayText: visibleText,
      autoBridge: true,
      autoBridgeBatchCount: count,
    },
  };
}