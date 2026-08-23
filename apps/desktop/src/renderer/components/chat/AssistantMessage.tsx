/**
 * AssistantMessage
 * ---------------------------------------------------------------------------
 * Left-aligned assistant message with Markdown rendering.
 *
 * F-MSG-1: assistant message styling (left-aligned, no bubble)
 * F-MSG-2: Markdown rendering
 * message-actions V1.2: hover-revealed bar below the markdown body, left-aligned,
 *   order [copy][fork][more][time][cost]. Streaming messages do NOT mount the bar (per spec
 *   "流式期间不挂载"); 且仅当父层标记本消息为 turn 收尾正文(showActionBar)
 *   时才挂载 —— 任务执行过程中的中间句没有操作行。The bar
 *   owns its own fade lifecycle (see MessageActionBar) so this component
 *   only tracks raw hover state.
 *
 * Streaming render strategy (line-commit, codex-style):
 *   Stream 期间把 content 切成两段:
 *     - committedText  = 累积到最后一个 '\n' 为止的部分 (含换行)
 *     - pendingLine    = 最后一个 '\n' 之后的不完整行
 *   committedText 走完整 MarkdownRenderer (享受 100ms throttle),
 *   pendingLine 走 plain-text <span>。这样收效:
 *     - 已经完整的行实时格式化, 屏幕上 95% 的内容用户看到的是渲染后样式,
 *       不会看到一堆 raw `**` `##` 标记
 *     - markdown parser 只在 "出现新换行" 时才有可能跑 (frequency = lines/sec
 *       而非 tokens/sec, 量级降 10-50 倍), 主线程压力大幅降低
 *     - pendingLine 是纯文本 div, 每个 token 只追加 textContent, 几乎零成本
 *   代价:
 *     - 跨行的 markdown 结构 (未闭合的 ``` code fence / 多行 table) 在闭合
 *       之前会以 "未闭合状态" 渲染, 视觉上会有半秒级抖动 — 但比卡死好
 *     - 行尾 inline 标记如果跨 token 抵达 (如 "**bold" + "**"), 在 ** 闭合前
 *       那行处于 pendingLine, 用户看到 `**bold` 字面值, 闭合后切到 committedText
 *       立刻变粗 — 这个跳变在打字机节奏下属于自然观感
 *
 *   选这个方案的依据: codex (codex-rs/tui/src/streaming/controller.rs:67-72)
 *   就是这么做的, ground-truth 反推这是流式 markdown 的最佳折中。Claude Code
 *   Desktop 的方案是 streaming 期间完全不渲染, 视觉上看到全是 raw markdown
 *   直到 finally — 那个体验更差, 没有借鉴。
 */

import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatModelShortLabel } from '@/lib/modelShortLabel';
import { stripGoalVerdictBlock } from '@/lib/goalVerdict';
import { getGhostCardEntry, subscribeGhostCards } from '@/cindy-brain/ghostCardStore';
import { GhostToolCard } from './GhostToolCard';
import type { KnownLocalFileRef } from '@/lib/localPathResolver';
import type { AgentKind as RendererAgentKind } from '@/lib/ccAgent.types';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';
import type { RegionalMoney } from '../../../shared/regionalMoney';
import { useAgentCapabilities, type AgentKind as MakerAgentKind } from '@/hooks/useAgentCapabilities';
import { useSessionFileOrigin } from './ChatSessionFileContext';
import { originDeviceId } from '@/lib/sessionFileOrigin';
import { buildSessionMessageDeepLink } from '@/lib/deepLink';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { insertSessionLinkIntoComposer } from '@/lib/composerActionsBus';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MessageActionBar } from './MessageActionBar';
import { shareSelectionStore } from './shareSelectionStore';
import { useForkAtMessage } from './useForkAtMessage';
import { useDeleteMessage } from './useDeleteMessage';
import {
  isInteractiveSessionNavigationMode,
  useSessionNavigationMode,
} from '@/features/cc-agent/embeddedSessionNavigation';

