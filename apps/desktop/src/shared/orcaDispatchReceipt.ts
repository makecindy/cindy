/**
 * 派发回执：宿主接受一条 Lead→Worker 派单后落库的系统记录。
 * 用户看到的「已派」事实以它为准；它不是模型消息，也不参与主张对账（对账读宿主派发记录）。
 */

export interface OrcaDispatchReceipt {
  version: 1;
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

/** 回执摘要长度上限，避免把整段派单正文塞进卡片。 */
export const ORCA_DISPATCH_RECEIPT_SUMMARY_MAX = 240;

export function buildOrcaDispatchReceiptSummary(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  return text.length > ORCA_DISPATCH_RECEIPT_SUMMARY_MAX
    ? `${text.slice(0, ORCA_DISPATCH_RECEIPT_SUMMARY_MAX - 1)}…`
    : text;
}
