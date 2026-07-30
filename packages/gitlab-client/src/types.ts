/** GitLab REST API v4 类型定义 */

/**
 * POST /projects/:id/uploads 返回。上传文件后 GitLab 会给出 markdown 片段,
 * 直接嵌到 issue / MR / wiki 描述里即可显示;图片会自动渲染。
 */
export interface GitlabProjectUpload {
  /** 文件在 GitLab 服务器上的存储别名(用于 markdown 链接) */
  alt: string;
  /** 相对 URL 路径,如 `/uploads/xxx/screenshot.png` */
  url: string;
  /** 完整 URL 路径(GitLab 15.7+ 才返回) */
  full_path?: string;
  /** 现成 markdown 片段:图片是 `![alt](url)`,普通文件是 `[alt](url)` */
  markdown: string;
}

export interface GitlabClientConfig {
  /** GitLab 实例地址，如 'https://gitlab.com' */
  baseUrl: string;
  /** Personal Access Token */
  token: string;
  /** 项目路径，如 'group/project'。cross-project / user-scope 调用可省略。 */
  projectPath?: string;
  /**
   * 出网通道。缺省 = 全局 fetch —— 在 **Node / Electron 主进程**下那是 undici,不读系统
   * 代理设置也不读代理环境变量,所以代理网络下的宿主应注入自己的代理感知实现
   * (desktop 注入 main/maker-host/outbound-fetch)。
   */
  fetchImpl?: typeof fetch;
}

export interface GitlabUser {
  id: number;
  username: string;
  name: string;
  avatar_url: string | null;
  web_url: string;
  email?: string;
  public_email?: string;
  state?: string;
}

export interface GitlabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  labels: string[];
  author: GitlabUser;
  assignee: GitlabUser | null;
  web_url: string;
  created_at: string;
  updated_at: string;
  project_id?: number;
}

export interface GitlabNote {
  id: number;
  body: string;
  author: GitlabUser;
  created_at: string;
  system: boolean;
}

export interface GitlabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  source_branch: string;
  target_branch: string;
  web_url: string;
  author: GitlabUser;
  project_id?: number;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  merge_status?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  labels?: string[];
}

export interface GitlabLabel {
  id: number;
  name: string;
  color: string;
}

export interface GitlabBranch {
  name: string;
  default: boolean;
  protected: boolean;
  commit?: {
    id: string;
    short_id: string;
    title: string;
    author_name: string;
    committed_date: string;
  };
}

/** GitLab 用户 / 项目 / 组 events */
export interface GitlabEvent {
  id: number;
  project_id: number;
  action_name: string;
  target_id: number | null;
  target_iid: number | null;
  target_type: string | null;
  target_title: string | null;
  author_id: number;
  author_username: string;
  author?: GitlabUser;
  created_at: string;
  /** PushEvent 特有 payload,包含 commits / commit_count / ref */
  push_data?: {
    commit_count: number;
    action: string;
    ref_type: string;
    commit_from: string | null;
    commit_to: string | null;
    ref: string;
    commit_title: string | null;
    ref_count?: number | null;
  };
  /** note event 的评论 body */
  note?: {
    id: number;
    body: string;
    noteable_type: string;
    noteable_id: number;
    noteable_iid: number | null;
  };
}

/** GitLab commit */
export interface GitlabCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  authored_date: string;
  committer_name: string;
  committer_email: string;
  committed_date: string;
  web_url: string;
  parent_ids: string[];
  /** 单条 GET 才返回;列表接口没有 */
  stats?: {
    additions: number;
    deletions: number;
    total: number;
  };
}

/** commit diff 的单个 file */
export interface GitlabCommitDiff {
  old_path: string;
  new_path: string;
  a_mode: string | null;
  b_mode: string | null;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

export interface GitlabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  description: string | null;
  default_branch: string | null;
  visibility: 'private' | 'internal' | 'public' | string;
  web_url: string;
  ssh_url_to_repo?: string;
  http_url_to_repo?: string;
  namespace?: { id: number; name: string; path: string; full_path: string; kind: string };
  archived: boolean;
  created_at?: string;
  last_activity_at?: string;
  star_count?: number;
  forks_count?: number;
  open_issues_count?: number;
}

