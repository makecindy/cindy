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
  MyIssuesSnapshot,
  SubmittedIssueRecord,
} from '../../shared/myIssues.js';
import { myIssueUrl } from '../../shared/myIssues.js';
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

/**
 * 启动兜底搜索所需的最低剩余预算。低于它就不去试 —— 那次请求注定等不到、又不能取消
 * (见 canTryFallback),白耗一次 GitHub 额度。gh CLI 搜索实测远快于此。
 */
const MIN_FALLBACK_BUDGET_MS = 1_500;

/**
 * 平台通道的整体超时。比 runtime 侧给 serverApiFetch 的单次 fetch 上限更长,
 * 因为它要覆盖**整条调用链**:401 → authManager.refresh() → 重试。那次 refresh
 * 自己是 `timeoutMs: 0`(无上限),所以只约束单次 fetch 挡不住整条链挂死。
 */
const DEFAULT_PLATFORM_TIMEOUT_MS = 12_000;
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
   * 主通道搜索失败时的**兜底通道**(本机 gh CLI)。返回 null = 没有兜底可用。
   *
   * 为什么必须有:身份能报出来 ≠ 这一路能查到数据。插件 PAT 若是 fine-grained
   * token,`get_current_user` 正常、搜本仓却被 GitHub 以 422 拒绝(未显式授权的仓库
   * 即使公开也搜不到)—— 上一版就此整路放弃,而本机 gh CLI 明明有权限。
   *
   * 分开注入而不是让 searchAuthoredIssues 内部消化:runtime 是真实接线、不进单测,
   * 「主通道失败必须换通道再试」这条不变量只有放这一层才钉得住。
   */
  searchAuthoredIssuesFallback?: (login: string) => Promise<RemoteIssuePage | null>;
  /**
   * 落地成功后写首屏快照(下次进页面先渲染它,不用空等远端)。
   * 注入而非直接 import,是为了让本模块保持 electron-free、单测不碰磁盘。
   */
  writeSnapshot?: (snapshot: MyIssuesSnapshot) => void;
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
  /** 平台通道整条调用链的超时,默认 12s;<=0 关闭(仅测试用)。 */
  platformTimeoutMs?: number;
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

/**
 * 单条输入通道这一次的健康状况。
 *
 * 四态而不是布尔,是因为**「没给出内容」有四种性质完全不同的原因**,而下游两个消费者
 * 对它们的处置方向相反(见 `isSnapshotWorthy` 与 `githubEnhancementFailed`):
 *  - `ok`      —— 查了,拿到了(可能就是空的,那是真的空);
 *  - `absent`  —— **没配 / 那边压根还没有这份数据**。正常状态,不是损失;
 *  - `failed`  —— 本该有却这次没拿到。内容真的少了一块;
 *  - `unknown` —— 连「配没配」都没问出来(整体超时打断在半路)。既不能说它失败,
 *                 也不能当它正常。
 */
export type ChannelState = 'ok' | 'absent' | 'failed' | 'unknown';

/**
 * 三路输入各自的健康状况。
 *
 * **为什么要有这个类型**:此前判据直接从 `MyIssuesResult` 推断「这次丢没丢内容」,而那份
 * 结果里的健康信息是**残缺的** —— 平台的挤在 `degraded`、增强的挤在
 * `githubEnhancementFailed`、**账本的根本没有位置**(读失败时被静默换成空数组)。信息不在
 * 输入里,判据就必然漏;本 PR 因此连续三轮被指出漏输入(先 degraded、再身份解析失败、
 * 再账本失败与身份超时),每次都是补一个特例而不是补上缺的那一维。
 *
 * 现在三路都必须显式报状态,判据从这里推导。再加第四路输入时,这个类型会强迫调用方声明
 * 它的健康 —— 漏输入从「靠人记得」变成结构上不可能。
 */
export interface ChannelHealth {
  platform: ChannelState;
  ledger: ChannelState;
  enhancement: ChannelState;
}

