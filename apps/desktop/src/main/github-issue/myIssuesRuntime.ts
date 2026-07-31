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

import {
  MY_ISSUES_REPOSITORY,
  type MyIssuesDegradedReason,
  type MyIssuesSnapshot,
} from '../../shared/myIssues.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService';
import { getSharedGhCliTokenSource } from '../git-context/ghCliTokenSource.js';
import { createLogger } from '../logger.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { serverApiFetch } from '../serverApiClient';
import { getSharedGithubUserSubmitterDeps } from './cindyGithubGhostDeps.js';
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
import { readMyIssuesSnapshot, writeMyIssuesSnapshot } from './myIssuesSnapshotStore.js';

const log = createLogger('github-issue/my-issues-runtime');

/** 平台读接口。与 POST /api/github/issues 同一个服务,同一份登录态。 */
const PLATFORM_MY_ISSUES_PATH = '/api/github/issues/mine';

/** GitHub 用户名字符集。拼进 search q 前必须校验,否则 login 里的空格 / 冒号会变成查询限定符。 */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * 平台列表请求的上限。serverApiFetch 默认不设 deadline,而这条是页面加载路径,
 * 与增强分支并行 await —— 不设上限时服务端 hang 住会把整页钉在 loading。
 */
const PLATFORM_FETCH_TIMEOUT_MS = 10_000;

const GHOST_IDENTITY_TIMEOUT_MS = 5_000;
/**
 * 增强搜索的插件通道超时。service 层另有一道整体超时兜着,但这里也必须传 ——
 * 那道只是放弃等待,这道才真正让插件调用自己了结(通道默认 330s)。
 *
 * 刻意不占满 service 那 8s 预算:插件搜不到时还要走 gh CLI 兜底,两段合计必须留在
 * 同一次总 deadline 内。权限类失败是立即 422,所以正常情况下兜底有近 8s 可用。
 */
const GHOST_SEARCH_TIMEOUT_MS = 4_000;

let serviceInstance: MyIssuesService | null = null;

export function getMyIssuesService(): MyIssuesService {
  if (!serviceInstance) {
    serviceInstance = new MyIssuesService({
      readLedger: listSubmittedIssues,
      fetchPlatformIssues: fetchPlatformIssues,
      resolveGithubEnhancement: resolveGithubEnhancement,
      searchAuthoredIssues: searchAuthoredIssues,
      searchAuthoredIssuesFallback: searchAuthoredIssuesFallback,
      writeSnapshot: writeMyIssuesSnapshot,
      readScope: activeOwnerScopeKey,
    });
  }
  return serviceInstance;
}

/** 首屏快照:进页面先渲染上次结果,不用空等远端。没有 / 坏掉返回 null。 */
export function getMyIssuesSnapshot(): MyIssuesSnapshot | null {
  return readMyIssuesSnapshot();
}

