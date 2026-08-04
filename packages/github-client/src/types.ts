/** GitHub REST API v3 类型定义 */

export interface GithubClientConfig {
  /** GitHub API 根地址,默认 'https://api.github.com'(GHE 自建实例可改) */
  baseUrl?: string;
  /** Personal Access Token(classic 或 fine-grained) */
  token: string;
  /** 仓库 owner,如 'makecindy'。user-scope / search / cross-repo 调用可省略。 */
  owner?: string;
  /** 仓库名,如 'cindy'。user-scope / search / cross-repo 调用可省略。 */
  repo?: string;
  /**
   * 出网通道。缺省 = 全局 fetch —— 在 **Node / Electron 主进程**下那是 undici,不读系统
   * 代理设置也不读代理环境变量,所以代理网络下的宿主应注入自己的代理感知实现
   * (desktop 注入 main/maker-host/outbound-fetch)。
   */
  fetchImpl?: typeof fetch;
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
}

/** /users/{u} 详情返回,比 GithubUser 多几个字段 */
export interface GithubUserFull extends GithubUser {
  email?: string | null;
  bio?: string | null;
  company?: string | null;
  location?: string | null;
  public_repos?: number;
  followers?: number;
  following?: number;
  created_at?: string;
  updated_at?: string;
}

export interface GithubOrg {
  id: number;
  login: string;
  description: string | null;
  avatar_url: string;
}

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  default_branch: string;
  owner: GithubUser;
  language: string | null;
  updated_at: string;
  pushed_at: string;
  stargazers_count?: number;
  open_issues_count?: number;
}

export interface GithubIssue {
  id: number;
  /** GitHub 用 number(GitLab 叫 iid) */
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: GithubLabel[];
  user: GithubUser;
  assignee: GithubUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  /** 评论数。声明为可选:老调用点不依赖它,search 结果里也不保证出现。 */
  comments?: number;
  /** issue 是 PR 时 GitHub 会带 pull_request 对象;纯 issue 时无此字段 */
  pull_request?: { url: string; html_url: string } | null;
}

export interface GithubComment {
  id: number;
  body: string;
  user: GithubUser;
  created_at: string;
}

export interface GithubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  head: { ref: string; sha?: string };
  base: { ref: string; sha?: string };
  html_url: string;
  user: GithubUser;
  /** 是否为 draft PR(列表接口也返回;老字段消费方可不读)。 */
  draft?: boolean;
  /** 仅单条 GET /pulls/{number} 返回;state='closed' 且 merged=true 表示已合并。 */
  merged?: boolean;
  /** 合并时间(ISO),未合并为 null。列表接口也返回,可用于区分 closed/merged。 */
  merged_at?: string | null;
}

export interface GithubLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GithubBranch {
  name: string;
  protected: boolean;
}

/**
 * /users/{u}/events 返回。type 字段是驱动 payload 类型的判别式(PushEvent /
 * PullRequestEvent / IssuesEvent / IssueCommentEvent / CreateEvent 等);
 * payload 结构因 type 而异,我们只把它照原样透传。
 */
export interface GithubEvent {
  id: string;
  type: string;
  actor: { id: number; login: string; avatar_url: string };
  repo: { id: number; name: string; url: string };
  payload: Record<string, unknown>;
  public: boolean;
  created_at: string;
  org?: { id: number; login: string; avatar_url: string };
}

/** /repos/{owner}/{repo}/commits 列表条目 */
export interface GithubCommit {
  sha: string;
  html_url: string;
  commit: {
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
    message: string;
    /** 修改的文件数与行数,仅单条 GET 返回;列表里没有 */
    tree?: { sha: string; url: string };
  };
  author: GithubUser | null;
  committer: GithubUser | null;
  parents: Array<{ sha: string; url: string }>;
  /** 单条 GET 返回;列表不返回 */
  stats?: { additions: number; deletions: number; total: number };
  /** 单条 GET 返回;列表不返回 */
  files?: GithubCommitFile[];
}

export interface GithubCommitFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  patch?: string;
  previous_filename?: string;
}

/** compare_commits 返回 */
export interface GithubCompareResult {
  status: 'diverged' | 'ahead' | 'behind' | 'identical';
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: GithubCommit[];
  files: GithubCommitFile[];
  html_url: string;
}

