/** Desktop item projection for the shared work-run grouping algorithm. No UI side effects. */
import {
  deriveAgentTaskStatus,
  subagentSpawnReceiptName,
  subagentSpawnResultIndicatesRunning,
  type AgentTaskTerminalStatus,
} from '@cindy/maker-shared/agent-task';
import {
  groupWorkRuns as groupSharedWorkRuns,
  isDeliveryProseText,
} from '@cindy/maker-shared/message-render';
import type { AgentTaskUpdate, ChatMessage } from '@/hooks/useCCAgentChat';
import type { GeneratedFileRef } from '@/lib/generatedFiles';
import type { TurnChangeSetSummary } from '../../../shared/turnChangeSet';
import type { TodoItem } from './TodoListCard';
import type { ToolMediaItem } from './AgentActionRow';

export type MessageRenderItem = { type: 'message'; key: string; message: ChatMessage };
type AgentPlanRenderItem = {
  type: 'agent_plan';
  key: string;
  todos: TodoItem[];
  /** 同一 session 的计划工具行；历史 prepend 改变首行 key 后仍可恢复旧锚点。 */
  sourceClientIds: string[];
  /** 计划调用在流里的位置与时间锚点；原 tool_use 行由本卡取代。 */
  createdAt?: string;
};
export type ToolSegmentRenderItem = {
  /** A run of consecutive tool_use messages between text segments,
   *  rendered as a single AgentActionsBlock. v2 — no isStreaming
   *  field; default-collapsed + persistent memory removes the need
   *  to thread streaming state down. */
  type: 'tool_segment';
  key: string;
  toolCalls: ChatMessage[];
  resultMap: Map<string, string>;
  /** tool_use clientId 集合:tool_result 已到达(含被 shouldHideToolResult
   *  隐藏、没进 resultMap 的空结果)。行级 running/done 状态判定用 —
   *  只看 resultMap 会让 orca 通信工具永久显示 running。 */
  settledIds: Set<string>;
  /** tool_use clientId → 对应 tool_result 的 createdAt(ms)。
   *  段的结束时间必须算进 result:单次工具跑了半小时以上时,只看最后一个 tool_use 的
   *  createdAt 会把段的结束时间大幅低估,让紧随其后的最终答复被空洞守卫误判(#676
   *  review)。resultMap 只留正文,时间戳单独存这里。 */
  resultTsMap: Map<string, number>;
};
export type AgentTaskRenderItem = {
  type: 'agent_task';
  key: string;
  toolCall?: ChatMessage;
  update?: AgentTaskUpdate;
  result?: string;
  persistedStatus?: AgentTaskTerminalStatus;
  /** 对应 tool_result 的 createdAt(ms)。历史会话没有 live taskUpdates 时,item 的结束
   *  时间只能靠它 —— 否则跑了半小时以上的 Agent/Task 会让紧随其后的最终答复被空洞守卫
   *  误判(#676 review)。与 tool_segment 的 resultTsMap 同源。 */
  resultTsMs?: number;
};
export type ForkOriginRenderItem = {
  type: 'fork_origin';
  key: string;
  parentSessionId: string;
  forkedAtMessageId: string;
};
type TurnChangesRenderItem = {
  /** Exact provider patches attached to one visible user turn. */
  type: 'turn_changes';
  key: string;
  changeSet: TurnChangeSetSummary;
};
type GeneratedFilesRenderItem = {
  type: 'generated_files';
  key: string;
  files: GeneratedFileRef[];
  turnStartMs: number | null;
  turnEndMs: number | null;
  /** 最新一轮没有后续 user 边界时 turnEndMs 仍为空，用封口信号触发完成后复核。 */
  turnSealed?: boolean;
};

/** 原子工作子项:tool / agent task / thinking / assistant 工作文字。 */
export type WorkChildItem = ToolSegmentRenderItem | AgentTaskRenderItem | MessageRenderItem;

/** work_group 可以嵌套一层:完成态外组装 assistant 文字时间线,其中每段
 *  连续动作仍是独立的内层「已工作 Xs」。内层继续只收原子工作子项。 */
export type WorkGroupChildItem = WorkChildItem | WorkGroupRenderItem;

