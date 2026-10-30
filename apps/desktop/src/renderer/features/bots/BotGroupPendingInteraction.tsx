/**
 * 正在发言的伙伴在群专线里等用户确认时，把确认卡片直接放进群聊时间线。
 *
 * 群专线是一条普通 Cindy Session：权限请求 / 提问经 maker 事件进入 makerChatStore，
 * 与任务页是同一份状态（按 sessionId 分片），这里只读它的轻量快照并复用任务页的
 * PermissionPrompt / AskUserQuestionPrompt / InputHandoffCard，作答也走同一条路径。其它交互（计划
 * 审阅、插件配置等）在群里只提示「在等你确认」。
 *
 * 灵动岛活动镜像报告等待交互、store 里却没有卡片时（窗口刚重载、错过了实时推送），
 * 先显示这条提示，再按任务页打开时的同一路径补读一次这条专线：ensureInitialMessages
 * 会顺带向宿主拉挂起交互的快照并重建卡片；读进来的历史受 store 的软淘汰约束。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AskUserQuestionPrompt } from '@/components/new-chat/AskUserQuestionPrompt';
import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';
import { InputHandoffCard } from '@/features/input-handoff/InputHandoffCard';
import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import type { BotChatIdentity } from './BotSessionContentHeader';

export function BotGroupPendingInteraction({
  sessionId,
  bot,
}: {
  sessionId: string;
  bot: BotChatIdentity;
}) {
  const { t } = useTranslation();
  const subscribe = useCallback(
    (listener: () => void) => makerChatStore.subscribeLight(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(() => makerChatStore.getLightSnapshot(sessionId), [sessionId]);
  const light = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const questionRequestId = light.pendingAskUser?.requestId;
  const [questionFiles, setQuestionFiles] = useState<{
    sessionId: string; requestId: string; workingDir: string; remoteHostId: string | null;
  } | null>(null);
  useEffect(() => {
    if (!questionRequestId) return;
    let cancelled = false;
    // Group lanes are hidden from the task list; use the actual lane/step row,
    // whose worktree may differ from both the group folder and the bot's home.
    void (async () => {
      try {
        const session = await sessionService.get(sessionId);
        if (!cancelled) setQuestionFiles({ sessionId, requestId: questionRequestId,
          workingDir: session.workingDir ?? '', remoteHostId: session.remoteHostId ?? null });
      } catch {
        // Keep the question answerable when its local lane is unavailable.
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, questionRequestId]);
  const currentQuestionFiles = questionFiles?.sessionId === sessionId && questionFiles.requestId === questionRequestId
    ? questionFiles : null;
  const activity = useAgentIslandActivity(sessionId);
  const missedCard =
    activity?.phase === 'needs-interaction' && !light.pendingPermission && !light.pendingAskUser;
  const recoveredSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!missedCard || recoveredSessionRef.current === sessionId) return;
    recoveredSessionRef.current = sessionId;
    makerChatStore.ensureInitialMessages(sessionId);
  }, [missedCard, sessionId]);

  if (light.pendingPermission) {
    return (
      <PermissionPrompt
        // P1 security: 与任务页同一套防护 —— 按 requestId remount,让实例(连同它
        // 冻结的 capturedRequestId 与键盘监听)随 A 卡一起销毁。若实例被复用,
        // A 的迟到点击会带着 A 的身份落到 B 的按钮上。
        key={light.pendingPermission.requestId}
        permission={light.pendingPermission}
        companion={bot}
        // P1 security: 端到端转发身份。不传第三个参数时 store 会退回「当前队首」,
        // 于是 A 结束后晋升的 B 会被 A 的迟到响应直接批准/拒绝。
        onRespond={(result) =>
          makerChatStore.respondToPermission(sessionId, result, result.requestId)
        }
      />
    );
  }
  if (light.pendingAskUser) {
    return (
      <AskUserQuestionPrompt
        sessionId={sessionId}
        workingDir={currentQuestionFiles?.workingDir ?? ''}
        remoteHostId={currentQuestionFiles?.remoteHostId}
        pending={light.pendingAskUser}
        onAnswer={(requestId, answers) => makerChatStore.answerUserQuestion(sessionId, requestId, answers)}
        viewerState={light.askUserViewerState}
        onViewerStateChange={(next) => makerChatStore.setAskUserViewerState(sessionId, next)}
        draft={light.askUserDraft}
        onDraftChange={(next) => makerChatStore.setAskUserDraft(sessionId, next)}
      />
    );
  }
  if (light.pendingInputHandoff) {
    return (
      <InputHandoffCard
        key={light.pendingInputHandoff.requestId}
        sessionId={sessionId}
        snapshot={light.pendingInputHandoff}
      />
    );
  }
  const waiting =
    activity?.phase === 'needs-interaction' ||
    light.pendingPlanReview !== null ||
    light.pendingPluginSetup !== null ||
    light.pendingIssueConfirm !== null ||
    light.pendingRenameSessionsConfirm !== null ||
    light.pendingGhostGrantConfirm !== null ||
    light.pendingRemoteDesktopConfirmation !== null;
  if (!waiting) return null;
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 text-13 text-[var(--text-secondary)]"
    >
      <CircleAlert size={14} className="shrink-0 text-[var(--warning-fg)]" aria-hidden />
      {t('bots.groupChat.waitingConfirm', { name: bot.name })}
    </p>
  );
}