export interface GitlabPipeline {
  id: number;
  iid?: number;
  project_id: number;
  status:
    | 'created'
    | 'waiting_for_resource'
    | 'preparing'
    | 'pending'
    | 'running'
    | 'success'
    | 'failed'
    | 'canceled'
    | 'skipped'
    | 'manual'
    | 'scheduled'
    | string;
  source?: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  duration?: number | null;
}

export interface GitlabJob {
  id: number;
  status: string;
  stage: string;
  name: string;
  ref: string;
  tag: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
  user?: GitlabUser;
  pipeline?: {
    id: number;
    ref: string;
    sha: string;
    status: string;
  };
  web_url: string;
  failure_reason?: string;
}

/** repository tree 里的 blob / tree 节点 */
export interface GitlabTreeItem {
  id: string;
  name: string;
  type: 'blob' | 'tree';
  path: string;
  mode: string;
}

/** GET /projects/:id/repository/tags 条目 */
export interface GitlabTag {
  name: string;
  message: string | null;
  target: string;
  commit: {
    id: string;
    short_id: string;
    title: string;
    message: string;
    author_name: string;
    committed_date: string;
  };
  release?: { tag_name: string; description: string } | null;
  protected?: boolean;
}

/** GET /projects/:id/repository/compare 返回 */
export interface GitlabCompareResult {
  commit: GitlabCommit | null;
  commits: GitlabCommit[];
  diffs: GitlabCommitDiff[];
  compare_timeout: boolean;
  compare_same_ref: boolean;
  web_url?: string;
}

/** GET /projects/:id/merge_requests/:iid/changes 返回(相当于 GitHub PR files) */
export interface GitlabMergeRequestChanges extends GitlabMergeRequest {
  changes: Array<{
    old_path: string;
    new_path: string;
    a_mode: string | null;
    b_mode: string | null;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
    diff: string;
  }>;
  overflow?: boolean;
}

export interface ListIssuesParams {
  state?: 'opened' | 'closed' | 'all';
  labels?: string;
  per_page?: number;
  page?: number;
  order_by?: 'created_at' | 'updated_at';
  sort?: 'asc' | 'desc';
  scope?: 'created_by_me' | 'assigned_to_me' | 'all';
  author_username?: string;
  assignee_username?: string;
  search?: string;
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
}

export interface CreateMergeRequestParams {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  /**
   * 是否以 Draft MR 创建。GitLab REST POST /merge_requests 不接受独立 draft 参数,
   * client 层通过给 title 补 `Draft: ` 前缀实现(已带 `Draft:` / `WIP:` 前缀时不重复补)。
   */
  draft?: boolean;
}

export interface ListMergeRequestsParams {
  state?: 'opened' | 'closed' | 'merged' | 'all';
  labels?: string;
  per_page?: number;
  page?: number;
  order_by?: 'created_at' | 'updated_at';
  sort?: 'asc' | 'desc';
  source_branch?: string;
  target_branch?: string;
  scope?: 'created_by_me' | 'assigned_to_me' | 'all';
  author_username?: string;
  /** GitLab 13.9+;精确匹配 MR 的 reviewer(单值)。 */
  reviewer_username?: string;
  /**
   * GitLab 9.5+;匹配 MR 的 assignee。GitLab API 声明为 `assignee_username[]`
   * 数组(`Array[String]`),即使只想匹配一个人也传单元素数组。
   */
  assignee_username?: string[];
  /**
   * GitLab 13.0+ Premium;MR 已被这些 username 全部 approve(交集,不是并集)。
   * 序列化为 `approved_by_usernames[]=alice&approved_by_usernames[]=bob`。
   */
  approved_by_usernames?: string[];
  search?: string;
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
}