/**
 * 这一次的结果**配不配写进首屏快照**。不配写时保留上一份,不覆盖也不清空。
 *
 * 判据:**三路都没丢内容**(全部 `ok` 或 `absent`)。`failed` 与 `unknown` 都拦下 ——
 * 快照要跨进程活到下一次冷启动,又刻意不带健康状况,拿一份缩水的结果覆盖它,用户下次
 * 进页面看到的就是残缺列表加零提示;仍然离线的话,那份完整列表就永久没了。所以这一侧
 * 遇到不确定必须保守拒写。
 *
 * `absent` 放行是关键:`platform-unavailable`(服务端读接口还没上线)是当前**所有**用户的
 * 常态,把它当成丢内容,快照就永远写不出来、整个首屏加速当场失效。「没配增强」同理。
 *
 * `truncated` 刻意**不**拦:它说的是「还有更多」,不是「显示的这些不对」。首屏本来只需要
 * 第一页,与 UI 当场展示的内容一致。
 *
 * 与 renderer 侧的 `canTrustEmptyList` 刻意**不是同一个判据,别去合并**:那边问「能不能
 * 断言用户从未提交」,空列表 + 平台 `absent` 必须答否;这边问「这些内容能不能原样留给
 * 下次首屏」,同样的组合答是。一个管断言缺失,一个管展示已有 —— 方向相反。
 */