/** 搜索结果外壳(items 的元素类型由具体 endpoint 决定) */
export interface GithubSearchResult<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}

/** PR review(不是 conversation comment,是 approve / request-changes / comment review) */
export interface GithubPullReview {
  id: number;
  user: GithubUser | null;
  body: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  html_url: string;
  submitted_at: string | null;
  commit_id: string | null;
}

/** PR review 内的 inline code comment */
export interface GithubPullReviewComment {
  id: number;
  path: string;
  line: number | null;
  original_line?: number | null;
  side?: 'LEFT' | 'RIGHT';
  body: string;
  user: GithubUser;
  commit_id: string;
  html_url: string;
  in_reply_to_id?: number;
  created_at: string;
  updated_at: string;
}

/** /repos/{o}/{r}/actions/runs 条目 */
export interface GithubWorkflowRun {
  id: number;
  name: string | null;
  head_branch: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'neutral'
    | 'stale'
    | null;
  workflow_id: number;
  event: string;
  html_url: string;
  run_number: number;
  created_at: string;
  updated_at: string;
  actor?: GithubUser;
}

/** workflow run 内的 job */
export interface GithubWorkflowJob {
  id: number;
  run_id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  head_sha: string;
  steps?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
    started_at?: string;
    completed_at?: string;
  }>;
}

export interface GithubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  html_url: string;
  author: GithubUser;
}

/** /repos/{o}/{r}/tags 条目(比 branches 简单,不含 protected 字段) */
export interface GithubTag {
  name: string;
  commit: { sha: string; url: string };
  zipball_url: string;
  tarball_url: string;
  node_id?: string;
}

/** GET /repos/{o}/{r}/readme 返回(和 GithubFileContent 结构一致,base64 内容) */
export interface GithubReadme {
  type: 'file';
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string;
  download_url: string | null;
  content?: string;
  encoding?: 'base64' | 'none';
}

/** /repos/{o}/{r}/actions/workflows 条目 */
export interface GithubWorkflow {
  id: number;
  node_id: string;
  name: string;
  path: string;
  state: 'active' | 'deleted' | 'disabled_fork' | 'disabled_inactivity' | 'disabled_manually' | string;
  created_at: string;
  updated_at: string;
  html_url: string;
  badge_url: string;
}

/** GET /repos/{o}/{r}/commits/{ref}/check-runs 里的单条 check run */
export interface GithubCheckRun {
  id: number;
  head_sha: string;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale'
    | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  details_url: string | null;
  external_id: string | null;
  app?: { id: number; slug: string; name: string } | null;
  output?: { title: string | null; summary: string | null; text?: string | null };
}

/** /repos/{o}/{r}/deployments 条目 */
export interface GithubDeployment {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  description: string | null;
  creator: GithubUser | null;
  created_at: string;
  updated_at: string;
  url: string;
  statuses_url: string;
  repository_url: string;
  original_environment?: string;
  production_environment?: boolean;
  transient_environment?: boolean;
}

/**
 * GET /repos/{o}/{r}/contents/{path} 返回。单文件 → 一个对象;目录 → 对象数组
 * (我们用 discriminated union 让消费者按 type 分支处理)。symlink / submodule
 * 场景暂略,遇到再补。
 */
export type GithubContent =
  | GithubFileContent
  | GithubDirContent[];

export interface GithubFileContent {
  type: 'file';
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string;
  download_url: string | null;
  /** base64 encoded when encoding='base64'(大文件 >1MB 会缺 content,用 download_url) */
  content?: string;
  encoding?: 'base64' | 'none';
}

export interface GithubDirContent {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string;
  download_url: string | null;
}

export interface ListIssuesParams {
  state?: 'open' | 'closed' | 'all';
  labels?: string;
  per_page?: number;
  page?: number;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
  since?: string;
  creator?: string;
  assignee?: string;
}