interface WorkGroupRenderItem {
  /** work-group:运行中的连续动作段,或完成态收拢整段工作文字的外层时间线。
   *  动作段展开后直接显示思考 / 工具行;外层展开后显示 assistant 文字和
   *  仍保持折叠的内层动作段。tool_media 不参与合并,继续留在组外可见。 */
  type: 'work_group';
  key: string;
  children: WorkGroupChildItem[];
  durationMs?: number;
  /** 当前是否是仍在执行的尾部动作段。完成态时间线始终 false。 */
  isStreaming: boolean;
  /** 工作段起点 epoch ms,供 live elapsed ticker 使用。优先是上一个边界
   *  (用户消息/上一句正文,可能早于段内首个活动),边界缺失时退回首个活动
   *  时间戳 —— 与 durationMs 的段起点同源(见 createWorkGroup)。 */
  startedAtMs?: number;
}

export type RenderItem =
  | MessageRenderItem
  | AgentPlanRenderItem
  | ToolSegmentRenderItem
  | AgentTaskRenderItem
  | ForkOriginRenderItem
  | TurnChangesRenderItem
  | GeneratedFilesRenderItem
  | {
      /** tool-result-media: 把 tool_result 里的 xdt_image_url(s) / xdt_video_urls
       *  提取出来作为独立视觉消息渲染,跳出 tool_segment 折叠卡片。统一容器,
       *  按 kind 分发到 ChatImageView / ChatVideoView。
       *
       *  生成期间不展示占位卡 — 与 image_generate 保持同款体验:tool_use 卡
       *  自身就标识"正在做",result 一到再渲染媒体。失败由 tool_result 文本
       *  里的 error 字段承载,不需要单独的 placeholder。 */
      type: 'tool_media';
      key: string;
      items: ToolMediaItem[];
    }
  | {
      /** ghost-card(卡槽③海报模式):意识为自己的一次 ghost_call 供片的
       *  聊天卡片,是该次调用的**唯一呈现**——配上卡后对应工具行不进
       *  tool_segment(行与卡信息重复,合并进卡),原始调用参数由卡片头带
       *  展开区承担(toolCall 透传)。key 锚定 ghost_call tool_use 的
       *  clientId(`ghostcard-${clientId}`,窗口锚定稳定);卡体 html/height
       *  渲染时从 ghostCardStore 现取(限速 ≥1s/卡,重建频率可控)。
       *  settled=false 为进行中(turn 内活卡,claude 精确 toolUseId 锚 /
       *  codex 同 ghost 启发式锚),tool_result 到达后经 xdt_card_id 配对
       *  转 settled。未供卡的调用不产生本 item —— 逐像素回退今日渲染。 */
      type: 'ghost_card';
      key: string;
      callId: string;
      ghostId: string;
      /** 该次调用的意识侧工具名(toolInput.tool;身份头徽章展示)。 */
      tool: string;
      /** 原始 tool_use 消息(头带展开区显示调用参数;审计层不因行隐身而丢)。 */
      toolCall: ChatMessage;
      settled: boolean;
      /** 配对到的 tool_result 时间戳(ms)。与 AgentTaskRenderItem.resultTsMs 同口径:
       *  toolCall.createdAt 只是"开始调用",一次跑很久的供卡调用(出图 / 出视频)拿它
       *  当结束会把结束时间低估整个执行时长,紧随其后的正文被误判成历史空洞。
       *  未配对(活卡)时缺省。 */
      resultTsMs?: number;
      /** 回锚媒体:后续调用(如 poll_result)的 tool_result 带 xdt_anchor_card_id
       *  指回本卡时,其媒体挂在卡正下方渲染(替换"生成中"的视觉位置),而非
       *  留在轮询调用处。仅同 ghostId 的结果可锚入;无回锚时字段缺省。 */
      media?: ToolMediaItem[];
    }
  | WorkGroupRenderItem;

export function isCompletedAssistantMessage(message: ChatMessage): boolean {
  return (
    message.turnCompleted === true ||
    (message.turnMoney?.amount ?? 0) > 0 ||
    (typeof message.turnCostUsd === 'number' && message.turnCostUsd > 0) ||
    // turnUsageDetails 也只在 turn 结束时 patch(算不出报价的轮次只落它),
    // 与费用字段一样是等价的收尾信号 —— 少这一条,无金额轮就挂不出 action bar。
    message.turnUsageDetails !== undefined
  );
}

/** 完成态 work_group 可合并的子项:tool_segment / agent_task / thinking /
 *  assistant 工作文字。运行态只通过 isWorkActivityItem 收动作,所以不会提前
 *  折叠正在输出的 assistant 文字。 */