/**
 * Streaming 渲染策略开关 (代码级 / 编译期):
 *   - false (默认) = 原方案: 全程把累积 content 喂给 MarkdownRenderer,靠它内部
 *                    的 100ms throttle 节流。视觉零取舍, streaming 中所有 markdown
 *                    即时格式化, 但主线程负载最高 (大答复 + 大 doc 共存时易卡)。
 *   - true         = 行级提交方案 (codex 风格): 切成 committedText + pendingLine,
 *                    committedText 走 MarkdownRenderer + memo 跳过, pendingLine
 *                    走纯文本 <span>。主线程压力最低, 代价是当前未完成行不格式化。
 *
 * 默认 false — 用户实测下来差异不明显, 先回到无视觉副作用的方案。要做对比测试
 * 或排查 doc 卡顿时翻成 true, 不需要改其它任何代码 / 不走 env / 不走配置中心 —
 * 单文件单常量, 改完重启 dev 即生效。
 *
 * 用 boolean 而不是 'original' | 'line-commit' 字符串 enum 是因为 TS 对 const
 * 初始化的字符串字面量会做类型收窄, 比较时报 TS2367; boolean 不会。
 */
const USE_LINE_COMMIT_STREAMING: boolean = false;

/**
 * 把流式累积文本按最后一个 '\n' 切成 (已提交段, 未完成行) 两段。
 * 没有任何 '\n' → 整段都是未完成行, committedText 为空。
 * 末尾就是 '\n' → pendingLine 为空字符串。
 */
function splitAtLastNewline(text: string): { committedText: string; pendingLine: string } {
  const idx = text.lastIndexOf('\n');
  if (idx < 0) return { committedText: '', pendingLine: text };
  return {
    committedText: text.slice(0, idx + 1),
    pendingLine: text.slice(idx + 1),
  };
}

/**
 * StreamingBody — 流式渲染体: committedText 走 markdown, pendingLine 走 plain。
 *
 * 关键性能点:
 *   - useMemo 切分 → committedText 引用稳定 (只在新 \n 出现时变), MarkdownRenderer
 *     被 memo 包过, 拿到相同 string 引用就跳过整次 react-markdown 解析。结果就是
 *     "每次新 token 但还没换行" 时, markdown 子树完全不重渲染, 只有底下那个
 *     pending <span> 的 textContent 变, 浏览器开销几乎为 0。
 *   - MarkdownRenderer 仍然带 isStreaming=true → 100ms throttle 还在, 当多个
 *     新行短时间内连续到达时合并成一次 parse。
 *   - pendingLine 用 <span> 而不是 <div>, 接在 markdown 输出尾部不会换行 — 视觉
 *     上接续上一段最后那个块级元素的末尾, 和 codex 行级提交后那行 "正在打字"
 *     的观感一致。如果 markdown 最后一个块是 <p>, 浏览器会把 <span> 渲在该 <p>
 *     之外的下一行, 但视觉上仍连续 (line-height 一致)。
 */
const StreamingBody = memo(function StreamingBody({
  workingDir,
  content,
  localFileRefs,
  currentSessionId,
  currentSessionTitle,
  streamFadeKey,
  allowPrivilegedLinks,
}: {
  workingDir: string;
  content: string;
  localFileRefs?: readonly KnownLocalFileRef[];
  currentSessionId?: string;
  currentSessionTitle?: string | null;
  streamFadeKey?: string;
  allowPrivilegedLinks: boolean;
}) {
  const { committedText, pendingLine } = useMemo(
    () => splitAtLastNewline(content),
    [content],
  );
  return (
    <>
      {committedText && (
        <MarkdownRenderer
          workingDir={workingDir}
          content={committedText}
          isStreaming
          streamFadeKey={streamFadeKey}
          localFileRefs={localFileRefs}
          currentSessionId={currentSessionId}
          currentSessionTitle={currentSessionTitle}
          allowPrivilegedLinks={allowPrivilegedLinks}
        />
      )}
      {pendingLine && (
        <span className="whitespace-pre-wrap break-words">{pendingLine}</span>
      )}
    </>
  );
});

