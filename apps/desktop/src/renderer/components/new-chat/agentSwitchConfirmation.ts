import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';

/**
 * 隐藏的本地用户 override（规则 20）：键缺失 = 系统默认“显示确认”；用户勾选
 * “下次不再提醒”并确认后，ConfirmDialogProvider 会写入显式 override。删除对应
 * `confirm-dialog.skip:*` localStorage 键即可恢复当前版本默认值，不固化默认快照。
 */
export const AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY = 'new-chat.agent-switch.handoff-risk.v1';

export interface AgentSwitchConfirmationCopy {
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
  dontShowAgainLabel: string;
}

export interface ConfirmAgentSwitchRiskParams {
  /**
   * 「这一次不必再问」——调用方按**两条**出口置位(任一成立即为 true):
   *
   * 1. 会话上已有**指向本次目标引擎**的切换意图:用户此前已对这个方向确认过,后续在同一
   *    目标里改选模型 / 来源 / 深度 / Fast 都不重复提示。
   * 2. 本次目标**就是会话的真实引擎**(撤销 / 回原引擎):main 侧走 same-engine no-op,
   *    不重建上下文、零风险。判它必须用不跟随意图的事实值,详见 ChatInput 的调用点。
   *
   * ★ 第 1 条必须带上「目标相同」这一维(Chris 2026-08-19 实测反馈)。只判「有没有意图」会
   * 让确认框在会话上挂着**任何**残留意图之后永久静默:用户先切了 Codex(意图挂上),再去
   * 选 Pi 的模型,风险确认一声不吭就直接改道了另一个引擎 —— 而每一次换目标都是一次新的
   * 上下文重建风险,必须重新确认。
   */
  hasSwitchIntent: boolean;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  copy: AgentSwitchConfirmationCopy;
}

/**
 * Agent 切换确认门。
 *
 * 首次进入另一 Agent(顶部分段浏览态,或统一面板里点中一条跨引擎行)时提示；已有**同目标**
 * 切换意图代表用户已经对这个方向确认过,后续改选模型/来源/effort/Fast 都直接放行;**返回
 * 原引擎**(目标 = 会话真实引擎)同样放行 —— 那是 same-engine no-op,不重建上下文。
 * 换一个目标引擎 = 一次新的风险,重新提示(两条出口见 hasSwitchIntent 的说明)。
 */
export async function confirmAgentSwitchRisk({
  hasSwitchIntent,
  confirm,
  copy,
}: ConfirmAgentSwitchRiskParams): Promise<boolean> {
  if (hasSwitchIntent) return true;

  return confirm({
    title: copy.title,
    description: copy.description,
    // 仅 Agent 切换风险文案禁选；其它 ConfirmDialog 仍保留复制能力。
    textClassName: 'select-none',
    confirmText: copy.confirmText,
    cancelText: copy.cancelText,
    dontShowAgainKey: AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
    dontShowAgainLabel: copy.dontShowAgainLabel,
  });
}

export interface AgentSwitchResponseFreshness {
  /** 发起方已放弃(effect 清理:切走会话 / 换设备)。同步调用点传 false。 */
  cancelled: boolean;
  /** 发起时的本端写序号 vs 响应到达时的当前值(覆盖「已点选但尚未落 store」的窗口)。 */
  writeSeqAtStart: number;
  writeSeqNow: number;
  /** 发起时的意图修订号 vs 响应到达时的当前值(覆盖任何来源的实际变更)。 */
  intentRevAtStart: number;
  intentRevNow: number;
}

/**
 * device-link 远程会话的异步意图响应是否仍然新鲜(可以落到展示态)。两个调用点同构:
 * 打开 / 重连时的**权威意图读回**,以及切换 IPC 的**登记 ack**——两者都在 await 期间
 * 可能被更新的状态超车,落下去就会让选择器显示过期引擎,与被控端实际要执行的不一致。
 *
 * 判定必须基于**单调计数**,不能比较意图值本身:意图在途期间从 null 变成非空又清回
 * null(本端登记后撤销,或另一窗口 / 被控端经 sessions:patched 来回改)时,值与引用都会
 * 回到相等,过期响应就会被误判为新鲜。
 *
 * 两个计数各管一段:store 修订号覆盖**任何来源**的实际变更(含外部权威回流);本端写序号
 * 覆盖「用户已点选、切换 IPC 还在途、尚未落 store」的空窗。
 */
