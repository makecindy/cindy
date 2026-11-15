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

/** 主张对账的失败原因：没有派单 / 没派给点名的人 / 队列编号对不上。 */
export type OrcaDispatchClaimFailure = 'no-dispatch' | 'target-not-dispatched' | 'unknown-message-id';

/**
 * 升级卡：补派一轮后主张仍无凭据。同样落成系统行，不进模型上下文，
 * 因此它不会像队列消息那样再开一轮。
 *
 * 只存事实、不存成句：同一行记录在桌面、手机、英文界面上按各自语言拼正文，
 * 否则正文会永远是落库那台机器的语言。
 */
export interface OrcaDispatchClaimNotice {
  version: 1;
  state: 'unverified';
  /** Lead 这轮点名要派的目标标签，按花名册解析得到，可能为空。 */
  targets: string[];
  reason: OrcaDispatchClaimFailure;
  /** 判定细节：没派到的目标标签，或对不上的队列编号。 */
  detail: string;
  /** 主张原句，卡片整句引用。 */
  quote: string;
  at: number;
}

export type OrcaDispatchSystemRecord = OrcaDispatchReceipt | OrcaDispatchClaimNotice;

/** 回执摘要长度上限，避免把整段派单正文塞进卡片。 */
export const ORCA_DISPATCH_RECEIPT_SUMMARY_MAX = 240;

/** 引文在卡片里的长度上限：升级卡要能读，引文不能占满整屏。 */
export const ORCA_DISPATCH_CLAIM_QUOTE_MAX = 120;

/**
 * 摘要是一句旁证，不是正文：markdown 标记在卡片里只会变成噪音（`##`、反引号、`**` 原样露出）。
 * 在写入端剥一次，卡片、历史与导出三处读到的就是同一句干净的话。
 */
function stripMarkupForSummary(message: string): string {
  // 行内代码先摘出来再还原：`__init__.py`、`a*b` 里的字符是文件名和运算符，
  // 直接交给下面那串强调标记规则会被当成 markdown 吃掉。
  const codeSpans: string[] = [];
  return message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, (_match, code: string) => `\uE000${codeSpans.push(code) - 1}\uE000`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => codeSpans[Number(index)] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildOrcaDispatchReceiptSummary(message: string): string {
  const text = stripMarkupForSummary(message);
  return text.length > ORCA_DISPATCH_RECEIPT_SUMMARY_MAX
    ? `${text.slice(0, ORCA_DISPATCH_RECEIPT_SUMMARY_MAX - 1)}…`
    : text;
}
