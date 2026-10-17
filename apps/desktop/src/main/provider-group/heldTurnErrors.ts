/**
 * 自动换电脑期间先不呈现的那次失败(docs/product-rules/provider-groups.md §6.1「换电脑期间不报错」)。
 *
 * 输入协调器在终态错误那一刻判断供应商组会先试着换电脑时，投影里先不带这次错误(没有红横幅)，只显示
 * 「正在换一台电脑继续」；本该立刻落库的 error 行与 Agent Island 的错误提醒由 host 暂存在这里，按协调器那次
 * 登记的 id 对号结算：
 * - 换成了(续跑已发出)：丢掉，历史里只留换电脑的活动行；
 * - 没换成、交回原有处理(组里都不能用、自动换电脑关着、交接失败等)：先放出来——横幅、error 行、Agent Island；
 * - 这一趟以别的方式结束(用户中途接手、错误已被新的一轮换掉)：补落 error 行，错误已不是当前状态时不再呈现。
 *
 * 补落的 error 行在暂存那一刻就取好写库要用的一切(`capture`)：补落时任务可能已在跑新的一轮(用户中途接手)，
 * 旧会话也可能已在交接时关闭，补落只写这一行，不碰那时正在进行的那一轮。行按出错的时刻排序：用户在换电脑途中
 * 发了新消息时，它仍排在那条消息之前。暂存时记下账号：结算时已换了账号就不再写(不往别的账号的数据里补行)。
 *
 * 暂存的必须有人结算，否则那次失败在历史里彻底消失；结算只认自己那次登记，迟到的旧结算碰不到下一次失败，
 * 新的一次登记也不会替还没结算的上一次做决定(上一次可能正要以「换成了」结算)。
 */

/** 暂存的失败详情(与 error 行 content 同形)，用于判断重复与 Agent Island 提醒。 */
export interface HeldTurnErrorDetail {
  message?: string;
  reason?: string;
  sdkError?: string;
}

export interface ProviderGroupHeldTurnErrorsDeps<Row> {
  /**
   * 暂存那一刻取好补落要用的 error 行(内容、agentMeta、错误来源等)；没有可写的内容时返回 null。
   * `agentMeta` 是失败那一轮的事件身份(没有时为 null)。
   */
  capture(sessionId: string, data: unknown, agentMeta: unknown): Row | null;
  /** 补落 `capture` 取好的那一行：只写这一行，不碰补落时正在进行的那一轮。 */
  persist(sessionId: string, row: Row): void;
  /** 错误确定要呈现：同步到聊天之外的错误表面(Agent Island)。 */
  surface(sessionId: string, detail: HeldTurnErrorDetail): void;
  /** 撤掉协调器那次「先不呈现」的登记；错误仍是当前状态时投影随即带出横幅，返回 true。 */
  releaseHold(sessionId: string, holdId: number): boolean;
  /** 当前登录账号的作用域键。 */
  ownerKey(): string;
  log?(message: string, meta?: Record<string, unknown>): void;
}

export interface ProviderGroupHeldTurnErrors {
  /**
   * 终态错误被先不呈现时，暂存本该立刻落库的 error 行。返回 false = 这不是被暂存的那次失败(同一次登记期间
   * 到达的另一条不同错误)：调用方照常落库，这里替它补上换电脑期间被压下的 Agent Island 提醒。同一次失败的
   * 重复终态 error 返回 true(只留一行)。
   */
  stash(sessionId: string, holdId: number, data: unknown, agentMeta?: unknown): boolean;
  /** 换成了：这次失败不再落库、不再呈现。 */
  discard(sessionId: string, holdId: number): void;
  /** 不再换了：撤掉登记并补落；错误仍是当前状态时一并呈现。重复调用无副作用。 */
  release(sessionId: string, holdId: number): void;
}

interface HeldEntry<Row> {
  detail: HeldTurnErrorDetail;
  row: Row | null;
  owner: string;
}

function toDetail(data: unknown): HeldTurnErrorDetail {
  const d = (data ?? {}) as { message?: unknown; reason?: unknown; sdkError?: unknown };
  return {
    ...(typeof d.message === 'string' ? { message: d.message } : {}),
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.sdkError === 'string' ? { sdkError: d.sdkError } : {}),
  };
}

export function createProviderGroupHeldTurnErrors<Row>(
  deps: ProviderGroupHeldTurnErrorsDeps<Row>,
): ProviderGroupHeldTurnErrors {
  /** sessionId → 登记 id → 暂存的那次失败。同一任务可能同时有两次还没结算(上一次正在以续跑收尾)。 */
  const held = new Map<string, Map<number, HeldEntry<Row>>>();

  function take(sessionId: string, holdId: number): HeldEntry<Row> | null {
    const entries = held.get(sessionId);
    const entry = entries?.get(holdId);
    if (!entries || !entry) return null;
    entries.delete(holdId);
    if (entries.size === 0) held.delete(sessionId);
    return entry;
  }

  /** 补落；暂存后已换了账号时不写。返回是否写了。 */
  function persist(sessionId: string, entry: HeldEntry<Row>): boolean {
    if (entry.owner !== deps.ownerKey()) {
      deps.log?.('provider group: dropped a held error row after the account changed', { sessionId });
      return false;
    }
    if (entry.row !== null) deps.persist(sessionId, entry.row);
    return true;
  }

  return {
    stash(sessionId, holdId, data, agentMeta) {
      const detail = toDetail(data);
      const entries = held.get(sessionId) ?? new Map<number, HeldEntry<Row>>();
      const previous = entries.get(holdId);
      if (previous) {
        // 同一次登记期间又来一条终态 error：同一次失败的重复就只留一行。不同的错误不归这次暂存：调用方照常落库，
        // 换电脑期间被压下的 Agent Island 提醒在这里补上。
        if (previous.detail.message === detail.message) return true;
        deps.surface(sessionId, detail);
        return false;
      }
      entries.set(holdId, { detail, row: deps.capture(sessionId, data, agentMeta ?? null), owner: deps.ownerKey() });
      held.set(sessionId, entries);
      return true;
    },

    discard(sessionId, holdId) {
      take(sessionId, holdId);
      deps.releaseHold(sessionId, holdId);
    },

    release(sessionId, holdId) {
      const live = deps.releaseHold(sessionId, holdId);
      const entry = take(sessionId, holdId);
      if (!entry) return;
      if (persist(sessionId, entry) && live) deps.surface(sessionId, entry.detail);
    },
  };
}