export interface ListPullRequestsParams {
  state?: 'open' | 'closed' | 'all';
  base?: string;
  head?: string;
  per_page?: number;
  page?: number;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface CreatePullRequestParams {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body?: string;
  /** 以 draft PR 创建(未标记 ready 前无法合并)。 */
  draft?: boolean;
}

export interface ListCommitsParams {
  sha?: string;
  path?: string;
  author?: string;
  committer?: string;
  since?: string;
  until?: string;
  per_page?: number;
  page?: number;
}

export interface ListEventsParams {
  per_page?: number;
  page?: number;
}

export interface SearchParams {
  q: string;
  sort?: string;
  order?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

export interface ListWorkflowRunsParams {
  branch?: string;
  event?: string;
  status?: string;
  actor?: string;
  per_page?: number;
  page?: number;
}

/** POST /repos/{o}/{r}/actions/workflows/{workflow_id}/dispatches */
export interface DispatchWorkflowParams {
  /** 分支 / tag 名(不是 sha)。workflow 会在这个 ref 上运行。 */
  ref: string;
  /** workflow 定义里 workflow_dispatch.inputs 声明的 kv,值全部走字符串。 */
  inputs?: Record<string, string>;
}

/** GET /repos/{o}/{r}/commits/{ref}/check-runs */
export interface ListCheckRunsParams {
  check_name?: string;
  status?: 'queued' | 'in_progress' | 'completed';
  filter?: 'latest' | 'all';
  per_page?: number;
  page?: number;
}

/** GET /repos/{o}/{r}/deployments */
export interface ListDeploymentsParams {
  sha?: string;
  ref?: string;
  task?: string;
  environment?: string;
  per_page?: number;
  page?: number;
}

/** POST /repos/{o}/{r}/releases */
export interface CreateReleaseParams {
  tag_name: string;
  target_commitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  /** true 让 GitHub 基于上一个 release 自动生成 body。 */
  generate_release_notes?: boolean;
}

/** GET /notifications 条目(一条 notification thread 摘要) */
export interface GithubNotificationThread {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  last_read_at: string | null;
  url: string;
  subject: {
    title: string;
    url: string;
    latest_comment_url: string | null;
    type: string;
  };
  repository: GithubRepo;
}

/** GET /repos/{o}/{r}/actions/runs/{run_id}/artifacts 里的单条 artifact */
export interface GithubArtifact {
  id: number;
  node_id: string;
  name: string;
  size_in_bytes: number;
  url: string;
  archive_download_url: string;
  expired: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  workflow_run?: {
    id: number;
    repository_id: number;
    head_repository_id: number;
    head_branch: string;
    head_sha: string;
  };
}

/** GET /repos/{o}/{r}/topics */
export interface GithubTopics {
  names: string[];
}

/** GET /repos/{o}/{r}/contributors 条目 */
export interface GithubContributor {
  id: number;
  login?: string;
  type?: string;
  contributions: number;
  avatar_url?: string;
  html_url?: string;
}

/** GET /repos/{o}/{r}/languages: language → bytes */
export type GithubLanguages = Record<string, number>;

/** GET /repos/{o}/{r}/hooks 条目 */
export interface GithubHook {
  id: number;
  name: string;
  active: boolean;
  events: string[];
  config: {
    url?: string;
    content_type?: string;
    secret?: string;
    insecure_ssl?: string;
  };
  updated_at: string;
  created_at: string;
  url: string;
  test_url: string;
  ping_url: string;
  deliveries_url?: string;
}

/** GET /repos/{o}/{r}/branches/{branch}/protection */
export interface GithubBranchProtection {
  url: string;
  required_status_checks?: {
    strict: boolean;
    contexts: string[];
  } | null;
  enforce_admins?: { enabled: boolean } | null;
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    required_approving_review_count?: number;
  } | null;
  restrictions?: unknown | null;
  allow_force_pushes?: { enabled: boolean };
  allow_deletions?: { enabled: boolean };
  required_conversation_resolution?: { enabled: boolean };
}

/** GET /orgs/{org}/teams 条目 */
export interface GithubTeam {
  id: number;
  node_id: string;
  slug: string;
  name: string;
  description: string | null;
  privacy: string;
  permission: string;
  url: string;
  html_url: string;
  parent?: { id: number; slug: string; name: string } | null;
}

/** GET /gists 条目 */
export interface GithubGist {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  owner: GithubUser | null;
  files: Record<
    string,
    {
      filename: string;
      type: string;
      language: string | null;
      raw_url: string;
      size: number;
      content?: string;
      truncated?: boolean;
    }
  >;
  comments: number;
}

/** PR review 请求列表返回结构 */
export interface GithubRequestedReviewers {
  users: GithubUser[];
  teams: GithubTeam[];
}

/** requested reviewers 请求参数 */
export interface RequestReviewersParams {
  reviewers?: string[];
  team_reviewers?: string[];
}

/** POST /repos/{o}/{r}/pulls/{n}/reviews */
export interface CreatePullReviewParams {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body?: string;
  commit_id?: string;
  comments?: Array<{
    path: string;
    position?: number;
    line?: number;
    side?: 'LEFT' | 'RIGHT';
    body: string;
  }>;
}

/** POST /repos/{o}/{r}/pulls/{n}/comments (inline review comment) */
export interface CreatePullReviewCommentParams {
  body: string;
  commit_id: string;
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

/** PATCH /repos/{o}/{r}/issues/{n} */
export interface UpdateIssueParams {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  state_reason?: 'completed' | 'not_planned' | 'reopened' | null;
  labels?: string[];
  assignees?: string[];
}

/** PATCH /repos/{o}/{r}/pulls/{n} */
export interface UpdatePullRequestParams {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  base?: string;
}

/** GET /notifications */
export interface ListNotificationsParams {
  all?: boolean;
  participating?: boolean;
  since?: string;
  before?: string;
  per_page?: number;
  page?: number;
}

/** PUT /repos/{o}/{r}/contents/{path} 参数(create or update) */
export interface CreateOrUpdateFileContentsParams {
  message: string;
  /** base64-encoded file content */
  content: string;
  /** blob sha; required when updating an existing file */
  sha?: string;
  branch?: string;
  committer?: { name: string; email: string };
  author?: { name: string; email: string };
}

/** DELETE /repos/{o}/{r}/contents/{path} 参数 */
export interface DeleteFileParams {
  message: string;
  /** blob sha of the file being deleted; required */
  sha: string;
  branch?: string;
  committer?: { name: string; email: string };
  author?: { name: string; email: string };
}

/** file content 变更返回(create / update / delete 共用) */
export interface GithubFileCommitResult {
  content: GithubFileContent | null;
  commit: {
    sha: string;
    html_url: string;
    message: string;
    author?: { name: string; email: string; date: string };
    committer?: { name: string; email: string; date: string };
  };
}

/** GET /repos/{o}/{r}/forks 参数 */
export interface ListForksParams {
  sort?: 'newest' | 'oldest' | 'stargazers' | 'watchers';
  per_page?: number;
  page?: number;
}

/** POST /repos/{o}/{r}/forks 参数 */
export interface CreateForkParams {
  organization?: string;
  name?: string;
  default_branch_only?: boolean;
}

/** GET /repos/{o}/{r}/collaborators 参数 */
export interface ListCollaboratorsParams {
  affiliation?: 'outside' | 'direct' | 'all';
  permission?: 'pull' | 'triage' | 'push' | 'maintain' | 'admin';
  per_page?: number;
  page?: number;
}

/** GET /orgs/{org}/members 参数 */
export interface ListOrgMembersParams {
  filter?: '2fa_disabled' | 'all';
  role?: 'all' | 'admin' | 'member';
  per_page?: number;
  page?: number;
}

/** GET /gists 参数 */
export interface ListGistsParams {
  since?: string;
  per_page?: number;
  page?: number;
}

// ── Reactions ────────────────────────────────────────────────────────────

/** Reaction content values supported by GitHub reactions API. */
export type GithubReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes';

/** Single reaction on an issue / comment / review comment. */
export interface GithubReaction {
  id: number;
  node_id: string;
  user: GithubUser | null;
  content: GithubReactionContent;
  created_at: string;
}

/** Params for reaction POST endpoints (add_*_reaction). */
export interface AddReactionParams {
  content: GithubReactionContent;
}

// ── Git Data ────────────────────────────────────────────────────────────

/** GET /repos/{o}/{r}/git/ref/{ref} 或 POST /git/refs 返回。 */
export interface GithubGitRef {
  ref: string;
  node_id: string;
  url: string;
  object: {
    type: 'commit' | 'tag' | string;
    sha: string;
    url: string;
  };
}

/** git tree 里的单条 entry(用于 create_tree 输入和 get_tree 返回)。 */
export interface GithubGitTreeItem {
  path: string;
  /** 100644 = file (blob), 100755 = executable, 040000 = tree, 160000 = commit (submodule), 120000 = symlink */
  mode: '100644' | '100755' | '040000' | '160000' | '120000' | string;
  type: 'blob' | 'tree' | 'commit';
  sha?: string;
  size?: number;
  url?: string;
  /** create_tree input only:直接内联内容(GitHub 会自动 create blob)。与 sha 二选一。 */
  content?: string;
}

/** GET /repos/{o}/{r}/git/trees/{tree_sha} 返回。 */
export interface GithubGitTree {
  sha: string;
  url: string;
  tree: GithubGitTreeItem[];
  truncated: boolean;
}

/** GET / POST /repos/{o}/{r}/git/commits 返回(git-data 视角,与 commits list 的 GithubCommit 不同)。 */
export interface GithubGitCommit {
  sha: string;
  node_id: string;
  url: string;
  html_url: string;
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  tree: { sha: string; url: string };
  parents: Array<{ sha: string; url: string; html_url?: string }>;
}

/** POST /repos/{o}/{r}/git/refs 参数(create_ref 原始版本)。 */
export interface CreateRefParams {
  /** 完整 ref,如 "refs/heads/my-branch" 或 "refs/tags/v1.0.0"。 */
  ref: string;
  sha: string;
}

/** createBranch 便捷方法参数。 */
export interface CreateBranchParams {
  /** 新分支名(不带 refs/heads/ 前缀)。 */
  branch: string;
  /** 基于哪个 commit sha 创建;为空时由调用方从 from_ref 解析。 */
  sha: string;
}

/** POST /repos/{o}/{r}/git/trees 参数。 */
export interface CreateTreeParams {
  tree: GithubGitTreeItem[];
  /** 基于哪个既有 tree sha 增量构造(否则会得到只含 tree 里列出的文件的空 tree)。 */
  base_tree?: string;
}

/** POST /repos/{o}/{r}/git/commits 参数。 */
export interface CreateCommitParams {
  message: string;
  tree: string;
  parents: string[];
  author?: { name: string; email: string; date?: string };
  committer?: { name: string; email: string; date?: string };
}

/** pushFiles 输入的单个文件。 */
export interface PushFilesFile {
  path: string;
  content: string;
  /** 'utf-8'(默认)→ 走 tree entry 的内联 content;'base64' → 先 create blob 再引用 sha。 */
  encoding?: 'utf-8' | 'base64';
}

/** pushFiles 参数。 */
export interface PushFilesParams {
  branch: string;
  message: string;
  files: PushFilesFile[];
}

/** pushFiles 返回值。 */
export interface PushFilesResult {
  commit_sha: string;
  tree_sha: string;
  ref_updated: boolean;
  files_pushed: number;
}

// ── Repository (create) ──────────────────────────────────────────────────

/** POST /user/repos 或 POST /orgs/{org}/repos 参数。 */
export interface CreateRepositoryParams {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  /** 传 org 时走 POST /orgs/{org}/repos;否则 POST /user/repos。 */
  org?: string;
  homepage?: string;
  has_issues?: boolean;
  has_projects?: boolean;
  has_wiki?: boolean;
  gitignore_template?: string;
  license_template?: string;
}

// ── Release assets ──────────────────────────────────────────────────────

/** GET /repos/{o}/{r}/releases/{id}/assets 条目。 */
export interface GithubReleaseAsset {
  id: number;
  node_id: string;
  name: string;
  label: string | null;
  content_type: string;
  state: 'uploaded' | 'open' | string;
  size: number;
  download_count: number;
  created_at: string;
  updated_at: string;
  browser_download_url: string;
  uploader: GithubUser | null;
}

// ── Sub-issues (2024 feature) ───────────────────────────────────────────

/** POST /repos/{o}/{r}/issues/{n}/sub_issues 参数。 */
export interface AddSubIssueParams {
  /** **child issue 的全局 id(不是 number-in-repo)**。 */
  sub_issue_id: number;
  replace_parent?: boolean;
}

/** GitHub API 调用失败时抛出 */
export class GithubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}
