/**
 * myIssuesService —— /issues 页面「我的 Issue」列表的业务体。
 *
 * 核心口径:**看自己的 issue 与提交 issue 走同一条公共能力**,只要 Cindy 登录态,
 * 不要求用户有 GitHub 账号。三路输入:
 *  1. 平台通道(主)—— 服务端按 Cindy 账号返回提交记录 + 实时状态,跨设备;
 *  2. 本机账本 —— 产品内提交时落在本机的记录。平台接口未就绪 / 离线时是唯一来源,
 *     此时状态标 unknown,但标题、编号、类型、时间、链接照常可见;
 *  3. GitHub 账号(可选增强)—— 配了插件 / gh CLI 才有,把用户自己 GitHub 名下的
 *     issue 并进来。缺它只是少一部分内容,**不构成任何前提**。
 *
 * 其它设计约束:
 *   - 状态是易变远端数据,**不落库**;60s TTL 内存缓存 + in-flight 去重,
 *     模式与 git-context/prStatusService 一致。
 *   - 结果超一页会截断,并在返回值里显式标出,不静默丢。
 *   - 依赖全注入、模块 electron-free,单测不碰网络与 Electron。
 */

import type {
  GithubEnhancementSource,
  MyIssueItem,
  MyIssueSource,
  MyIssuesDegradedReason,
  MyIssuesResult,
  SubmittedIssueRecord,
} from '../../shared/myIssues.js';
import { createLogger } from '../logger.js';

const log = createLogger('github-issue/my-issues');

const DEFAULT_CACHE_TTL_MS = 60_000;
/**
 * 可选 GitHub 增强的整体超时。插件通道默认工具超时是 330s
 * (cindy-brain/pipeDispatcher),而增强与平台通道是 Promise.all 并行等的 ——
 * 不设短超时,插件卡住时账本与平台结果早已就绪也会被加载态遮上五分半。
 * 增强只是加成,超时就当「没有增强」,绝不拖累主列表。
 */
const DEFAULT_ENHANCEMENT_TIMEOUT_MS = 8_000;
/** 单次查询只取一页;更多就截断并让 UI 明说,不静默丢也不翻页打爆额度。 */
export const SEARCH_PAGE_SIZE = 100;

/** 可选增强的 GitHub 身份。token 只在 gh CLI 路径存在(插件路径拿不到明文)。 */
export interface GithubEnhancementViewer {
  source: GithubEnhancementSource;
  login: string;
  token?: string;
}

/** 远端 issue 的必要字段子集(平台响应与 GitHub 响应的公共部分)。 */
export interface RemoteIssue {
  number: number;
  title: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string | null;
  commentCount: number | null;
}

/** 一页远端结果 + 远端总数;拿不到总数时为 null。 */
export interface RemoteIssuePage {
  issues: RemoteIssue[];
  totalCount: number | null;
}

/** 平台通道的结果。unavailable 表示服务端还没提供这条读接口。 */
export type PlatformIssuesOutcome =
  | { ok: true; page: RemoteIssuePage }
  | { ok: false; reason: MyIssuesDegradedReason };

export interface MyIssuesServiceDeps {
  readLedger: () => SubmittedIssueRecord[];
  /** 平台通道:按 Cindy 登录态取「我提交过的 issue」。永不抛,失败归一为 reason。 */
  fetchPlatformIssues: () => Promise<PlatformIssuesOutcome>;
  /** 可选增强的 GitHub 身份;没配返回 null(正常状态)。 */
  resolveGithubEnhancement: () => Promise<GithubEnhancementViewer | null>;
  /** 搜该 login 名下的 issue。抛错只丢掉增强部分,不影响主列表。 */
  searchAuthoredIssues: (
    viewer: GithubEnhancementViewer,
    login: string,
  ) => Promise<RemoteIssuePage>;
  /**
   * 当前账号作用域标识(data owner + session generation)。**这是安全边界**:
   * issue 列表含标题、编号与 GitHub 用户名,属于账号私有数据。服务是进程级单例,
   * 缓存与在途请求都必须按它键控,否则 60s TTL 内切号会让新账号看到上一个账号的
   * issue 历史。切号时该值必须变化。
   */
  readScope: () => string;
  cacheTtlMs?: number;
  /** 可选增强整条路径的超时,默认 8s;<=0 关闭(仅测试用)。 */
  enhancementTimeoutMs?: number;
  now?: () => number;
}

