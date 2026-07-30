/**
 * myIssuesRuntime —— 「我的 Issue」查询的真实依赖接线。
 *
 * 主通道 = 平台公共能力,与提交 issue 完全同源:同一个 github-server
 * (`githubApiBaseUrl`)、同一份 Cindy 登录态。**不要求用户有 GitHub 账号**。
 * 服务端(独立仓)尚未提供这条读接口时返回 404,这里归一成
 * `platform-unavailable`,由 service 降级成「只展示本机账本」,接口上线后零改动生效。
 *
 * 可选增强 = 用户自己的 GitHub 身份,仅用于把他**直接在 GitHub 上**提的 issue 也并
 * 进来。两条来源,都只是加成:
 *  1. `ghost` —— Cindy GitHub 插件(PAT 存在加密 secret store,main 侧读不到明文,
 *     只能经 call_tool 走);
 *  2. `gh-cli` —— 本机 `gh auth token`(与 PR 状态徽标同一个来源)。
 * 两者都没有属于正常状态,不去碰 GitHub 匿名额度(60 req/h,很快 403)。
 */

import { GithubClient } from '@cindy/github-client';

import { MY_ISSUES_REPOSITORY, type MyIssuesDegradedReason } from '../../shared/myIssues.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { getActiveAppSession } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService';
import { getSharedGhCliTokenSource } from '../git-context/ghCliTokenSource.js';
import { createLogger } from '../logger.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { serverApiFetch } from '../serverApiClient';
import { buildGithubUserSubmitterDeps } from './cindyGithubGhostDeps.js';
import { parseIssuePage } from './githubIssuePayload.js';
import {
  callCindyGithubOperation,
  isCindyGithubGhostUsable,
  type GithubUserIssueSubmitterDeps,
} from './githubUserIssueSubmitter.js';
import {
  MyIssuesService,
  SEARCH_PAGE_SIZE,
  type GithubEnhancementViewer,
  type PlatformIssuesOutcome,
  type RemoteIssuePage,
} from './myIssuesService.js';
import { listSubmittedIssues } from './submittedIssueLedger.js';

const log = createLogger('github-issue/my-issues-runtime');

/** 平台读接口。与 POST /api/github/issues 同一个服务,同一份登录态。 */
const PLATFORM_MY_ISSUES_PATH = '/api/github/issues/mine';

/** GitHub 用户名字符集。拼进 search q 前必须校验,否则 login 里的空格 / 冒号会变成查询限定符。 */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const GHOST_IDENTITY_TIMEOUT_MS = 5_000;

let serviceInstance: MyIssuesService | null = null;

export function getMyIssuesService(): MyIssuesService {
  if (!serviceInstance) {
    serviceInstance = new MyIssuesService({
      readLedger: listSubmittedIssues,
      fetchPlatformIssues: fetchPlatformIssues,
      resolveGithubEnhancement: resolveGithubEnhancement,
      searchAuthoredIssues: searchAuthoredIssues,
      readScope: readAccountScope,
    });
  }
  return serviceInstance;
}

/** 提交成功后让列表缓存立即失效,不然新提交的那条最多要等 60s 才出现。 */
export function invalidateMyIssuesCache(): void {
  serviceInstance?.invalidate();
}

/**
 * 账号作用域键。generation 在每次 mode / dataOwnerId 变化时递增
 * (appSessionState.commitActiveAppSession),所以切号后旧缓存与旧在途结果一律作废 ——
 * issue 列表是账号私有数据,进程级单例不能跨账号复用。
 */
function readAccountScope(): string {
  const session = getActiveAppSession();
  return `${session.mode}:${session.dataOwnerId ?? 'none'}:${session.generation}`;
}

/** 平台通道。约定不抛:所有失败归一成 reason,由 UI 如实说明。 */
async function fetchPlatformIssues(): Promise<PlatformIssuesOutcome> {
  if (!getAppCapabilities().canUseCindyAccountServices) {
    return { ok: false, reason: 'not-signed-in' };
  }
  try {
    const data = await serverApiFetch<unknown>(PLATFORM_MY_ISSUES_PATH, {
      method: 'GET',
      // 与提交路径同源;resolver 形态保证 401 refresh 切区域后重新读端点。
      baseUrl: () => getClientEndpoint('githubApiBaseUrl'),
    });
    return { ok: true, page: parseIssuePage(data) };
  } catch (err) {
    const reason = mapPlatformFailure(err);
    log.debug('platform my-issues fetch failed', { reason, error: errorText(err) });
    return { ok: false, reason };
  }
}