function isWorkChild(it: RenderItem): it is WorkChildItem {
  return (
    it.type === 'tool_segment' ||
    it.type === 'agent_task' ||
    (it.type === 'message' &&
      (it.message.role === 'thinking' ||
        (it.message.role === 'assistant' && !it.message.systemCardType)))
  );
}

/** 运行中(未到终态)的子 Agent 卡片 —— 折叠时视为"可见锚点",绝不折进
 *  「已工作 Xs」工作组:任务没完成就归档会谎报终态时长(典型:后台 workflow
 *  子 Agent 仍在跑,父 turn 却已产出最终正文)。status 派生口径与 AgentTaskCard
 *  完全一致:配对的最终 result 会把 stale running 收敛为 completed,但不覆盖
 *  failed/stopped 等明确终态,
 *  保证"卡片显示运行中"与"是否折叠"永远同步。 */
// A paired final result closes a stale running update; this must match AgentTaskCard.
function isRunningAgentTask(it: RenderItem): boolean {
  if (it.type !== 'agent_task') return false;
  const status = deriveAgentTaskStatus(it.update?.status, it.result, {
    persistedStatus: it.persistedStatus,
    resultIsLaunchReceipt:
      subagentSpawnReceiptName(it.toolCall?.toolName, it.toolCall?.toolInput, it.result) !==
        undefined || subagentSpawnResultIndicatesRunning(it.toolCall?.toolName, it.result),
  });
  return status === 'running';
}

/** workflow 卡永远平铺,完成后也不折进工作组:它是后台任务面板的常驻入口,
 *  折叠掉等于把入口藏起来(产品拍板 2026-07-27:完成后保留痕迹、可点击进
 *  面板详情;对齐官方——原版完成的 workflow 行留在对话里)。 */
function isWorkflowTaskItem(it: RenderItem): boolean {
  return (
    it.type === 'agent_task' &&
    (it.update?.taskType === 'local_workflow' || it.toolCall?.toolName === 'Workflow')
  );
}

/** preview 中计为一条真实活动的 render item。assistant 进度文字
 *  始终留在主消息流,不占最近 5 条活动窗口。 */
function isWorkActivityItem(it: RenderItem): it is WorkChildItem {
  return (
    !isRunningAgentTask(it) &&
    // workflow 卡三条分组路径(answered/legacy/active)统一平铺,见 isWorkflowTaskItem。
    !isWorkflowTaskItem(it) &&
    (it.type === 'tool_segment' ||
      it.type === 'agent_task' ||
      (it.type === 'message' && it.message.role === 'thinking'))
  );
}

/**
 * 交付正文 item —— 无论落在 turn 的哪个位置都不折进「已工作 Xs」。
 *
 * 为什么只靠 seal 位置不够:「最终答复」只认最后一次动作之后的正文,而 agent
 * 常见「先输出正文 → 再执行一个收尾副作用(发通知 / 落库 / 提交) → 再说一句
 * 已完成」。这时真正的交付内容排在收尾动作之前,会被整段折起来,只剩收尾那句
 * 元数据留在消息流里(实例:2026-07-31 定时巡检的产品决策简报 3250 字被折,
 * 外面只剩 110 字的「已触发通知」)。
 *
 * 判据(长度 / 块级 markdown 结构)由 maker-shared 的 isDeliveryProseText 单一
 * 提供,两端不各写一份。
 */
function isDeliveryProseItem(it: RenderItem): boolean {
  return (
    it.type === 'message' &&
    it.message.role === 'assistant' &&
    !it.message.systemCardType &&
    isDeliveryProseText(it.message.content)
  );
}

/** 最终可见正文候选:同一用户 turn 内最后一条普通 assistant 文本。 */
function isAssistantAnswerCandidate(it: RenderItem): it is MessageRenderItem {
  return (
    it.type === 'message' &&
    it.message.role === 'assistant' &&
    !it.message.systemCardType &&
    it.message.content.trim().length > 0
  );
}

/** 自动压缩会开始新的 live 工作片段，因此也必须结束压缩前的动作组。 */
function isCompactBoundaryItem(it: RenderItem): it is MessageRenderItem {
  return (
    it.type === 'message' &&
    it.message.role === 'assistant' &&
    it.message.systemCardType === 'compact'
  );
}

/** 子项的稳定 clientId(group key 派生用)。 */
function workChildClientId(it: WorkChildItem): string {
  if (it.type === 'tool_segment') return it.toolCalls[0].clientId;
  if (it.type === 'agent_task') {
    return (
      it.toolCall?.clientId ??
      it.update?.parentToolUseId ??
      it.update?.taskId ??
      (it.key.startsWith('task-update-') ? it.key.slice('task-update-'.length) : it.key)
    );
  }
  return it.message.clientId;
}

