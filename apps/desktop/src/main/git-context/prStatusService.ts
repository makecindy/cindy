/**
 * prStatusService — PR 实时状态查询(GitHub API + 短 TTL 缓存)。
 *
 * 数据流:renderer 拿到 session 的 PR 引用列表后,批量调 git-context:pr-status
 * IPC → 本服务对每条 (owner, repo, number) 查 GitHub `GET /pulls/{number}`,
 * 映射成四态:open / draft / merged / closed。
 *
 * 设计约束:
 *   - 状态是易变远端数据,**不落库**;60s TTL 内存缓存 + in-flight 去重,
 *     防止徽标重渲染打爆 API(PAT 限额 5000 req/h)。
 *   - 拿不到 GitHub token 时优雅降级:按 gh CLI 的失败原因返回
 *     'gh-missing' / 'gh-not-logged-in',renderer 据此把徽标点击变成引导动作;
 *     只显示 PR 号不显示状态点(不要拿匿名额度 60 req/h 去碰运气,很快会 403
 *     连号都查不了)。device-link 远端查询统一归为 'no-token':远端控制器不该
 *     指导被控机装 gh 或登录。
 *   - 依赖(token 读取 / PR 查询)构造时注入,单测不碰网络与 Electron。
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { GhCliTokenReadResult } from './ghCliTokenSource.js';
import type { PrChecksSummary } from '@cindy/maker-shared';

const log = createLogger('git-context/pr-status');

/** PR 四态 + 查询失败的降级态。 */
export type PrStatusKind = 'open' | 'draft' | 'merged' | 'closed';

export interface PrStatusQuery {
  owner: string;
  repo: string;
  prNumber: number;
}

/** Restrict remote status reads to PRs already attached to the target session. */
export function filterPrStatusQueriesForRefs(
  queries: readonly PrStatusQuery[],
  refs: readonly PrStatusQuery[],
): PrStatusQuery[] {
  const allowed = new Set(
    refs.map((ref) => `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.prNumber}`),
  );
  return queries.filter((query) =>
    allowed.has(`${query.owner.toLowerCase()}/${query.repo.toLowerCase()}#${query.prNumber}`),
  );
}

export type PrStatusResult =
  | {
      ok: true;
      owner: string;
      repo: string;
      prNumber: number;
      status: PrStatusKind;
      title: string;
      htmlUrl: string;
      /** PR 的源分支名(GitHub `head.ref`)。会话徽标在拿不到本地工作目录时用它兜底显示分支。 */
      branch: string;
      /**
       * 未解决的 review thread 数(GraphQL reviewThreads.isResolved 统计,
       * 上限 100)。null = 查询失败、token 不支持 GraphQL 或有未读取的下一页。
       */
      unresolvedCount: number | null;
      checks?: PrChecksSummary | null;
      headSha?: string;
      baseBranch?: string;
      reviewDecision?: string | null;
      observedAt?: number;
      revision?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      owner: string;
      repo: string;
      prNumber: number;
      reason: PrStatusFailureReason;
    };

/**
 * 查询失败原因:
 *   gh-missing       = 本机没有 gh CLI(UI:点击引导 Agent 安装并登录)
 *   gh-not-logged-in = gh 在但未登录 github.com(UI:点击引导 Agent 登录)
 *   no-token         = 拿不到 token 但不告诉原因——device-link 远端查询、或 gh 子进程超时
 *   not-found        = PR 不存在 / 无权限(404)
 *   fetch-failed     = 网络等其它错误
 */
export type PrStatusFailureReason =
  'gh-missing' | 'gh-not-logged-in' | 'no-token' | 'not-found' | 'fetch-failed';

/** 单条 PR 的远端原始字段(github-client GithubPullRequest 的子集 + thread 统计)。 */
export interface PrRemoteState {
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  title: string;
  html_url: string;
  /** PR 源分支名(github-client `head.ref`)。 */
  branch: string;
  /** 未解决 review thread 数;fetch 端拿不到(GraphQL 失败)时为 null。 */
  unresolved_count?: number | null;
  checks?: PrChecksSummary | null;
  head_sha?: string;
  base_branch?: string;
  review_decision?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PrStatusServiceDeps {
  /** 读本机 gh 登录 token,拿不到时带原因(见 ghCliTokenSource.readTokenDetailed)。 */
  readToken: () => Promise<GhCliTokenReadResult>;
  /** 查单条 PR。404 等错误直接抛(带 status 的错误对象)。 */
  fetchPr: (token: string, q: PrStatusQuery) => Promise<PrRemoteState>;
  /** 缓存 TTL,默认 60s。测试可注小值。 */
  cacheTtlMs?: number;
  /**
   * 过期后仍可直接回答的时长,默认 10 分钟:过期条目先原样返回,再后台向 GitHub 复核,
   * 下一次查询拿到新值。PR 状态变化以分钟计,但每次 60s 过期都让侧栏 / 手机等一次
   * ~1.2s 的 GitHub 往返(并占住远程调用名额)并不值得;超过此窗才同步等待。
   */
  staleTtlMs?: number;
  now?: () => number;
  scope?: () => Promise<string>;
}

/** 把远端字段映射为四态。merged 优先于 closed;draft 仅在 open 时有意义。 */
export function mapRemoteToStatus(remote: PrRemoteState): PrStatusKind {
  if (remote.merged || remote.merged_at) return 'merged';
  if (remote.state === 'closed') return 'closed';
  if (remote.draft) return 'draft';
  return 'open';
}

interface CacheEntry {
  result: PrStatusResult;
  expiresAt: number;
  /** 过期后到此刻之前仍可直接回答(后台复核);之后必须同步重查。 */
  staleUntil: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_TTL_MS = 10 * 60_000;
/** 单次批量查询上限——renderer 正常只显示前几条,防御异常调用。 */
const MAX_BATCH = 10;

export class PrStatusService {
  private readonly deps: Required<Pick<PrStatusServiceDeps, 'readToken' | 'fetchPr'>> &
    PrStatusServiceDeps;
  private readonly ttlMs: number;
  private readonly staleTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PrStatusResult>>();
  private generation = 0;
  private scope = '';

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.inFlight.clear();
  }

