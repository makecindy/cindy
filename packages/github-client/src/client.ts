/**
 * GitHub REST API v3 客户端。
 *
 * 零外部依赖 — 仅使用全局 fetch(Node 18+ / Electron 28+)。
 * 所有方法均可在 main / server 进程直接调用。
 *
 * 与 @cindy/gitlab-client 接口形状对齐,差异点:
 *   - GitHub 用 `number` 标识 issue/PR(GitLab 是 `iid`)
 *   - GitHub 路径是 `/repos/{owner}/{repo}/...`(GitLab 是 `/projects/{id}/...`)
 *   - 认证 header 是 `Authorization: Bearer <token>`(GitLab 是 `PRIVATE-TOKEN: <token>`)
 *   - GitHub PR 叫 Pull Request(GitLab 叫 Merge Request)
 */

import type {
  GithubClientConfig,
  GithubIssue,
  GithubComment,
  GithubPullRequest,
  GithubPullReview,
  GithubPullReviewComment,
  GithubLabel,
  GithubBranch,
  GithubUser,
  GithubUserFull,
  GithubOrg,
  GithubRepo,
  GithubEvent,
  GithubCommit,
  GithubCompareResult,
  GithubSearchResult,
  GithubWorkflowRun,
  GithubWorkflowJob,
  GithubWorkflow,
  GithubCheckRun,
  GithubDeployment,
  GithubRelease,
  GithubTag,
  GithubReadme,
  GithubContent,
  ListIssuesParams,
  CreateIssueParams,
  CreatePullRequestParams,
  ListPullRequestsParams,
  ListCommitsParams,
  ListEventsParams,
  SearchParams,
  ListWorkflowRunsParams,
  DispatchWorkflowParams,
  ListCheckRunsParams,
  ListDeploymentsParams,
  CreateReleaseParams,
  GithubNotificationThread,
  GithubArtifact,
  GithubTopics,
  GithubContributor,
  GithubLanguages,
  GithubHook,
  GithubBranchProtection,
  GithubTeam,
  GithubGist,
  GithubRequestedReviewers,
  GithubFileCommitResult,
  GithubFileContent,
  RequestReviewersParams,
  CreatePullReviewParams,
  CreatePullReviewCommentParams,
  UpdateIssueParams,
  UpdatePullRequestParams,
  ListNotificationsParams,
  CreateOrUpdateFileContentsParams,
  DeleteFileParams,
  ListForksParams,
  CreateForkParams,
  ListCollaboratorsParams,
  ListOrgMembersParams,
  ListGistsParams,
  GithubReaction,
  GithubReactionContent,
  AddReactionParams,
  GithubGitRef,
  GithubGitTree,
  GithubGitTreeItem,
  GithubGitCommit,
  CreateRefParams,
  CreateTreeParams,
  CreateCommitParams,
  PushFilesParams,
  PushFilesResult,
  CreateRepositoryParams,
  GithubReleaseAsset,
  AddSubIssueParams,
} from './types.js';
import { GithubApiError } from './types.js';
import { assertSafeBaseUrl, fetchWithSafeRedirect } from './http-safety.js';

const DEFAULT_BASE_URL = 'https://api.github.com';

// 去尾部斜杠。不用 /\/+$/ 正则——超长 '/' 串上会 O(n²) 回溯(CodeQL js/polynomial-redos)。
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return s.slice(0, end);
}

export class GithubClient {
  private readonly baseUrl: string;
  private readonly token: string;
  /** Raw owner / repo, used by GraphQL queries that need them as separate variables.
   * null when the client was constructed without a repo (user-scope). */
  private readonly owner: string | null;
  private readonly repo: string | null;
  /** URL-encoded `<owner>/<repo>`, or null when the client was constructed
   * without a repo (user-scope / search / graphql). Repo-scoped methods route
   * through {@link requireRepo} which throws a clear error in that case. */
  private readonly repoPath: string | null;
  /**
   * GraphQL 完整 URL。github.com 上是 `${baseUrl}/graphql`(baseUrl 本身就是
   * `api.github.com`);GHE 场景 baseUrl 是 `https://<host>/api/v3`(REST 前缀),
   * 但 GraphQL 走 `/api/graphql` —— 路径前缀不同,必须单独算,不能复用 request()。
   * 见 https://docs.github.com/en/enterprise-server/graphql/guides
   */
  private readonly graphqlUrl: string;

  constructor(config: GithubClientConfig) {
    this.baseUrl = trimTrailingSlashes(config.baseUrl ?? DEFAULT_BASE_URL);
    // GitHub(含 GHE)惯例强制 https(源自已退役的 shared/connectorUrl.ts 的 forceHttps 惯例,该模块已随 lizi_gitlab 于 2026-07-14 退役删除),
    // 故默认拒绝非 loopback 的 http,并拒绝非 http(s) 协议 / userinfo / 不可解析的 baseUrl。
    assertSafeBaseUrl(this.baseUrl);
    this.token = config.token;
    this.owner = config.owner ?? null;
    this.repo = config.repo ?? null;
    this.repoPath =
      config.owner && config.repo
        ? `${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`
        : null;
    // GHE 的 baseUrl 末尾是 '/api/v3',把它剥掉换成 '/api' 后拼 '/graphql'。
    // github.com 的 baseUrl 是 'https://api.github.com',正则不匹配,直接拼 '/graphql'。
    this.graphqlUrl = `${this.baseUrl.replace(/\/api\/v3$/, '/api')}/graphql`;
  }

  /** Return the encoded repo path or fail fast when the caller invoked a
   * repo-scoped endpoint without configuring owner/repo. */
  private requireRepo(): string {
    if (!this.repoPath) {
      throw new Error(
        'GithubClient: owner and repo are required for repo-scoped calls',
      );
    }
    return this.repoPath;
  }