/** group 的身份锚在首个真实活动(tool / thinking / agent task)。
 *  完成后的合并组沿用第一段的锚点,保持该段的手动展开态。 */
function workGroupClientId(run: WorkChildItem[]): string {
  const firstActivity = run.find((it) => it.type !== 'message' || it.message.role === 'thinking');
  return workChildClientId(firstActivity ?? run[0]);
}

export function renderItemStartMs(item: RenderItem): number | null {
  if (item.type === 'message') {
    const ms = Date.parse(item.message.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  if (item.type === 'tool_segment') {
    const ms = Date.parse(item.toolCalls[0]?.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  if (item.type === 'agent_task') {
    const ms = Date.parse(item.toolCall?.createdAt ?? item.update?.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  if (item.type === 'agent_plan') {
    const ms = Date.parse(item.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  // ghost_card 是那次调用在流里的**唯一**呈现(工具行被卡片取代),所以它必须
  // 报出调用时间。漏掉的后果是间隔判定把它当"无时间戳"跳过:空洞后的第一个
  // 动作恰好是卡片时切不开,卡片还会被归到空洞前那一组里(#676 review)。
  if (item.type === 'ghost_card') {
    const ms = Date.parse(item.toolCall.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  if (item.type === 'work_group') {
    for (const child of item.children) {
      const childMs = renderItemStartMs(child);
      if (childMs !== null) return childMs;
    }
  }
  // 剩下两类**故意**不报时间,不是漏:
  //  - tool_media:段产物,永远紧跟在派生它的 tool_segment 之后(见 flushSegment),
  //    锚点留在段末正是它自己的时间区间,单独给它一个时间戳没有意义。
  //  - fork_origin:分叉标记,不是动作,不该参与间隔判定。
  return null;
}

/**
 * item 的结束时间戳 —— 空洞判定必须用它,不能用 start。
 *
 * 一个合法连续 turn 里的 tool_segment 本身可能跨半小时以上(段内每次相邻调用都在
 * 阈值内,所以不会被切段)。若拿下一条 item 的 start 去跟这个段的 **start** 比,
 * 差值就等于整段耗时,会把正常长任务误判成历史空洞:该切的没切,不该切的切了,
 * 前面的 assistant 进度文字被留在工作组外,时长也退化成段兜底而非最终答复。
 *
 * 段的结束必须算进 tool_result:单次工具跑半小时以上时(典型:一次长构建 / CI),
 * 段里只有一个 tool_use,它的 createdAt 是"开始执行"的时刻,拿它当段末会把结束
 * 时间低估整个执行时长,紧随其后的最终答复照样被误判成空洞。
 */
function renderItemEndMs(item: RenderItem): number | null {
  if (item.type === 'tool_segment') {
    let latest = Number.NEGATIVE_INFINITY;
    for (const call of item.toolCalls) {
      const callMs = Date.parse(call.createdAt ?? '');
      if (Number.isFinite(callMs)) latest = Math.max(latest, callMs);
      const resultMs = item.resultTsMap.get(call.clientId);
      if (resultMs !== undefined) latest = Math.max(latest, resultMs);
    }
    return Number.isFinite(latest) ? latest : renderItemStartMs(item);
  }
  if (item.type === 'agent_task') {
    // fallback 顺序:updatedAt → update.createdAt → toolCall.createdAt。
    // AgentTaskUpdate 可以只有 createdAt 而没有 updatedAt(见 normalizeAgentTaskUpdate),
    // 那时 update.createdAt 比调用发起时刻更接近任务结束 —— 先取 toolCall.createdAt 会
    // 低估结束时间,进而误判空洞、低报工作组时长(#676 review)。
    const ms = Date.parse(
      item.update?.updatedAt ?? item.update?.createdAt ?? item.toolCall?.createdAt ?? '',
    );
    const liveEnd = Number.isFinite(ms) ? ms : renderItemStartMs(item);
    // 历史会话没有 live update 时,liveEnd 退化成调用的开始时间;result 时间戳才是
    // 这张卡真正的结束(与 tool_segment 同口径)。两者取更晚的。
    if (item.resultTsMs === undefined) return liveEnd;
    return liveEnd === null ? item.resultTsMs : Math.max(liveEnd, item.resultTsMs);
  }
  if (item.type === 'ghost_card') {
    const startMs = renderItemStartMs(item);
    if (item.resultTsMs === undefined) return startMs;
    return startMs === null ? item.resultTsMs : Math.max(startMs, item.resultTsMs);
  }
  if (item.type === 'work_group') {
    // 全量取 max,不是"最后一个 child":children 按**发起**时刻排列,并行的 Agent/Task 乱序完成时
    // 真正的结束时刻可能落在更靠前的 child 上(先发起、更晚 settle)。取最后一个会低估组的结束
    // 时间,于是空洞判定的锚点变小、把本来连续的 turn 误判成空洞切开 —— 与本函数 tool_segment
    // 分支、以及 groupWorkRuns 里 prevEndMs 的 Math.max 是同一条理由(#676 review codex P1)。
    // 手机端同款函数(maker-shared 的 itemEndTimestamp)已按此收敛,#1210 review 指出这里镜像存在。
    let latest: number | null = null;
    for (const child of item.children) {
      const childMs = renderItemEndMs(child);
      if (childMs === null) continue;
      latest = latest === null ? childMs : Math.max(latest, childMs);
    }
    return latest;
  }
  // thinking 的 createdAt 是块**开始**的时刻,真正结束要加 thinkingDurationMs
  // (与 workRunEndTs 同口径)。一个想了半小时以上的 thinking 块后面紧跟工具或正文时,
  // 只看 createdAt 会把它误判成历史空洞、切开一个本来连续的 turn。
  const startMs = renderItemStartMs(item);
  if (startMs !== null && item.type === 'message' && item.message.role === 'thinking') {
    // duration 与 mapServerCreatedAt 同口径夹断:该字段可能是负数 / 非有限值(那边就做了
    // Math.max(0, …) 的防御)。不夹断会得出 end < start,空洞判定与工作组时长都跟着错
    // (#676 review copilot)。
    const durationMs = item.message.thinkingDurationMs;
    const safeDurationMs =
      typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    return startMs + safeDurationMs;
  }
  return startMs;
}

/** 消息 createdAt → epoch ms,缺失 / 非法返回 null。 */
export function messageTs(msg: ChatMessage): number | null {
  if (!msg.createdAt) return null;
  const t = new Date(msg.createdAt).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 边界项(用户消息 / assistant 正文)的时间戳;非 message 项(卡片等)返回 null,
 *  让下一段退回段内锚点,避免把已折叠段的时长重复计入。 */
function boundaryTs(item: RenderItem | undefined): number | null {
  return item && item.type === 'message' ? messageTs(item.message) : null;
}

/** run 首子项的起始时间戳。 */
function workRunStartTs(it: WorkChildItem): number | null {
  if (it.type === 'tool_segment') return messageTs(it.toolCalls[0]);
  if (it.type === 'agent_task') return renderItemStartMs(it);
  return messageTs(it.message);
}

/**
 * run 末子项的结束时间戳 —— 直接复用 renderItemEndMs,不再自己算一份。
 *
 * 原来这里另算一份:tool_segment 取**最后一次调用的发起时刻**、agent_task 取
 * `updatedAt ?? toolCall.createdAt`,两者都不看 tool_result 时间。于是"一个跑了 40 分钟的
 * 工具 / Task 之后紧跟一段历史空洞、后面没有 assistant 正文"时,createWorkGroup 拿不到
 * nextItem、回落到这里,时长显示成约 0s —— 而 renderItemEndMs 明明已经算得出真正的结束
 * 时间(#676 review codex P1)。两处口径合一,顺带修掉 agent_task 那个把
 * `toolCall.createdAt` 排在 `update.createdAt` 前面的旧 fallback 顺序。
 */
function workRunEndTs(it: WorkChildItem): number | null {
  return renderItemEndMs(it);
}

/**
 * 没有终结正文可用时,run 的结束时间 = **所有子项结束时间的最大值**。
 *
 * 不能"从后往前找第一个有时间的子项就返回":并行的 Agent/Task 会乱序完成(A 跑到 40 分钟,
 * B 紧随其后 2 分钟就结束),末尾那张卡的结束时间可能远早于整段真正的结束。被空洞收尾的组
 * 正好走这条 fallback(没有 nextItem),于是 40 分钟的工作显示成约 2 分钟 —— 而空洞判定那边
 * 用的已经是正确的最大值(#676 review codex P1)。
 */
function workRunFallbackEndTs(run: WorkChildItem[]): number | null {
  let latest: number | null = null;
  for (const item of run) {
    const ts = workRunEndTs(item);
    if (ts === null) continue;
    latest = latest === null ? ts : Math.max(latest, ts);
  }
  return latest;
}

function createWorkGroup(
  run: WorkChildItem[],
  nextItem: RenderItem | undefined,
  isStreaming = false,
  prevBoundaryTs: number | null = null,
): Extract<RenderItem, { type: 'work_group' }> {
  const firstActivity = run.find((it) => it.type !== 'message' || it.message.role === 'thinking');
  const anchorTs = workRunStartTs(firstActivity ?? run[0]);
  // 段起点优先锚上一个边界(用户消息 / 上一句正文),与「正在工作…」活表的墙钟
  // 口径一致:一次性到达的 thinking 块 createdAt≈结束时刻,只用段内锚点会把
  // 模型思考整段丢掉(实际 6s 显示 1s,内层相加也对不上外层总表)。边界缺失
  // (窗口截断)或时序异常(rewind 改序)时退回段内锚点。
  const startTs =
    prevBoundaryTs !== null && (anchorTs === null || prevBoundaryTs <= anchorTs)
      ? prevBoundaryTs
      : anchorTs;
  const endTs =
    nextItem && nextItem.type === 'message'
      ? messageTs(nextItem.message)
      : workRunFallbackEndTs(run);
  const durationMs =
    startTs !== null && endTs !== null && endTs >= startTs ? endTs - startTs : undefined;
  return {
    type: 'work_group',
    key: `work-${workGroupClientId(run)}`,
    children: run,
    durationMs,
    isStreaming,
    ...(startTs !== null ? { startedAtMs: startTs } : {}),
  };
}

/** 完成态时间线:assistant 工作文字直接成为外组子项,文字之间的连续动作
 *  继续复用 createWorkGroup 生成内层「已工作 Xs」。外组使用独立 key,
 *  避免与第一段动作共享展开记忆;内组 key 保持不变,从运行中到完成后连续。 */
function createCompletedWorkGroup(
  run: WorkChildItem[],
  nextItem: RenderItem | undefined,
  prevBoundaryTs: number | null = null,
): WorkGroupRenderItem {
  const hasAssistantText = run.some(
    (item) => item.type === 'message' && item.message.role === 'assistant',
  );
  if (!hasAssistantText) return createWorkGroup(run, nextItem, false, prevBoundaryTs);

  const children: WorkGroupChildItem[] = [];
  let activityRun: WorkChildItem[] = [];
  let innerPrevBoundaryTs = prevBoundaryTs;
  const flushActivityRun = (activityNextItem: RenderItem | undefined) => {
    if (activityRun.length === 0) return;
    children.push(createWorkGroup(activityRun, activityNextItem, false, innerPrevBoundaryTs));
    activityRun = [];
  };

  for (const item of run) {
    if (isWorkActivityItem(item)) {
      activityRun.push(item);
      continue;
    }
    flushActivityRun(item);
    children.push(item);
    innerPrevBoundaryTs = boundaryTs(item);
  }
  flushActivityRun(nextItem);

  const outer = createWorkGroup(run, nextItem, false, prevBoundaryTs);
  return {
    ...outer,
    key: `work-summary-${workGroupClientId(run)}`,
    children,
    isStreaming: false,
  };
}

/** Keep desktop card shapes and stable keys while sharing turn, gap and answer boundaries. */
export function groupWorkRuns(items: RenderItem[], isSessionStreaming: boolean): RenderItem[] {
  return groupSharedWorkRuns<RenderItem, WorkChildItem>(items, isSessionStreaming, {
    isUserBoundary: (item) => item.type === 'message' && item.message.role === 'user',
    isAnswer: isAssistantAnswerCandidate,
    isSealedAnswer: (item) => item.type === 'message' && isCompletedAssistantMessage(item.message),
    isCompactBoundary: isCompactBoundaryItem,
    isActivity: isWorkActivityItem,
    isArchivable: (item): item is WorkChildItem =>
      !isRunningAgentTask(item) &&
      !isWorkflowTaskItem(item) &&
      !isDeliveryProseItem(item) &&
      isWorkChild(item),
    startTimestamp: renderItemStartMs,
    endTimestamp: renderItemEndMs,
    boundaryTimestamp: boundaryTs,
    userBoundaryEnd: (item, previousEnd) => renderItemEndMs(item) ?? previousEnd,
    createGroup: createWorkGroup,
    createCompletedGroup: createCompletedWorkGroup,
  });
}
