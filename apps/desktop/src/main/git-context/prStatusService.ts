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
 *   - 未配置 GitHub PAT 时优雅降级:返回 'no-token',renderer 只显示 PR 号
 *     不显示状态点(不要拿匿名额度 60 req/h 去碰运气,很快会 403 连号都查不了)。
 *   - 依赖(token 读取 / PR 查询)构造时注入,单测不碰网络与 Electron。
 */

import { createLogger } from '../logger.js';

const log = createLogger('git-context/pr-status');

/** PR 四态 + 查询失败的降级态。 */
export type PrStatusKind = 'open' | 'draft' | 'merged' | 'closed';

export interface PrStatusQuery {
  owner: string;
  repo: string;
  prNumber: number;
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
       * 上限 100)。null = 查询失败 / token 不支持 GraphQL,UI 不显示该信号。
       */
      unresolvedCount: number | null;
    }
  | {
      ok: false;
      owner: string;
      repo: string;
      prNumber: number;
      /** no-token = 未配 PAT;not-found = PR 不存在/无权限;fetch-failed = 网络等其它错误。 */
      reason: 'no-token' | 'not-found' | 'fetch-failed';
    };

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
}

export interface PrStatusServiceDeps {
  /** 读当前 GitHub PAT;null = 未配置。 */
  readToken: () => Promise<string | null>;
  /** 查单条 PR。404 等错误直接抛(带 status 的错误对象)。 */
  fetchPr: (token: string, q: PrStatusQuery) => Promise<PrRemoteState>;
  /** 缓存 TTL,默认 60s。测试可注小值。 */
  cacheTtlMs?: number;
  now?: () => number;
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
}

const DEFAULT_TTL_MS = 60_000;
/** 单次批量查询上限——renderer 正常只显示前几条,防御异常调用。 */
const MAX_BATCH = 10;

export class PrStatusService {
  private readonly deps: Required<Pick<PrStatusServiceDeps, 'readToken' | 'fetchPr'>> &
    PrStatusServiceDeps;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PrStatusResult>>();

  constructor(deps: PrStatusServiceDeps) {
    this.deps = deps;
    this.ttlMs = deps.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /** 批量查询(上限 MAX_BATCH,超出部分忽略)。永不抛错,失败映射为 reason。 */
  async getStatuses(queries: PrStatusQuery[]): Promise<PrStatusResult[]> {
    const bounded = queries.slice(0, MAX_BATCH);
    return Promise.all(bounded.map((q) => this.getOne(q)));
  }

  private async getOne(q: PrStatusQuery): Promise<PrStatusResult> {
    const key = `${q.owner.toLowerCase()}/${q.repo.toLowerCase()}#${q.prNumber}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.result;

    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;

    const p = this.fetchOne(q)
      .then((result) => {
        // 只缓存确定性结果(ok / not-found)。两类失败都不缓存:
        //  - no-token:设置页配完 PAT 后下一次查询应立即生效;
        //  - fetch-failed:瞬时网络抖动 / 临时 5xx 不该把失败钉死满 TTL,
        //    下次渲染触发查询时立即重试(review 反馈)。
        if (result.ok || result.reason === 'not-found') {
          this.cache.set(key, { result, expiresAt: this.now() + this.ttlMs });
        }
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, p);
    return p;
  }

  private async fetchOne(q: PrStatusQuery): Promise<PrStatusResult> {
    const base = { owner: q.owner, repo: q.repo, prNumber: q.prNumber };
    let token: string | null = null;
    try {
      token = await this.deps.readToken();
    } catch (err) {
      log.warn('read github pat failed', { err: String(err) });
    }
    if (!token) return { ok: false, ...base, reason: 'no-token' };

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
      };
    } catch (err) {
      const status = (err as { status?: unknown })?.status;
      if (status === 404) return { ok: false, ...base, reason: 'not-found' };
      log.warn('fetch pr status failed', { key: `${q.owner}/${q.repo}#${q.prNumber}`, err: String(err) });
      return { ok: false, ...base, reason: 'fetch-failed' };
    }
  }
}
