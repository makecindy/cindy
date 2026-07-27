/**
 * 会话自动起名的**唯一权威实现**(main 侧)。
 *
 * 两条输入路径都收敛到这里:
 *   - 本机发送:renderer 经 `maker:auto-title` IPC 调进来;
 *   - device-link 远控:被控端 `maker:input:enqueue` 直接调(控制端 renderer 不
 *     参与起名,只在自己的投影层显示预览)。
 *
 * 为什么必须单一持有:同一个会话既可能被本机用户发送,也可能被另一台设备远控。
 * 占位归属若分散在 renderer 与 main 两份内存里,一端写的合成占位会被另一端当成
 * 「用户手动改名」而永久跳过替换(PR #510 review)。DB 是唯一真相,归属表就必须
 * 跟 DB 待在同一个进程里。
 *
 * 行为(与本机 Codex 式体验一致):
 *   1. 立即占位:先用原话截断改名落库 + 广播,不等模型;
 *   2. 智能标题:再让 oneShot 出结果覆盖占位。
 * 两段写入都走 `persistSessionTitleIfStillDraft` 的条件写(SQL `WHERE title = 期望值`),
 * 因此任何时刻用户手动改名都会让后续写入落空 —— user rename wins。
 *
 * `isUserText=false`(纯附件消息合成的描述,如文件名 /「图片」)只写占位、**绝不
 * 调用标题模型**:模型拿不到实质内容会返回「我没有看到用户消息的内容」这类回复,
 * 线上出现过。这类占位记进归属表,等用户真正打字时再替换成他写的内容。
 */

import type { AgentKind } from '@cindy/maker-core';

import {
  getOverwritableAutoTitle,
  isUntitledSessionAwaitingAutoTitle,
  normalizeAutoTitle,
  persistSessionTitleIfStillDraft,
  setOnUserSessionTitleWritten,
  type OverwritableAutoTitleTarget,
} from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';

import { generateMakerSessionTitle } from './title.js';

const log = createLogger('maker-ipc/session-auto-title');

export interface SessionAutoTitleRequest {
  sessionId: string;
  text: string;
  agentKind: AgentKind;
  /**
   * text 是否为用户真正写下的文字。false = 本地合成的描述(附件文件名 / 被引用
   * 会话标题等):只写占位标题,不调用标题模型。缺省 true。
   */
  isUserText?: boolean;
}

export interface SessionAutoTitleResult {
  /** 本次是否真的写入了标题。 */
  applied: boolean;
  /**
   * 该会话是否已不再需要自动起名(已用用户文字起过名,或用户手动改过名)。
   *
   * 调用方据此停止后续尝试。**瞬时失败(DB/IPC 异常、模型无结果)一律返回
   * false**,让下一条带文字的消息重试 —— 否则一次抖动就会把会话永久钉在
   * "New Maker" 或合成占位上(PR #510 review)。
   */
  done: boolean;
}

export interface SessionAutoTitleDeps {
  /**
   * 标题仍是系统占位时返回覆写目标(当前标题 + 权威 agentKind + 是否裸默认标题),
   * 否则返回 null。当前标题直接当条件写的期望值 —— fork 与合成占位都不等于草稿
   * 默认,猜期望值会让写入落空(PR #510 review)。
   */
  resolveOverwritableTitle: (
    sessionId: string,
    synthesizedPlaceholder?: string,
  ) => Promise<OverwritableAutoTitleTarget | null>;
  generateTitle: (message: string, agentKind: AgentKind, sessionId?: string) => Promise<string | null>;
  /** 条件写:仅当当前标题等于 expectedTitle 时才落库(默认期望草稿占位)。 */
  persistTitle: (sessionId: string, title: string, expectedTitle?: string) => Promise<boolean>;
}

const defaultDeps: SessionAutoTitleDeps = {
  resolveOverwritableTitle: getOverwritableAutoTitle,
  generateTitle: generateMakerSessionTitle,
  persistTitle: persistSessionTitleIfStillDraft,
};