  /** 把 params 对象里非 undefined 的字段拼成 URLSearchParams,统一 querystring 构造。 */
  private qs(params: Record<string, string | number | boolean | undefined>): string {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      usp.set(k, String(v));
    }
    const s = usp.toString();
    return s ? `?${s}` : '';
  }

  // ── Issues ───────────────────────────────────────────────────────────────

  async listIssues(params: ListIssuesParams = {}): Promise<GithubIssue[]> {
    return this.get<GithubIssue[]>(`/repos/${this.requireRepo()}/issues${this.qs({ ...params })}`);
  }

  async getIssue(issueNumber: number): Promise<GithubIssue> {
    return this.get<GithubIssue>(`/repos/${this.requireRepo()}/issues/${issueNumber}`);
  }

  async createIssue(params: CreateIssueParams): Promise<GithubIssue> {
    return this.post<GithubIssue>(`/repos/${this.requireRepo()}/issues`, {
      title: params.title,
      body: params.body,
      labels: params.labels,
      assignees: params.assignees,
    });
  }

  async getIssueComments(issueNumber: number): Promise<GithubComment[]> {
    return this.get<GithubComment[]>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}/comments?per_page=100`,
    );
  }

  async addIssueComment(issueNumber: number, body: string): Promise<GithubComment> {
    return this.post<GithubComment>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}/comments`,
      { body },
    );
  }

  /** 增删 issue label(GitHub PATCH 不支持增量,需先 GET 拿现有再合并) */
  async updateIssueLabels(
    issueNumber: number,
    addLabels: string[],
    removeLabels: string[],
  ): Promise<GithubIssue> {
    const current = await this.getIssue(issueNumber);
    const currentNames = new Set(current.labels.map((l) => l.name));
    for (const name of addLabels) currentNames.add(name);
    for (const name of removeLabels) currentNames.delete(name);
    return this.patch<GithubIssue>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}`,
      { labels: Array.from(currentNames) },
    );
  }

  // ── Pull Requests ────────────────────────────────────────────────────────

  /** 单条 PR 详情(含 merged / draft / merged_at,用于状态展示)。 */
  async getPullRequest(prNumber: number): Promise<GithubPullRequest> {
    return this.get<GithubPullRequest>(`/repos/${this.requireRepo()}/pulls/${prNumber}`);
  }

  async listPullRequests(params: ListPullRequestsParams = {}): Promise<GithubPullRequest[]> {
    return this.get<GithubPullRequest[]>(
      `/repos/${this.requireRepo()}/pulls${this.qs({ ...params })}`,
    );
  }

  /**
   * 创建 PR。跨 fork 场景 `sourceBranch`(head)必须带 fork owner 前缀
   * `forkOwner:branch`,否则 GitHub 返 422 head invalid;head 与 base 同仓时裸分支名即可。
   */
  async createPullRequest(params: CreatePullRequestParams): Promise<GithubPullRequest> {
    return this.post<GithubPullRequest>(
      `/repos/${this.requireRepo()}/pulls`,
      {
        head: params.sourceBranch,
        base: params.targetBranch,
        title: params.title,
        body: params.body,
        draft: params.draft,
      },
    );
  }

  /** PR 变更文件列表(含 patch)。分页,默认拉第一页 100 条,大 PR 需外部再翻页。 */
  async listPullRequestFiles(
    prNumber: number,
    params: { per_page?: number; page?: number } = {},
  ): Promise<Array<import('./types.js').GithubCommitFile>> {
    return this.get(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/files${this.qs({
        per_page: params.per_page ?? 100,
        page: params.page,
      })}`,
    );
  }

  /** PR 关联的 commit 列表(按顺序)。 */
  async listPullRequestCommits(
    prNumber: number,
    params: { per_page?: number; page?: number } = {},
  ): Promise<GithubCommit[]> {
    return this.get<GithubCommit[]>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/commits${this.qs({
        per_page: params.per_page ?? 100,
        page: params.page,
      })}`,
    );
  }

  /** PR reviews(approve / request-changes / comment,不是 conversation comment)。 */
  async listPullRequestReviews(prNumber: number): Promise<GithubPullReview[]> {
    return this.get<GithubPullReview[]>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/reviews?per_page=100`,
    );
  }

  /** PR review 里的 inline code comment。 */
  async listPullRequestReviewComments(prNumber: number): Promise<GithubPullReviewComment[]> {
    return this.get<GithubPullReviewComment[]>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/comments?per_page=100`,
    );
  }

  /** 合并 PR。merge_method: 'merge' | 'squash' | 'rebase'。 */
  async mergePullRequest(
    prNumber: number,
    params: {
      commit_title?: string;
      commit_message?: string;
      sha?: string;
      merge_method?: 'merge' | 'squash' | 'rebase';
    } = {},
  ): Promise<{ sha: string; merged: boolean; message: string }> {
    return this.put(`/repos/${this.requireRepo()}/pulls/${prNumber}/merge`, params);
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  /** 列出仓库所有 label(per_page=100 一页够用) */
  async listLabels(): Promise<GithubLabel[]> {
    return this.get<GithubLabel[]>(`/repos/${this.requireRepo()}/labels?per_page=100`);
  }

  /** 列出仓库所有分支 */
  async listBranches(): Promise<GithubBranch[]> {
    return this.get<GithubBranch[]>(`/repos/${this.requireRepo()}/branches?per_page=100`);
  }

  /** 列出仓库所有 tag(按 commit date 倒序,分页) */
  async listTags(params: { per_page?: number; page?: number } = {}): Promise<GithubTag[]> {
    return this.get<GithubTag[]>(
      `/repos/${this.requireRepo()}/tags${this.qs({ ...params })}`,
    );
  }

  /** 获取仓库 README(base64 content,和 getContents 文件返回结构一致)。 */
  async getReadme(params: { ref?: string } = {}): Promise<GithubReadme> {
    return this.get<GithubReadme>(
      `/repos/${this.requireRepo()}/readme${this.qs({ ref: params.ref })}`,
    );
  }

  /** 确保 label 存在;已存在则忽略(422 → swallow) */
  async ensureLabels(names: string[]): Promise<void> {
    const existing = await this.listLabels();
    const existingNames = new Set(existing.map((l) => l.name));
    for (const name of names) {
      if (existingNames.has(name)) continue;
      try {
        await this.post(`/repos/${this.requireRepo()}/labels`, {
          name,
          color: '428BCA',
        });
      } catch (err) {
        if (err instanceof GithubApiError && err.status === 422) continue;
        throw err;
      }
    }
  }

  // ── Repository ──────────────────────────────────────────────────────────

  /** 单个仓库元信息 */
  async getRepo(): Promise<GithubRepo> {
    return this.get<GithubRepo>(`/repos/${this.requireRepo()}`);
  }

  /**
   * 获取仓库内文件/目录内容。path='' 拿仓库根。
   * ref 可以是 branch / tag / commit sha。默认走仓库默认分支。
   * 返回值:文件 → 单个对象;目录 → 对象数组。
   */
  async getContents(path: string, ref?: string): Promise<GithubContent> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return this.get<GithubContent>(
      `/repos/${this.requireRepo()}/contents/${encodedPath}${this.qs({ ref })}`,
    );
  }

  // ── Commits ─────────────────────────────────────────────────────────────

  async listCommits(params: ListCommitsParams = {}): Promise<GithubCommit[]> {
    return this.get<GithubCommit[]>(
      `/repos/${this.requireRepo()}/commits${this.qs({ ...params })}`,
    );
  }

  async getCommit(sha: string): Promise<GithubCommit> {
    return this.get<GithubCommit>(`/repos/${this.requireRepo()}/commits/${sha}`);
  }

  /** compare_commits: /repos/{o}/{r}/compare/{base}...{head} */
  async compareCommits(base: string, head: string): Promise<GithubCompareResult> {
    return this.get<GithubCompareResult>(
      `/repos/${this.requireRepo()}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** 认证用户能看到的 events(公开 + 关注的 + 自己的私有)。 */
  async listAuthenticatedUserEvents(
    username: string,
    params: ListEventsParams = {},
  ): Promise<GithubEvent[]> {
    return this.get<GithubEvent[]>(
      `/users/${encodeURIComponent(username)}/events${this.qs({ ...params })}`,
    );
  }

  /**
   * 认证用户在某 org 内能看到的 events(GET /users/:u/events/orgs/:org)。
   * 与 `listOrgEvents` 走的 /orgs/:org/events 公开源不同 —— 这个端点会包含
   * username 在 org 里 access 到的私有 repo 活动,work-collect 类场景该用它。
   */
  async listAuthenticatedUserOrgEvents(
    username: string,
    org: string,
    params: ListEventsParams = {},
  ): Promise<GithubEvent[]> {
    return this.get<GithubEvent[]>(
      `/users/${encodeURIComponent(username)}/events/orgs/${encodeURIComponent(org)}${this.qs({ ...params })}`,
    );
  }

  /** 指定 user 的公开 events(不需要认证,但走认证可提升 rate limit)。 */
  async listUserPublicEvents(
    username: string,
    params: ListEventsParams = {},
  ): Promise<GithubEvent[]> {
    return this.get<GithubEvent[]>(
      `/users/${encodeURIComponent(username)}/events/public${this.qs({ ...params })}`,
    );
  }

  /** org 的 events(需 org 成员权限)。 */
  async listOrgEvents(
    org: string,
    params: ListEventsParams = {},
  ): Promise<GithubEvent[]> {
    return this.get<GithubEvent[]>(
      `/orgs/${encodeURIComponent(org)}/events${this.qs({ ...params })}`,
    );
  }

  /** 仓库的 events。 */
  async listRepoEvents(params: ListEventsParams = {}): Promise<GithubEvent[]> {
    return this.get<GithubEvent[]>(
      `/repos/${this.requireRepo()}/events${this.qs({ ...params })}`,
    );
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /** 搜索仓库。q 语法见 https://docs.github.com/search-github/searching-on-github/searching-for-repositories */
  async searchRepos(params: SearchParams): Promise<GithubSearchResult<GithubRepo>> {
    return this.get(`/search/repositories${this.qs({ ...params })}`);
  }

  /**
   * 搜索 issue / PR(GitHub 把 issue 和 PR 归到同一个 /search/issues endpoint,
   * 通过 q 里的 `is:pr` / `is:issue` 或 `type:pr` / `type:issue` 过滤)。
   */
  async searchIssuesAndPRs(params: SearchParams): Promise<GithubSearchResult<GithubIssue>> {
    return this.get(`/search/issues${this.qs({ ...params })}`);
  }

  async searchCommits(params: SearchParams): Promise<GithubSearchResult<GithubCommit>> {
    return this.get(`/search/commits${this.qs({ ...params })}`);
  }

  async searchCode(params: SearchParams): Promise<
    GithubSearchResult<{
      name: string;
      path: string;
      sha: string;
      html_url: string;
      repository: GithubRepo;
    }>
  > {
    return this.get(`/search/code${this.qs({ ...params })}`);
  }

  async searchUsers(params: SearchParams): Promise<GithubSearchResult<GithubUser>> {
    return this.get(`/search/users${this.qs({ ...params })}`);
  }

  // ── Users / Orgs ────────────────────────────────────────────────────────

  async getUser(username: string): Promise<GithubUserFull> {
    return this.get<GithubUserFull>(`/users/${encodeURIComponent(username)}`);
  }

  async listUserOrgs(username: string): Promise<GithubOrg[]> {
    return this.get<GithubOrg[]>(
      `/users/${encodeURIComponent(username)}/orgs?per_page=100`,
    );
  }

  /** 认证用户能访问的仓库(含私有)。 */
  async listAuthenticatedUserRepos(
    params: {
      visibility?: 'all' | 'public' | 'private';
      affiliation?: string;
      type?: 'all' | 'owner' | 'public' | 'private' | 'member';
      sort?: 'created' | 'updated' | 'pushed' | 'full_name';
      direction?: 'asc' | 'desc';
      per_page?: number;
      page?: number;
    } = {},
  ): Promise<GithubRepo[]> {
    return this.get<GithubRepo[]>(`/user/repos${this.qs({ ...params })}`);
  }

  /** org 的所有仓库(需可见性权限)。 */
  async listOrgRepos(
    org: string,
    params: {
      type?: 'all' | 'public' | 'private' | 'forks' | 'sources' | 'member';
      sort?: 'created' | 'updated' | 'pushed' | 'full_name';
      direction?: 'asc' | 'desc';
      per_page?: number;
      page?: number;
    } = {},
  ): Promise<GithubRepo[]> {
    return this.get<GithubRepo[]>(
      `/orgs/${encodeURIComponent(org)}/repos${this.qs({ ...params })}`,
    );
  }

  // ── Actions (workflows / workflow runs) ─────────────────────────────────

  /** 列出仓库的 workflow 定义(不是 run)。 */
  async listWorkflows(
    params: { per_page?: number; page?: number } = {},
  ): Promise<{ total_count: number; workflows: GithubWorkflow[] }> {
    return this.get(
      `/repos/${this.requireRepo()}/actions/workflows${this.qs({ ...params })}`,
    );
  }

  /**
   * 触发一个 workflow_dispatch 事件。workflowIdOrFileName 可以是数字 id,
   * 也可以是 workflow 文件名(如 'ci.yml')。204 No Content。
   */
  async dispatchWorkflow(
    workflowIdOrFileName: number | string,
    params: DispatchWorkflowParams,
  ): Promise<void> {
    const id = encodeURIComponent(String(workflowIdOrFileName));
    await this.post<void>(
      `/repos/${this.requireRepo()}/actions/workflows/${id}/dispatches`,
      { ref: params.ref, inputs: params.inputs },
    );
  }

  /** 重跑一次 workflow run(与原 run 同一 event、同一 sha)。 */
  async rerunWorkflowRun(runId: number): Promise<void> {
    await this.post<void>(
      `/repos/${this.requireRepo()}/actions/runs/${runId}/rerun`,
      {},
    );
  }

  /** 取消进行中的 workflow run。 */
  async cancelWorkflowRun(runId: number): Promise<void> {
    await this.post<void>(
      `/repos/${this.requireRepo()}/actions/runs/${runId}/cancel`,
      {},
    );
  }

  async listWorkflowRuns(
    params: ListWorkflowRunsParams = {},
  ): Promise<{ total_count: number; workflow_runs: GithubWorkflowRun[] }> {
    return this.get(
      `/repos/${this.requireRepo()}/actions/runs${this.qs({ ...params })}`,
    );
  }

  async getWorkflowRun(runId: number): Promise<GithubWorkflowRun> {
    return this.get<GithubWorkflowRun>(
      `/repos/${this.requireRepo()}/actions/runs/${runId}`,
    );
  }

  async listWorkflowRunJobs(
    runId: number,
    params: { filter?: 'latest' | 'all'; per_page?: number; page?: number } = {},
  ): Promise<{ total_count: number; jobs: GithubWorkflowJob[] }> {
    return this.get(
      `/repos/${this.requireRepo()}/actions/runs/${runId}/jobs${this.qs({ ...params })}`,
    );
  }

  // ── Releases ────────────────────────────────────────────────────────────

  async listReleases(params: { per_page?: number; page?: number } = {}): Promise<GithubRelease[]> {
    return this.get<GithubRelease[]>(
      `/repos/${this.requireRepo()}/releases${this.qs({ ...params })}`,
    );
  }

  async getReleaseByTag(tag: string): Promise<GithubRelease> {
    return this.get<GithubRelease>(
      `/repos/${this.requireRepo()}/releases/tags/${encodeURIComponent(tag)}`,
    );
  }

  /** 创建 release。tag 不存在时 GitHub 会自动在 target_commitish 上打 tag。 */
  async createRelease(params: CreateReleaseParams): Promise<GithubRelease> {
    return this.post<GithubRelease>(`/repos/${this.requireRepo()}/releases`, {
      tag_name: params.tag_name,
      target_commitish: params.target_commitish,
      name: params.name,
      body: params.body,
      draft: params.draft,
      prerelease: params.prerelease,
      generate_release_notes: params.generate_release_notes,
    });
  }

  // ── Checks ──────────────────────────────────────────────────────────────

  /** 列出某 ref(commit sha / branch / tag)上的 check runs。 */
  async listCheckRunsForRef(
    ref: string,
    params: ListCheckRunsParams = {},
  ): Promise<{ total_count: number; check_runs: GithubCheckRun[] }> {
    return this.get(
      `/repos/${this.requireRepo()}/commits/${encodeURIComponent(ref)}/check-runs${this.qs({ ...params })}`,
    );
  }

  // ── Deployments ─────────────────────────────────────────────────────────

  async listDeployments(params: ListDeploymentsParams = {}): Promise<GithubDeployment[]> {
    return this.get<GithubDeployment[]>(
      `/repos/${this.requireRepo()}/deployments${this.qs({ ...params })}`,
    );
  }

  // ── GraphQL ──────────────────────────────────────────────────────────────

  /**
   * 通用 GraphQL 查询。REST 缺口场景用(如 review thread 的 resolved 状态只有
   * GraphQL 暴露)。响应含 errors 时抛 GithubApiError。
   *
   * 不走 request() 是因为 GHE 的 GraphQL 路径(`/api/graphql`)和 REST 路径
   * (`/api/v3/...`)前缀不同 —— request() 一律用 baseUrl 拼,GHE 上会拼成
   * `/api/v3/graphql` 拿到 404。graphqlUrl 在构造时已算好,github.com 场景
   * 直接拼 `${baseUrl}/graphql`。
   */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    // 认证请求不跟随跨 host 重定向(同 request())。
    const res = await fetchWithSafeRedirect(this.graphqlUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GithubApiError(
        `GitHub GraphQL POST failed: ${res.status}`,
        res.status,
        text,
      );
    }
    const body = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (body.errors && body.errors.length > 0) {
      throw new GithubApiError(
        `GitHub GraphQL failed: ${body.errors.map((e) => e.message).join('; ')}`,
        200,
        JSON.stringify(body.errors),
      );
    }
    if (body.data === undefined) {
      throw new GithubApiError('GitHub GraphQL returned no data', 200);
    }
    return body.data;
  }

  // ── Auth 验证 ────────────────────────────────────────────────────────────

  /** 验证 token 有效性,返回当前用户信息 */
  async getCurrentUser(): Promise<GithubUser> {
    return this.get<GithubUser>('/user');
  }

  // ── Issues / PR (mutations) ─────────────────────────────────────────────

  /** PATCH /repos/{o}/{r}/issues/{n}:更新 issue title / body / state / labels 等。 */
  async updateIssue(issueNumber: number, params: UpdateIssueParams): Promise<GithubIssue> {
    return this.patch<GithubIssue>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}`,
      {
        title: params.title,
        body: params.body,
        state: params.state,
        state_reason: params.state_reason,
        labels: params.labels,
        assignees: params.assignees,
      },
    );
  }

  /** POST /repos/{o}/{r}/issues/{n}/assignees:批量增加 assignee。 */
  async addIssueAssignees(issueNumber: number, assignees: string[]): Promise<GithubIssue> {
    return this.post<GithubIssue>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}/assignees`,
      { assignees },
    );
  }

  /** DELETE /repos/{o}/{r}/issues/{n}/assignees:移除 assignee。 */
  async removeIssueAssignees(issueNumber: number, assignees: string[]): Promise<GithubIssue> {
    return this.request<GithubIssue>(
      'DELETE',
      `/repos/${this.requireRepo()}/issues/${issueNumber}/assignees`,
      { assignees },
    );
  }

  /** POST /repos/{o}/{r}/issues/{n}/labels:批量增加 label(不删除现有)。 */
  async addIssueLabels(issueNumber: number, labels: string[]): Promise<GithubLabel[]> {
    return this.post<GithubLabel[]>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}/labels`,
      { labels },
    );
  }

  /** DELETE /repos/{o}/{r}/issues/{n}/labels/{name}:移除单个 label。 */
  async removeIssueLabel(issueNumber: number, name: string): Promise<GithubLabel[]> {
    return this.request<GithubLabel[]>(
      'DELETE',
      `/repos/${this.requireRepo()}/issues/${issueNumber}/labels/${encodeURIComponent(name)}`,
    );
  }

  /** PATCH /repos/{o}/{r}/pulls/{n}:更新 PR title / body / state / base。 */
  async updatePullRequest(
    prNumber: number,
    params: UpdatePullRequestParams,
  ): Promise<GithubPullRequest> {
    return this.patch<GithubPullRequest>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}`,
      {
        title: params.title,
        body: params.body,
        state: params.state,
        base: params.base,
      },
    );
  }

  /** POST /repos/{o}/{r}/pulls/{n}/reviews:提交一次 review(approve / request_changes / comment)。 */
  async createPullRequestReview(
    prNumber: number,
    params: CreatePullReviewParams,
  ): Promise<GithubPullReview> {
    return this.post<GithubPullReview>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/reviews`,
      {
        event: params.event,
        body: params.body,
        commit_id: params.commit_id,
        comments: params.comments,
      },
    );
  }

  /** POST /repos/{o}/{r}/pulls/{n}/comments:新增单条 inline review comment(独立于 review)。 */
  async createPullRequestReviewComment(
    prNumber: number,
    params: CreatePullReviewCommentParams,
  ): Promise<GithubPullReviewComment> {
    return this.post<GithubPullReviewComment>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/comments`,
      {
        body: params.body,
        commit_id: params.commit_id,
        path: params.path,
        line: params.line,
        side: params.side,
        start_line: params.start_line,
        start_side: params.start_side,
      },
    );
  }

  /** GET /repos/{o}/{r}/pulls/comments/{comment_id}:获取单条 review 评论。 */
  async getPullRequestReviewComment(commentId: number): Promise<GithubPullReviewComment> {
    return this.get<GithubPullReviewComment>(
      `/repos/${this.requireRepo()}/pulls/comments/${commentId}`,
    );
  }

  /**
   * POST /repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies:
   * 回复某条已有 review 评论(挂到同一线程内)。与 createPullRequestReviewComment 不同,
   * 走 replies 专用端点,只需 commentId + body,不需 commit_id/path/line。
   * GitHub API 要求 commentId 必须是线程顶层评论 ID；若传入的是回复评论 ID(有
   * in_reply_to_id),本方法会先解析到顶层 ID 再发请求,避免 404。
   */
  async replyToPullRequestReviewComment(
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<GithubPullReviewComment> {
    // 若传入的是回复评论(有 in_reply_to_id),解析到顶层 ID(Codex P2)。
    const comment = await this.getPullRequestReviewComment(commentId);
    const topLevelId = comment.in_reply_to_id ?? commentId;
    return this.post<GithubPullReviewComment>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/comments/${topLevelId}/replies`,
      { body },
    );
  }

  /** POST /repos/{o}/{r}/pulls/{n}/requested_reviewers:请求 reviewer。 */
  async requestPullRequestReviewers(
    prNumber: number,
    params: RequestReviewersParams,
  ): Promise<GithubPullRequest> {
    return this.post<GithubPullRequest>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/requested_reviewers`,
      { reviewers: params.reviewers, team_reviewers: params.team_reviewers },
    );
  }

  /** DELETE /repos/{o}/{r}/pulls/{n}/requested_reviewers:移除已请求的 reviewer。 */
  async removePullRequestReviewers(
    prNumber: number,
    params: RequestReviewersParams,
  ): Promise<GithubPullRequest> {
    return this.request<GithubPullRequest>(
      'DELETE',
      `/repos/${this.requireRepo()}/pulls/${prNumber}/requested_reviewers`,
      { reviewers: params.reviewers, team_reviewers: params.team_reviewers },
    );
  }

  /** GET /repos/{o}/{r}/pulls/{n}/requested_reviewers。 */
  async listPullRequestRequestedReviewers(prNumber: number): Promise<GithubRequestedReviewers> {
    return this.get<GithubRequestedReviewers>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/requested_reviewers`,
    );
  }

  // ── Notifications ───────────────────────────────────────────────────────

  /** GET /notifications:当前用户的 notification threads。user-scope。 */
  async listNotifications(params: ListNotificationsParams = {}): Promise<GithubNotificationThread[]> {
    return this.get<GithubNotificationThread[]>(`/notifications${this.qs({ ...params })}`);
  }

  /** PATCH /notifications/threads/{id}:标记一条 notification 已读。 */
  async markNotificationRead(threadId: string): Promise<void> {
    await this.patch<void>(`/notifications/threads/${encodeURIComponent(threadId)}`);
  }

  // ── Actions: artifacts / logs (extended) ────────────────────────────────

  /** GET /repos/{o}/{r}/actions/runs/{run_id}/artifacts */
  async listWorkflowRunArtifacts(
    runId: number,
    params: { per_page?: number; page?: number } = {},
  ): Promise<{ total_count: number; artifacts: GithubArtifact[] }> {
    return this.get(
      `/repos/${this.requireRepo()}/actions/runs/${runId}/artifacts${this.qs({ ...params })}`,
    );
  }

  /**
   * GET /repos/{o}/{r}/actions/artifacts/{id}/zip → 302 redirect。返回 Location URL,
   * 调用方直接下载(URL 时效通常 1 分钟)。
   */
  async getArtifactDownloadUrl(artifactId: number): Promise<string | null> {
    return this.requestRedirectUrl(
      'GET',
      `/repos/${this.requireRepo()}/actions/artifacts/${artifactId}/zip`,
    );
  }

  /**
   * GET /repos/{o}/{r}/actions/runs/{run_id}/logs → 302 redirect。返回 Location URL,
   * 调用方直接下载 zip 格式的日志文件。
   */
  async getWorkflowRunLogsUrl(runId: number): Promise<string | null> {
    return this.requestRedirectUrl(
      'GET',
      `/repos/${this.requireRepo()}/actions/runs/${runId}/logs`,
    );
  }

  // ── Repository (topics / contributors / languages / forks / etc.) ──────

  /** GET /repos/{o}/{r}/topics */
  async listRepoTopics(): Promise<GithubTopics> {
    return this.get<GithubTopics>(`/repos/${this.requireRepo()}/topics`);
  }

  /** PUT /repos/{o}/{r}/topics:整表替换 topics 列表。 */
  async replaceRepoTopics(names: string[]): Promise<GithubTopics> {
    return this.put<GithubTopics>(`/repos/${this.requireRepo()}/topics`, { names });
  }

  /** GET /repos/{o}/{r}/contributors */
  async listRepoContributors(
    params: { anon?: boolean; per_page?: number; page?: number } = {},
  ): Promise<GithubContributor[]> {
    return this.get<GithubContributor[]>(
      `/repos/${this.requireRepo()}/contributors${this.qs({
        anon: params.anon,
        per_page: params.per_page,
        page: params.page,
      })}`,
    );
  }

  /** GET /repos/{o}/{r}/languages:language → bytes。 */
  async listRepoLanguages(): Promise<GithubLanguages> {
    return this.get<GithubLanguages>(`/repos/${this.requireRepo()}/languages`);
  }

  /** GET /repos/{o}/{r}/stargazers */
  async listStargazers(
    params: { per_page?: number; page?: number } = {},
  ): Promise<GithubUser[]> {
    return this.get<GithubUser[]>(
      `/repos/${this.requireRepo()}/stargazers${this.qs({ ...params })}`,
    );
  }

  /** GET /repos/{o}/{r}/forks */
  async listForks(params: ListForksParams = {}): Promise<GithubRepo[]> {
    return this.get<GithubRepo[]>(
      `/repos/${this.requireRepo()}/forks${this.qs({ ...params })}`,
    );
  }

  /** POST /repos/{o}/{r}/forks:创建 fork。organization 指定 fork 到某 org。 */
  async createFork(params: CreateForkParams = {}): Promise<GithubRepo> {
    return this.post<GithubRepo>(`/repos/${this.requireRepo()}/forks`, {
      organization: params.organization,
      name: params.name,
      default_branch_only: params.default_branch_only,
    });
  }

  /** GET /repos/{o}/{r}/collaborators */
  async listRepoCollaborators(params: ListCollaboratorsParams = {}): Promise<GithubUser[]> {
    return this.get<GithubUser[]>(
      `/repos/${this.requireRepo()}/collaborators${this.qs({ ...params })}`,
    );
  }

  /** GET /repos/{o}/{r}/hooks */
  async listRepoHooks(): Promise<GithubHook[]> {
    return this.get<GithubHook[]>(`/repos/${this.requireRepo()}/hooks?per_page=100`);
  }

  /**
   * GET /repos/{o}/{r}/branches/{branch}/protection。分支未开启保护时 GitHub
   * 返回 404,由 client 抛 GithubApiError(status=404),caller 应映射为 NOT_FOUND。
   */
  async getBranchProtection(branch: string): Promise<GithubBranchProtection> {
    return this.get<GithubBranchProtection>(
      `/repos/${this.requireRepo()}/branches/${encodeURIComponent(branch)}/protection`,
    );
  }

  // ── Contents: create / update / delete ──────────────────────────────────

  /**
   * PUT /repos/{o}/{r}/contents/{path}:创建或更新单个文件。sha 存在时是 update,
   * 不存在时是 create。content 必须已 base64 编码。
   */
  async createOrUpdateFileContents(
    path: string,
    params: CreateOrUpdateFileContentsParams,
  ): Promise<GithubFileCommitResult> {
    const encPath = path.split('/').map(encodeURIComponent).join('/');
    return this.put<GithubFileCommitResult>(
      `/repos/${this.requireRepo()}/contents/${encPath}`,
      {
        message: params.message,
        content: params.content,
        sha: params.sha,
        branch: params.branch,
        committer: params.committer,
        author: params.author,
      },
    );
  }

  /** DELETE /repos/{o}/{r}/contents/{path}:删除单个文件(必须传当前 blob sha)。 */
  async deleteFile(path: string, params: DeleteFileParams): Promise<GithubFileCommitResult> {
    const encPath = path.split('/').map(encodeURIComponent).join('/');
    return this.request<GithubFileCommitResult>(
      'DELETE',
      `/repos/${this.requireRepo()}/contents/${encPath}`,
      {
        message: params.message,
        sha: params.sha,
        branch: params.branch,
        committer: params.committer,
        author: params.author,
      },
    );
  }

  // ── Orgs / Teams / Gists ────────────────────────────────────────────────

  /** GET /orgs/{org}/members */
  async listOrgMembers(org: string, params: ListOrgMembersParams = {}): Promise<GithubUser[]> {
    return this.get<GithubUser[]>(
      `/orgs/${encodeURIComponent(org)}/members${this.qs({ ...params })}`,
    );
  }

  /** GET /orgs/{org}/teams */
  async listOrgTeams(
    org: string,
    params: { per_page?: number; page?: number } = {},
  ): Promise<GithubTeam[]> {
    return this.get<GithubTeam[]>(
      `/orgs/${encodeURIComponent(org)}/teams${this.qs({ ...params })}`,
    );
  }

  /** GET /orgs/{org}/teams/{team_slug}/members */
  async listTeamMembers(
    org: string,
    teamSlug: string,
    params: { per_page?: number; page?: number } = {},
  ): Promise<GithubUser[]> {
    return this.get<GithubUser[]>(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/members${this.qs({ ...params })}`,
    );
  }

  /** GET /orgs/{org}/teams/{team_slug}/repos */
  async listTeamRepos(
    org: string,
    teamSlug: string,
    params: { per_page?: number; page?: number } = {},
  ): Promise<GithubRepo[]> {
    return this.get<GithubRepo[]>(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/repos${this.qs({ ...params })}`,
    );
  }

  /** GET /gists:当前用户的 gist(user-scope)。 */
  async listGists(params: ListGistsParams = {}): Promise<GithubGist[]> {
    return this.get<GithubGist[]>(`/gists${this.qs({ ...params })}`);
  }

  /** GET /gists/{id} */
  async getGist(id: string): Promise<GithubGist> {
    return this.get<GithubGist>(`/gists/${encodeURIComponent(id)}`);
  }

  // ── Pull Request reviews (pending workflow / dismiss / branch update) ───

  /**
   * 创建 pending review(body 不带 event 字段;GitHub 返回 state=PENDING 的 review)。
   * 与 createPullRequestReview 的差异:后者要求 event ∈ APPROVE/REQUEST_CHANGES/COMMENT
   * 且会立即 submit;这里刻意把 event 省掉,让 review 停留在 pending 状态,方便后续
   * 通过 addPendingPullRequestReviewComment 追加 inline comment,再一次性 submit。
   * Create a pending review (no `event` in body → state=PENDING). Use with
   * addPendingPullRequestReviewComment + submitPendingPullRequestReview.
   */
  async createPendingPullRequestReview(
    prNumber: number,
    params: { body?: string; commit_id?: string } = {},
  ): Promise<GithubPullReview> {
    return this.post<GithubPullReview>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/reviews`,
      {
        body: params.body,
        commit_id: params.commit_id,
      },
    );
  }

  /**
   * 往指定 pending review 追加 inline comment。
   *
   * ⚠️ 不能复用 POST /pulls/{n}/comments —— 那个端点会**立即发布**一条独立
   * review comment,而不是挂到当前 pending review 里。GitHub REST 只在初始
   * POST /pulls/{n}/reviews 的 body.comments 数组里接受 pending 内联评论,
   * 后续追加必须走 GraphQL 的 addPullRequestReviewThread mutation。
   *
   * 需要的 reviewNodeId 是 create pending review 响应里的 node_id
   * (`PRR_...` 前缀),不是 REST 数字 id。
   *
   * Add an inline comment to an existing pending review via GraphQL
   * addPullRequestReviewThread. reviewNodeId must be the node id returned by
   * createPendingPullRequestReview (its `node_id` field), not the numeric id.
   */
  async addPendingPullRequestReviewComment(
    reviewNodeId: string,
    params: {
      body: string;
      path: string;
      line: number;
      side?: 'LEFT' | 'RIGHT';
      startLine?: number;
      startSide?: 'LEFT' | 'RIGHT';
      subjectType?: 'LINE' | 'FILE';
    },
  ): Promise<{ threadId: string; commentId: string; databaseId: number | null }> {
    const input: Record<string, unknown> = {
      pullRequestReviewId: reviewNodeId,
      body: params.body,
      path: params.path,
      line: params.line,
    };
    if (params.side) input.side = params.side;
    if (params.startLine !== undefined) input.startLine = params.startLine;
    if (params.startSide) input.startSide = params.startSide;
    if (params.subjectType) input.subjectType = params.subjectType;
    const res = await this.graphql<{
      addPullRequestReviewThread: {
        thread: {
          id: string;
          comments: { nodes: Array<{ id: string; databaseId: number | null }> };
        };
      };
    }>(
      `mutation AddPendingReviewThread($input: AddPullRequestReviewThreadInput!) {
         addPullRequestReviewThread(input: $input) {
           thread { id comments(first: 1) { nodes { id databaseId } } }
         }
       }`,
      { input },
    );
    const t = res.addPullRequestReviewThread.thread;
    const c = t.comments.nodes[0];
    return { threadId: t.id, commentId: c?.id ?? '', databaseId: c?.databaseId ?? null };
  }

  /**
   * 提交一条 pending review:POST /pulls/{n}/reviews/{review_id}/events。
   * event 取值 APPROVE / REQUEST_CHANGES / COMMENT。
   * Submit a pending review with an approval verdict.
   */
  async submitPendingPullRequestReview(
    prNumber: number,
    reviewId: number,
    params: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string },
  ): Promise<GithubPullReview> {
    return this.post<GithubPullReview>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/reviews/${reviewId}/events`,
      { event: params.event, body: params.body },
    );
  }

  /**
   * 删除一条 pending review(未 submit 前可用)。
   * Delete a pending pull request review.
   */
  async deletePendingPullRequestReview(
    prNumber: number,
    reviewId: number,
  ): Promise<GithubPullReview> {
    return this.request<GithubPullReview>(
      'DELETE',
      `/repos/${this.requireRepo()}/pulls/${prNumber}/reviews/${reviewId}`,
    );
  }

  /**
   * dismiss 一条已提交的 review(PUT /reviews/{id}/dismissals)。
   * Dismiss a submitted pull request review.
   */
  async dismissPullRequestReview(
    prNumber: number,
    reviewId: number,
    params: { message: string; event?: 'DISMISS' },
  ): Promise<GithubPullReview> {
    return this.put<GithubPullReview>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/reviews/${reviewId}/dismissals`,
      { message: params.message, event: params.event ?? 'DISMISS' },
    );
  }

  /**
   * resolveReviewThread mutation(GraphQL-only)。thread_id 是 PRRT_... 节点 id。
   * Resolve a PR review thread via GraphQL.
   */
  async resolveReviewThread(threadId: string): Promise<{ thread: { id: string; isResolved: boolean } }> {
    const query = `mutation($threadId: ID!) {
      resolveReviewThread(input: {threadId: $threadId}) {
        thread { id isResolved }
      }
    }`;
    const data = await this.graphql<{ resolveReviewThread: { thread: { id: string; isResolved: boolean } } }>(
      query,
      { threadId },
    );
    return data.resolveReviewThread;
  }

  /**
   * unresolveReviewThread mutation(GraphQL-only)。
   * Unresolve a PR review thread via GraphQL.
   */
  async unresolveReviewThread(threadId: string): Promise<{ thread: { id: string; isResolved: boolean } }> {
    const query = `mutation($threadId: ID!) {
      unresolveReviewThread(input: {threadId: $threadId}) {
        thread { id isResolved }
      }
    }`;
    const data = await this.graphql<{ unresolveReviewThread: { thread: { id: string; isResolved: boolean } } }>(
      query,
      { threadId },
    );
    return data.unresolveReviewThread;
  }

  /**
   * listPullRequestReviewThreads query(GraphQL-only)。REST 不暴露 thread id,
   * 只能通过 GraphQL 拿到 PRRT_... 节点 id,供 resolveReviewThread / unresolveReviewThread 消费。
   *
   * 单页拉取(默认每页 50,GraphQL 上限 100)。PR 的 review thread 多于一页时,
   * 调用方读返回的 `pageInfo`:`hasNextPage` 为 true 时把 `endCursor` 作为 `after`
   * 再次调用继续翻页,直到 `hasNextPage` 为 false —— 保证靠后的 thread 也能拿到 id。
   *
   * 每个 thread 返回完整会话(comments 最多 50 条,含 databaseId 供与 REST 评论关联)
   * 及代码位置(path / line),避免调用方只看到首条评论就 resolve、漏掉后续未处理的追评。
   * commentsTruncated 为 true 时说明该 thread 评论超过 50 条被截断。
   *
   * List one page of PR review threads via GraphQL. When hasNextPage is true,
   * pass endCursor back as `after` to fetch the next page. Each thread includes
   * its full conversation (up to 50 comments, with databaseId for REST joins)
   * plus code location (path / line).
   */
  async listPullRequestReviewThreads(
    prNumber: number,
    params: { first?: number; after?: string } = {},
  ): Promise<{
    threads: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string | null;
      line: number | null;
      commentsTruncated: boolean;
      comments: Array<{
        id: number | null;
        body: string;
        author: { login: string } | null;
        createdAt: string;
      }>;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }> {
    // GraphQL 需要 owner / repo 作为独立变量;REST 的 repoPath 是编码后的合并形式,
    // 不能直接复用。client 未配置 owner/repo 时 fail-fast,与 requireRepo() 语义一致。
    if (!this.owner || !this.repo) {
      throw new Error(
        'GithubClient: owner and repo are required for repo-scoped calls',
      );
    }
    const { first = 50, after } = params;
    // 每个 thread 拉取的评论上限。绝大多数 review thread 远不到 50 条;超过则置
    // commentsTruncated 提示调用方还有更多追评,不要仅凭已见评论就 resolve。
    const COMMENTS_PER_THREAD = 50;
    const query = `query($owner: String!, $repo: String!, $prNumber: Int!, $first: Int!, $after: String, $comments: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first: $comments) {
                totalCount
                nodes {
                  databaseId
                  body
                  createdAt
                  author { login }
                }
              }
            }
          }
        }
      }
    }`;
    const data = await this.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              id: string;
              isResolved: boolean;
              isOutdated: boolean;
              path: string | null;
              line: number | null;
              comments: {
                totalCount: number;
                nodes: Array<{
                  databaseId: number | null;
                  body: string;
                  createdAt: string;
                  author: { login: string } | null;
                }>;
              };
            }>;
          };
        } | null;
      };
    }>(query, {
      owner: this.owner,
      repo: this.repo,
      prNumber,
      first,
      after: after ?? null,
      comments: COMMENTS_PER_THREAD,
    });
    // GitHub GraphQL 对不存在的 PR 编号返回 pullRequest: null(而非 error),
    // 直接访问 .reviewThreads 会抛裸 TypeError。抛 GithubApiError(status=404),
    // 与 REST 404 同路径,让上层 toolCatch 统一映射成 NOT_FOUND(而非 GITHUB_API_ERROR)。
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      throw new GithubApiError(
        `PR #${prNumber} not found in ${this.owner}/${this.repo}`,
        404,
      );
    }
    const reviewThreads = pullRequest.reviewThreads;
    return {
      threads: reviewThreads.nodes.map((n) => ({
        id: n.id,
        isResolved: n.isResolved,
        isOutdated: n.isOutdated,
        path: n.path,
        line: n.line,
        commentsTruncated: n.comments.totalCount > n.comments.nodes.length,
        comments: n.comments.nodes.map((c) => ({
          id: c.databaseId,
          body: c.body,
          author: c.author,
          createdAt: c.createdAt,
        })),
      })),
      pageInfo: reviewThreads.pageInfo,
    };
  }

  /**
   * 更新 PR 分支(把 base 上的最新 commit 合到 PR head)。返回 202 + 异步消息。
   * Update the PR branch (merge latest base into head). 202 Accepted.
   */
  async updatePullRequestBranch(
    prNumber: number,
    params: { expected_head_sha?: string } = {},
  ): Promise<{ message?: string; url?: string } | undefined> {
    return this.put<{ message?: string; url?: string } | undefined>(
      `/repos/${this.requireRepo()}/pulls/${prNumber}/update-branch`,
      { expected_head_sha: params.expected_head_sha },
    );
  }

  /**
   * 请求 Copilot 帮 review 一条 PR —— 本质是往 requested_reviewers 里加固定的
   * bot 用户名 `copilot-pull-request-reviewer[bot]`。封装成单独方法是为了让
   * caller 不用记 magic name。
   * Request a Copilot review by adding the copilot bot to requested reviewers.
   */
  async requestCopilotReview(prNumber: number): Promise<GithubPullRequest> {
    return this.requestPullRequestReviewers(prNumber, {
      reviewers: ['copilot-pull-request-reviewer[bot]'],
    });
  }

  // ── Git Data (refs / trees / commits / push_files) ───────────────────────

  /**
   * GET /repos/{o}/{r}/git/ref/{ref}。ref 形如 `heads/main` 或 `tags/v1.0`,
   * 不带 `refs/` 前缀(GitHub 会自动补)。
   * Get a single git ref (heads/<branch> or tags/<tag>).
   */
  async getRef(ref: string): Promise<GithubGitRef> {
    // ref 里的 '/' 是路径分隔符不能整体 encode,按段 encode 每一段
    const encoded = ref.split('/').map(encodeURIComponent).join('/');
    return this.get<GithubGitRef>(`/repos/${this.requireRepo()}/git/ref/${encoded}`);
  }

  /**
   * POST /repos/{o}/{r}/git/refs。ref 必须是完整的 `refs/heads/<name>` 或
   * `refs/tags/<name>`。这是最原始的 create_ref 端点。
   * Create a raw git ref (branch or tag).
   */
  async createRef(params: CreateRefParams): Promise<GithubGitRef> {
    return this.post<GithubGitRef>(
      `/repos/${this.requireRepo()}/git/refs`,
      { ref: params.ref, sha: params.sha },
    );
  }

  /**
   * 便捷方法:基于 base sha 创建新分支(封装 create_ref 的 refs/heads/ 前缀)。
   * Convenience: create a new branch from a base commit sha.
   */
  async createBranch(branch: string, fromSha: string): Promise<GithubGitRef> {
    return this.createRef({ ref: `refs/heads/${branch}`, sha: fromSha });
  }

  /**
   * GET /repos/{o}/{r}/git/trees/{tree_sha}?recursive=1。recursive=true 时把
   * 整个子树一次拉回。truncated=true 说明 GitHub 服务端截断了(> 100k entries)。
   * Get a git tree (recursive=true walks the whole subtree).
   */
  async getTree(treeSha: string, recursive: boolean = false): Promise<GithubGitTree> {
    return this.get<GithubGitTree>(
      `/repos/${this.requireRepo()}/git/trees/${encodeURIComponent(treeSha)}${this.qs({
        recursive: recursive ? 1 : undefined,
      })}`,
    );
  }

  /**
   * POST /repos/{o}/{r}/git/trees。tree entry 里 content(内联 UTF-8)与 sha
   * (指向已存在的 blob)二选一。base_tree 指定基础树 → 增量补丁,不然只包含
   * 传入的这些 entry。
   * Create a git tree (with base_tree for incremental patches).
   */
  async createTree(params: CreateTreeParams): Promise<GithubGitTree> {
    return this.post<GithubGitTree>(
      `/repos/${this.requireRepo()}/git/trees`,
      { tree: params.tree, base_tree: params.base_tree },
    );
  }

  /**
   * POST /repos/{o}/{r}/git/commits。parents 用父 commit sha 数组;merge commit
   * 有 2 个 parent,普通 commit 有 1 个,root commit 传 []。
   * Create a git commit object.
   */
  async createCommit(params: CreateCommitParams): Promise<GithubGitCommit> {
    return this.post<GithubGitCommit>(
      `/repos/${this.requireRepo()}/git/commits`,
      {
        message: params.message,
        tree: params.tree,
        parents: params.parents,
        author: params.author,
        committer: params.committer,
      },
    );
  }

  /**
   * PATCH /repos/{o}/{r}/git/refs/{ref}。ref 传 `heads/<branch>` 或
   * `tags/<name>`(不带 refs/ 前缀)。force=true 时允许非 fast-forward。
   * Update a git ref to point at a new sha.
   */
  async updateRef(
    ref: string,
    sha: string,
    force: boolean = false,
  ): Promise<GithubGitRef> {
    const encoded = ref.split('/').map(encodeURIComponent).join('/');
    return this.patch<GithubGitRef>(
      `/repos/${this.requireRepo()}/git/refs/${encoded}`,
      { sha, force },
    );
  }

  /**
   * POST /repos/{o}/{r}/git/blobs。多用于 push_files 的 base64 分支。
   * Create a blob object. Returns { sha, url }.
   */
  async createBlob(
    content: string,
    encoding: 'utf-8' | 'base64' = 'utf-8',
  ): Promise<{ sha: string; url: string }> {
    return this.post<{ sha: string; url: string }>(
      `/repos/${this.requireRepo()}/git/blobs`,
      { content, encoding },
    );
  }

  /**
   * 一次原子提交多文件:tree/commit/ref 三步走。
   *   1. getRef('heads/<branch>') 拿当前 head sha
   *   2. 拿 head commit 的 tree sha 作 base_tree
   *   3. 对 utf-8 文件走 tree entry 的内联 content;对 base64 文件先 createBlob
   *      再引用 blob sha
   *   4. createTree({ base_tree, tree: entries })
   *   5. createCommit({ message, tree, parents:[headSha] })
   *   6. updateRef('heads/<branch>', newCommitSha) — force=false,保持 fast-forward
   * Atomically push multiple files as a single commit on a branch.
   */
  async pushFiles(params: PushFilesParams): Promise<PushFilesResult> {
    const { branch, message, files } = params;
    if (files.length === 0) {
      throw new Error('pushFiles: files must be non-empty');
    }
    // Step 1: current head
    const headRef = await this.getRef(`heads/${branch}`);
    const headSha = headRef.object.sha;
    // Step 2: base tree sha —— 从 head commit 拿 tree.sha
    const headCommit = await this.get<GithubGitCommit>(
      `/repos/${this.requireRepo()}/git/commits/${encodeURIComponent(headSha)}`,
    );
    const baseTreeSha = headCommit.tree.sha;

    // Step 3: 构造 tree entries;base64 走 blob upload,utf-8 走内联 content。
    const treeEntries: GithubGitTreeItem[] = [];
    for (const f of files) {
      const enc = f.encoding ?? 'utf-8';
      if (enc === 'base64') {
        const blob = await this.createBlob(f.content, 'base64');
        treeEntries.push({
          path: f.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        });
      } else {
        treeEntries.push({
          path: f.path,
          mode: '100644',
          type: 'blob',
          content: f.content,
        });
      }
    }

    // Step 4-5: tree + commit
    const newTree = await this.createTree({ base_tree: baseTreeSha, tree: treeEntries });
    const newCommit = await this.createCommit({
      message,
      tree: newTree.sha,
      parents: [headSha],
    });

    // Step 6: ref update(fast-forward only,不 force)
    await this.updateRef(`heads/${branch}`, newCommit.sha, false);

    return {
      commit_sha: newCommit.sha,
      tree_sha: newTree.sha,
      ref_updated: true,
      files_pushed: files.length,
    };
  }

  // ── Reactions ────────────────────────────────────────────────────────────

  /**
   * GET /repos/{o}/{r}/issues/{n}/reactions。可选 content filter。
   * List reactions on an issue.
   */
  async listIssueReactions(
    issueNumber: number,
    params: { content?: GithubReactionContent; per_page?: number; page?: number } = {},
  ): Promise<GithubReaction[]> {
    return this.get<GithubReaction[]>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}/reactions${this.qs({ ...params })}`,
    );
  }

  /**
   * POST /repos/{o}/{r}/issues/{n}/reactions。已存在同 content 时 GitHub 返回 200
   * (不重复创建),否则 201。
   * Add a reaction to an issue.
   */
  async addIssueReaction(
    issueNumber: number,
    params: AddReactionParams,
  ): Promise<GithubReaction> {
    return this.post<GithubReaction>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}/reactions`,
      { content: params.content },
    );
  }

  /**
   * GET /repos/{o}/{r}/issues/comments/{comment_id}/reactions。
   * List reactions on an issue comment.
   */
  async listIssueCommentReactions(
    commentId: number,
    params: { content?: GithubReactionContent; per_page?: number; page?: number } = {},
  ): Promise<GithubReaction[]> {
    return this.get<GithubReaction[]>(
      `/repos/${this.requireRepo()}/issues/comments/${commentId}/reactions${this.qs({ ...params })}`,
    );
  }

  /**
   * POST /repos/{o}/{r}/issues/comments/{comment_id}/reactions。
   * Add a reaction to an issue comment.
   */
  async addIssueCommentReaction(
    commentId: number,
    params: AddReactionParams,
  ): Promise<GithubReaction> {
    return this.post<GithubReaction>(
      `/repos/${this.requireRepo()}/issues/comments/${commentId}/reactions`,
      { content: params.content },
    );
  }

  /**
   * GET /repos/{o}/{r}/pulls/comments/{comment_id}/reactions。
   * List reactions on a PR inline review comment.
   */
  async listPullRequestReviewCommentReactions(
    commentId: number,
    params: { content?: GithubReactionContent; per_page?: number; page?: number } = {},
  ): Promise<GithubReaction[]> {
    return this.get<GithubReaction[]>(
      `/repos/${this.requireRepo()}/pulls/comments/${commentId}/reactions${this.qs({ ...params })}`,
    );
  }

  /**
   * POST /repos/{o}/{r}/pulls/comments/{comment_id}/reactions。
   * Add a reaction to a PR inline review comment.
   */
  async addPullRequestReviewCommentReaction(
    commentId: number,
    params: AddReactionParams,
  ): Promise<GithubReaction> {
    return this.post<GithubReaction>(
      `/repos/${this.requireRepo()}/pulls/comments/${commentId}/reactions`,
      { content: params.content },
    );
  }

  // ── Small writes / gets (create_repo, get_label, get_tag, releases) ─────

  /**
   * 创建仓库。传 org → POST /orgs/{org}/repos;不传 → POST /user/repos。
   * Create a new repository (org-owned when `org` is set, else user-owned).
   */
  async createRepository(params: CreateRepositoryParams): Promise<GithubRepo> {
    const { org, ...body } = params;
    const path = org
      ? `/orgs/${encodeURIComponent(org)}/repos`
      : '/user/repos';
    return this.post<GithubRepo>(path, body);
  }

  /**
   * GET /repos/{o}/{r}/labels/{name}。404 → 该 label 不存在。
   * Get a single label by name.
   */
  async getLabel(name: string): Promise<GithubLabel> {
    return this.get<GithubLabel>(
      `/repos/${this.requireRepo()}/labels/${encodeURIComponent(name)}`,
    );
  }

  /**
   * GET /repos/{o}/{r}/git/ref/tags/{tag}(GitHub 单数 endpoint 是 `git/ref/`;
   * 复数 `git/refs/` 是列表/更新/删除,单条 GET 会 404)。返回 ref(其 object.sha
   * 指向 commit 或 annotated tag object)。annotated tag 需要再 fetch git/tags/
   * {sha} 拿元数据,这里返 ref 已能满足绝大多数场景。
   * Get a tag ref by name (delegates to getRef which uses the correct
   * singular `/git/ref/` endpoint).
   */
  async getTag(tag: string): Promise<GithubGitRef> {
    return this.getRef(`tags/${tag}`);
  }

  /**
   * GET /repos/{o}/{r}/releases/latest。
   * Get the latest published release.
   */
  async getLatestRelease(): Promise<GithubRelease> {
    return this.get<GithubRelease>(
      `/repos/${this.requireRepo()}/releases/latest`,
    );
  }

  /**
   * GET /repos/{o}/{r}/releases/{id}/assets。
   * List assets attached to a release.
   */
  async listReleaseAssets(
    releaseId: number,
    params: { per_page?: number; page?: number } = {},
  ): Promise<GithubReleaseAsset[]> {
    return this.get<GithubReleaseAsset[]>(
      `/repos/${this.requireRepo()}/releases/${releaseId}/assets${this.qs({ ...params })}`,
    );
  }

  // ── Sub-issues (2024 feature) ────────────────────────────────────────────

  /**
   * GET /repos/{o}/{r}/issues/{n}/sub_issues。
   * List sub-issues attached to a parent issue.
   */
  async listSubIssues(
    issueNumber: number,
    params: { per_page?: number; page?: number } = {},
  ): Promise<GithubIssue[]> {
    return this.get<GithubIssue[]>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}/sub_issues${this.qs({ ...params })}`,
    );
  }

  /**
   * POST /repos/{o}/{r}/issues/{n}/sub_issues。sub_issue_id 是 child 的**全局
   * issue id**(不是 number-in-repo,GitHub API 特意要求这个)。
   * Attach a sub-issue by global issue id (not number-in-repo).
   */
  async addSubIssue(
    issueNumber: number,
    params: AddSubIssueParams,
  ): Promise<GithubIssue> {
    return this.post<GithubIssue>(
      `/repos/${this.requireRepo()}/issues/${issueNumber}/sub_issues`,
      { sub_issue_id: params.sub_issue_id, replace_parent: params.replace_parent },
    );
  }

  // ── HTTP 基础方法 ────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  private async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    // 认证请求禁止自动跟随跨 host 重定向:Authorization token 绝不重放到另一个 host。
    const res = await fetchWithSafeRedirect(url, init);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GithubApiError(
        `GitHub ${method} ${path} failed: ${res.status}`,
        res.status,
        text,
      );
    }

    // 空 body 的成功响应:除了 204 No Content,GitHub 还会用
    //   201 Created(workflow rerun / repo fork 等)
    //   202 Accepted(workflow cancel、异步任务已入队)
    //   205 Reset Content(notification mark-read)
    // 这些 case 下 res.json() 会抛 SyntaxError,让上层误报 API 失败。
    // 用 Content-Length: 0 或空 body 直接短路,不去解析 JSON。
    if (res.status === 204 || res.status === 205) return undefined as T;
    const contentLength = res.headers.get('content-length');
    if (contentLength === '0') return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  /**
   * 只跟一次的重定向请求(redirect: 'manual')。GitHub 的 artifact zip /
   * workflow run logs 会 302 到一个短时效的 S3 签名 URL,不适合 fetch 自动跟
   * (会把 auth header 带到 S3 上),这里返 Location 让调用方自己下载。
   * 未拿到 Location(非 3xx 或缺 header)时返 null。
   */
  private async requestRedirectUrl(method: string, path: string): Promise<string | null> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    // 3xx 是预期路径;location 由 GitHub 填充。
    if (res.status >= 300 && res.status < 400) {
      return res.headers.get('Location');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GithubApiError(
        `GitHub ${method} ${path} failed: ${res.status}`,
        res.status,
        text,
      );
    }
    return null;
  }
}
