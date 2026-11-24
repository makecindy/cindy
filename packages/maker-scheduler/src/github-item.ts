/**
 * 「指定 PR 或 Issue」的输入解析与 Issue 条件。GitHub 的 PR 与 Issue 共用同一套编号，
 * 所以表单只有一个输入框：编号、#编号、owner/repo#编号或链接都可以。是 PR 还是 Issue 由宿主
 * 向 GitHub 查询确认（链接里的 /pull/ 可直接确定是 PR）。不依赖 Node，Renderer 也会引用。
 */

const REPOSITORY = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;

export interface GithubItemReference {
  /** owner/repo，小写。 */
  repository: string;
  number: number;
  /** 链接能确定时给出；/issues/ 链接也可能是 PR（GitHub 会跳转），所以只有 /pull/ 能确定。 */
  kind?: 'pr';
}

const positive = (text: string): number | null => {
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

/**
 * 解析输入框内容。只填编号时使用 defaultRepository；解析不了返回 null。
 * 支持：42、#42、owner/repo#42、https://github.com/owner/repo/pull/42、…/issues/42（可带尾部路径）。
 */
export function parseGithubItemReference(input: string, defaultRepository?: string): GithubItemReference | null {
  const text = input.trim();
  if (!text) return null;
  const bare = /^#?(\d+)$/.exec(text);
  if (bare) {
    const number = positive(bare[1]!);
    const repository = defaultRepository?.trim().toLowerCase();
    return number && repository && REPOSITORY.test(repository) ? { repository, number } : null;
  }
  const short = /^([^\s#/]+\/[^\s#/]+)#(\d+)$/.exec(text);
  if (short) {
    const number = positive(short[2]!);
    return number && REPOSITORY.test(short[1]!) ? { repository: short[1]!.toLowerCase(), number } : null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password) return null;
  const match = /^\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)(?:\/.*)?$/.exec(url.pathname);
  if (!match || !REPOSITORY.test(match[1]!)) return null;
  const number = positive(match[3]!);
  if (!number) return null;
  return { repository: match[1]!.toLowerCase(), number, ...(match[2] === 'pull' ? { kind: 'pr' as const } : {}) };
}

export function githubItemUrl(item: { repository: string; number: number }, kind: 'pr' | 'issue'): string {
  return `https://github.com/${item.repository}/${kind === 'pr' ? 'pull' : 'issues'}/${item.number}`;
}

/** 指定 Issue 的触发条件，对应 GitHub App 的事件筛选。 */
export const ISSUE_CHANGES = ['any', 'comment', 'closed', 'reopened'] as const;
export type IssueChange = (typeof ISSUE_CHANGES)[number];

const ISSUE_CHANGE_EVENTS: Record<IssueChange, readonly string[]> = {
  any: ['issues', 'issue_comment'],
  comment: ['issue_comment.created'],
  closed: ['issues.closed'],
  reopened: ['issues.reopened'],
};

export function issueChangeEvents(change: IssueChange): string[] {
  return [...ISSUE_CHANGE_EVENTS[change]];
}

/** 从保存的事件筛选还原条件；不是这几种组合时返回 null，表单原样保留筛选。 */
export function issueChangeFromEvents(events: readonly string[] | undefined): IssueChange | null {
  const key = [...new Set(events ?? [])].sort().join(',');
  return ISSUE_CHANGES.find((change) => [...ISSUE_CHANGE_EVENTS[change]].sort().join(',') === key) ?? null;
}
