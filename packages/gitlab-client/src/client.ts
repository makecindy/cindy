/**
 * GitLab REST API v4 客户端。
 *
 * 零外部依赖 — 仅使用全局 fetch(Node 18+ / Electron 28+)。
 * 所有方法均可在 main 进程直接调用。
 */

import type {
  GitlabClientConfig,
  GitlabIssue,
  GitlabNote,
  GitlabMergeRequest,
  GitlabLabel,
  GitlabBranch,
  GitlabUser,
  GitlabEvent,
  GitlabCommit,
  GitlabCommitDiff,
  GitlabProject,
  GitlabPipeline,
  GitlabJob,
  GitlabTreeItem,
  GitlabTag,
  GitlabCompareResult,
  GitlabMergeRequestChanges,
  ListIssuesParams,
  CreateIssueParams,
  UpdateIssueParams,
  CreateMergeRequestParams,
  ListMergeRequestsParams,
  ListCommitsParams,
  ListEventsParams,
  SearchParams,
  ListProjectsParams,
  ListPipelinesParams,
  CompareRefsParams,
  ListTagsParams,
  MergeMergeRequestParams,
  ListGroupProjectsParams,
  GitlabMilestone,
  GitlabMember,
  GitlabProjectHook,
  GitlabProjectVariable,
  GitlabEnvironment,
  GitlabDeployment,
  GitlabPipelineSchedule,
  GitlabDiscussion,
  GitlabMergeRequestApprovals,
  GitlabProtectedBranch,
  GitlabWikiPage,
  GitlabSnippet,
  GitlabRelease,
  GitlabFileCommitResult,
  GitlabRepositoryArchiveDescriptor,
  CreateOrUpdateFileParams,
  DeleteFileParams,
  UpdateMergeRequestParams,
  CreateMergeRequestDiscussionParams,
  ListMilestonesParams,
  ListMembersParams,
  ListEnvironmentsParams,
  ListDeploymentsParams,
  ListReleasesParams,
  ForkProjectParams,
  ListGroupIssuesParams,
  ListGroupMergeRequestsParams,
  GitlabDraftNote,
  CreateDraftNoteParams,
  UpdateDraftNoteParams,
  CommitActionsParams,
  GitlabRepositoryCommit,
  CreateBranchParams,
  CreateTagParams,
  GitlabRepoTag,
  CreateProjectParams,
  GitlabIssueLink,
  CreateIssueLinkParams,
  GitlabAwardEmoji,
  GitlabProjectUpload,
} from './types.js';
import { GitlabApiError } from './types.js';
import { assertSafeBaseUrl, fetchWithSafeRedirect } from './http-safety.js';

// 去尾部斜杠。不用 /\/+$/ 正则——超长 '/' 串上会 O(n²) 回溯(CodeQL js/polynomial-redos)。
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return s.slice(0, end);
}

