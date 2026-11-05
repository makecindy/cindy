import { prStatusKey, sessionPrUrl, isPrHost, type PrIdentity } from '@cindy/maker-shared';
/**
 * prRefExtractor — 从消息文本中确定性提取 GitHub PR 与 GitLab MR 链接(纯函数,零依赖)。
 *
 * 设计取舍(规则 9:确定性逻辑用代码不用 prompt):
 *   - 只认完整的 github.com PR URL 或 HTTPS GitLab MR URL,不做 "#123" 裸编号推断(裸编号无法确定仓库,
 *     且 issue / PR 无法区分,误报率高)。
 *   - 调用方限定只扫 user / assistant 两种角色的消息:tool_result 里出现的 PR 列表
 *     (如 `gh pr list` 输出 20 条)是噪音,会污染"本对话在处理哪条 PR"的语义。
 */

/** 一条被识别出的 PR 引用(尚未带状态)。 */
export interface PrRef extends PrIdentity {
  owner: string;
  repo: string;
  prNumber: number;
  /** 规范化后的 PR 首页 URL(去掉 /files 等子路径与 query/hash)。 */
  url: string;
}

const PR_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\b/g;

/**
 * 提取文本中所有 PR/MR 引用,按 (provider, host, owner, repo, number) 去重,保持首次出现顺序。
 */
export function extractPrRefs(text: string): PrRef[] {
  const seen = new Set<string>();
  const refs: PrRef[] = [];
  const mrPattern =
    /https:\/\/([^/\s<>"'`]+)\/((?:[A-Za-z0-9_.-]+\/)+)([A-Za-z0-9_.-]+)\/-\/merge_requests\/([1-9]\d*)\b/g;
  const candidates: Array<{ index: number; ref: PrRef }> = [];
  for (const m of text.matchAll(PR_URL_RE)) {
    const owner = m[1].toLowerCase();
    const repo = m[2].replace(/\.git$/, '').toLowerCase();
    const prNumber = Number(m[3]);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) continue;
    candidates.push({
      index: m.index!,
      ref: { owner, repo, prNumber, url: `https://github.com/${owner}/${repo}/pull/${prNumber}` },
    });
  }
  for (const m of text.matchAll(mrPattern)) {
    const host = m[1].toLowerCase();
    const owner = m[2].slice(0, -1).toLowerCase();
    const repo = m[3].toLowerCase();
    const prNumber = Number(m[4]);
    if (
      !isPrHost(host) ||
      !Number.isSafeInteger(prNumber) ||
      `${owner}/${repo}`.split('/').some((p) => p === '.' || p === '..')
    )
      continue;
    const ref = { provider: 'gitlab' as const, host, owner, repo, prNumber };
    candidates.push({ index: m.index!, ref: { ...ref, url: sessionPrUrl(ref) } });
  }
  for (const { ref } of candidates.sort((a, b) => a.index - b.index)) {
    const key = prStatusKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * 把一条消息的 content(string 或结构化对象)转成可扫描的文本。
 * 结构化 content 用 JSON.stringify 兜底——URL 出现在嵌套字段里也能命中。
 */
export function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}