/**
 * 按 ServerApiError 的 statusCode duck-typing(不 import 网络实现的具体类型)。
 * 404 / 501 = 服务端还没提供这条读接口,是**预期状态**而非故障。
 */
function mapPlatformFailure(err: unknown): MyIssuesDegradedReason {
  const statusCode =
    err && typeof err === 'object' && 'statusCode' in err
      ? (err as { statusCode?: unknown }).statusCode
      : undefined;
  if (statusCode === 404 || statusCode === 501) return 'platform-unavailable';
  if (statusCode === 401 || statusCode === 403) return 'not-signed-in';
  return 'fetch-failed';
}

async function resolveGithubEnhancement(): Promise<GithubEnhancementViewer | null> {
  const ghostDeps = buildGithubUserSubmitterDeps();
  // workdir 传 null:/issues 是全局页面,没有会话工作目录上下文。
  if (isCindyGithubGhostUsable(ghostDeps, null)) {
    const login = await readGhostViewerLogin(ghostDeps);
    if (login) return { source: 'ghost', login };
  }

  const token = await getSharedGhCliTokenSource().readToken();
  if (!token) return null;
  try {
    const user = await userScopedClient(token).getCurrentUser();
    if (typeof user.login === 'string' && user.login.length > 0) {
      return { source: 'gh-cli', login: user.login, token };
    }
  } catch (err) {
    log.debug('gh cli viewer lookup failed', { error: errorText(err) });
  }
  return null;
}

async function readGhostViewerLogin(
  deps: GithubUserIssueSubmitterDeps,
): Promise<string | null> {
  try {
    const operation = await callCindyGithubOperation(deps, 'get_current_user', {}, {
      timeoutMs: GHOST_IDENTITY_TIMEOUT_MS,
    });
    if (!operation.ok) {
      log.debug('ghost viewer lookup unavailable', { message: operation.message });
      return null;
    }
    const login = (operation.data as { login?: unknown } | null)?.login;
    return typeof login === 'string' && login.trim().length > 0 ? login.trim() : null;
  } catch (err) {
    log.debug('ghost viewer lookup threw', { error: errorText(err) });
    return null;
  }
}

async function searchAuthoredIssues(
  viewer: GithubEnhancementViewer,
  login: string,
): Promise<RemoteIssuePage> {
  if (!GITHUB_LOGIN_RE.test(login)) {
    throw new Error(`refusing to search with a malformed GitHub login: ${login}`);
  }
  const { owner, repo } = MY_ISSUES_REPOSITORY;
  const q = `repo:${owner}/${repo} is:issue author:${login}`;
  const params = { q, sort: 'created', order: 'desc' as const, per_page: SEARCH_PAGE_SIZE };

  if (viewer.source === 'ghost') {
    const operation = await callCindyGithubOperation(
      buildGithubUserSubmitterDeps(),
      'search_issues_and_prs',
      params,
    );
    if (!operation.ok) throw new Error(operation.message);
    return parseIssuePage(operation.data);
  }

  return parseIssuePage(await repoScopedClient(requireToken(viewer)).searchIssuesAndPRs(params));
}

function requireToken(viewer: GithubEnhancementViewer): string {
  if (!viewer.token) throw new Error('gh-cli viewer is missing its token');
  return viewer.token;
}

/** fetchImpl:api.github.com 是境外端点,走吃系统代理的通道(同 git-context)。 */
function repoScopedClient(token: string): GithubClient {
  return new GithubClient({
    token,
    owner: MY_ISSUES_REPOSITORY.owner,
    repo: MY_ISSUES_REPOSITORY.repo,
    fetchImpl: outboundFetch,
  });
}

function userScopedClient(token: string): GithubClient {
  return new GithubClient({ token, fetchImpl: outboundFetch });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