interface AssistantMessageProps {
  /** F1 transit: pass through to MarkdownRenderer for local-path resolution
   *  in markdown links. Stable per-session; doesn't trigger extra renders. */
  workingDir: string;
  /**
   * Whether this content may reach privileged link targets (`file:` and Cindy
   * deep links) on *this* machine. False for anything whose author is another
   * machine — a device-link or SSH task — where `workingDir` names a path the
   * control side does not own. Default true keeps every existing caller,
   * which renders local sessions, exactly as it was.
   */
  allowPrivilegedLinks?: boolean;
  localFileRefs?: readonly KnownLocalFileRef[];
  currentSessionId?: string;
  currentSessionTitle?: string | null;
  content: string;
  isStreaming?: boolean;
  /** ISO timestamp for the smart-time display in the hover action bar. */
  createdAt?: string;
  /** clientId of this message (== messages.client_id in DB) — backend fork
   *  IPC takes (sessionId, clientId) to locate the fork point. When omitted,
   *  the Fork button is not rendered. */
  messageClientId?: string;
  /** Owning agent kind — gates Fork icon visibility via capabilities,
   *  same scheme as UserMessage. */
  agentKind?: RendererAgentKind;
  /** Owning session's remote SSH host id (null for local). Remote cc daemon
   *  sessions don't support the query-rebuild that Fork needs yet (MVP). */
  remoteHostId?: string | null;
  /** True when this assistant belongs to the still-active tail turn. */
  forkBlocked?: boolean;
  /** Whole-session running state; single-message deletion waits until idle. */
  sessionRunning?: boolean;
  /** 是否挂载 hover action bar(复制 / 分叉 / 时间 / 费用)。父层只对每个 turn
   *  的收尾 assistant 正文传 true —— 任务执行过程中的中间句不挂 bar(bar 即使
   *  opacity-0 也占 24px 布局高度,每句都挂会拉散消息流)。默认 false。 */
  showActionBar?: boolean;
  /** Per-turn 费用 (USD) — 仅该轮最后一条 assistant 有值, action bar 时间旁显示。 */
  turnMoney?: RegionalMoney;
  turnCostUsd?: number;
  /** true = 订阅模式下的 token 价值;false = API 账单 cost / API 单价折算 cost。 */
  turnCostIsEstimate?: boolean;
  userTurnMoney?: RegionalMoney;
  userTurnCostUsd?: number;
  userTurnCostIsEstimate?: boolean;
  /** Per-turn token/cache 明细。 */
  turnUsageDetails?: TurnUsageDetails;
  /** 同一用户轮跨多个 SDK segment 聚合后的 token/cache/model 明细。 */
  userTurnUsageDetails?: TurnUsageDetails;
  /** 本轮模型降级标记(main turn 结束检测命中时挂到收尾 assistant 上),
   *  正文下方渲染一条常显的降级提示行。 */
  modelMismatch?: { selected: string; actual: string };
  /** 出口钩子(will-assistant-message)后台处理中:回复已显示、意识还在跑那段
   *  (润色/自绘,最长 5 分钟)挂一条"意识处理中"轻指示;完成/超时由 main 清。 */
  ghostReplyPending?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({
  workingDir,
  allowPrivilegedLinks = true,
  localFileRefs,
  currentSessionId,
  currentSessionTitle,
  content,
  isStreaming,
  createdAt,
  messageClientId,
  agentKind,
  remoteHostId,
  forkBlocked,
  sessionRunning,
  showActionBar = false,
  turnMoney,
  turnCostUsd,
  turnCostIsEstimate,
  userTurnMoney,
  userTurnCostUsd,
  userTurnCostIsEstimate,
  turnUsageDetails,
  userTurnUsageDetails,
  modelMismatch,
  ghostReplyPending,
}: AssistantMessageProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  // 出口钩子自绘卡(will-assistant-message render):卡片以本消息 clientId 为键
  // 存在 ghostCardStore 里,存在即"该气泡被意识自绘替换"。原文仍在 content 里,
  // 提供"查看原文"切换(信任边界:意识盖不住 AI 实际说了什么)。
  const renderCardEntry = useSyncExternalStore(subscribeGhostCards, () =>
    messageClientId ? getGhostCardEntry(messageClientId) : undefined,
  );
  const ghostRenderCard = renderCardEntry?.status === 'ready' ? renderCardEntry : null;
  const [showOriginal, setShowOriginal] = useState(false);

  // fork-from-reply: 在 AI 回复上分叉 — 复制含本回复所在 turn 的全部上下文
  // 到新会话（语义在 main 侧 forkSessionAtMessage 按 role 分支）。capability /
  // remote gate 与 UserMessage 同款；assistant 分叉无可预填文本 → 不传 draftText。
  const makerKind: MakerAgentKind = agentKind === 'codex' || agentKind === 'pi' ? agentKind : 'claude-code';
  // device-link 远程会话:fork 能力按被控端读(本机会话 deviceId undefined,行为不变)。
  // deviceId 取自 ChatSessionFileContext(MessageStream 顶层订阅式构造,见该文件注释)。
  const sessionFileOrigin = useSessionFileOrigin();
  const { capabilities } = useAgentCapabilities(
    makerKind,
    currentSessionId ? originDeviceId(sessionFileOrigin) : undefined,
  );
  const isRemote = Boolean(remoteHostId);
  const forkSupported = !isRemote && (!agentKind || (capabilities?.fork?.supported ?? true));
  const handleFork = useForkAtMessage({
    sessionId: currentSessionId,
    messageClientId,
    forkBlocked: forkBlocked || isStreaming,
  });
  const handleDelete = useDeleteMessage({
    sessionId: currentSessionId,
    messageClientId,
    blocked: sessionRunning || isStreaming,
  });
  const navigationMode = useSessionNavigationMode();
  const canFork =
    isInteractiveSessionNavigationMode(navigationMode) &&
    Boolean(currentSessionId && messageClientId) &&
    forkSupported;
  // 远程会话的消息深链把归属设备冻进 `?device=`(粘滞解析,relay 重连窗口不丢),
  // 复制/「加入对话」产出的链接在任何时刻发送都能路由回来源设备。
  const messageDeepLink = currentSessionId && messageClientId
    ? buildSessionMessageDeepLink(currentSessionId, messageClientId, {
        deviceId: getStickySessionDeviceId(currentSessionId),
      })
    : undefined;
  // 分享为图片:进入选择模式并预选本条(入口那条天然该已勾选,省一次点击)。
  const handleShareAsImage = useMemo(
    () =>
      currentSessionId && messageClientId
        ? () => shareSelectionStore.enter(currentSessionId, messageClientId)
        : undefined,
    [currentSessionId, messageClientId],
  );
  const handleAddToChat = useCallback(() => {
    if (!currentSessionId || !messageDeepLink) return;
    insertSessionLinkIntoComposer({
      targetSessionId: currentSessionId,
      href: messageDeepLink,
    });
  }, [currentSessionId, messageDeepLink]);

  // /goal:隐藏助手输出末尾由 goal 协议要求模型吐出的裁决 JSON 块(仅显示层剥离,
  // 原文仍保留在 DB / transcript)。pattern:末尾的 ```json {...goal_status...} ``` 围栏块。
  const displayContent = stripGoalVerdictBlock(content);
  const streamFadeKey = messageClientId
    ? `${currentSessionId ?? ''}\u0000${messageClientId}`
    : undefined;

  return (
    <div
      className="flex w-full flex-col items-start gap-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={cn(
          // min-w-0: flex item 默认 min-width: auto 会被 <pre> 的固有宽度撑爆，
          // 导致代码块溢出消息流右边界。加上 min-w-0 让 w-full 真正生效，
          // <pre> 的 overflow-x-auto 才能正常接管横向滚动。
          'w-full min-w-0',
          'text-15 font-normal leading-[1.6]',
          'text-[var(--msg-assistant-text)]',
        )}
      >
        {ghostRenderCard && messageClientId && !showOriginal ? (
          // 出口钩子自绘:意识卡片替换气泡(净化后的静态 HTML,沙箱 iframe)。
          // 复用 GhostToolCard(自带主机身份头 + 主题注入 + 沙箱),turn 级无
          // 工具名/参数,running 恒 false(turn 已结束)。
          <GhostToolCard
            callId={messageClientId}
            ghostId={ghostRenderCard.ghostId}
            toolName=""
            toolInput={undefined}
            html={ghostRenderCard.html}
            height={ghostRenderCard.height}
            running={false}
            sessionId={currentSessionId}
          />
        ) : isStreaming && USE_LINE_COMMIT_STREAMING ? (
          <StreamingBody
            workingDir={workingDir}
            content={displayContent}
            localFileRefs={localFileRefs}
            currentSessionId={currentSessionId}
            currentSessionTitle={currentSessionTitle}
            streamFadeKey={streamFadeKey}
            allowPrivilegedLinks={allowPrivilegedLinks}
          />
        ) : (
          // 默认分支 (USE_LINE_COMMIT_STREAMING=false) + 非 streaming 都走完整
          // MarkdownRenderer。isStreaming 透传 — true 时 MarkdownRenderer 内部启用
          // 100ms throttle, false 时无节流, 行为和该文件性能优化前完全一致。
          <MarkdownRenderer
            workingDir={workingDir}
            content={displayContent}
            isStreaming={isStreaming}
            streamFadeKey={streamFadeKey}
            localFileRefs={localFileRefs}
            currentSessionId={currentSessionId}
            currentSessionTitle={currentSessionTitle}
            allowPrivilegedLinks={allowPrivilegedLinks}
          />
        )}
        {/* 自绘卡在场:提供原文 ↔ 意识卡片切换(信任边界,主机绘制,始终可切回原文)。 */}
        {ghostRenderCard && (
          <button
            type="button"
            onClick={() => setShowOriginal((v) => !v)}
            className="mt-1 text-11 underline decoration-dotted underline-offset-2"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {showOriginal ? t('chat.ghostHook.viewGhostCard') : t('chat.ghostHook.viewOriginal')}
          </button>
        )}
        {/* 出口钩子后台处理中:回复已显示、意识还在跑那段的轻指示(规则 7:
            spinner 挂 wrapper 的 compositor-only transform,仅 pending 时挂载)。 */}
        {ghostReplyPending && !ghostRenderCard && (
          <div className="mt-1 flex items-center gap-1.5 text-11" style={{ color: 'var(--text-tertiary)' }}>
            <span className="inline-flex animate-spin motion-reduce:animate-none">
              <Loader2 size={11} />
            </span>
            {t('chat.ghostHook.processing')}
          </div>
        )}
        {/* 模型降级提示:所选模型本轮被上游静默替换(main turn 结束检测,详见
            shared/modelMismatch.ts)。常显不随 hover —— 用户需要在不悬停的情况
            下知道这轮不是自己选的模型回答的;icon 用 warning 语义色(token 豁免
            簇),文字保持 tertiary 灰阶,不喧宾夺主。 */}
        {modelMismatch && (
          <div className="mt-1 flex items-center gap-1.5 text-11" style={{ color: 'var(--text-tertiary)' }}>
            <TriangleAlert size={11} style={{ color: 'var(--warning-fg)' }} aria-hidden />
            {t('chat.modelMismatch.notice', {
              actual: formatModelShortLabel(modelMismatch.actual) || modelMismatch.actual,
              selected: formatModelShortLabel(modelMismatch.selected) || modelMismatch.selected,
            })}
          </div>
        )}
      </div>
      {/* Streaming → bar not mounted at all (V1.2 验收 "流式期间不挂载");
          非 turn 收尾正文(showActionBar=false)同样不挂,消息流保持紧凑 */}
      {!isStreaming && showActionBar && (
        <MessageActionBar
          createdAt={createdAt}
          copyText={content}
          copyLinkText={messageDeepLink}
          align="left"
          hovered={hovered}
          onFork={canFork ? handleFork : undefined}
          onAddToChat={messageDeepLink ? handleAddToChat : undefined}
          onShareAsImage={handleShareAsImage}
          onDelete={currentSessionId && messageClientId ? handleDelete : undefined}
          turnMoney={turnMoney}
          turnCostUsd={turnCostUsd}
          turnCostIsEstimate={turnCostIsEstimate}
          userTurnMoney={userTurnMoney}
          userTurnCostUsd={userTurnCostUsd}
          userTurnCostIsEstimate={userTurnCostIsEstimate}
          turnUsageDetails={userTurnUsageDetails ?? turnUsageDetails}
        />
      )}
    </div>
  );
});