/**
 * 纯附件消息合成的占位标题(sessionId → 写进 DB 的那个串)。
 *
 * `sessions` 表只有一个 title 字段、不记录「谁写的」,所以在内存里记住哪些标题是
 * 系统合成的:用户后来真正打字时才能安全覆盖它,而他手动改的名不会被冲掉。
 * 重启后记忆丢失 → 合成占位固化为正式标题(用户仍可手动改名)。这是刻意选择的
 * 失败模式,换来不动 schema migration。
 */
const synthesizedPlaceholders = new Map<string, string>();

/**
 * 每个会话的起名串行队列。
 *
 * 纯附件消息与紧随其后的文字消息会并发触发起名;若各自独立读标题再写,慢的那个
 * 会拿着过期的期望值,导致文字标题被附件描述盖掉或直接写不进去(PR #510 review)。
 * 串行化让后一个任务总能读到前一个写完的归属与标题。
 */
const queues = new Map<string, Promise<unknown>>();

function enqueuePerSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(task, task);
  // 队尾出队后清理,避免 Map 随会话数无界增长(仅当自己仍是队尾)。
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(sessionId, settled);
  void settled.then(() => {
    if (queues.get(sessionId) === settled) queues.delete(sessionId);
  });
  return next;
}

/**
 * 用户手动改过名的会话(本进程内)。
 *
 * 条件写只能挡住「标题变了」的改名:用户把标题保存成与占位**逐字相同**的串时
 * `WHERE title = 期望值` 依然命中,随后的智能标题会盖掉他刚保存的名字
 * (PR #510 review P1)。`sessions` 表没有「谁写的」这一列,所以由改名出口显式
 * 通知,这里记下来直接收手。重启后遗忘 —— 那时标题早已不是系统占位,资格检查
 * 本身就会拦住,不需要持久化。
 */
const manuallyRenamed = new Set<string>();

/**
 * 是否装有启用中的 will-user-message 拦截意识。由 register 注入(避免
 * maker-ipc → cindy-brain 的额外静态依赖),未注入时按"没有"处理。
 */
let isUserMessageScreeningActive: (() => boolean) | null = null;

/**
 * 接上 DB 侧的改名通知与拦截意识探针。register 时调用一次(重复调用幂等)。
 * 放在这里而不是 sessions.ts 自己调,是因为依赖方向只能是 maker-ipc → localDb。
 */
export function registerSessionAutoTitleHooks(hooks?: {
  isUserMessageScreeningActive?: () => boolean;
}): void {
  setOnUserSessionTitleWritten((sessionId) => {
    manuallyRenamed.add(sessionId);
    synthesizedPlaceholders.delete(sessionId);
  });
  if (hooks?.isUserMessageScreeningActive) {
    isUserMessageScreeningActive = hooks.isUserMessageScreeningActive;
  }
}

/** 测试专用:清空归属表与串行队列。 */
export function __resetSessionAutoTitleStateForTest(): void {
  synthesizedPlaceholders.clear();
  manuallyRenamed.clear();
  queues.clear();
}

/** 会话是否还需要自动起名(标题仍是系统占位、且用户没手动改过名)。 */
export async function isSessionAutoTitleEligible(sessionId: string): Promise<boolean> {
  if (manuallyRenamed.has(sessionId)) return false;
  const eligible = await isUntitledSessionAwaitingAutoTitle(
    sessionId,
    synthesizedPlaceholders.get(sessionId),
  );
  // 不合格 = 标题已不是系统占位(用户改过名 / 已起过名),记着的合成串必然过期。
  // 这条预检会短路掉 runUnsynchronized,那边的回收走不到,归属会留到进程结束
  // (review)。抛错时刻意不删:读不出状态属于瞬时失败,不能拿它当作废依据。
  if (!eligible) synthesizedPlaceholders.delete(sessionId);
  return eligible;
}