/** 结果落地时账号已切换 —— 这份数据属于别人,拒绝交付。 */
export const STALE_ACCOUNT_SCOPE_CODE = 'stale-account-scope';

export function isStaleAccountScopeError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { myIssuesErrorCode?: unknown }).myIssuesErrorCode === STALE_ACCOUNT_SCOPE_CODE
  );
}

function staleAccountScopeError(): Error {
  return Object.assign(
    new Error('active account changed while the issue list was loading; result discarded'),
    { myIssuesErrorCode: STALE_ACCOUNT_SCOPE_CODE },
  );
}

interface CacheEntry {
  at: number;
  scope: string;
  result: MyIssuesResult;
}

export class MyIssuesService {
  private readonly deps: MyIssuesServiceDeps;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: CacheEntry | null = null;
  private inFlight: {
    scope: string;
    /** 发起时的账本世代。invalidate() 之后的调用不得复用更早的在途请求。 */
    epoch: number;
    promise: Promise<MyIssuesResult>;
  } | null = null;
  /** 账本世代。invalidate() 递增,使早于它发起的在途结果不再可缓存。 */
  private cacheEpoch = 0;

  constructor(deps: MyIssuesServiceDeps) {
    this.deps = deps;
    this.ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /** force=true 绕过 TTL(手动刷新按钮),但仍复用**同账号**正在飞的请求。 */
  async list(options: { force?: boolean } = {}): Promise<MyIssuesResult> {
    const scope = this.deps.readScope();
    if (
      !options.force &&
      this.cache &&
      this.cache.scope === scope &&
      this.now() - this.cache.at < this.ttlMs
    ) {
      return this.cache.result;
    }
    // 发起时的账本世代。invalidate() 会递增它 —— 见 settle() 的两条不变量。
    const epochAtStart = this.cacheEpoch;
    // 复用在途请求要求**账号与世代都相同**:只比 scope 的话,提交成功
    // (invalidate 递增世代)之后发起的查询会复用那个读了旧账本的在途请求,
    // 拿回不含新 issue 的快照,而页面不会自动再查一次。
    if (
      this.inFlight &&
      this.inFlight.scope === scope &&
      this.inFlight.epoch === epochAtStart
    ) {
      return this.inFlight.promise;
    }
    const promise = this.load()
      .then((result) => this.settle(result, scope, epochAtStart))
      .finally(() => {
        // 只清自己那条,别把切号后新起的在途请求误清掉。
        if (this.inFlight?.promise === promise) this.inFlight = null;
      });
    this.inFlight = { scope, epoch: epochAtStart, promise };
    return promise;
  }

  /**
   * 结果落地的**唯一**收口。两条不变量刻意分开判,因为它们并不对称 ——
   * 上一版把两者混成一个「不写缓存」的判断,于是漏掉了「也不能返回」这半条:
   *
   *  1. 归属(安全):结果只能交给发起它的那个账号。落地时 scope 变了说明期间切了号,
   *     这份数据属于别人 —— **既不返回也不缓存**,直接拒绝,让调用方按新账号重取。
   *  2. 新鲜度(正确性):落地时 epoch 变了说明期间有提交成功过。数据仍是本账号的,
   *     所以照常**返回**(拒绝只会让刚提交完的用户看到一次假错误),但**不得落缓存** ——
   *     否则接下来 60s 都会命中这个不含新 issue 的旧快照。
   */
  private settle(result: MyIssuesResult, scope: string, epochAtStart: number): MyIssuesResult {
    if (this.deps.readScope() !== scope) {
      throw staleAccountScopeError();
    }
    if (this.cacheEpoch === epochAtStart) {
      this.cache = { at: this.now(), scope, result };
    }
    return result;
  }

  /**
   * 提交成功后调用:账本变了,缓存立即失效,下次进页面能看到新提交的那条。
   * 递增 epoch 是关键 —— 只清 cache 挡不住「早于本次提交发起、晚于本次提交完成」
   * 的那个请求把旧快照写回来。
   */
  invalidate(): void {
    this.cache = null;
    this.cacheEpoch += 1;
  }

  private async load(): Promise<MyIssuesResult> {
    const ledger = this.deps.readLedger();

    // 两路互不阻塞:平台通道挂了不能连可选增强一起拖掉,反之亦然。
    const [platform, enhancement] = await Promise.all([
      this.loadPlatform(),
      this.loadGithubEnhancement(),
    ]);

    return {
      items: mergeIssues(ledger, enhancement.issues, platform.issues),
      githubEnhancement: enhancement.viewer
        ? { login: enhancement.viewer.login, source: enhancement.viewer.source }
        : null,
      degraded: platform.degraded,
      truncated: platform.truncated || enhancement.truncated,
    };
  }

  private async loadPlatform(): Promise<{
    issues: RemoteIssue[];
    degraded: MyIssuesDegradedReason | null;
    truncated: boolean;
  }> {
    let outcome: PlatformIssuesOutcome;
    try {
      outcome = await this.deps.fetchPlatformIssues();
    } catch (err) {
      // fetchPlatformIssues 约定不抛;真抛了也不能把整页打挂。
      log.warn('platform issues fetch threw', { error: errorText(err) });
      return { issues: [], degraded: 'fetch-failed', truncated: false };
    }
    if (!outcome.ok) {
      log.debug('platform issues unavailable', { reason: outcome.reason });
      return { issues: [], degraded: outcome.reason, truncated: false };
    }
    return {
      issues: outcome.page.issues,
      degraded: null,
      truncated: isTruncated(outcome.page),
    };
  }

  /**
   * 可选增强。整条路径(身份解析 + 搜索)共用**一次**总 deadline —— 分阶段各起一次
   * 计时器会让第二段重置 deadline,页面最坏等两倍时长(#1103 review 实例:注释写
   * 「整条路径 8s」,实现却是 8s + 8s)。
   *
   * 插件通道自己的默认超时长达 330s,而这一路与平台通道并行 await,卡住就等于把
   * 整页遮住。超时、失败、没配置三种情况对用户是同一个结果 ——「这次没有增强」,
   * 主列表照常出。
   *
   * 注:runtime 侧另给插件调用传了各自的 timeoutMs(身份 5s / 搜索 6s),那是让**通道
   * 自己了结**,与这里的页面等待上限目的不同,不能互相替代。
   */
  private async loadGithubEnhancement(): Promise<{
    viewer: GithubEnhancementViewer | null;
    issues: RemoteIssue[];
    truncated: boolean;
  }> {
    // 总超时触发时也要能回传已经解析成功的身份:header 照常显示并入了谁名下的 issue,
    // 只是这一次没并进内容。所以把它记在闭包外。
    let resolved: GithubEnhancementViewer | null = null;
    try {
      return await this.withEnhancementDeadline(async () => {
        resolved = await this.deps.resolveGithubEnhancement();
        const viewer = resolved;
        if (!viewer) return { viewer: null, issues: [], truncated: false };
        try {
          const page = await this.deps.searchAuthoredIssues(viewer, viewer.login);
          return { viewer, issues: page.issues, truncated: isTruncated(page) };
        } catch (err) {
          // 搜索失败(非超时)不算列表降级 —— 主路径是平台通道。
          log.debug('github enhancement search failed', { error: errorText(err) });
          return { viewer, issues: [], truncated: false };
        }
      });
    } catch (err) {
      // 没有 GitHub 身份是正常状态;解析失败与总超时同样只是「这次没有增强」。
      log.debug('github enhancement unavailable', { error: errorText(err) });
      return { viewer: resolved, issues: [], truncated: false };
    }
  }

  /** 整条增强路径的单次 deadline;<=0 表示关闭(仅测试用)。 */
  private withEnhancementDeadline<T>(run: () => Promise<T>): Promise<T> {
    const timeoutMs = this.deps.enhancementTimeoutMs ?? DEFAULT_ENHANCEMENT_TIMEOUT_MS;
    if (timeoutMs <= 0) return run();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`github enhancement timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      run().then(
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
}

/**
 * 合并三路输入,按 issue 号去重、远端字段覆盖账本历史字段(标题会被维护者改),
 * 按创建时间倒序。纯函数,单测直接调。
 *
 * 来源标记的区别是关键:
 *  - `authored` 是按 `author:<login>` 搜出来的,命中即证明是本人 GitHub 账号发的 →
 *    打 github-account;
 *  - `platform` 是服务端按 Cindy 账号返回的产品内提交记录。平台代发的 issue 在
 *    GitHub 上作者是 cindy-issue App,**不是**本人 → 只打 cindy-tool。
 */
export function mergeIssues(
  ledger: SubmittedIssueRecord[],
  authored: RemoteIssue[],
  platform: RemoteIssue[] = [],
): MyIssueItem[] {
  const byNumber = new Map<number, MyIssueItem>();

  for (const record of ledger) {
    byNumber.set(record.number, ledgerOnlyItem(record));
  }
  for (const issue of platform) {
    byNumber.set(issue.number, overlayRemote(byNumber.get(issue.number), issue, 'cindy-tool'));
  }
  for (const issue of authored) {
    byNumber.set(issue.number, overlayRemote(byNumber.get(issue.number), issue, 'github-account'));
  }

  return [...byNumber.values()].sort((a, b) => {
    const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    // 同一时间戳时按 issue 号兜底,保证顺序稳定、不随 Map 插入顺序抖。
    return delta !== 0 ? delta : b.number - a.number;
  });
}

function overlayRemote(
  existing: MyIssueItem | undefined,
  issue: RemoteIssue,
  source: MyIssueSource,
): MyIssueItem {
  const sources: MyIssueSource[] = existing ? [...existing.sources] : [];
  if (!sources.includes(source)) sources.push(source);
  return {
    number: issue.number,
    url: issue.htmlUrl,
    title: issue.title,
    // 远端标签被人工清掉时回退账本记的类型,而不是莫名变成「无类型」。
    type: issueTypeFromLabels(issue.labels) ?? existing?.type ?? null,
    state: issue.state,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    commentCount: issue.commentCount,
    sources: sortSources(sources),
  };
}

/** 固定「产品内提交」在前,保证同一条 issue 的来源顺序不随合并顺序抖。 */
function sortSources(sources: MyIssueSource[]): MyIssueSource[] {
  const order: MyIssueSource[] = ['cindy-tool', 'github-account'];
  return order.filter((source) => sources.includes(source));
}

/** 拿不到远端数据时的形态:标题用账本记的那一版,状态明确标 unknown。 */
function ledgerOnlyItem(record: SubmittedIssueRecord): MyIssueItem {
  return {
    number: record.number,
    url: record.url,
    title: record.title,
    type: record.type,
    state: 'unknown',
    createdAt: record.submittedAt,
    updatedAt: null,
    commentCount: null,
    sources: ['cindy-tool'],
  };
}

/** 反馈 issue 由提交链路打 bug / feature 标签;人工改过标签时回退 null。 */
export function issueTypeFromLabels(labels: string[]): 'bug' | 'feature' | null {
  const lowered = labels.map((label) => label.toLowerCase());
  if (lowered.includes('bug')) return 'bug';
  if (lowered.includes('feature')) return 'feature';
  return null;
}

function isTruncated(page: RemoteIssuePage): boolean {
  return page.totalCount !== null && page.totalCount > page.issues.length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
