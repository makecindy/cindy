/**
 * chatHistorySearch.pure.ts —— chatHistorySearch 引擎里"零 IO、零 electron 依赖"的
 * 纯逻辑(RRF 融合 + FTS query 构造), 抽出来便于单测。
 *
 * 与 renderer/features/cc-agent/lib/sessionSearch.ts 同思路: 把无副作用的计算从
 * 带 sqlite / embedding / electron 依赖的主引擎里剥离, 让单测不必 mock 整个环境。
 * 主引擎 chatHistorySearch.ts import 这里的函数。
 */

import { cjkSeg } from './cjkSeg';

/** RRF 平滑常数(业界惯用 60); 越大越削弱头部排名优势。 */
export const RRF_K = 60;

export interface FusedEntry {
  messageId: string;
  score: number;
  /** 1-based FTS 排名; 未被 FTS 召回则 null。 */
  ftsRank: number | null;
  /** 1-based 向量排名; 未被向量召回则 null。 */
  vectorRank: number | null;
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ_arm 1 / (k + rank_arm(d)), rank 为 1-based。
 * 两路命中同一 doc 时分数相加(共识加权)。同分按 messageId 字典序兜底, 保证确定性
 * (可测、分页稳定)。
 *
 * @param ftsRanked FTS arm 命中的 messageId, 按相关度降序(best first)
 * @param vecRanked 向量 arm 命中的 messageId, 按距离升序(best first)
 */
export function fuseRRF(
  ftsRanked: readonly string[],
  vecRanked: readonly string[],
  k: number = RRF_K,
): FusedEntry[] {
  const map = new Map<string, FusedEntry>();
  const accum = (id: string, rank0: number, arm: 'fts' | 'vec') => {
    let e = map.get(id);
    if (!e) {
      e = { messageId: id, score: 0, ftsRank: null, vectorRank: null };
      map.set(id, e);
    }
    e.score += 1 / (k + rank0 + 1);
    if (arm === 'fts') e.ftsRank = rank0 + 1;
    else e.vectorRank = rank0 + 1;
  };
  ftsRanked.forEach((id, i) => accum(id, i, 'fts'));
  vecRanked.forEach((id, i) => accum(id, i, 'vec'));
  return [...map.values()].sort(
    (a, b) => b.score - a.score || a.messageId.localeCompare(b.messageId),
  );
}

const FTS_TOKEN_CAP = 32;
/**
 * 单个 token 码点数上限，与 MCP schema 的 query 上限（256）对齐。连续汉字在
 * 口径内整段保留才能整段精确召回——截成前缀会让只含前缀的消息假阳性命中
 * （messages_fts 按字 phrase 与群历史整段 token 两条路径都是）。帽只防御
 * 绕过 schema 的超长侧栏输入。
 */
const FTS_TOKEN_CHAR_CAP = 256;
/** 最终 MATCH 表达式字符上限，挡住超长 CJK phrase 在进 SQLite 前就把 heap 打爆。 */
const FTS_MATCH_CHAR_CAP = 2_048;
/**
 * 字母/数字 run，附着的 combining mark / 变体选择符跟着所属 token，
 * 不单独切开。与写入侧 cjkSeg「mark 不阻断分词」对齐。
 */
const FTS_TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}\u{E0100}-\u{E01EF}]*/gu;

/**
 * 与 {@link buildMessagesFtsMatch} 同源的 token 抽取（去重 + 上限）。
 * buildSnippetFromContent 用同一份 token 在原文上定位高亮区间，
 * 保证「召回用什么词、snippet 就标什么词」。
 */
export function extractMessagesFtsTokens(query: string): string[] {
  const tokens = query.match(FTS_TOKEN_RE);
  if (!tokens || tokens.length === 0) return [];
  const capped = tokens
    .map((token) => {
      const chars = [...token];
      // 超长 token 截到上限防御病态输入；Latin / 数字整段保留（截断后 quoted
      // MATCH 不再是精确命中，例如 128 位 hex）。汉字 run 在 schema 口径内整段保留。
      if (chars.length <= FTS_TOKEN_CHAR_CAP) {
        return token;
      }
      return chars.slice(0, FTS_TOKEN_CHAR_CAP).join('');
    })
    .filter((token) => token.length > 0);
  return [...new Set(capped)].slice(0, FTS_TOKEN_CAP);
}