export class GitlabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  /** URL-encoded projectPath, or null when the client is constructed without one
   * (cross-project / user-scope calls). Project-scoped methods route through
   * {@link requireProject} which throws a clear error in that case. */
  private readonly projectId: string | null;

  constructor(config: GitlabClientConfig) {
    this.baseUrl = trimTrailingSlashes(config.baseUrl);
    // GitLab 自建实例惯例允许 http(源自已退役的 shared/connectorUrl.ts「沿用输入协议」惯例,该模块已随 lizi_gitlab 于 2026-07-14 退役删除),
    // 故 allowInsecureHttp: true;仍拒绝非 http(s) 协议 / userinfo / 不可解析的 baseUrl。
    assertSafeBaseUrl(this.baseUrl, { allowInsecureHttp: true });
    this.token = config.token;
    this.projectId = config.projectPath
      ? encodeURIComponent(config.projectPath)
      : null;
  }

  /** Return the encoded project id or fail fast when the caller invoked a
   * project-scoped endpoint without configuring projectPath. */
  private requireProject(): string {
    if (!this.projectId) {
      throw new Error(
        'GitlabClient: projectPath is required for project-scoped calls',
      );
    }
    return this.projectId;
  }

  private qs(
    params: Record<string, string | number | boolean | ReadonlyArray<string | number> | undefined>,
  ): string {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      // GitLab 侧数组参数(如 approved_by_usernames[]) 要求 `k[]=a&k[]=b` 形式,
      // 不能 join 成 `k=a,b`。key 已带 `[]` 就照原样多次 append;否则自动加。
      if (Array.isArray(v)) {
        if (v.length === 0) continue;
        const arrayKey = k.endsWith('[]') ? k : `${k}[]`;
        for (const item of v) {
          if (item === undefined || item === null || item === '') continue;
          usp.append(arrayKey, String(item));
        }
        continue;
      }
      usp.set(k, String(v));
    }
    const s = usp.toString();
    return s ? `?${s}` : '';
  }

  // ── Issues ───────────────────────────────────────────────────────────────

  async listIssues(params: ListIssuesParams = {}): Promise<GitlabIssue[]> {
    return this.get<GitlabIssue[]>(
      `/projects/${this.requireProject()}/issues${this.qs({ ...params })}`,
    );
  }

  async getIssue(iid: number): Promise<GitlabIssue> {
    return this.get<GitlabIssue>(`/projects/${this.requireProject()}/issues/${iid}`);
  }

  async getIssueComments(iid: number): Promise<GitlabNote[]> {
    const notes = await this.get<GitlabNote[]>(
      `/projects/${this.requireProject()}/issues/${iid}/notes?sort=asc&per_page=100`,
    );
    return notes.filter((n) => !n.system);
  }

  async addIssueComment(iid: number, body: string): Promise<GitlabNote> {
    return this.post<GitlabNote>(
      `/projects/${this.requireProject()}/issues/${iid}/notes`,
      { body },
    );
  }

  /** 增删 issue label(GitLab PUT /issues/:iid 支持 add_labels / remove_labels) */
  async updateIssueLabels(
    iid: number,
    addLabels: string[],
    removeLabels: string[],
  ): Promise<GitlabIssue> {
    const payload: Record<string, string> = {};
    if (addLabels.length > 0) payload.add_labels = addLabels.join(',');
    if (removeLabels.length > 0) payload.remove_labels = removeLabels.join(',');
    return this.put<GitlabIssue>(
      `/projects/${this.requireProject()}/issues/${iid}`,
      payload,
    );
  }

  /** 新建 issue。labels 用 comma-separated string(GitLab 惯例)。 */
  async createIssue(params: CreateIssueParams): Promise<GitlabIssue> {
    return this.post<GitlabIssue>(`/projects/${this.requireProject()}/issues`, {
      title: params.title,
      description: params.description,
      labels: params.labels,
      assignee_ids: params.assignee_ids,
    });
  }

  /** 修改 issue(可传 state_event: 'close'/'reopen',或改 title / description / labels)。 */
  async updateIssue(iid: number, params: UpdateIssueParams): Promise<GitlabIssue> {
    return this.put<GitlabIssue>(
      `/projects/${this.requireProject()}/issues/${iid}`,
      {
        title: params.title,
        description: params.description,
        labels: params.labels,
        add_labels: params.add_labels,
        remove_labels: params.remove_labels,
        assignee_ids: params.assignee_ids,
        state_event: params.state_event,
      },
    );
  }

  // ── Merge Requests ───────────────────────────────────────────────────────

  async createMergeRequest(params: CreateMergeRequestParams): Promise<GitlabMergeRequest> {
    // GitLab REST 创建 MR 时不接受独立 draft 参数,只能靠 title 前缀 `Draft: ` 声明
    // (旧的 `WIP: ` 前缀也仍被服务端识别;若用户已带上就不重复补)。
    let title = params.title;
    if (params.draft && !/^(draft|wip):/i.test(title)) {
      title = `Draft: ${title}`;
    }
    return this.post<GitlabMergeRequest>(
      `/projects/${this.requireProject()}/merge_requests`,
      {
        source_branch: params.sourceBranch,
        target_branch: params.targetBranch,
        title,
        description: params.description,
      },
    );
  }

  async listMergeRequests(params: ListMergeRequestsParams = {}): Promise<GitlabMergeRequest[]> {
    return this.get<GitlabMergeRequest[]>(
      `/projects/${this.requireProject()}/merge_requests${this.qs({ ...params })}`,
    );
  }

  async getMergeRequest(iid: number): Promise<GitlabMergeRequest> {
    return this.get<GitlabMergeRequest>(
      `/projects/${this.requireProject()}/merge_requests/${iid}`,
    );
  }

  async getMergeRequestComments(iid: number): Promise<GitlabNote[]> {
    const notes = await this.get<GitlabNote[]>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/notes?sort=asc&per_page=100`,
    );
    return notes.filter((n) => !n.system);
  }

  async addMergeRequestComment(iid: number, body: string): Promise<GitlabNote> {
    return this.post<GitlabNote>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/notes`,
      { body },
    );
  }

  /** MR 关联的 commit 列表(按顺序,类似 GitHub PR commits)。 */
  async listMergeRequestCommits(
    iid: number,
    params: { per_page?: number; page?: number } = {},
  ): Promise<GitlabCommit[]> {
    return this.get<GitlabCommit[]>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/commits${this.qs({ ...params })}`,
    );
  }

  /** MR 的 per-file diff(类似 GitHub PR files,附带 MR 元信息)。 */
  async listMergeRequestChanges(iid: number): Promise<GitlabMergeRequestChanges> {
    return this.get<GitlabMergeRequestChanges>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/changes`,
    );
  }

  /** 合并 MR。sha 传了后会校验 head SHA,防止并发 push 后误合。 */
  async mergeMergeRequest(
    iid: number,
    params: MergeMergeRequestParams = {},
  ): Promise<GitlabMergeRequest> {
    return this.put<GitlabMergeRequest>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/merge`,
      {
        merge_commit_message: params.merge_commit_message,
        squash: params.squash,
        should_remove_source_branch: params.should_remove_source_branch,
        sha: params.sha,
      },
    );
  }

  /**
   * 跨 project 拉当前认证用户能看到的 MR。传 scope=all + author_username 可
   * 覆盖"用户在整个 instance 的 MR",work-collect 场景比逐 project 遍历高效。
   */
  async listMergeRequestsGlobally(
    params: ListMergeRequestsParams = {},
  ): Promise<GitlabMergeRequest[]> {
    return this.get<GitlabMergeRequest[]>(`/merge_requests${this.qs({ ...params })}`);
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  async listLabels(): Promise<GitlabLabel[]> {
    return this.get<GitlabLabel[]>(
      `/projects/${this.requireProject()}/labels?per_page=100`,
    );
  }

  async listBranches(): Promise<GitlabBranch[]> {
    return this.get<GitlabBranch[]>(
      `/projects/${this.requireProject()}/repository/branches?per_page=100`,
    );
  }

  async ensureLabels(names: string[]): Promise<void> {
    const existing = await this.listLabels();
    const existingNames = new Set(existing.map((l) => l.name));
    for (const name of names) {
      if (existingNames.has(name)) continue;
      try {
        await this.post(`/projects/${this.requireProject()}/labels`, {
          name,
          color: '#428BCA',
        });
      } catch (err) {
        if (err instanceof GitlabApiError && err.status === 409) continue;
        throw err;
      }
    }
  }

  // ── Repository ──────────────────────────────────────────────────────────

  /** 列出仓库某 ref 下的文件树。recursive=true 递归全仓;默认只列顶层。 */
  async listRepositoryTree(
    params: {
      path?: string;
      ref?: string;
      recursive?: boolean;
      per_page?: number;
      page?: number;
    } = {},
  ): Promise<GitlabTreeItem[]> {
    return this.get<GitlabTreeItem[]>(
      `/projects/${this.requireProject()}/repository/tree${this.qs({ ...params })}`,
    );
  }

  /**
   * 获取文件 raw 内容(bytes → utf-8 text)。ref 可以是 branch / tag / commit sha。
   * 二进制文件调用方自己 base64,这里默认返 utf-8 string。
   */
  async getFileRaw(path: string, ref?: string): Promise<string> {
    const encPath = encodeURIComponent(path);
    return this.requestRaw(
      'GET',
      `/projects/${this.requireProject()}/repository/files/${encPath}/raw${this.qs({ ref })}`,
    );
  }

  // ── Commits ─────────────────────────────────────────────────────────────

  async listCommits(params: ListCommitsParams = {}): Promise<GitlabCommit[]> {
    return this.get<GitlabCommit[]>(
      `/projects/${this.requireProject()}/repository/commits${this.qs({ ...params })}`,
    );
  }

  async getCommit(sha: string, params: { stats?: boolean } = {}): Promise<GitlabCommit> {
    return this.get<GitlabCommit>(
      `/projects/${this.requireProject()}/repository/commits/${sha}${this.qs({ ...params })}`,
    );
  }

  async getCommitDiff(sha: string): Promise<GitlabCommitDiff[]> {
    return this.get<GitlabCommitDiff[]>(
      `/projects/${this.requireProject()}/repository/commits/${sha}/diff`,
    );
  }

  /**
   * 比较两个 ref(branch / tag / sha)。straight=true 走 --straight 语义
   * (纯 diff,不合并 merge base);默认 false 走 ...merge-base... 语义。
   */
  async compareRefs(params: CompareRefsParams): Promise<GitlabCompareResult> {
    return this.get<GitlabCompareResult>(
      `/projects/${this.requireProject()}/repository/compare${this.qs({
        from: params.from,
        to: params.to,
        straight: params.straight,
      })}`,
    );
  }

  /** 列出仓库 tag(支持 search / order_by / sort)。 */
  async listTags(params: ListTagsParams = {}): Promise<GitlabTag[]> {
    return this.get<GitlabTag[]>(
      `/projects/${this.requireProject()}/repository/tags${this.qs({ ...params })}`,
    );
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** 认证用户的事件流(需 read_user / api scope)。 */
  async listEvents(params: ListEventsParams = {}): Promise<GitlabEvent[]> {
    return this.get<GitlabEvent[]>(`/events${this.qs({ ...params })}`);
  }

  /**
   * 指定用户的事件流(公开活动,不需要 admin 权限)。work-collect 关键接口:
   * 按 after / before 拿窗口内 push / issue / MR / comment 活动。
   *
   * ⚠️ GitLab 官方 `GET /users/:id/events` 的 `:id` 只接受**数字 user id**,
   * 传 username(如 `chenzhuyu`)会 404。所以这里如果传进来的是非数字字符串,
   * 先走 `/users?username=...` 解析成数字 id 再拼路径。数字 id 或数字字符串
   * 直接透传,不做额外查询。
   */
  async listUserEvents(
    userIdOrUsername: string | number,
    params: ListEventsParams = {},
  ): Promise<GitlabEvent[]> {
    let userId: string | number = userIdOrUsername;
    if (typeof userIdOrUsername === 'string' && !/^\d+$/.test(userIdOrUsername)) {
      const user = await this.getUserByUsername(userIdOrUsername);
      if (!user) {
        throw new GitlabApiError(
          `GitLab user not found: ${userIdOrUsername}`,
          404,
          `No user with username '${userIdOrUsername}' visible to the current token.`,
        );
      }
      userId = user.id;
    }
    return this.get<GitlabEvent[]>(
      `/users/${encodeURIComponent(String(userId))}/events${this.qs({ ...params })}`,
    );
  }

  /** 指定 project 的事件流。 */
  async listProjectEvents(params: ListEventsParams = {}): Promise<GitlabEvent[]> {
    return this.get<GitlabEvent[]>(
      `/projects/${this.requireProject()}/events${this.qs({ ...params })}`,
    );
  }

  // ── Search (cross-project) ──────────────────────────────────────────────

  /**
   * instance-wide 搜索。scope 可选 issues / merge_requests / commits / blobs /
   * users / projects / milestones / snippet_titles / wiki_blobs / notes。
   * 返回类型 union,调用方按 scope 分支消费。
   */
  async searchGlobally(params: SearchParams): Promise<unknown[]> {
    return this.get<unknown[]>(`/search${this.qs({ ...params })}`);
  }

  /**
   * project 内搜索(scope: issues / merge_requests / commits / blobs / notes /
   * milestones / users / wiki_blobs)。
   */
  async searchInProject(params: SearchParams): Promise<unknown[]> {
    return this.get<unknown[]>(
      `/projects/${this.requireProject()}/search${this.qs({ ...params })}`,
    );
  }

  // ── Projects ────────────────────────────────────────────────────────────

  async listProjects(params: ListProjectsParams = {}): Promise<GitlabProject[]> {
    return this.get<GitlabProject[]>(`/projects${this.qs({ ...params })}`);
  }

  async getProject(): Promise<GitlabProject> {
    return this.get<GitlabProject>(`/projects/${this.requireProject()}`);
  }

  /**
   * 列出某 group 下的项目(不需要 projectPath;传 group id 或 URL-encoded group path)。
   * include_subgroups=true 会同时返回子 group 的项目。
   */
  async listGroupProjects(
    groupIdOrPath: string | number,
    params: ListGroupProjectsParams = {},
  ): Promise<GitlabProject[]> {
    const gid = encodeURIComponent(String(groupIdOrPath));
    return this.get<GitlabProject[]>(
      `/groups/${gid}/projects${this.qs({ ...params })}`,
    );
  }

  // ── Users ───────────────────────────────────────────────────────────────

  async searchUsers(query: string, params: { per_page?: number } = {}): Promise<GitlabUser[]> {
    return this.get<GitlabUser[]>(
      `/users${this.qs({ search: query, per_page: params.per_page })}`,
    );
  }

  async getUserByUsername(username: string): Promise<GitlabUser | null> {
    const users = await this.get<GitlabUser[]>(
      `/users${this.qs({ username })}`,
    );
    return users[0] ?? null;
  }

  // ── Pipelines / Jobs ────────────────────────────────────────────────────

  async listPipelines(params: ListPipelinesParams = {}): Promise<GitlabPipeline[]> {
    return this.get<GitlabPipeline[]>(
      `/projects/${this.requireProject()}/pipelines${this.qs({ ...params })}`,
    );
  }

  async getPipeline(pipelineId: number): Promise<GitlabPipeline> {
    return this.get<GitlabPipeline>(
      `/projects/${this.requireProject()}/pipelines/${pipelineId}`,
    );
  }

  async listPipelineJobs(
    pipelineId: number,
    params: { scope?: string; per_page?: number; page?: number } = {},
  ): Promise<GitlabJob[]> {
    return this.get<GitlabJob[]>(
      `/projects/${this.requireProject()}/pipelines/${pipelineId}/jobs${this.qs({ ...params })}`,
    );
  }

  // ── Auth 验证 ────────────────────────────────────────────────────────────

  /** 验证 token 有效性，返回当前用户信息 */
  async getCurrentUser(): Promise<GitlabUser> {
    return this.get<GitlabUser>('/user');
  }

  // ── Merge Requests (extended) ───────────────────────────────────────────

  /** PUT /projects/:id/merge_requests/:iid:更新 MR title / description / state / labels 等。 */
  async updateMergeRequest(
    iid: number,
    params: UpdateMergeRequestParams,
  ): Promise<GitlabMergeRequest> {
    return this.put<GitlabMergeRequest>(
      `/projects/${this.requireProject()}/merge_requests/${iid}`,
      {
        title: params.title,
        description: params.description,
        state_event: params.state_event,
        labels: params.labels,
        add_labels: params.add_labels,
        remove_labels: params.remove_labels,
        assignee_ids: params.assignee_ids,
        reviewer_ids: params.reviewer_ids,
        target_branch: params.target_branch,
        milestone_id: params.milestone_id,
        remove_source_branch: params.remove_source_branch,
        squash: params.squash,
        discussion_locked: params.discussion_locked,
      },
    );
  }

  /** GET /projects/:id/merge_requests/:iid/discussions */
  async listMergeRequestDiscussions(iid: number): Promise<GitlabDiscussion[]> {
    return this.get<GitlabDiscussion[]>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/discussions?per_page=100`,
    );
  }

  /** POST /projects/:id/merge_requests/:iid/discussions:开启新一条 discussion(可含 inline position)。 */
  async createMergeRequestDiscussion(
    iid: number,
    params: CreateMergeRequestDiscussionParams,
  ): Promise<GitlabDiscussion> {
    return this.post<GitlabDiscussion>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/discussions`,
      {
        body: params.body,
        position: params.position,
        commit_id: params.commit_id,
        created_at: params.created_at,
      },
    );
  }

  /** PUT /projects/:id/merge_requests/:iid/discussions/:discussion_id:resolve / unresolve 一条 discussion。 */
  async resolveMergeRequestDiscussion(
    iid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<GitlabDiscussion> {
    return this.put<GitlabDiscussion>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`,
      { resolved },
    );
  }

  /** GET /projects/:id/merge_requests/:iid/approvals */
  async listMergeRequestApprovals(iid: number): Promise<GitlabMergeRequestApprovals> {
    return this.get<GitlabMergeRequestApprovals>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/approvals`,
    );
  }

  /** POST /projects/:id/merge_requests/:iid/approve */
  async approveMergeRequest(iid: number, sha?: string): Promise<GitlabMergeRequestApprovals> {
    return this.post<GitlabMergeRequestApprovals>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/approve`,
      sha ? { sha } : {},
    );
  }

  /** POST /projects/:id/merge_requests/:iid/unapprove */
  async unapproveMergeRequest(iid: number): Promise<void> {
    await this.post<void>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/unapprove`,
      {},
    );
  }

  /** GET /projects/:id/merge_requests/:iid/pipelines */
  async listMergeRequestPipelines(iid: number): Promise<GitlabPipeline[]> {
    return this.get<GitlabPipeline[]>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/pipelines`,
    );
  }

  /** GET /projects/:id/issues/:iid/related_merge_requests */
  async listIssueRelatedMergeRequests(iid: number): Promise<GitlabMergeRequest[]> {
    return this.get<GitlabMergeRequest[]>(
      `/projects/${this.requireProject()}/issues/${iid}/related_merge_requests`,
    );
  }

  // ── Milestones ──────────────────────────────────────────────────────────

  /** GET /projects/:id/milestones */
  async listProjectMilestones(params: ListMilestonesParams = {}): Promise<GitlabMilestone[]> {
    return this.get<GitlabMilestone[]>(
      `/projects/${this.requireProject()}/milestones${this.qs({
        state: params.state,
        search: params.search,
        per_page: params.per_page,
        page: params.page,
      })}`,
    );
  }

  /** GET /groups/:group_id/milestones */
  async listGroupMilestones(
    groupIdOrPath: string | number,
    params: ListMilestonesParams = {},
  ): Promise<GitlabMilestone[]> {
    const gid = encodeURIComponent(String(groupIdOrPath));
    return this.get<GitlabMilestone[]>(
      `/groups/${gid}/milestones${this.qs({
        state: params.state,
        search: params.search,
        per_page: params.per_page,
        page: params.page,
      })}`,
    );
  }

  // ── Members / Hooks / Variables ─────────────────────────────────────────

  /** GET /projects/:id/members */
  async listProjectMembers(params: ListMembersParams = {}): Promise<GitlabMember[]> {
    return this.get<GitlabMember[]>(
      `/projects/${this.requireProject()}/members${this.qs({
        query: params.query,
        per_page: params.per_page,
        page: params.page,
      })}`,
    );
  }

  /** GET /groups/:group_id/members */
  async listGroupMembers(
    groupIdOrPath: string | number,
    params: ListMembersParams = {},
  ): Promise<GitlabMember[]> {
    const gid = encodeURIComponent(String(groupIdOrPath));
    return this.get<GitlabMember[]>(
      `/groups/${gid}/members${this.qs({
        query: params.query,
        per_page: params.per_page,
        page: params.page,
      })}`,
    );
  }

  /** GET /projects/:id/hooks */
  async listProjectHooks(): Promise<GitlabProjectHook[]> {
    return this.get<GitlabProjectHook[]>(
      `/projects/${this.requireProject()}/hooks?per_page=100`,
    );
  }

  /** GET /projects/:id/variables(CI/CD variables) */
  async listProjectVariables(): Promise<GitlabProjectVariable[]> {
    return this.get<GitlabProjectVariable[]>(
      `/projects/${this.requireProject()}/variables?per_page=100`,
    );
  }

  // ── Environments / Deployments ──────────────────────────────────────────

  /** GET /projects/:id/environments */
  async listProjectEnvironments(
    params: ListEnvironmentsParams = {},
  ): Promise<GitlabEnvironment[]> {
    return this.get<GitlabEnvironment[]>(
      `/projects/${this.requireProject()}/environments${this.qs({ ...params })}`,
    );
  }

  /** GET /projects/:id/deployments */
  async listProjectDeployments(
    params: ListDeploymentsParams = {},
  ): Promise<GitlabDeployment[]> {
    return this.get<GitlabDeployment[]>(
      `/projects/${this.requireProject()}/deployments${this.qs({ ...params })}`,
    );
  }

  /** GET /projects/:id/forks */
  async listProjectForks(
    params: { per_page?: number; page?: number } = {},
  ): Promise<GitlabProject[]> {
    return this.get<GitlabProject[]>(
      `/projects/${this.requireProject()}/forks${this.qs({ ...params })}`,
    );
  }

  /** GET /projects/:id/pipeline_schedules */
  async listPipelineSchedules(): Promise<GitlabPipelineSchedule[]> {
    return this.get<GitlabPipelineSchedule[]>(
      `/projects/${this.requireProject()}/pipeline_schedules?per_page=100`,
    );
  }

  // ── Jobs (retry / cancel / log) ─────────────────────────────────────────

  /** GET /projects/:id/jobs/:job_id/trace:plain text 日志。 */
  async getJobLog(jobId: number): Promise<string> {
    return this.requestRaw(
      'GET',
      `/projects/${this.requireProject()}/jobs/${jobId}/trace`,
    );
  }

  /** POST /projects/:id/jobs/:job_id/retry */
  async retryJob(jobId: number): Promise<GitlabJob> {
    return this.post<GitlabJob>(
      `/projects/${this.requireProject()}/jobs/${jobId}/retry`,
      {},
    );
  }

  /** POST /projects/:id/jobs/:job_id/cancel */
  async cancelJob(jobId: number): Promise<GitlabJob> {
    return this.post<GitlabJob>(
      `/projects/${this.requireProject()}/jobs/${jobId}/cancel`,
      {},
    );
  }

  // ── Repository files (create / update / delete) + archive URL ──────────

  /**
   * 返回 repository archive URL 与 header 提示。不直接下载,也不把 token 塞进
   * 返回值——由调用方拿到 URL 后自己带上 PRIVATE-TOKEN header 请求(避免 token
   * 意外流入 log / 传给下游)。
   */
  getRepositoryArchiveUrl(
    params: { sha?: string; format?: 'zip' | 'tar.gz' | 'tar.bz2' | 'tar' | 'tb2' | 'tbz' | 'tbz2' | 'tb' } = {},
  ): GitlabRepositoryArchiveDescriptor {
    const project = this.requireProject();
    const format = params.format ?? 'zip';
    const qs = this.qs({ sha: params.sha });
    const url = `${this.baseUrl}/api/v4/projects/${project}/repository/archive.${format}${qs}`;
    return {
      url,
      header: { 'PRIVATE-TOKEN': '***' },
      note:
        'Add the real PRIVATE-TOKEN header when downloading; the URL itself does not include the token.',
    };
  }

  /** POST /projects/:id/repository/files/:path:创建新文件。 */
  async createFile(
    path: string,
    params: CreateOrUpdateFileParams,
  ): Promise<GitlabFileCommitResult> {
    const encPath = encodeURIComponent(path);
    return this.post<GitlabFileCommitResult>(
      `/projects/${this.requireProject()}/repository/files/${encPath}`,
      {
        branch: params.branch,
        content: params.content,
        commit_message: params.commit_message,
        encoding: params.encoding,
        author_email: params.author_email,
        author_name: params.author_name,
        start_branch: params.start_branch,
        last_commit_id: params.last_commit_id,
      },
    );
  }

  /** PUT /projects/:id/repository/files/:path:更新已存在文件。 */
  async updateFile(
    path: string,
    params: CreateOrUpdateFileParams,
  ): Promise<GitlabFileCommitResult> {
    const encPath = encodeURIComponent(path);
    return this.put<GitlabFileCommitResult>(
      `/projects/${this.requireProject()}/repository/files/${encPath}`,
      {
        branch: params.branch,
        content: params.content,
        commit_message: params.commit_message,
        encoding: params.encoding,
        author_email: params.author_email,
        author_name: params.author_name,
        start_branch: params.start_branch,
        last_commit_id: params.last_commit_id,
      },
    );
  }

  /** DELETE /projects/:id/repository/files/:path */
  async deleteFile(
    path: string,
    params: DeleteFileParams,
  ): Promise<GitlabFileCommitResult> {
    const encPath = encodeURIComponent(path);
    return this.request<GitlabFileCommitResult>(
      'DELETE',
      `/projects/${this.requireProject()}/repository/files/${encPath}`,
      {
        branch: params.branch,
        commit_message: params.commit_message,
        author_email: params.author_email,
        author_name: params.author_name,
        start_branch: params.start_branch,
        last_commit_id: params.last_commit_id,
      },
    );
  }

  // ── Groups: issues / merge_requests ─────────────────────────────────────

  /** GET /groups/:group_id/issues */
  async listGroupIssues(
    groupIdOrPath: string | number,
    params: ListGroupIssuesParams = {},
  ): Promise<GitlabIssue[]> {
    const gid = encodeURIComponent(String(groupIdOrPath));
    return this.get<GitlabIssue[]>(`/groups/${gid}/issues${this.qs({ ...params })}`);
  }

  /** GET /groups/:group_id/merge_requests */
  async listGroupMergeRequests(
    groupIdOrPath: string | number,
    params: ListGroupMergeRequestsParams = {},
  ): Promise<GitlabMergeRequest[]> {
    const gid = encodeURIComponent(String(groupIdOrPath));
    return this.get<GitlabMergeRequest[]>(
      `/groups/${gid}/merge_requests${this.qs({ ...params })}`,
    );
  }

  // ── Wiki / Snippets / Releases / Protected branches ────────────────────

  /** GET /projects/:id/wikis */
  async listWikiPages(params: { with_content?: boolean } = {}): Promise<GitlabWikiPage[]> {
    return this.get<GitlabWikiPage[]>(
      `/projects/${this.requireProject()}/wikis${this.qs({ ...params })}`,
    );
  }

  /** GET /projects/:id/wikis/:slug */
  async getWikiPage(slug: string): Promise<GitlabWikiPage> {
    return this.get<GitlabWikiPage>(
      `/projects/${this.requireProject()}/wikis/${encodeURIComponent(slug)}`,
    );
  }

  /** GET /projects/:id/snippets */
  async listSnippets(): Promise<GitlabSnippet[]> {
    return this.get<GitlabSnippet[]>(
      `/projects/${this.requireProject()}/snippets?per_page=100`,
    );
  }

  /** GET /projects/:id/snippets/:snippet_id */
  async getSnippet(snippetId: number): Promise<GitlabSnippet> {
    return this.get<GitlabSnippet>(
      `/projects/${this.requireProject()}/snippets/${snippetId}`,
    );
  }

  /** GET /projects/:id/releases */
  async listReleases(params: ListReleasesParams = {}): Promise<GitlabRelease[]> {
    return this.get<GitlabRelease[]>(
      `/projects/${this.requireProject()}/releases${this.qs({ ...params })}`,
    );
  }

  /** GET /projects/:id/releases/:tag_name */
  async getRelease(tagName: string): Promise<GitlabRelease> {
    return this.get<GitlabRelease>(
      `/projects/${this.requireProject()}/releases/${encodeURIComponent(tagName)}`,
    );
  }

  /** GET /projects/:id/protected_branches */
  async listProjectProtectedBranches(): Promise<GitlabProtectedBranch[]> {
    return this.get<GitlabProtectedBranch[]>(
      `/projects/${this.requireProject()}/protected_branches?per_page=100`,
    );
  }

  // ── Project mutations: fork / star / unstar ────────────────────────────

  /** POST /projects/:id/fork:创建 fork 到指定 namespace。 */
  async forkProject(params: ForkProjectParams = {}): Promise<GitlabProject> {
    return this.post<GitlabProject>(`/projects/${this.requireProject()}/fork`, {
      namespace: params.namespace,
      namespace_id: params.namespace_id,
      namespace_path: params.namespace_path,
      name: params.name,
      path: params.path,
      description: params.description,
      visibility: params.visibility,
    });
  }

  /** POST /projects/:id/star */
  async starProject(): Promise<GitlabProject> {
    return this.post<GitlabProject>(`/projects/${this.requireProject()}/star`, {});
  }

  /** POST /projects/:id/unstar */
  async unstarProject(): Promise<GitlabProject> {
    return this.post<GitlabProject>(`/projects/${this.requireProject()}/unstar`, {});
  }

  // ── Draft notes (MR pending review) ────────────────────────────────────

  /** GET /projects/:id/merge_requests/:iid/draft_notes */
  async listDraftNotes(iid: number): Promise<GitlabDraftNote[]> {
    return this.get<GitlabDraftNote[]>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/draft_notes`,
    );
  }

  /** POST /projects/:id/merge_requests/:iid/draft_notes */
  async createDraftNote(
    iid: number,
    params: CreateDraftNoteParams,
  ): Promise<GitlabDraftNote> {
    return this.post<GitlabDraftNote>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/draft_notes`,
      {
        note: params.note,
        position: params.position,
        resolve_discussion: params.resolve_discussion,
        in_reply_to_discussion_id: params.in_reply_to_discussion_id,
      },
    );
  }

  /** PUT /projects/:id/merge_requests/:iid/draft_notes/:draft_note_id */
  async updateDraftNote(
    iid: number,
    draftNoteId: number,
    params: UpdateDraftNoteParams,
  ): Promise<GitlabDraftNote> {
    return this.put<GitlabDraftNote>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/draft_notes/${draftNoteId}`,
      {
        note: params.note,
        position: params.position,
      },
    );
  }

  /** PUT /projects/:id/merge_requests/:iid/draft_notes/:draft_note_id/publish */
  async publishDraftNote(iid: number, draftNoteId: number): Promise<void> {
    await this.put<void>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/draft_notes/${draftNoteId}/publish`,
      {},
    );
  }

  /** POST /projects/:id/merge_requests/:iid/draft_notes/bulk_publish */
  async bulkPublishDraftNotes(iid: number): Promise<void> {
    await this.post<void>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/draft_notes/bulk_publish`,
      {},
    );
  }

  /** DELETE /projects/:id/merge_requests/:iid/draft_notes/:draft_note_id */
  async deleteDraftNote(iid: number, draftNoteId: number): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/projects/${this.requireProject()}/merge_requests/${iid}/draft_notes/${draftNoteId}`,
    );
  }

  // ── Repository: multi-file commit / branch CRUD / tag CRUD ─────────────

  /**
   * POST /projects/:id/repository/commits:一次性以多个 file action(create /
   * update / delete / move / chmod)提交单个 commit。GitLab 单端点已支持批量,
   * 不需要拆成 getRef → getTree → createCommit 那种 GitHub Git Data API dance。
   */
  async commitMultipleFiles(
    params: CommitActionsParams,
  ): Promise<GitlabRepositoryCommit> {
    return this.post<GitlabRepositoryCommit>(
      `/projects/${this.requireProject()}/repository/commits`,
      {
        branch: params.branch,
        commit_message: params.commit_message,
        actions: params.actions,
        start_branch: params.start_branch,
        start_sha: params.start_sha,
        author_email: params.author_email,
        author_name: params.author_name,
        stats: params.stats,
      },
    );
  }

  /** POST /projects/:id/repository/branches:创建分支。 */
  async createBranch(params: CreateBranchParams): Promise<GitlabBranch> {
    return this.post<GitlabBranch>(
      `/projects/${this.requireProject()}/repository/branches`,
      { branch: params.branch, ref: params.ref },
    );
  }

  /** DELETE /projects/:id/repository/branches/:branch */
  async deleteBranch(branch: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/projects/${this.requireProject()}/repository/branches/${encodeURIComponent(branch)}`,
    );
  }

  /** GET /projects/:id/repository/branches/:branch */
  async getBranch(branch: string): Promise<GitlabBranch> {
    return this.get<GitlabBranch>(
      `/projects/${this.requireProject()}/repository/branches/${encodeURIComponent(branch)}`,
    );
  }

  /** POST /projects/:id/repository/tags */
  async createTag(params: CreateTagParams): Promise<GitlabRepoTag> {
    return this.post<GitlabRepoTag>(
      `/projects/${this.requireProject()}/repository/tags`,
      {
        tag_name: params.tag_name,
        ref: params.ref,
        message: params.message,
        release_description: params.release_description,
      },
    );
  }

  /** DELETE /projects/:id/repository/tags/:tag_name */
  async deleteTag(tagName: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/projects/${this.requireProject()}/repository/tags/${encodeURIComponent(tagName)}`,
    );
  }

  /** GET /projects/:id/repository/tags/:tag_name */
  async getTag(tagName: string): Promise<GitlabRepoTag> {
    return this.get<GitlabRepoTag>(
      `/projects/${this.requireProject()}/repository/tags/${encodeURIComponent(tagName)}`,
    );
  }

  /** GET /projects/:id/labels/:label_id(numeric id 或 URL-encoded name)。 */
  async getLabel(labelIdOrName: string | number): Promise<GitlabLabel> {
    const seg = encodeURIComponent(String(labelIdOrName));
    return this.get<GitlabLabel>(
      `/projects/${this.requireProject()}/labels/${seg}`,
    );
  }

  // ── Merge Request rebase ──────────────────────────────────────────────

  /** PUT /projects/:id/merge_requests/:iid/rebase:异步触发 rebase,返 in-progress flag。 */
  async rebaseMergeRequest(
    iid: number,
    params: { skip_ci?: boolean } = {},
  ): Promise<{ rebase_in_progress: boolean }> {
    return this.put<{ rebase_in_progress: boolean }>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/rebase`,
      params.skip_ci !== undefined ? { skip_ci: params.skip_ci } : {},
    );
  }

  // ── Award emoji reactions ─────────────────────────────────────────────

  /** GET /projects/:id/issues/:iid/award_emoji */
  async listIssueAwardEmoji(iid: number): Promise<GitlabAwardEmoji[]> {
    return this.get<GitlabAwardEmoji[]>(
      `/projects/${this.requireProject()}/issues/${iid}/award_emoji`,
    );
  }

  /** POST /projects/:id/issues/:iid/award_emoji */
  async addIssueAwardEmoji(iid: number, name: string): Promise<GitlabAwardEmoji> {
    return this.post<GitlabAwardEmoji>(
      `/projects/${this.requireProject()}/issues/${iid}/award_emoji`,
      { name },
    );
  }

  /** DELETE /projects/:id/issues/:iid/award_emoji/:award_id */
  async removeIssueAwardEmoji(iid: number, awardId: number): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/projects/${this.requireProject()}/issues/${iid}/award_emoji/${awardId}`,
    );
  }

  /** GET /projects/:id/merge_requests/:iid/award_emoji */
  async listMergeRequestAwardEmoji(iid: number): Promise<GitlabAwardEmoji[]> {
    return this.get<GitlabAwardEmoji[]>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/award_emoji`,
    );
  }

  /** POST /projects/:id/merge_requests/:iid/award_emoji */
  async addMergeRequestAwardEmoji(
    iid: number,
    name: string,
  ): Promise<GitlabAwardEmoji> {
    return this.post<GitlabAwardEmoji>(
      `/projects/${this.requireProject()}/merge_requests/${iid}/award_emoji`,
      { name },
    );
  }

  /** DELETE /projects/:id/merge_requests/:iid/award_emoji/:award_id */
  async removeMergeRequestAwardEmoji(
    iid: number,
    awardId: number,
  ): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/projects/${this.requireProject()}/merge_requests/${iid}/award_emoji/${awardId}`,
    );
  }

  /** GET /projects/:id/{issues|merge_requests}/:iid/notes/:note_id/award_emoji */
  async listNoteAwardEmoji(
    noteable: 'issues' | 'merge_requests',
    iid: number,
    noteId: number,
  ): Promise<GitlabAwardEmoji[]> {
    return this.get<GitlabAwardEmoji[]>(
      `/projects/${this.requireProject()}/${noteable}/${iid}/notes/${noteId}/award_emoji`,
    );
  }

  /** POST 同上 */
  async addNoteAwardEmoji(
    noteable: 'issues' | 'merge_requests',
    iid: number,
    noteId: number,
    name: string,
  ): Promise<GitlabAwardEmoji> {
    return this.post<GitlabAwardEmoji>(
      `/projects/${this.requireProject()}/${noteable}/${iid}/notes/${noteId}/award_emoji`,
      { name },
    );
  }

  /** DELETE .../award_emoji/:award_id */
  async removeNoteAwardEmoji(
    noteable: 'issues' | 'merge_requests',
    iid: number,
    noteId: number,
    awardId: number,
  ): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/projects/${this.requireProject()}/${noteable}/${iid}/notes/${noteId}/award_emoji/${awardId}`,
    );
  }

  // ── Project create ────────────────────────────────────────────────────

  /** POST /projects:新建项目(user-scope,不需要 projectPath)。 */
  async createProject(params: CreateProjectParams): Promise<GitlabProject> {
    return this.post<GitlabProject>('/projects', {
      name: params.name,
      path: params.path,
      namespace_id: params.namespace_id,
      description: params.description,
      visibility: params.visibility,
      initialize_with_readme: params.initialize_with_readme,
      default_branch: params.default_branch,
    });
  }

  // ── Issue links ───────────────────────────────────────────────────────

  /** GET /projects/:id/issues/:iid/links */
  async listIssueLinks(iid: number): Promise<GitlabIssueLink[]> {
    return this.get<GitlabIssueLink[]>(
      `/projects/${this.requireProject()}/issues/${iid}/links`,
    );
  }

  /** POST /projects/:id/issues/:iid/links */
  async createIssueLink(
    iid: number,
    params: CreateIssueLinkParams,
  ): Promise<GitlabIssueLink> {
    return this.post<GitlabIssueLink>(
      `/projects/${this.requireProject()}/issues/${iid}/links`,
      {
        target_project_id: params.target_project_id,
        target_issue_iid: params.target_issue_iid,
        link_type: params.link_type,
      },
    );
  }

  /** DELETE /projects/:id/issues/:iid/links/:link_id */
  async deleteIssueLink(iid: number, linkId: number): Promise<GitlabIssueLink> {
    return this.request<GitlabIssueLink>(
      'DELETE',
      `/projects/${this.requireProject()}/issues/${iid}/links/${linkId}`,
    );
  }

  // ── Uploads (project attachments,用于 MR/issue/wiki 附图) ──────────────

  /**
   * POST /projects/:id/uploads:上传文件到 project attachment store。
   * 返回值里的 `markdown` 字段可以直接嵌入 MR / issue / wiki 描述,
   * 图片会自动渲染为 `![alt](url)`,其它文件是 `[alt](url)`。
   *
   * body 走 `multipart/form-data`,字段名固定为 `file`。GitLab 会按 filename
   * 后缀识别 mime 并决定是否作为图片渲染;调用方最好传带扩展名的 filename
   * (`screenshot.png`)。contentType 省略时兜底 `application/octet-stream`。
   *
   * @param file 二进制数据(Uint8Array / ArrayBuffer / Blob 等 fetch body 可接受的类型)
   * @param params.filename 文件名(带扩展名),GitLab 用它决定 mime 与 markdown 渲染
   * @param params.contentType 可选 MIME(如 image/png),不传按扩展名兜底
   */
  async uploadProjectFile(
    file: Uint8Array | ArrayBuffer | Blob,
    params: { filename: string; contentType?: string },
  ): Promise<GitlabProjectUpload> {
    const url = `${this.baseUrl}/api/v4/projects/${this.requireProject()}/uploads`;
    const form = new FormData();
    // fetch 的 FormData 只接受 Blob/File 作为 blob-like 字段,Uint8Array/
    // ArrayBuffer 需先包装成 Blob。contentType 显式传入时始终重包装一次以覆盖 mime——
    // 即使 file 已是 Blob,若其 type 为空(常见于 new Blob([bytes])),不重包 GitLab
    // 拿到的 multipart part 就没有 Content-Type,图片识别会失败。
    const blob =
      file instanceof Blob
        ? params.contentType
          ? new Blob([file], { type: params.contentType })
          : file
        : new Blob([file as BlobPart], {
            type: params.contentType ?? 'application/octet-stream',
          });
    form.append('file', blob, params.filename);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': this.token },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitlabApiError(
        `GitLab POST /projects/:id/uploads failed: ${res.status}`,
        res.status,
        text,
      );
    }
    // 走 text → JSON.parse,与 request() 的防御模式对齐,避免 res.json() 在空 body
    // 上抛 SyntaxError 破坏 GitlabApiError 契约(uploads 端点正常不返空 body,但保持一致)。
    const text = await res.text();
    return JSON.parse(text) as GitlabProjectUpload;
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v4${path}`;
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.token,
    };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    // 认证请求禁止自动跟随跨 host 重定向:PRIVATE-TOKEN 绝不重放到另一个 host。
    const res = await fetchWithSafeRedirect(url, init);

    // 304 Not Modified 对幂等写端点(如 POST /projects/:id/star 已 star / unstar
    // 未 star)是"操作 no-op、状态和目标一致"的成功语义,GitLab 不返 body。
    // res.ok 的定义是 200-299,304 会落进 !res.ok 抛错,但语义上应等价于成功。
    // 提前拦下,当 void success 处理。
    if (res.status === 304) return undefined as T;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitlabApiError(
        `GitLab ${method} ${path} failed: ${res.status}`,
        res.status,
        text,
      );
    }

    // 空 body 的成功响应(204 No Content / 205 Reset Content / Content-Length: 0)
    // 直接短路,避免 res.json() 对空 body 抛 SyntaxError 让上层误报 API 失败。
    if (res.status === 204 || res.status === 205) return undefined as T;
    const contentLength = res.headers.get('content-length');
    if (contentLength === '0') return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** 返回 body 为 raw text 的场景(如 files/{path}/raw)。 */
  private async requestRaw(method: string, path: string): Promise<string> {
    const url = `${this.baseUrl}/api/v4${path}`;
    // 同 request():认证请求不跟随跨 host 重定向。
    const res = await fetchWithSafeRedirect(url, {
      method,
      headers: { 'PRIVATE-TOKEN': this.token },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitlabApiError(
        `GitLab ${method} ${path} failed: ${res.status}`,
        res.status,
        text,
      );
    }
    return res.text();
  }
}