  constructor(deps: PrStatusServiceDeps) {
    this.deps = deps;
    this.ttlMs = deps.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.staleTtlMs = Math.max(0, deps.staleTtlMs ?? DEFAULT_STALE_TTL_MS);
    this.now = deps.now ?? Date.now;
  }

  /**
   * 批量查询(上限 MAX_BATCH,超出部分忽略)。永不抛错,失败映射为 reason。
   * opts.remote = device-link 远端发起:gh 缺失 / 未登录一律归为 no-token,
   * 不把被控机的本地环境细节交给远端 UI 去引导。
   */
  async getStatuses(
    queries: PrStatusQuery[],
    opts: { remote?: boolean; waitForFresh?: boolean; refresh?: boolean } = {},
  ): Promise<PrStatusResult[]> {
    const scope = (await this.deps.scope?.()) ?? '';
    if (scope !== this.scope) {
      this.invalidate();
      this.scope = scope;
    }
    const generation = this.generation;
    const bounded = queries.slice(0, MAX_BATCH);
    const results = await Promise.all(
      bounded.map((q) => this.getOne(q, opts.waitForFresh, opts.refresh)),
    );
    if (generation !== this.generation || scope !== ((await this.deps.scope?.()) ?? ''))
      return bounded.map((q) => ({ ...q, ok: false, reason: 'no-token' }));
    if (!opts.remote) return results;
    return results.map((r) =>
      !r.ok && (r.reason === 'gh-missing' || r.reason === 'gh-not-logged-in')
        ? { ...r, reason: 'no-token' }
        : r,
    );
  }

  private async getOne(
    q: PrStatusQuery,
    waitForFresh = false,
    refresh = false,
  ): Promise<PrStatusResult> {
    const key = `${q.owner.toLowerCase()}/${q.repo.toLowerCase()}#${q.prNumber}`;
    const cached = this.cache.get(key);
    const now = this.now();
    if (!refresh && cached && cached.expiresAt > now) return cached.result;
    if (!refresh && !waitForFresh && cached && cached.staleUntil > now) {
      // Stale-while-revalidate: answer now, refresh once in the background.
      void this.revalidate(key, q).catch(() => undefined);
      return cached.result;
    }
    return this.revalidate(key, q);
  }

  /** One GitHub read per key at a time; both the stale and the cold path join it. */
  private revalidate(key: string, q: PrStatusQuery): Promise<PrStatusResult> {
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;

    const generation = this.generation;
    const p = this.fetchOne(q)
      .then((result) => {
        // 只缓存确定性结果(ok / not-found)。其余失败都不缓存:
        //  - gh-missing / gh-not-logged-in / no-token:用户装完 gh 或登录后,
        //    下一次查询应立即生效(token source 自带 30s 负缓存兜底);
        //  - fetch-failed:瞬时网络抖动 / 临时 5xx 不该把失败钉死满 TTL,
        //    下次渲染触发查询时立即重试(review 反馈)。过期条目遇到这类失败时
        //    保留原值继续作为 stale 回答,直到 staleUntil。
        if (generation === this.generation && (result.ok || result.reason === 'not-found')) {
          const fetchedAt = this.now();
          if (this.cache.size >= 200 && !this.cache.has(key))
            this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, {
            result,
            expiresAt: fetchedAt + this.ttlMs,
            staleUntil: fetchedAt + this.ttlMs + this.staleTtlMs,
          });
        }
        return result;
      })
      .finally(() => {
        if (this.inFlight.get(key) === p) this.inFlight.delete(key);
      });
    this.inFlight.set(key, p);
    return p;
  }

  private async fetchOne(q: PrStatusQuery): Promise<PrStatusResult> {
    const base = { owner: q.owner, repo: q.repo, prNumber: q.prNumber };
    let read: GhCliTokenReadResult;
    try {
      read = await this.deps.readToken();
    } catch (err) {
      log.warn('read github token failed', { err: String(err) });
      return { ok: false, ...base, reason: 'no-token' };
    }
    if (!read.ok) {
      // 超时 / 执行故障用户做不了什么,不引导;缺失与未登录交给 UI 引导。
      return {
        ok: false,
        ...base,
        reason:
          read.reason === 'gh-timeout' || read.reason === 'gh-exec-failed'
            ? 'no-token'
            : read.reason,
      };
    }
    const token = read.token;

    try {
      const remote = await this.deps.fetchPr(token, q);
      return {
        ok: true,
        ...base,
        status: mapRemoteToStatus(remote),
        title: remote.title,
        htmlUrl: remote.html_url,
        branch: remote.branch,
        unresolvedCount: remote.unresolved_count ?? null,
        checks: remote.checks ?? null,
        headSha: remote.head_sha,
        baseBranch: remote.base_branch,
        reviewDecision: remote.review_decision ?? null,
        observedAt: this.now(),
        revision: randomUUID(),
        metadata: remote.metadata,
      };
    } catch (err) {
      const status = (err as { status?: unknown })?.status;
      if (status === 401) return { ok: false, ...base, reason: 'gh-not-logged-in' };
      if (status === 404) return { ok: false, ...base, reason: 'not-found' };
      log.warn('fetch pr status failed', {
        key: `${q.owner}/${q.repo}#${q.prNumber}`,
        err: String(err),
      });
      return { ok: false, ...base, reason: 'fetch-failed' };
    }
  }
}
