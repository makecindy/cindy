/**
 * Orca 协同消息排队时，宿主告诉 Agent「队列里还有什么」的两处共用格式：
 *  - 发送回执：发送方自己此前发出、对方还没读到的消息（`earlier_queued`）；
 *  - 送达提示：一条排队的协同消息送达时，它后面还在等待的协同消息（Queue note）。
 *
 * 两处只陈述事实（编号、发送方、开头一行）。要不要合并、改写、撤回或先一并读完，
 * 由 Lead / Worker 的协同提示词引导模型自己判断，见
 * docs/dev-rules/orca-team-architecture.md「消息派发与 auto-bridge」第 11 条。
 */

/** 预览只取开头一行，够判断「是不是同一件事」即可；完整正文用队列工具读取。 */
export const ORCA_QUEUE_PREVIEW_MAX_LENGTH = 120;

/** 送达提示最多逐条列出的条数；超出只报数量，避免积压很深时淹没消息正文。 */
export const ORCA_QUEUE_NOTE_MAX_ENTRIES = 5;

/** 压成一行并限长。正文来自协同成员，属于不可信展示文本：不让它伪造提示结构。 */
export function orcaQueuePreview(
  text: string,
  maxLength: number = ORCA_QUEUE_PREVIEW_MAX_LENGTH,
): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= maxLength) return line;
  let cut = line.slice(0, Math.max(0, maxLength - 1));
  // 不在代理对中间截断:落单的高位代理会让整条消息变成非法字符串,严格的 JSON 消费方会拒收。
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const FULL_WIDTH_BRACKETS: Record<string, string> = { '[': '［', ']': '］', '(': '（', ')': '）' };

/** 提示正文里的预览与名字:括号转全角,闭合不了 `(Queue note: …)`,也冒充不了消息前缀。 */
function queueNoteText(text: string, maxLength?: number): string {
  return orcaQueuePreview(text, maxLength).replace(/[[\]()]/g, (ch) => FULL_WIDTH_BRACKETS[ch] ?? ch);
}

export interface OrcaQueueNoteEntry {
  queuedMessageId: string;
  /** 与刚送达的这条消息是同一个发送方。 */
  sameSender: boolean;
  /** 发送方展示名（Worker 的 role，或 `Lead`）；`sameSender` 为 true 时不显示。 */
  senderLabel: string;
  /** 消息原始正文；这里统一压成预览。 */
  content: string;
}

/**
 * 生成追加在送达消息末尾的 Queue note；后面没有协同消息时返回 null。
 * 只进发给模型的 wire 消息，不进排队正文、落库正文或系统提示词。
 */
export function buildOrcaQueueNote(entries: readonly OrcaQueueNoteEntry[]): string | null {
  if (entries.length === 0) return null;
  const sameSenderCount = entries.filter((entry) => entry.sameSender).length;
  const total = entries.length;
  const header =
    `${total} more collaboration ${total === 1 ? 'message is' : 'messages are'} queued behind this one` +
    (sameSenderCount > 0 ? ` (${sameSenderCount} from the same sender)` : '') +
    ':';
  const lines = entries.slice(0, ORCA_QUEUE_NOTE_MAX_ENTRIES).map((entry) => {
    // 其他发送方的名字加引号:Worker 的 role 由用户或 Lead 起名,不能让它读成「same sender」。
    const sender = entry.sameSender
      ? 'same sender'
      : `"${queueNoteText(entry.senderLabel, 40).replace(/"/g, '') || 'unknown'}"`;
    return `- queued_message_id: ${entry.queuedMessageId} | from: ${sender} | starts: ${queueNoteText(entry.content)}`;
  });
  const hidden = total - lines.length;
  if (hidden > 0) lines.push(`- …and ${hidden} more`);
  return `(Queue note: ${header}\n${lines.join('\n')})`;
}