export function isAgentSwitchResponseFresh(args: AgentSwitchResponseFreshness): boolean {
  if (args.cancelled) return false;
  if (args.writeSeqNow !== args.writeSeqAtStart) return false;
  return args.intentRevNow === args.intentRevAtStart;
}

/** 切换 ack 到达后该做什么。 */
export type AgentSwitchAckAction =
  /** 登记乐观意图(deferred 常态路径)。 */
  | 'apply-intent'
  /** 同引擎 no-op:清掉展示意图,把这次点选当普通模型/来源切换应用到当前引擎。 */
  | 'same-engine-reselect'
  /** 立即切换已完成(harness / registry 缺省兜底),收敛真实引擎。 */
  | 'apply-switched'
  /** 已被更新的状态超车,本次 ack 作废。 */
  | 'discard';

/**
 * 切换 ack 的分派决策。三类判据作用域**不同**,不能一刀切:
 *
 * - **写序号**(本端点选)对所有分支生效:用户又点了一次,本次 ack 整体作废。
 * - **意图修订号**保护「要把本次选择写成乐观意图值」的分支(apply-intent /
 *   apply-switched):外部权威值更新,就不能用旧选择盖回去。deferred 分支另有一条
 *   `registeredIntentMatchesCurrent` 出口,专治**本次登记自己的广播回声**(见其字段说明)。
 * - 同引擎 no-op 不能从 renderer 的「修订号 + 最终值」猜因果：外部 set→clear ABA 与
 *   本次 clear 都会得到「修订号已变 + 当前为空」。新 host 因此返回 CAS 成功后的
 *   `sameEngineRevision`，后续 SET_MODEL 带回该 token 再做一次 CAS；若请求已在 host
 *   内被超车则返回 `sameEngineSuperseded` 直接丢弃。远程入口另由
 *   `supportsSessionAgentSwitchCas` 门控，不会向缺 token 的旧 host 开放；这里的无 token
 *   分支只作本地 harness / 防御性兼容，修订号变化时仍 fail-closed。
 */
/**
 * 回声匹配路径的**完整配置一致性**判据(2026-08-19 review P2 收口)。
 *
 * `registeredIntentMatchesCurrent` 刻意只比 target / model / providerId 三项(见下方字段
 * 说明):effort / fastMode 可能被 main 归一化,比它们会把合法回声误判成不匹配。但这留下
 * 一个缺口 —— device-link 往返期间,另一控制端**只改同一意图的 effort 或 Fast**(三元组
 * 不变)时,回声照样匹配,切换事务若据此报「完整成功」,面板会执行「成功才做」的持久化
 * 收尾(清 override / 提交・删除收藏编辑 / 写收藏锚点),把一份**并未实际应用**的本端配置
 * 当成了正在跑的那一份。
 *
 * 所以回声匹配之后还要补这一问:**权威快照里的 effort / Fast 是不是就是本端这次请求的
 * 值**。不一致 = 登记本身可能成功了,但本端的完整配置没有原样落地,调用方必须按
 * 「未完整应用」处理(不做任何破坏性收尾;意图展示与偏好同步照用权威值,那是另一条
 * 已收口的链路)。
 *
 * 宽严取向逐维写明(与偏好同步的「缺字段不写」同族,方向相反 —— 这里缺字段**放行**):
 * - 权威快照缺该维(`undefined`):main 对无档位模型不投影 effort、旧 host 不带 fastMode。
 *   缺 ≠ 被改,判不一致会把这类模型的每一次正常切换都误伤成失败 → 视为一致。
 * - 本端没请求 effort(空值):语义同 providerId 传 null —— 「跟随默认解析」,main 归一化
 *   出什么都是本次意图的一部分 → 视为一致。
 * - 两边都有值:逐字相等才一致。归一化分叉与外部超车在这里不可区分,也**不必**区分:
 *   两种情况下「本端请求的那份配置」都不是会话将要采用的配置,收尾都不该做。
 */
