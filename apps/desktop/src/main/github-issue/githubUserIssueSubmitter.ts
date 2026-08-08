/**
 * Cindy GitHub 用户身份提交适配器。
 *
 * PAT 只由 Ghost network slot 注入；本模块仅经 call_tool 调 get_current_user /
 * create_issue。身份在确认前解析，并在真正创建前再次核对，防止确认期间切号。
 */

import type { GithubIssuePostBody, GithubIssuePostResponse } from './githubIssueSubmitService';
import type { IssueSubmissionChoices, IssueSubmissionIdentity } from './issueConfirmBridge';

export const CINDY_GITHUB_GHOST_ID = 'cindy-github';
export const CINDY_GITHUB_SECRET_KEY = 'github_pat';
export const PLATFORM_ISSUE_SUBMISSION_IDENTITY = {
  kind: 'platform',
  login: 'cindy-issue',
} as const satisfies IssueSubmissionIdentity;

const FEEDBACK_REPOSITORY = { owner: 'makecindy', repo: 'cindy' } as const;

type GhostToolCallResult =
  { ok: true; result: unknown } | { ok: false; errorCode: string; message: string };

export interface GithubUserIssueSubmitterDeps {
  isGithubGhostEnabled: () => boolean;
  isGithubCredentialSaved: () => boolean;
  isGithubGhostDisabledForWorkdir: (workdir: string | null | undefined) => boolean;
  callGhostTool: (request: {
    ghostId: string;
    tool: string;
    args: Record<string, unknown>;
  }) => Promise<GhostToolCallResult>;
  identityProbeTimeoutMs?: number;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

interface IssueSubmissionError extends Error {
  issueErrorCode: 'AUTH_NOT_READY' | 'NETWORK_ERROR' | 'SERVER_ERROR';
}

export interface GithubOperationFailure {
  ok: false;
  errorCode: string;
  message: string;
}

/**
 * 插件通道是否可用(已装、已启用、当前 workdir 未停用、且保存了凭证)。
 * 提交路径与「我的 Issue」查询路径共用这一份判定,避免两边口径漂移。
 */
export function isCindyGithubGhostUsable(
  deps: GithubUserIssueSubmitterDeps,
  workdir?: string | null,
): boolean {
  return (
    !deps.isGithubGhostDisabledForWorkdir(workdir) &&
    deps.isGithubGhostEnabled() &&
    deps.isGithubCredentialSaved()
  );
}

/**
 * 本模块对外开放的只读操作名。收成联合类型而不是 string,是为了让拼错的 tool name
 * 在编译期就挂掉 —— 否则 `search_issues_and_prs` 少个字母要等运行到插件通道才失败,
 * 而那条路径的失败又是**静默降级**(可选增强拿不到就当没配),几乎不会被发现。
 */
export type CindyGithubReadOperation = 'get_current_user' | 'search_issues_and_prs';

/**
 * 插件通道支持的全部操作名 = 只读操作 + 提交。**通道函数一律用它,不要放宽成 string**:
 * 加新操作时改这一处,拼错立刻是编译错误。
 */
type CindyGithubOperation = CindyGithubReadOperation | 'create_issue';

/**
 * 经插件通道调一个只读 GitHub 操作。失败返回结构化 failure(不抛),
 * 响应形状不对时才抛 —— 与提交路径共用同一个通道与解包逻辑。
 */
export function callCindyGithubOperation(
  deps: GithubUserIssueSubmitterDeps,
  name: CindyGithubReadOperation,
  args: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: true; data: unknown } | GithubOperationFailure> {
  return callGithubOperation(deps, name, args, options);
}

/**
 * 平台 Bot 始终作为默认身份返回。GitHub 插件只负责提供一个可选增强：当前配置
 * 完整且身份验证成功时追加本人账号；任何插件、凭证、网络或响应异常都只隐藏
 * 这个可选项，绝不能阻断官方反馈入口。
 */
export async function resolveGithubIssueSubmissionChoices(
  deps: GithubUserIssueSubmitterDeps,
  workdir?: string | null,
): Promise<IssueSubmissionChoices> {
  const platformOnly: IssueSubmissionChoices = {
    platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
  };
  try {
    if (!isCindyGithubGhostUsable(deps, workdir)) {
      return platformOnly;
    }
  } catch (err) {
    logOptionalIdentityUnavailable(deps, 'readiness check failed', err);
    return platformOnly;
  }

  let operation: { ok: true; data: unknown } | GithubOperationFailure;
  try {
    operation = await callGithubOperation(
      deps,
      'get_current_user',
      {},
      {
        timeoutMs: deps.identityProbeTimeoutMs ?? 5000,
      },
    );
  } catch (err) {
    logOptionalIdentityUnavailable(deps, 'identity probe failed', err);
    return platformOnly;
  }
  if (!operation.ok) {
    logOptionalIdentityUnavailable(deps, 'identity probe unavailable', operation);
    return platformOnly;
  }

  try {
    return {
      ...platformOnly,
      githubUser: { kind: 'github-user', login: parseGithubLogin(operation.data) },
    };
  } catch (err) {
    logOptionalIdentityUnavailable(deps, 'identity response invalid', err);
    return platformOnly;
  }
}

/** 按确认过的用户身份创建 issue；任何失败都原样报错，绝不降级到平台身份。 */
export async function postGithubIssueAsUser(
  deps: GithubUserIssueSubmitterDeps,
  identity: Extract<IssueSubmissionIdentity, { kind: 'github-user' }>,
  body: GithubIssuePostBody,
): Promise<GithubIssuePostResponse> {
  const currentUser = await requireGithubOperation(deps, 'get_current_user', {});
  const currentLogin = parseGithubLogin(currentUser);
  if (currentLogin !== identity.login) {
    throw submissionError(
      'AUTH_NOT_READY',
      `确认期间 GitHub 身份已从 @${identity.login} 切换为 @${currentLogin}，issue 未提交。请重新发起并确认提交身份。`,
    );
  }

  const created = await requireGithubOperation(deps, 'create_issue', {
    owner: FEEDBACK_REPOSITORY.owner,
    repo: FEEDBACK_REPOSITORY.repo,
    title: body.title,
    body: buildDirectIssueBody(body),
    labels: [body.type === 'bug' ? 'bug' : 'feature'],
  });
  if (
    !isRecord(created) ||
    typeof created.number !== 'number' ||
    typeof created.html_url !== 'string'
  ) {
    throw submissionError(
      'SERVER_ERROR',
      'Cindy GitHub 返回的 issue 创建结果不完整，issue 状态无法确认，请勿自动重试。',
    );
  }
  return { githubIssue: { number: created.number, url: created.html_url } };
}

async function requireGithubOperation(
  deps: GithubUserIssueSubmitterDeps,
  name: 'get_current_user' | 'create_issue',
  args: Record<string, unknown>,
): Promise<unknown> {
  let operation: { ok: true; data: unknown } | GithubOperationFailure;
  try {
    operation = await callGithubOperation(deps, name, args);
  } catch (err) {
    throw malformedResponseError(`Cindy GitHub 的 ${name} 调用失败`, err);
  }
  if (operation.ok) return operation.data;
  const code = isGithubAuthFailure(operation.message)
    ? 'AUTH_NOT_READY'
    : isNetworkFailure(operation.message)
      ? 'NETWORK_ERROR'
      : 'SERVER_ERROR';
  throw submissionError(
    code,
    code === 'AUTH_NOT_READY'
      ? `GitHub 用户身份或仓库权限不可用，issue 未提交。请到「插件」→「Cindy GitHub」检查 token 权限：${operation.message}`
      : `GitHub 用户身份提交失败，issue 未提交且未切换为平台代提交：${operation.message}`,
  );
}

async function callGithubOperation(
  deps: GithubUserIssueSubmitterDeps,
  name: CindyGithubOperation,
  args: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: true; data: unknown } | GithubOperationFailure> {
  const result = await withOptionalTimeout(
    deps.callGhostTool({
      ghostId: CINDY_GITHUB_GHOST_ID,
      tool: 'call_tool',
      args: { name, args },
    }),
    options.timeoutMs,
    () => ({
      ok: false as const,
      errorCode: 'GHOST_TIMEOUT',
      message: `Cindy GitHub ${name} 超时`,
    }),
  );
  if (!result.ok) return result;
  if (!isRecord(result.result) || !Object.prototype.hasOwnProperty.call(result.result, 'data')) {
    throw new Error('响应缺少 data');
  }
  return { ok: true, data: result.result.data };
}

function parseGithubLogin(value: unknown): string {
  if (!isRecord(value) || typeof value.login !== 'string' || !value.login.trim()) {
    throw submissionError(
      'SERVER_ERROR',
      'Cindy GitHub 未返回有效的 GitHub 用户名，issue 未提交。',
    );
  }
  return value.login.trim();
}

function buildDirectIssueBody(body: GithubIssuePostBody): string {
  return [
    `**客户端版本**: ${body.appVersion}`,
    `**反馈类型**: ${body.type}`,
    '',
    '---',
    '',
    body.description ?? '',
  ].join('\n');
}

function isGithubAuthFailure(message: string): boolean {
  return /token 未配置|token.*失效|凭证.*尚未配置|HTTP 401|HTTP 403|没有权限.*token scope|token scope 不够/i.test(
    message,
  );
}

function isNetworkFailure(message: string): boolean {
  return /网络|network|fetch|ECONN|ENOTFOUND|timed? ?out/i.test(message);
}

function malformedResponseError(context: string, err: unknown): IssueSubmissionError {
  return submissionError(
    'SERVER_ERROR',
    `${context}，issue 未提交：${err instanceof Error ? err.message : String(err)}`,
  );
}

function logOptionalIdentityUnavailable(
  deps: GithubUserIssueSubmitterDeps,
  reason: string,
  detail: unknown,
): void {
  if (!deps.logger) return;
  const meta: Record<string, unknown> = { reason };
  if (detail instanceof Error) {
    meta.errorName = detail.name;
  } else if (isRecord(detail) && typeof detail.errorCode === 'string') {
    meta.errorCode = detail.errorCode;
  }
  try {
    deps.logger.warn(
      'GitHub user identity unavailable; platform issue submission remains available',
      meta,
    );
  } catch {
    // 可选身份的诊断日志也不能反过来阻断平台 Bot 提交。
  }
}

function submissionError(
  issueErrorCode: IssueSubmissionError['issueErrorCode'],
  message: string,
): IssueSubmissionError {
  return Object.assign(new Error(message), { issueErrorCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withOptionalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  fallback: () => T,
): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
