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

/**
 * GitLab 的 MR（!N）和 Issue（#N）是两套编号，所以同一个输入框靠链接或前缀区分：
 * 链接（…/-/merge_requests/N、…/-/issues/N、…/-/work_items/N）、group/project!N、group/project#N，
 * 或在已知项目时只填 !N / #N。只写编号无法区分，返回 null。
 */
export interface GitlabItemReference {
  /** 实例域名，小写；只用短写法且没有已知项目时为空。 */
  host?: string;
  /** group/subgroup/project，小写。 */
  project: string;
  number: number;
  kind: 'mr' | 'issue';
}

const GITLAB_PROJECT = /^[a-z\d_.-]+(?:\/[a-z\d_.-]+)+$/i;
const GITLAB_HOST = /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i;

export function parseGitlabItemReference(input: string, known?: { host?: string; project: string }): GitlabItemReference | null {
  const text = input.trim();
  if (!text) return null;
  const kindOf = (sigil: string): 'mr' | 'issue' => (sigil === '!' ? 'mr' : 'issue');
  const validProject = (project: string) => GITLAB_PROJECT.test(project) && !project.split('/').some((part) => part === '.' || part === '..');
  const bare = /^([!#])(\d+)$/.exec(text);
  if (bare) {
    const number = positive(bare[2]!);
    return number && known && validProject(known.project)
      ? { ...(known.host ? { host: known.host.toLowerCase() } : {}), project: known.project.toLowerCase(), number, kind: kindOf(bare[1]!) }
      : null;
  }
  const short = /^([^\s!#]+)([!#])(\d+)$/.exec(text);
  if (short && !short[1]!.includes(':')) {
    const number = positive(short[3]!);
    return number && validProject(short[1]!)
      ? { ...(known?.host ? { host: known.host.toLowerCase() } : {}), project: short[1]!.toLowerCase(), number, kind: kindOf(short[2]!) }
      : null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !GITLAB_HOST.test(url.hostname)) return null;
  const match = /^\/(.+?)\/-\/(merge_requests|issues|work_items)\/(\d+)(?:\/.*)?$/.exec(url.pathname);
  if (!match || !validProject(match[1]!)) return null;
  const number = positive(match[3]!);
  if (!number) return null;
  return { host: url.hostname.toLowerCase(), project: match[1]!.toLowerCase(), number, kind: match[2] === 'merge_requests' ? 'mr' : 'issue' };
}

export function gitlabItemUrl(item: GitlabItemReference & { host: string }): string {
  return `https://${item.host}/${item.project}/-/${item.kind === 'mr' ? 'merge_requests' : 'issues'}/${item.number}`;
}

/** 指定 GitLab Issue 的条件，对应 GitLab Webhook 的 Issue 事件（object_kind=issue，action=open/close/reopen/update）。 */
export const GITLAB_ISSUE_CHANGES = ['any', 'closed', 'reopened'] as const;
export type GitlabIssueChange = (typeof GITLAB_ISSUE_CHANGES)[number];

const GITLAB_ISSUE_CHANGE_EVENTS: Record<GitlabIssueChange, readonly string[]> = {
  any: ['issue'],
  closed: ['issue.close'],
  reopened: ['issue.reopen'],
};

export function gitlabIssueChangeEvents(change: GitlabIssueChange): string[] {
  return [...GITLAB_ISSUE_CHANGE_EVENTS[change]];
}

export function gitlabIssueChangeFromEvents(events: readonly string[] | undefined): GitlabIssueChange | null {
  const key = [...new Set(events ?? [])].sort().join(',');
  return GITLAB_ISSUE_CHANGES.find((change) => [...GITLAB_ISSUE_CHANGE_EVENTS[change]].sort().join(',') === key) ?? null;
}

/*
 * GitLab 插件做事件来源（2026-11-24）：GitLab 不推送到本机，官方 GitLab 插件用自己连好的账号轮询
 * 自动化订阅的项目或 Issue，再把变化作为插件事件发布。表单把「通过 GitLab 插件」保存成一个插件来源，
 * 条件写成插件事件字段（host / project / iid / kind）的 equals 条件；这里负责两边互转。
 */

/** GitLab 插件的安装身份：官方安装为 cindy-gitlab，命名空间安装（如本机开发版）以 __cindy-gitlab 结尾。 */
export function isGitlabPluginId(id: string): boolean {
  return /(^|[/:]|__)cindy-gitlab$/.test(id);
}

/** group/project 或项目链接（可带 /-/ 后的页面路径）；链接给出实例地址。 */
export function parseGitlabProjectReference(input: string): { host?: string; project: string } | null {
  const text = input.trim().replace(/\/+$/, '');
  if (!text) return null;
  const valid = (project: string) => GITLAB_PROJECT.test(project) && !project.split('/').some((part) => part === '.' || part === '..');
  if (!/^https?:\/\//i.test(text)) return !text.includes(':') && valid(text) ? { project: text.toLowerCase() } : null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !GITLAB_HOST.test(url.hostname)) return null;
  const project = url.pathname.replace(/^\/+/, '').replace(/\/-(?:\/.*)?$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return valid(project) ? { host: url.hostname.toLowerCase(), project: project.toLowerCase() } : null;
}

/** 通过插件指定 Issue 时的条件：插件能区分 Issue 的评论，所以比 Webhook 多一个「有新评论」。 */
export const GITLAB_PLUGIN_ISSUE_CHANGES = ['any', 'comment', 'closed', 'reopened'] as const;
export type GitlabPluginIssueChange = (typeof GITLAB_PLUGIN_ISSUE_CHANGES)[number];

const GITLAB_PLUGIN_ISSUE_EVENTS: Record<GitlabPluginIssueChange, readonly string[]> = {
  any: ['issue.updated', 'issue.comment', 'issue.closed', 'issue.reopened'],
  comment: ['issue.comment'],
  closed: ['issue.closed'],
  reopened: ['issue.reopened'],
};

export function gitlabPluginIssueChangeEvents(change: GitlabPluginIssueChange): string[] {
  return [...GITLAB_PLUGIN_ISSUE_EVENTS[change]];
}

export function gitlabPluginIssueChangeFromEvents(events: readonly string[] | undefined): GitlabPluginIssueChange | null {
  const key = [...new Set(events ?? [])].sort().join(',');
  return GITLAB_PLUGIN_ISSUE_CHANGES.find((change) => [...GITLAB_PLUGIN_ISSUE_EVENTS[change]].sort().join(',') === key) ?? null;
}

/** 表单里「通过 GitLab 插件」的范围：整个项目（events 为所选事件，空表示全部）或项目里的一个 Issue。 */
export interface GitlabPluginScope {
  plugin: string;
  host?: string;
  project: string;
  issue?: number;
  events: string[];
}

export function gitlabPluginSource(scope: GitlabPluginScope): { plugin: string; events?: string[]; filters: Array<{ field: string; operator: 'equals'; value: string }> } {
  const filters: Array<{ field: string; operator: 'equals'; value: string }> = [];
  if (scope.host) filters.push({ field: 'host', operator: 'equals', value: scope.host.toLowerCase() });
  filters.push({ field: 'project', operator: 'equals', value: scope.project.toLowerCase() });
  if (scope.issue !== undefined) {
    filters.push({ field: 'iid', operator: 'equals', value: String(scope.issue) });
    filters.push({ field: 'kind', operator: 'equals', value: 'issue' });
  }
  return { plugin: scope.plugin, ...(scope.events.length ? { events: [...scope.events] } : {}), filters };
}

/** 能按「通过 GitLab 插件」表单还原的插件来源；Agent 写的其他组合返回 null，按普通插件来源显示。 */
export function gitlabPluginScopeFromSource(
  sources: ReadonlyArray<{ plugin: string; events?: readonly string[]; filters?: ReadonlyArray<{ field: string; operator: string; value: string }> }>,
): GitlabPluginScope | null {
  if (sources.length !== 1 || !isGitlabPluginId(sources[0]!.plugin)) return null;
  const source = sources[0]!;
  const values: Record<string, string> = {};
  for (const filter of source.filters ?? []) {
    if (filter.operator !== 'equals' || !['host', 'project', 'iid', 'kind'].includes(filter.field) || filter.field in values) return null;
    values[filter.field] = filter.value;
  }
  const project = values.project !== undefined ? parseGitlabProjectReference(values.project) : null;
  if (!project || project.host || (values.host !== undefined && !GITLAB_HOST.test(values.host))) return null;
  const events = [...(source.events ?? [])];
  if (values.iid === undefined && values.kind === undefined) {
    return { plugin: source.plugin, ...(values.host ? { host: values.host } : {}), project: project.project, events };
  }
  const issue = values.iid !== undefined ? positive(values.iid) : null;
  if (values.kind !== 'issue' || !issue || String(issue) !== values.iid) return null;
  return { plugin: source.plugin, ...(values.host ? { host: values.host } : {}), project: project.project, issue, events };
}