export interface ListCommitsParams {
  ref_name?: string;
  since?: string;
  until?: string;
  path?: string;
  author?: string;
  all?: boolean;
  with_stats?: boolean;
  per_page?: number;
  page?: number;
}

export interface ListEventsParams {
  action?: string;
  target_type?: string;
  before?: string;
  after?: string;
  sort?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

export interface SearchParams {
  scope:
    | 'projects'
    | 'issues'
    | 'merge_requests'
    | 'milestones'
    | 'snippet_titles'
    | 'users'
    | 'wiki_blobs'
    | 'commits'
    | 'blobs'
    | 'notes';
  search: string;
  per_page?: number;
  page?: number;
}

export interface ListProjectsParams {
  membership?: boolean;
  owned?: boolean;
  starred?: boolean;
  search?: string;
  order_by?: 'id' | 'name' | 'path' | 'created_at' | 'updated_at' | 'last_activity_at';
  sort?: 'asc' | 'desc';
  visibility?: 'public' | 'internal' | 'private';
  simple?: boolean;
  archived?: boolean;
  per_page?: number;
  page?: number;
}

export interface CreateIssueParams {
  title: string;
  description?: string;
  labels?: string;
  assignee_ids?: number[];
}

export interface UpdateIssueParams {
  title?: string;
  description?: string;
  labels?: string;
  add_labels?: string;
  remove_labels?: string;
  assignee_ids?: number[];
  state_event?: 'close' | 'reopen';
}

export interface CompareRefsParams {
  from: string;
  to: string;
  /** true 走 --straight 比较(不含 merge base 归并),false 走 ...merge-base... 语义。 */
  straight?: boolean;
}

export interface ListTagsParams {
  search?: string;
  order_by?: 'name' | 'updated' | 'version';
  sort?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

export interface MergeMergeRequestParams {
  merge_commit_message?: string;
  squash?: boolean;
  should_remove_source_branch?: boolean;
  /** SHA guard;传了就仅当 MR 头 SHA 一致时才 merge。 */
  sha?: string;
}

export interface ListGroupProjectsParams {
  search?: string;
  per_page?: number;
  page?: number;
  include_subgroups?: boolean;
  archived?: boolean;
}

export interface ListPipelinesParams {
  scope?: 'running' | 'pending' | 'finished' | 'branches' | 'tags';
  status?: string;
  ref?: string;
  sha?: string;
  username?: string;
  updated_after?: string;
  updated_before?: string;
  order_by?: 'id' | 'status' | 'ref' | 'updated_at' | 'user_id';
  sort?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

/** GET /projects/:id/milestones 或 /groups/:g/milestones 条目 */
export interface GitlabMilestone {
  id: number;
  iid: number;
  project_id?: number;
  group_id?: number;
  title: string;
  description: string | null;
  state: 'active' | 'closed' | string;
  due_date: string | null;
  start_date: string | null;
  created_at: string;
  updated_at: string;
  web_url: string;
}

/** GET /projects/:id/members 或 /groups/:g/members 条目 */
export interface GitlabMember {
  id: number;
  username: string;
  name: string;
  state: string;
  avatar_url: string | null;
  web_url: string;
  access_level: number;
  expires_at?: string | null;
}

/** GET /projects/:id/hooks 条目 */
export interface GitlabProjectHook {
  id: number;
  url: string;
  project_id: number;
  push_events: boolean;
  issues_events: boolean;
  confidential_issues_events: boolean;
  merge_requests_events: boolean;
  tag_push_events: boolean;
  note_events: boolean;
  pipeline_events: boolean;
  wiki_page_events: boolean;
  job_events?: boolean;
  enable_ssl_verification: boolean;
  created_at: string;
}

/** GET /projects/:id/variables 条目 */
export interface GitlabProjectVariable {
  key: string;
  value: string;
  variable_type: 'env_var' | 'file' | string;
  protected: boolean;
  masked: boolean;
  raw?: boolean;
  environment_scope?: string;
}

/** GET /projects/:id/environments 条目 */
export interface GitlabEnvironment {
  id: number;
  name: string;
  slug: string;
  external_url: string | null;
  state: 'available' | 'stopping' | 'stopped' | string;
  created_at?: string;
  updated_at?: string;
  tier?: string;
}

/** GET /projects/:id/deployments 条目 */
export interface GitlabDeployment {
  id: number;
  iid: number;
  ref: string;
  sha: string;
  status: 'created' | 'running' | 'success' | 'failed' | 'canceled' | 'blocked' | string;
  environment?: { id: number; name: string; external_url: string | null };
  deployable?: { id: number; status: string; stage: string; name: string; ref: string };
  user?: GitlabUser;
  created_at: string;
  updated_at: string;
}

/** GET /projects/:id/pipeline_schedules 条目 */
export interface GitlabPipelineSchedule {
  id: number;
  description: string;
  ref: string;
  cron: string;
  cron_timezone: string;
  next_run_at: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  owner?: GitlabUser;
}

/** GET /projects/:id/merge_requests/:iid/discussions 条目 */
export interface GitlabDiscussion {
  id: string;
  individual_note: boolean;
  notes: Array<{
    id: number;
    type: string | null;
    body: string;
    author: GitlabUser;
    resolvable?: boolean;
    resolved?: boolean;
    resolved_by?: GitlabUser | null;
    created_at: string;
    updated_at: string;
    system: boolean;
    position?: {
      base_sha: string;
      start_sha: string;
      head_sha: string;
      old_path?: string;
      new_path?: string;
      position_type?: string;
      old_line?: number | null;
      new_line?: number | null;
    };
  }>;
}

/** GET /projects/:id/merge_requests/:iid/approvals */
export interface GitlabMergeRequestApprovals {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: string;
  merge_status: string;
  approvals_required: number;
  approvals_left: number;
  approved_by?: Array<{ user: GitlabUser }>;
  approvers?: Array<{ user: GitlabUser }>;
  approver_groups?: unknown[];
  web_url?: string;
}

/** GET /projects/:id/protected_branches 条目 */
export interface GitlabProtectedBranch {
  id: number;
  name: string;
  push_access_levels: Array<{ access_level: number; access_level_description: string }>;
  merge_access_levels: Array<{ access_level: number; access_level_description: string }>;
  allow_force_push?: boolean;
  code_owner_approval_required?: boolean;
}

/** GET /projects/:id/wikis 条目 */
export interface GitlabWikiPage {
  slug: string;
  title: string;
  format: 'markdown' | 'rdoc' | 'asciidoc' | 'org' | string;
  content?: string;
  encoding?: string;
}

/** GET /projects/:id/snippets 条目 */
export interface GitlabSnippet {
  id: number;
  title: string;
  description: string | null;
  visibility: string;
  author?: GitlabUser;
  file_name?: string;
  files?: Array<{ path: string; raw_url: string }>;
  created_at: string;
  updated_at: string;
  web_url: string;
  raw_url?: string;
}

/** GET /projects/:id/releases 条目 */
export interface GitlabRelease {
  tag_name: string;
  name: string;
  description: string | null;
  created_at: string;
  released_at: string | null;
  author?: GitlabUser;
  commit?: { id: string; short_id: string; title: string; message: string };
  assets?: { count: number; sources: Array<{ format: string; url: string }>; links: Array<{ id: number; name: string; url: string }> };
  _links?: Record<string, string>;
}

/** PUT /projects/:id/repository/files/:path 或 POST 参数(create / update file) */
export interface CreateOrUpdateFileParams {
  branch: string;
  content: string;
  commit_message: string;
  encoding?: 'text' | 'base64';
  author_email?: string;
  author_name?: string;
  start_branch?: string;
  last_commit_id?: string;
}

/** DELETE /projects/:id/repository/files/:path 参数 */
export interface DeleteFileParams {
  branch: string;
  commit_message: string;
  author_email?: string;
  author_name?: string;
  start_branch?: string;
  last_commit_id?: string;
}

/** file mutation 返回结构(create / update / delete 共用) */
export interface GitlabFileCommitResult {
  file_path: string;
  branch: string;
}

/** PUT /projects/:id/merge_requests/:iid 参数 */
export interface UpdateMergeRequestParams {
  title?: string;
  description?: string;
  state_event?: 'close' | 'reopen';
  labels?: string;
  add_labels?: string;
  remove_labels?: string;
  assignee_ids?: number[];
  reviewer_ids?: number[];
  target_branch?: string;
  milestone_id?: number;
  remove_source_branch?: boolean;
  squash?: boolean;
  discussion_locked?: boolean;
}

/** POST /projects/:id/merge_requests/:iid/discussions 参数 */
export interface CreateMergeRequestDiscussionParams {
  body: string;
  position?: {
    base_sha: string;
    start_sha: string;
    head_sha: string;
    position_type: 'text' | 'image' | 'file';
    old_path?: string;
    new_path?: string;
    old_line?: number;
    new_line?: number;
  };
  commit_id?: string;
  created_at?: string;
}

/** GET /projects/:id/milestones 参数 */
export interface ListMilestonesParams {
  iids?: number[];
  state?: 'active' | 'closed';
  search?: string;
  per_page?: number;
  page?: number;
}

/** GET /projects/:id/members 参数 */
export interface ListMembersParams {
  query?: string;
  user_ids?: number[];
  per_page?: number;
  page?: number;
}

/** GET /projects/:id/environments 参数 */
export interface ListEnvironmentsParams {
  name?: string;
  search?: string;
  states?: 'available' | 'stopping' | 'stopped';
  per_page?: number;
  page?: number;
}

/** GET /projects/:id/deployments 参数 */
export interface ListDeploymentsParams {
  order_by?: 'id' | 'iid' | 'created_at' | 'updated_at' | 'ref';
  sort?: 'asc' | 'desc';
  updated_after?: string;
  updated_before?: string;
  environment?: string;
  status?: 'created' | 'running' | 'success' | 'failed' | 'canceled' | 'blocked';
  per_page?: number;
  page?: number;
}

/** GET /projects/:id/releases 参数 */
export interface ListReleasesParams {
  order_by?: 'released_at' | 'created_at';
  sort?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

/** POST /projects/:id/fork 参数 */
export interface ForkProjectParams {
  namespace?: string | number;
  namespace_id?: number;
  namespace_path?: string;
  name?: string;
  path?: string;
  description?: string;
  visibility?: 'private' | 'internal' | 'public';
}

/** GET /groups/:g/issues 参数(与 project ListIssuesParams 复用大部分) */
export interface ListGroupIssuesParams {
  state?: 'opened' | 'closed' | 'all';
  labels?: string;
  per_page?: number;
  page?: number;
  order_by?: 'created_at' | 'updated_at';
  sort?: 'asc' | 'desc';
  scope?: 'created_by_me' | 'assigned_to_me' | 'all';
  author_username?: string;
  assignee_username?: string;
  search?: string;
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
  milestone?: string;
}

/** GET /groups/:g/merge_requests 参数 */
export interface ListGroupMergeRequestsParams {
  state?: 'opened' | 'closed' | 'merged' | 'all';
  labels?: string;
  per_page?: number;
  page?: number;
  order_by?: 'created_at' | 'updated_at';
  sort?: 'asc' | 'desc';
  scope?: 'created_by_me' | 'assigned_to_me' | 'all';
  author_username?: string;
  /** GitLab 13.9+;精确匹配 MR 的 reviewer(单值)。 */
  reviewer_username?: string;
  /**
   * GitLab 9.5+;匹配 MR 的 assignee。GitLab API 声明为 `assignee_username[]`
   * 数组(`Array[String]`),即使只想匹配一个人也传单元素数组。
   */
  assignee_username?: string[];
  /** GitLab 13.0+ Premium;MR 已被这些 username 全部 approve(交集)。 */
  approved_by_usernames?: string[];
  search?: string;
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
}

/** GET /projects/:id/repository/archive URL 描述(带 token 提醒的占位返回) */
export interface GitlabRepositoryArchiveDescriptor {
  url: string;
  header: Record<string, string>;
  note: string;
}

/** GET /projects/:id/merge_requests/:iid/draft_notes 条目。GitLab "pending review"
 * 语义:未发布的 MR 评论,支持 bulk publish。 */
export interface GitlabDraftNote {
  id: number;
  author_id: number;
  merge_request_id: number;
  resolve_discussion: boolean;
  discussion_id: string | null;
  note: string;
  commit_id: string | null;
  line_code: string | null;
  position: unknown | null;
}

/** POST /projects/:id/merge_requests/:iid/draft_notes 参数 */
export interface CreateDraftNoteParams {
  note: string;
  /** anchor 到 diff line 的 position(与 CreateMergeRequestDiscussionParams.position 同结构)。 */
  position?: {
    base_sha: string;
    start_sha: string;
    head_sha: string;
    position_type: 'text' | 'image' | 'file';
    old_path?: string;
    new_path?: string;
    old_line?: number;
    new_line?: number;
  };
  resolve_discussion?: boolean;
  in_reply_to_discussion_id?: string;
}

/** PUT /projects/:id/merge_requests/:iid/draft_notes/:draft_note_id 参数 */
export interface UpdateDraftNoteParams {
  note?: string;
  position?: CreateDraftNoteParams['position'];
}

/** POST /projects/:id/repository/commits 里 actions[] 的单条 */
export interface CommitAction {
  action: 'create' | 'update' | 'delete' | 'move' | 'chmod';
  file_path: string;
  previous_path?: string;
  content?: string;
  encoding?: 'text' | 'base64';
  last_commit_id?: string;
  execute_filemode?: boolean;
}

/** POST /projects/:id/repository/commits 参数 */
export interface CommitActionsParams {
  branch: string;
  commit_message: string;
  actions: CommitAction[];
  start_branch?: string;
  start_sha?: string;
  author_email?: string;
  author_name?: string;
  stats?: boolean;
}

/** POST /projects/:id/repository/commits 返回 */
export interface GitlabRepositoryCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  authored_date: string;
  committed_date: string;
  parent_ids: string[];
  web_url: string;
  stats?: {
    additions: number;
    deletions: number;
    total: number;
  };
}

/** POST /projects/:id/repository/branches 参数 */
export interface CreateBranchParams {
  branch: string;
  ref: string;
}

/** POST /projects/:id/repository/tags 参数 */
export interface CreateTagParams {
  tag_name: string;
  ref: string;
  message?: string;
  release_description?: string;
}

/** GET /projects/:id/repository/tags/:tag_name 返回(创建 tag 也返此结构) */
export interface GitlabRepoTag {
  name: string;
  message: string | null;
  target: string;
  commit: {
    id: string;
    short_id: string;
    title: string;
  };
  release?: { tag_name: string; description: string } | null;
  protected?: boolean;
}

/** POST /projects 参数 */
export interface CreateProjectParams {
  name: string;
  path?: string;
  namespace_id?: number;
  description?: string;
  visibility?: 'private' | 'internal' | 'public';
  initialize_with_readme?: boolean;
  default_branch?: string;
}

/** GET /projects/:id/issues/:iid/links 条目 */
export interface GitlabIssueLink {
  source_issue: GitlabIssue;
  target_issue: GitlabIssue;
  link_type: string;
}

/** POST /projects/:id/issues/:iid/links 参数 */
export interface CreateIssueLinkParams {
  target_project_id: number | string;
  target_issue_iid: number;
  link_type?: 'relates_to' | 'blocks' | 'is_blocked_by';
}

/** award emoji reaction 通用条目(issues / MRs / notes 共用) */
export interface GitlabAwardEmoji {
  id: number;
  name: string;
  user: GitlabUser;
  created_at: string;
  updated_at: string;
  awardable_id: number;
  awardable_type: string;
}

/** GitLab API 调用失败时抛出 */
export class GitlabApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'GitlabApiError';
  }
}