export function isSnapshotWorthy(health: ChannelHealth): boolean {
  return [health.platform, health.ledger, health.enhancement].every(
    (state) => state === 'ok' || state === 'absent',
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
      .then(({ result, health }) => this.settle(result, health, scope, epochAtStart))
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
  private settle(
    result: MyIssuesResult,
    health: ChannelHealth,
    scope: string,
    epochAtStart: number,
  ): MyIssuesResult {
    if (this.deps.readScope() !== scope) {
      throw staleAccountScopeError();
    }
    if (this.cacheEpoch === epochAtStart) {
      this.cache = { at: this.now(), scope, result };
      // 落盘快照比内存缓存**多一条**门槛(isSnapshotWorthy):内存缓存 60s 后自然过期,
      // 而快照要跨进程活到下一次冷启动,还刻意不带健康状况 —— 用一份缩水的结果覆盖它,
      // 用户下次进页面看到的就是残缺列表加零提示。判据吃的是三路健康而不是 result:
      // result 里没有账本那一路的位置,只看它必然漏(本 PR 已因此栽过三次)。
      if (isSnapshotWorthy(health)) {
        this.persistSnapshot(result);
      } else {
        log.debug('skipped the my-issues snapshot write; this result lost content', health);
      }
    }
    return result;
  }

  /**
   * 快照是 best-effort 的首屏加速:写失败只记日志,绝不能把一次成功的查询翻成失败。
   * 刻意只带 items 与身份 —— degraded / failed / truncated 是「这一次查得怎么样」,
   * 缓存它们会让用户进页面就看到一条过期的错误提示。
   */
  private persistSnapshot(result: MyIssuesResult): void {
    const write = this.deps.writeSnapshot;
    if (!write) return;
    try {
      write({
        items: result.items,
        githubEnhancement: result.githubEnhancement,
        cachedAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      log.warn('writing the my-issues snapshot failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  private async load(): Promise<{ result: MyIssuesResult; health: ChannelHealth }> {
    const ledger = this.readLedgerSafely();

    // 两路互不阻塞:平台通道挂了不能连可选增强一起拖掉,反之亦然。
    const [platform, enhancement] = await Promise.all([
      this.loadPlatform(),
      this.loadGithubEnhancement(),
    ]);

    const result: MyIssuesResult = {
      items: mergeIssues(ledger.records, enhancement.issues, platform.issues),
      githubEnhancement: enhancement.viewer
        ? { login: enhancement.viewer.login, source: enhancement.viewer.source }
        : null,
      // 只有确知失败才提示。`unknown`(整体超时打断在半路,连配没配都没问出来)保持
      // 静默 —— 对没配增强的用户说「增强没用上」是在断言我们并不知道的事。
      // 快照那一侧对 `unknown` 的处置正相反(拒写),两者由同一份 health 各自推导。
      githubEnhancementFailed: enhancement.state === 'failed',
      degraded: platform.degraded,
      truncated: platform.truncated || enhancement.truncated,
    };
    return {
      result,
      health: {
        platform: platform.state,
        ledger: ledger.state,
        enhancement: enhancement.state,
      },
    };
  }

  /**
   * 账本读取失败不得拖累另两路 —— **依赖方向不能反**:平台通道才是主来源,账本只是
   * 它未就绪 / 离线时的兜底。
   *
   * electron-store 的初始化会同步抛出(目录不可读、权限、磁盘错误);裸调用放在
   * Promise.all 之前,一次抛出就让平台请求与 GitHub 增强**都不再启动**,整页只剩
   * unexpected —— 明明主来源好着,用户却什么都看不到。
   *
   * 不计入 degraded:那三个 reason 讲的都是平台通道的状态。账本读不到时,平台正常
   * 就能给出完整列表(没有可见损失),平台也失败则用户已经看到对应提示。
   *
   * 但**必须报出状态**:读失败时静默换成空数组,会让「丢了全部本机记录」的结果看起来
   * 和「本来就没有记录」一模一样,于是那份缩水的列表照样覆盖掉完整的首屏快照 ——
   * 用户下次冷启动就永久少掉了只有账本才有的那些 issue。不提示是一回事,不记录是另一回事。
   */
  private readLedgerSafely(): { records: SubmittedIssueRecord[]; state: ChannelState } {
    try {
      return { records: this.deps.readLedger(), state: 'ok' };
    } catch (err) {
      log.warn('reading the submitted-issue ledger failed; continuing without it', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { records: [], state: 'failed' };
    }
  }

  private async loadPlatform(): Promise<{
    issues: RemoteIssue[];
    degraded: MyIssuesDegradedReason | null;
    truncated: boolean;
    state: ChannelState;
  }> {
    let outcome: PlatformIssuesOutcome;
    try {
      // 总 deadline 覆盖整条调用链,不只是单次 fetch:401 之后 serverApiFetch 会等
      // authManager.refresh(),而那次 refresh 自己无超时上限,只约束 fetch 挡不住
      // 整条链挂死、把本机账本一直遮在 loading 后面。
      outcome = await this.withDeadline(
        () => this.deps.fetchPlatformIssues(),
        this.deps.platformTimeoutMs ?? DEFAULT_PLATFORM_TIMEOUT_MS,
        'platform',
      );
    } catch (err) {
      // fetchPlatformIssues 约定不抛;超时或它真抛了都不能把整页打挂。
      log.warn('platform issues fetch failed', { error: errorText(err) });
      return { issues: [], degraded: 'fetch-failed', truncated: false, state: 'failed' };
    }
    if (!outcome.ok) {
      log.debug('platform issues unavailable', { reason: outcome.reason });
      return {
        issues: [],
        degraded: outcome.reason,
        truncated: false,
        // 接口还没上线 = 平台侧**压根没有这份数据可给**,不是丢内容(而且这是当前所有
        // 用户的常态,当成丢的话首屏快照永远写不出来)。未登录 / 网络异常则是本该有却没拿到。
        state: outcome.reason === 'platform-unavailable' ? 'absent' : 'failed',
      };
    }
    return {
      issues: outcome.page.issues,
      degraded: null,
      truncated: isTruncated(outcome.page),
      state: 'ok',
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
   * 注:runtime 侧另给插件调用传了各自的 timeoutMs(身份 5s / 搜索 4s),那是让**通道
   * 自己了结**,与这里的页面等待上限目的不同,不能互相替代。搜索那档留 4s 而不是占满,
   * 是为了给下面的兜底通道留出预算 —— 两段合计仍在这一次总 deadline 内。
   */
  private async loadGithubEnhancement(): Promise<{
    viewer: GithubEnhancementViewer | null;
    issues: RemoteIssue[];
    truncated: boolean;
    state: ChannelState;
  }> {
    // 总超时触发时也要能回传已经解析成功的身份:header 照常显示并入了谁名下的 issue,
    // 只是这一次没并进内容。所以把它记在闭包外。
    let resolved: GithubEnhancementViewer | null = null;
    /**
     * 身份解析**有没有了结**,以及了结成什么样。三态缺一不可:
     *  - `pending` —— 还在飞。总 deadline 先到时就停在这里,此时**连配没配都不知道**;
     *  - `none`    —— 返回了 null = 没配(约定:失败一律抛出,返回 null 只表示没配);
     *  - `failed`  —— 自己抛了 = 配了却问不出身份。
     *
     * `pending` 曾经缺失:只标记「已 reject」的话,gh CLI 有 token 但 getCurrentUser
     * 挂住超过总预算时,promise 还没 reject,于是「配了但超时」被当成「没配」——
     * 既不提示,缩水的结果还照样覆盖完整快照。
     */
    // 包在对象里而不是裸 let:赋值发生在回调内,TS 的控制流分析追不到,读的时候会把
    // 类型窄成初始值 'pending'。
    const resolution: { at: 'pending' | 'none' | 'resolved' | 'failed' } = { at: 'pending' };
    const budgetMs = this.deps.enhancementTimeoutMs ?? DEFAULT_ENHANCEMENT_TIMEOUT_MS;
    const startedAt = this.now();
    try {
      return await this.withDeadline(async () => {
        resolved = await this.deps.resolveGithubEnhancement().then(
          (viewer) => {
            resolution.at = viewer ? 'resolved' : 'none';
            return viewer;
          },
          (err: unknown) => {
            resolution.at = 'failed';
            throw err;
          },
        );
        const viewer = resolved;
        // 没配增强是**正常状态**,不是失败。
        if (!viewer) return { viewer: null, issues: [], truncated: false, state: 'absent' as const };
        try {
          const page = await this.deps.searchAuthoredIssues(viewer, viewer.login);
          return {
            viewer,
            issues: page.issues,
            truncated: isTruncated(page),
            state: 'ok' as const,
          };
        } catch (err) {
          // 提到 warn:身份能报出来却搜不到是异常,而这条路的失败对用户是静默的 ——
          // 记 debug 等于线上不可诊断(排查这个 bug 时日志里就只有平台通道的 404)。
          // 文案按「会不会真的换通道」分两种,否则排障时会被误导:gh-cli 主通道
          // (或没注入 fallback)时 searchViaFallback 直接判失败,并不会真去试。
          const willRetry = this.canTryFallback(viewer, budgetMs, startedAt);
          log.warn(
            willRetry
              ? 'github enhancement search failed; trying the fallback channel'
              : 'github enhancement search failed; no fallback channel to try',
            { source: viewer.source, error: errorText(err) },
          );
          if (!willRetry) {
            return { viewer, issues: [], truncated: false, state: 'failed' as const };
          }
          return await this.searchViaFallback(viewer);
        }
      }, budgetMs, 'enhancement');
    } catch (err) {
      // 没有 GitHub 身份是正常状态;这一路失败也从不打挂整页。
      log.debug('github enhancement unavailable', { error: errorText(err) });
      // 走到这里 = 整条路径被总 deadline 打断(或 withDeadline 自己抛)。按身份解析
      // 停在哪一步定性,三条都必须区分:
      //  - 身份已拿到 ⇒ 搜索连兜底一起超时,配了却没用上 ⇒ failed;
      //  - 身份解析自己抛了 ⇒ 配了却问不出身份 ⇒ failed;
      //  - 身份返回了 null ⇒ 确实没配 ⇒ absent(正常状态,静默);
      //  - 身份还在飞 ⇒ **连配没配都不知道** ⇒ unknown。不提示(不能对没配的人说
      //    「增强没用上」),但也不许覆盖快照(可能真丢了内容)。两个消费者方向相反,
      //    正是它必须独立于 failed 存在的原因。
      const state: ChannelState =
        resolution.at === 'resolved' || resolution.at === 'failed'
          ? 'failed'
          : resolution.at === 'none'
            ? 'absent'
            : 'unknown';
      return { viewer: resolved, issues: [], truncated: false, state };
    }
  }

  /**
   * 现在还值不值得去试兜底通道。
   *
   * 两个条件:
   *  1. 有兜底可换 —— `ghost` 主通道 + 注入了 fallback。`gh-cli` 自己就是兜底。
   *  2. **剩余预算够** —— `withDeadline` 只停止等待,不能取消底层请求(GithubClient
   *     不支持 AbortSignal,给它加会动到 git-context 等其它调用方)。主通道耗掉大半
   *     预算才失败时启动兜底,等于发一次注定被丢弃、却照样消耗 GitHub 额度的请求。
   *     宁可直接判失败,让 UI 如实说这一路没用上。
   */
  private canTryFallback(
    viewer: GithubEnhancementViewer,
    budgetMs: number,
    startedAt: number,
  ): boolean {
    if (!this.deps.searchAuthoredIssuesFallback || viewer.source !== 'ghost') return false;
    // budgetMs <= 0 表示关掉了 deadline(仅测试用),此时不做预算判断。
    if (budgetMs <= 0) return true;
    return budgetMs - (this.now() - startedAt) >= MIN_FALLBACK_BUDGET_MS;
  }

  /**
   * 换本机 gh CLI 再搜一次。**只在 canTryFallback() 为真时调用** —— 「有没有兜底可换」
   * 的判据只留在那一处,不在这里重复一份(两处判据迟早分歧,本页已栽过几次)。
   *
   * 兜底通道自己说没有(没装 / 没登录 gh)或它也失败 ⇒ `failed: true`,让 UI 说明这一路
   * 配了却没用上;回退成功 ⇒ `failed: false`,用户已经拿到数据,没有可见损失就不提示。
   */
  private async searchViaFallback(viewer: GithubEnhancementViewer): Promise<{
    viewer: GithubEnhancementViewer;
    issues: RemoteIssue[];
    truncated: boolean;
    state: ChannelState;
  }> {
    const fallback = this.deps.searchAuthoredIssuesFallback;
    if (!fallback) {
      return { viewer, issues: [], truncated: false, state: 'failed' };
    }
    try {
      const page = await fallback(viewer.login);
      if (!page) {
        log.warn('no fallback channel available for the github enhancement');
        return { viewer, issues: [], truncated: false, state: 'failed' };
      }
      log.info('github enhancement recovered through the fallback channel', {
        count: page.issues.length,
      });
      return { viewer, issues: page.issues, truncated: isTruncated(page), state: 'ok' };
    } catch (err) {
      log.warn('github enhancement fallback search failed too', { error: errorText(err) });
      return { viewer, issues: [], truncated: false, state: 'failed' };
    }
  }

  /**
   * `load()` 里**每一条**并行分支的总 deadline —— 唯一实现,新增分支照同一形状套。
   *
   * 「一条分支挂住就把整页钉在 loading」这个缺陷在 review 里出现过四次(增强身份、
   * 增强搜索、平台单次 fetch、平台 401-refresh 链),每次都是某条路径没有上限。
   * 所以 deadline 只留这一个入口:传 run + 预算,不要在分支内部各自 new 计时器
   * (那样第二段还会重置前一段的 deadline)。`<=0` 关闭,仅测试用。
   */
  private withDeadline<T>(run: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (timeoutMs <= 0) return run();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`my-issues ${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const settleOk = (value: T) => {
        clearTimeout(timer);
        resolve(value);
      };
      const settleErr = (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      };
      // try/catch 而不是 Promise.resolve().then(run):run 若**同步**抛出(某个 deps
      // 实现直接 throw 而非返回 rejected promise),裸 run() 会让异常越过清理路径,
      // 留下一个跑到超时才触发的计时器。包一层微任务也能修,但那会把**所有**调用的
      // 远端发起时刻推后一个微任务 —— 为一个边缘缺陷改掉全部时序,副作用比缺陷本身大
      // (在途去重的语义就依赖「list() 同步就已发起请求」)。
      try {
        run().then(settleOk, settleErr);
      } catch (err) {
        settleErr(err);
      }
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
    // 派生,不用 issue.htmlUrl —— 见 shared/myIssues.ts 的 myIssueUrl 注释。
    url: myIssueUrl(issue.number),
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
    // 同上:账本落盘的 url 也不直接用,一律按 number 派生。
    url: myIssueUrl(record.number),
    title: record.title,
    type: record.type,
    state: 'unknown',
    createdAt: record.submittedAt,
    updatedAt: null,
    commentCount: null,
    sources: sourcesFromLedger(record),
  };
}

/**
 * 账本记录自带的来源。`identity` 是**提交那一刻**确定下来的事实,比事后按
 * `author:` 搜索更可靠 —— 用自己 GitHub 身份提交的那条,两个来源都成立:
 * 它确实经产品内 /issue 提交(cindy-tool),作者也确实是本人账号(github-account)。
 *
 * 硬编码成 ['cindy-tool'] 会造成同一条 issue 的来源标记随插件状态漂移:插件开着时
 * (搜索命中)显示两个来源,插件停用 / 超时 / 离线时只显示「由 Cindy 提交」,丢掉一个
 * 早已确认的事实。
 *
 * 注意与平台代发的区别:`identity === 'platform'` 时 GitHub 上的作者是 cindy-issue
 * App、**不是**本人,所以只打 cindy-tool(同 mergeIssues 对 platform 那一路的口径)。
 */
function sourcesFromLedger(record: SubmittedIssueRecord): MyIssueSource[] {
  return sortSources(
    record.identity === 'github-user' ? ['cindy-tool', 'github-account'] : ['cindy-tool'],
  );
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