/**
 * 把一段可见文本收成与 messages_fts 写入侧接近的 token 序列：先 cjk_seg，
 * 再按字母/数字/汉字 run 切开，并小写。用于判断 FTS 命中是不是落在用户看得见的字上。
 */
export function tokenizeVisibleMessagesFtsText(text: string): string[] {
  const segmented = cjkSeg(text) ?? text;
  const tokens = segmented.match(FTS_TOKEN_RE);
  if (!tokens || tokens.length === 0) return [];
  return tokens.map((token) => token.toLowerCase());
}

function indexOfTokenSequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * 侧栏用：query 的 messages_fts token 是否作为相邻序列出现在可见文本里。
 * 能保住「边，界」这种按字 phrase，但不会把附件文件名、内部 citation 当成可见命中。
 * 不含 porter 词干（那是已知限制）。
 */
export function visibleTextMatchesMessagesFtsQuery(visibleText: string, query: string): boolean {
  if (!visibleText) return false;
  const haystack = tokenizeVisibleMessagesFtsText(visibleText);
  if (haystack.length === 0) return false;
  for (const token of extractMessagesFtsTokens(query)) {
    const needle = tokenizeVisibleMessagesFtsText(token);
    if (needle.length === 0) continue;
    if (indexOfTokenSequence(haystack, needle) >= 0) return true;
  }
  return false;
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * 把自然语言 query 转成 FTS5 MATCH 表达式: 抽取字母/数字/CJK 连续 run 作为 token,
 * 每个 token 用双引号包裹(中和 FTS 操作符 - * : ( ) " 等防注入/语法错), OR 连接
 * 最大化词法召回(相关度交给 bm25 + RRF 裁决)。无有效 token → null(跳过 FTS arm)。
 *
 * 这是 unicode61 整段 token 形态, 给尚未按字切分的 FTS 表用(群历史)。
 * messages_fts 请用 {@link buildMessagesFtsMatch}。
 */
export function buildFtsMatch(query: string): string | null {
  const uniq = extractMessagesFtsTokens(query);
  if (uniq.length === 0) return null;
  return joinQuotedTokens(uniq.map(quoteFtsToken), 'OR');
}

/**
 * messages_fts 查询构造: 与写入侧 `cjk_seg` 对齐。
 * CJK run 收成相邻 phrase（`"边 界"`），英文 / 数字仍是独立 quoted token。
 *
 * 多词连接符由入口决定，不是 FTS5 默认值：
 * - 侧栏 / search_chat_history 走 OR，最大化词法召回，相关度交给 bm25 + RRF
 *   （与改 CJK 分词前同一口径，也是本 issue 要改进召回的那条路径）。
 * - session_search 走 AND：旧实现是整句单 phrase，AND 比整句更宽、仍要求
 *   各词都在同一条消息里，适合 LLM 精确回忆。
 *
 * FTS5 隐式连接符本来就是 AND（`"login" "bug"` 与 `"login" AND "bug"` 等价），
 * 所以 OR 必须显式写出；AND 显式写出仅为和 OR 对照、可读。
 */
export function buildMessagesFtsMatch(
  query: string,
  join: 'AND' | 'OR' = 'OR',
): string | null {
  const tokens = extractMessagesFtsTokens(query);
  if (tokens.length === 0) return null;
  return joinQuotedTokens(
    tokens.map((token) => quoteFtsToken(cjkSeg(token) ?? token)),
    join,
  );
}

function joinQuotedTokens(quoted: readonly string[], join: 'AND' | 'OR'): string | null {
  const sep = ` ${join} `;
  let out = '';
  for (const part of quoted) {
    const next = out ? `${out}${sep}${part}` : part;
    if (next.length > FTS_MATCH_CHAR_CAP) break;
    out = next;
  }
  return out.length > 0 ? out : null;
}