/** 提交成功后让列表缓存立即失效,不然新提交的那条最多要等 60s 才出现。 */
export function invalidateMyIssuesCache(): void {
  serviceInstance?.invalidate();
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
      // 必须显式传:serverApiFetch 默认 timeoutMs=0 即**不设 deadline**。这是页面
      // 加载路径,且与增强分支是并行 await 的 —— 服务端连上却不回时,不设上限会让
      // 本机账本一直被 loading 遮住。超时按 fetch-failed 降级。
      timeoutMs: PLATFORM_FETCH_TIMEOUT_MS,
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

/**
 * 身份解析:插件优先,本机 gh CLI 兜底。
 *
 * 这里锁定的只是**身份来源**,不代表数据也只能从那条通道取 —— 两者曾被混为一谈:
 * 插件报出身份后 gh CLI 就再也不会被尝试,于是 PAT 搜不动本仓时整路放弃。取数的回退
 * 在 service 层(searchAuthoredIssuesFallback),与身份来源解耦。
 *
 * **返回 null = 一条都没配(正常状态,静默);抛出 = 配了却问不出身份**(要提示,且不许拿
 * 缩水的结果覆盖首屏快照)。上一版把两条通道的身份失败都咽成 null,于是与「没配」不可
 * 区分:凭据过期 / 被撤销 / 通道超时 / GitHub 限流时,用户直接在 GitHub 提的那些 issue
 * 静静消失,页面一个字都不说,而缩水的结果还照样覆盖了完整快照。
 *
 * 判据是「**有没有通道配过**」,不是「哪一步报了错」——
 * `isCindyGithubGhostUsable` 含 `isGithubCredentialSaved()`,所以它为真就意味着用户确实
 * 存过 GitHub 凭据;「装了插件但从未授权」根本进不到这个分支(那时它为假)。同理 gh 那路
 * 以「有没有 token」判配没配。任一通道配过却一个身份都没拿到,就是配了用不上。
 *
 * (曾经错在这里:以为插件那步含糊、怕对「装了没授权」的用户误报,于是让它静默落到
 * 「没配」。但那种用户压根到不了这一步 —— 前提判错,结论也就跟着错。)
 */
async function resolveGithubEnhancement(): Promise<GithubEnhancementViewer | null> {
  const ghostDeps = getSharedGithubUserSubmitterDeps();
  // workdir 传 null:/issues 是全局页面,没有会话工作目录上下文。
  const ghostConfigured = isCindyGithubGhostUsable(ghostDeps, null);
  if (ghostConfigured) {
    const login = await readGhostViewerLogin(ghostDeps);
    // 插件问不出身份时不直接判死:gh CLI 可能有权限,下面照常再试一次。
    if (login) return { source: 'ghost', login };
  }

  const token = await getSharedGhCliTokenSource().readToken();
  if (!token) {
    // gh 这一路没配。插件那一路要是配过,说明「配了却一个身份都没拿到」⇒ 失败。
    if (ghostConfigured) {
      throw new Error('github enhancement identity lookup failed on every configured channel');
    }
    return null;
  }
  // 有 token 却问不出身份,同样是配了却用不上。
  const user = await userScopedClient(token).getCurrentUser();
  if (typeof user.login !== 'string' || user.login.length === 0) {
    throw new Error('gh cli viewer lookup returned no login');
  }
  return { source: 'gh-cli', login: user.login, token };
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

/**
 * 两条通道共用同一份查询参数 —— 各写一份迟早会漂移(而且 login 的校验漏在哪条上,
 * 那条就能把 login 里的空格 / 冒号当查询限定符送出去)。
 */
function authoredSearchParams(login: string): {
  q: string;
  sort: string;
  order: 'desc';
  per_page: number;
} {
  if (!GITHUB_LOGIN_RE.test(login)) {
    throw new Error(`refusing to search with a malformed GitHub login: ${login}`);
  }
  const { owner, repo } = MY_ISSUES_REPOSITORY;
  return {
    q: `repo:${owner}/${repo} is:issue author:${login}`,
    sort: 'created',
    order: 'desc',
    per_page: SEARCH_PAGE_SIZE,
  };
}

async function searchAuthoredIssues(
  viewer: GithubEnhancementViewer,
  login: string,
): Promise<RemoteIssuePage> {
  const params = authoredSearchParams(login);

  if (viewer.source === 'ghost') {
    const operation = await callCindyGithubOperation(
      getSharedGithubUserSubmitterDeps(),
      'search_issues_and_prs',
      params,
      { timeoutMs: GHOST_SEARCH_TIMEOUT_MS },
    );
    if (!operation.ok) throw new Error(operation.message);
    return parseIssuePage(operation.data);
  }

  return parseIssuePage(await repoScopedClient(requireToken(viewer)).searchIssuesAndPRs(params));
}

/**
 * 兜底通道:本机 `gh auth token`。插件 PAT 搜不动本仓时(fine-grained token 对未显式
 * 授权的仓库返回 422,即使仓库公开)由它接手 —— gh 的 OAuth token 权限完整。
 *
 * 返回 null = 没装 / 没登录 gh,没有兜底可用。ghCliTokenSource 会探测 homebrew 等绝对
 * 路径,所以 GUI 启动的正式版(PATH 精简)同样能找到 gh。
 */
async function searchAuthoredIssuesFallback(login: string): Promise<RemoteIssuePage | null> {
  const token = await getSharedGhCliTokenSource().readToken();
  if (!token) return null;
  const page = await repoScopedClient(token).searchIssuesAndPRs(authoredSearchParams(login));
  return parseIssuePage(page);
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
