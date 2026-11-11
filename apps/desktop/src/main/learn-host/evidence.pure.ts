/**
 * evidence.pure.ts —— learn 证据打包的纯函数部分(截断预算 / 关键词 / 格式化)。
 *
 * 规则 9:检索取多少、截多少、怎么排,全部由这里的常量与代码钉死,不留给模型
 * 即兴发挥。IO(实际调混合检索)在 evidence.ts 编排层。
 */

// ── 预算常量(代码钉死;字符数近似 token:CJK ≈ 1 char/token,英文偏保守) ────

/** 单条证据(命中 + 上下文窗口拼接后)的字符上限,超出截断。 */
export const EVIDENCE_PER_HIT_CHAR_CAP = 2000;
/** 证据块总字符预算,超出丢弃后续条目。 */
export const EVIDENCE_TOTAL_CHAR_BUDGET = 16000;
/** 检索命中条数上限(交给混合检索的 limit)。 */
export const EVIDENCE_HIT_LIMIT = 8;
/** 每条命中前后各取几条邻居消息(混合检索 contextRadius)。 */
export const EVIDENCE_CONTEXT_RADIUS = 2;

// ── 当前会话蒸馏(无参 /learn:把本会话提炼成 skill)────────────────────────

/** 当前会话取最近多少条 user/assistant 消息。 */
export const CONVERSATION_MESSAGE_LIMIT = 120;
/** 单条消息字符上限(超出截尾;长贴文/大段代码不需要全文进 prompt)。 */
export const CONVERSATION_PER_MSG_CHAR_CAP = 1500;
/** 会话块总字符预算。 */
export const CONVERSATION_TOTAL_CHAR_BUDGET = 24000;

export interface ConversationItem {
  role: string;
  /** 已提取为纯文本、已 redact。 */
  text: string;
}

/** A bare Learn invocation triggers collection but is never itself evidence. */
export function isBareLearnInvocationText(text: string): boolean {
  return /^\/(?:skill:)?learn\s*$/i.test(text.trim());
}

/**
 * 把当前会话消息渲染成 prompt 块(时间正序;超预算从**最早**的开始丢 ——
 * 提炼工作流时近期消息价值更高)。空输入返回空串。
 */
export function formatConversationBlock(items: ConversationItem[]): string {
  if (items.length === 0) return '';
  const clipped = items.map((m) => ({
    role: m.role,
    text:
      m.text.length > CONVERSATION_PER_MSG_CHAR_CAP
        ? `${m.text.slice(0, CONVERSATION_PER_MSG_CHAR_CAP)}\n[...truncated]`
        : m.text,
  }));
  // 从尾部(最新)往前装,直到预算耗尽,再恢复正序输出
  const kept: typeof clipped = [];
  let used = 0;
  let dropped = 0;
  for (let i = clipped.length - 1; i >= 0; i -= 1) {
    const line = `${clipped[i].role === 'user' ? 'User' : 'Assistant'}: ${clipped[i].text}`;
    if (used + line.length > CONVERSATION_TOTAL_CHAR_BUDGET) {
      dropped = i + 1;
      break;
    }
    kept.unshift(clipped[i]);
    used += line.length;
  }
  const lines = kept.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`);
  const head = dropped > 0 ? `(${dropped} earlier message(s) omitted due to size budget.)\n` : '';
  return `${head}${lines.join('\n\n')}`;
}

/** 一条已提取为纯文本的证据(evidence.ts 从检索命中 + 上下文窗口拼出)。 */
export interface EvidenceItem {
  sessionId: string;
  /** 命中消息 unix ms,格式化时转成日期供模型参照时间线。 */
  createdAt: number;
  /** 上下文窗口拼接后的对话文本(已 redact)。 */
  text: string;
}

export interface TruncateResult {
  items: EvidenceItem[];
  /** 因总预算丢弃的条数(>0 时格式化块里注明,避免"看着像全量"——no silent caps)。 */
  droppedCount: number;
}

/**
 * 按预算截断证据:单条超限截尾,总量超限丢弃后续条目。
 * 输入顺序即相关性顺序(检索已按 RRF 排好),不重排。
 */
export function truncateEvidence(
  items: EvidenceItem[],
  caps: { perHitCharCap?: number; totalCharBudget?: number } = {},
): TruncateResult {
  const perHit = caps.perHitCharCap ?? EVIDENCE_PER_HIT_CHAR_CAP;
  const total = caps.totalCharBudget ?? EVIDENCE_TOTAL_CHAR_BUDGET;

  const out: EvidenceItem[] = [];
  let used = 0;
  let droppedCount = 0;
  for (const item of items) {
    const clipped = item.text.length > perHit ? `${item.text.slice(0, perHit)}\n[...truncated]` : item.text;
    if (used + clipped.length > total) {
      droppedCount += 1;
      continue;
    }
    out.push({ ...item, text: clipped });
    used += clipped.length;
  }
  return { items: out, droppedCount };
}

/**
 * 从 skill 名 + 描述生成检索关键词(hub 源用 —— 用户没写自由文本,查询词由
 * skill 元数据派生)。策略:name 连字符拆词 + 描述里的显著词,去重、限量。
 * 混合检索的 FTS arm 自己会再 tokenize,这里只负责拼一个合理的自然语言 query。
 */
export function extractKeywords(name: string, description: string, max = 12): string {
  const words: string[] = [];
  const seen = new Set<string>();
  const push = (w: string): void => {
    const t = w.trim();
    if (t.length < 2 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    words.push(t);
  };
  for (const part of name.split(/[-_.]+/)) push(part);
  // 描述:抽英文词(≥3 字符)与 CJK 连续段,按出现顺序。
  for (const m of description.matchAll(/[A-Za-z][A-Za-z0-9]{2,}|[一-鿿]{2,}/g)) {
    push(m[0]);
    if (words.length >= max) break;
  }
  return words.slice(0, max).join(' ');
}

/**
 * 把截断后的证据渲染成 prompt 内嵌块。空证据返回空串(prompt 构造器据此
 * 省略整个证据段落)。日期用 ISO date(证据仅供模型参照,非展示文案)。
 */
export function formatEvidenceBlock(result: TruncateResult): string {
  if (result.items.length === 0) return '';
  const sections = result.items.map((item, i) => {
    const date = new Date(item.createdAt).toISOString().slice(0, 10);
    return `--- Evidence ${i + 1} (from a local session on ${date}) ---\n${item.text}`;
  });
  const dropped =
    result.droppedCount > 0
      ? `\n(${result.droppedCount} more matching excerpt(s) omitted due to size budget.)`
      : '';
  return `${sections.join('\n\n')}${dropped}`;
}