async function runUnsynchronized(
  request: SessionAutoTitleRequest,
  deps: SessionAutoTitleDeps,
): Promise<SessionAutoTitleResult> {
  const seedText = request.text.trim();
  if (!seedText) return { applied: false, done: false };

  // 用户已经手动给过名字 —— 条件写挡不住"同值改名"(WHERE title = 期望值 仍命中),
  // 只能靠这条显式记号收手(review P1)。
  if (manuallyRenamed.has(request.sessionId)) return { applied: false, done: true };

  const remembered = synthesizedPlaceholders.get(request.sessionId);

  let target: OverwritableAutoTitleTarget | null;
  try {
    target = await deps.resolveOverwritableTitle(request.sessionId, remembered);
  } catch (err) {
    // 读不到状态属于瞬时失败:不下结论,让下一条消息重试。
    log.warn('auto-title eligibility check failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { applied: false, done: false };
  }
  if (target === null) {
    // 标题已不是系统占位(用户改过名 / 已起过名)→ 回收过期归属,不再尝试。
    synthesizedPlaceholders.delete(request.sessionId);
    return { applied: false, done: true };
  }

  const placeholder = normalizeAutoTitle(seedText);
  if (!placeholder) return { applied: false, done: false };

  // 合成占位只允许覆写「建会话时的裸默认标题」。已经是 fork 占位或上一条附件写下的
  // 合成占位时一律保留,等用户真正打字再换 —— 否则每贴一张图标题就换一次文件名,
  // fork 的 "[Fork] …" 也会被文件名顶掉。desktop 本机路径同样只在 isUserText=true
  // 时补起名,两条路径必须一致(review P1)。
  if (request.isUserText === false && !target.isDefaultDraftTitle) {
    return { applied: false, done: false };
  }

  // 1) 立即占位。失败(用户抢先改名 / 写库异常)不中断后续智能起名。
  let placeholderPersisted = false;
  try {
    placeholderPersisted = await deps.persistTitle(request.sessionId, placeholder, target.title);
  } catch (err) {
    log.warn('auto-title placeholder write failed (continuing)', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (request.isUserText === false) {
    // 不论写入是否**确认**成功都记归属。`persistSessionTitleIfStillDraft` 的 UPDATE
    // 与回读是两次 worker RPC:回读那一跳失败(worker 重启等)时更新其实已经提交,
    // 但这里只看到一个 false —— 不记归属的话,下一条文字消息会把库里这个合成标题
    // 当成用户手动改的名而永久跳过替换(review P1)。
    //
    // 无条件记录是安全的:归属只是"这个串是系统合成的"这一条信息,资格判定仍拿它
    // 与 DB 实际标题比对(getOverwritableAutoTitle)。真没写进去时它压根不匹配,
    // 不会产生任何效果;标题已被用户改名时下一轮的 null 分支会把它回收掉。
    synthesizedPlaceholders.set(request.sessionId, placeholder);
    // 还没用用户文字起名 —— 等他打字,别标记完成。
    return { applied: placeholderPersisted, done: false };
  }

  // 归属只在**用户文字占位确实写进去之后**才作废:写失败时 DB 里仍是旧的合成
  // 标题,提前删掉会让资格检查再也认不出它,后续消息永久跳过起名(review P1)。
  if (placeholderPersisted) synthesizedPlaceholders.delete(request.sessionId);

  // 2) 智能标题覆盖占位。
  //
  // 这中间隔着一次模型调用,用户完全来得及在这段时间里改名。改成别的串时条件写
  // 自然落空;改成与占位**逐字相同**的串时条件写仍会命中,所以每次落笔前都要再
  // 看一眼这条记号(review P1)。
  if (manuallyRenamed.has(request.sessionId)) {
    return { applied: placeholderPersisted, done: true };
  }

  // 占位写入没被确认时重读一次权威标题。`persistSessionTitleIfStillDraft` 的 UPDATE
  // 与回读是两次 worker RPC:回读那一跳失败时更新其实已经提交,这里却只看到 false。
  // 不重读的话,智能标题会拿着过期的期望值去写、必然落空,而库里那个已提交的占位
  // 从未广播出去 —— 侧边栏会一直停在 New Maker 直到下次刷新(review P1)。
  let expectedForSmart = placeholderPersisted ? placeholder : target.title;
  let placeholderLive = placeholderPersisted;
  if (!placeholderPersisted) {
    try {
      // 把刚写的串当"已知的系统占位"喂进去:库里若真是它,就能被认出来并当期望值。
      const latest = await deps.resolveOverwritableTitle(request.sessionId, placeholder);
      if (latest === null) {
        // 标题已经不是任何系统占位(用户改了名)→ 不再尝试。
        return { applied: false, done: true };
      }
      expectedForSmart = latest.title;
      placeholderLive = latest.title === placeholder;
    } catch (err) {
      // 读不到就沿用旧期望值:最坏情况是这次智能标题写不进去,下一条消息重试。
      log.warn('auto-title re-resolve after ambiguous placeholder write failed', {
        sessionId: request.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 装有启用中的 will-user-message 拦截意识时,不把用户原话送去标题模型。
  //
  // 拦截在 coordinator 的派发环节才发生,而起名在发送瞬间就跑了 —— 一条本该被
  // 拦下的消息仍会被送进标题模型这个外部 provider,正好绕开了这个钩子存在的理由
  // (合规 / 敏感信息);被改写的消息则会拿改写前的原文起名(review P1)。
  //
  // 只挡**模型调用**这一步:原话占位是纯本地写库,不外发,而且被拦消息的正文本来
  // 就以「被拦气泡」原样显示在这个界面上,标题不构成新的暴露面。挡掉之后标题停在
  // 原话截断版 —— 那正是本 PR 的主行为(Codex 式即时占位),退化是可接受的。
  //
  // 这里刻意**不**重新询问钩子本身:同一条消息被问两次会让 Ghost 产生它没预期的
  // 副作用(计数、日志、二次改写)。要给这类用户恢复智能标题,正解是让
  // coordinator 在筛查通过后再触发一次起名,那是独立于本 PR 的改动。
  if (isUserMessageScreeningActive?.()) {
    return { applied: placeholderLive, done: placeholderLive };
  }

  let generated: string | undefined;
  try {
    // agentKind 取 DB 权威值而非入参快照:另一窗口/设备切过 agent 时快照会过期,
    // 用错 agent 会让标题走错供应商(review P1)。
    generated = (
      await deps.generateTitle(seedText, target.agentKind, request.sessionId)
    )?.trim();
  } catch (err) {
    log.warn('auto-title generation failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // 模型没结果 → 标题此刻已经是**用户第一条消息的原话**(截断版),会话已经起过名,
  // `done` 为真。这不是"瞬时失败被标记完成":智能标题只是锦上添花,占位本身就是
  // 本 PR 的主行为(Codex 式即时占位)。此处若返回 false,下一条消息会把标题改成
  // 第二句话 —— 标题就不再对应会话的开头了,那才是 bug。真正的瞬时失败是"占位也
  // 没写进去",那时 placeholderLive 为 false,照旧可重试。
  if (!generated) return { applied: placeholderLive, done: placeholderLive };
  if (manuallyRenamed.has(request.sessionId)) {
    return { applied: placeholderLive, done: true };
  }

  let smartPersisted = false;
  try {
    smartPersisted = await deps.persistTitle(request.sessionId, generated, expectedForSmart);
  } catch (err) {
    log.warn('auto-title smart write failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // 同上:智能标题没写进去但占位活着 → 会话仍有一个来自用户原话的标题,不必再起。
  // 两段都没写进去才是真失败,applied/done 皆为 false,下一条带文字的消息重试。
  const applied = smartPersisted || placeholderLive;
  return { applied, done: applied };
}

/** 起名主入口:同一会话串行执行。 */
export function runSessionAutoTitle(
  request: SessionAutoTitleRequest,
  deps: SessionAutoTitleDeps = defaultDeps,
): Promise<SessionAutoTitleResult> {
  return enqueuePerSession(request.sessionId, () => runUnsynchronized(request, deps));
}

/** fire-and-forget 版本:调用方不关心结果(device-link 远控入队后触发)。 */
export function scheduleSessionAutoTitle(
  request: SessionAutoTitleRequest,
  deps: SessionAutoTitleDeps = defaultDeps,
): void {
  void runSessionAutoTitle(request, deps).catch((err) => {
    log.warn('auto-title failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}
