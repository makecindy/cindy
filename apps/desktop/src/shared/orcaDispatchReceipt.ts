/**
 * 派发回执：宿主接受一条 Lead→Worker 派单后落库的系统记录。
 * 用户看到的「已派」事实以它为准；它不是模型消息，也不参与主张对账（对账读宿主派发记录）。
 */

export interface OrcaDispatchReceipt {
  version: 1;
  state: 'sent';
  /** 宿主这次投递的唯一 id（直发与排队都有），回执行主键用它，避免同毫秒派单被去重。 */
  dispatchId: string;
  /** Worker 会话 id。 */
  workerId: string;
  /** 展示用 Worker 名（角色名，缺省回落到 id 前缀）。 */
  workerLabel: string;
  /** direct = 直接唤醒；queued = 进 Worker 队列，尚未被读取。 */
  delivery: 'direct' | 'queued';
  queuedMessageId?: string;
  /** 派单正文摘要，截断后落库。 */
  summary: string;
  at: number;
}

/**
 * 升级卡：补派一轮后主张仍无凭据。同样落成系统行，不进模型上下文，
 * 因此它不会像队列消息那样再开一轮。
 */
export interface OrcaDispatchClaimNotice {
  version: 1;
  state: 'unverified';
  /** 给主人看的纠正正文（含原句引用与判定依据）。 */
  summary: string;
  reason: string;
  quote: string;
  at: number;
}

export type OrcaDispatchSystemRecord = OrcaDispatchReceipt | OrcaDispatchClaimNotice;

/** 回执摘要长度上限，避免把整段派单正文塞进卡片。 */
export const ORCA_DISPATCH_RECEIPT_SUMMARY_MAX = 240;

export function buildOrcaDispatchReceiptSummary(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  return text.length > ORCA_DISPATCH_RECEIPT_SUMMARY_MAX
    ? `${text.slice(0, ORCA_DISPATCH_RECEIPT_SUMMARY_MAX - 1)}…`
    : text;
}