export function isAgentSwitchEchoConfigConsistent(args: {
  /** 回声匹配时 store 里的权威意图快照;非回声路径(常规新鲜 ack)传 null,恒一致。 */
  authoritative: { effort?: string; fastMode?: boolean } | null;
  /** 本次请求解析后发出的 effort(空串 / undefined = 本端没指定,跟随默认解析)。 */
  requestedEffort: string | undefined;
  /** 本次请求解析后发出的 Fast。 */
  requestedFastMode: boolean;
}): boolean {
  const { authoritative, requestedEffort, requestedFastMode } = args;
  if (!authoritative) return true;
  const effortConsistent =
    authoritative.effort === undefined ||
    !requestedEffort ||
    authoritative.effort === requestedEffort;
  const fastConsistent =
    authoritative.fastMode === undefined || authoritative.fastMode === requestedFastMode;
  return effortConsistent && fastConsistent;
}

export function resolveAgentSwitchAckAction(args: {
  deferred: boolean;
  switched: boolean;
  sameEngineRevision?: number;
  sameEngineSuperseded?: boolean;
  /**
   * **deferred 分支专用**:ack 到达时 store 里的意图值,是不是逐字就是本次登记的那一份
   * (目标引擎 + 模型 + 来源)。
   *
   * 为什么需要它(Chris 2026-08-19 实测:「会话内换引擎整条链都不生效」的主根因):
   * main 在登记意图时**先同步广播 `sessions:patched`(带 agentSwitchIntent)、后返回 invoke
   * reply**。renderer 的 push 处理因此必然先于 ack 到达 —— 本地此刻还是 null,镜像一写就把
   * 修订号 +1。等 ack 回来,修订号守卫看到「变了」,把这次登记判成被外部超车而丢弃:乐观
   * 呈现、草稿同步、收藏锚点全都不落,而 main 的 pendingSwitches 里意图**还在** —— 下一条
   * 消息照样切引擎,用户看到的是「点了没反应,然后莫名其妙换了引擎」。
   *
   * 值相等就足以放行,因为它回答的正是修订号回答不了的那个问题:**此刻的权威值是不是我要
   * 的那一份**。相等 = 应用它不会覆盖任何更新的外部选择(它就是最新值);不等 = 真被外部
   * 超车,维持丢弃。ABA(外部 set → clear → set 回同值)最终值仍等于本次登记,应用无害;
   * 「用户又点了一次」由上面的写序号守卫独立覆盖,不靠这条。
   *
   * 刻意只比 target / model / providerId 三项:effort 与 fastMode 在 main 侧可能被目标引擎
   * 的档位集合归一化后才投影出来(projectPendingAgentSwitchIntent 只在有值时带上),比它们
   * 会把合法回声误判成不匹配,退回本次要修的那个 bug。providerId 还要再让一步:调用方传
   * `null` = 「我没指定来源,跟随默认路由」,main 可能解析出具体来源再投影回来,那一路只认
   * target + model(判据的构造见 ChatInput 的调用点)。
   *
   * effort / Fast 不进这条匹配判据 ≠ 不管:三元组放行只回答「该不该应用这份权威值」,
   * 「本端请求的完整配置有没有原样落地」由 isAgentSwitchEchoConfigConsistent 单独回答,
   * 切换事务的成功返回值挂在后者上(见其头注)。
   */
  registeredIntentMatchesCurrent?: boolean;
  freshness: AgentSwitchResponseFreshness;
}): AgentSwitchAckAction {
  const { freshness } = args;
  if (freshness.cancelled) return 'discard';
  if (freshness.writeSeqNow !== freshness.writeSeqAtStart) return 'discard';
  if (args.deferred) {
    if (isAgentSwitchResponseFresh(freshness)) return 'apply-intent';
    // 修订号变了,但当前权威值就是本次登记的那一份 → 变化来自本次登记自己的广播回声。
    return args.registeredIntentMatchesCurrent === true ? 'apply-intent' : 'discard';
  }
  if (!args.switched) {
    if (args.sameEngineSuperseded) return 'discard';
    if (args.sameEngineRevision !== undefined) return 'same-engine-reselect';
    return freshness.intentRevNow === freshness.intentRevAtStart
      ? 'same-engine-reselect'
      : 'discard';
  }
  return isAgentSwitchResponseFresh(freshness) ? 'apply-switched' : 'discard';
}
