/**
 * LearnStatusCard —— /learn 蒸馏 run 的聊天流状态卡(systemCardType='learn')。
 *
 * 卡片数据只存 runId,状态经 useLearnRun 订阅 learn:event 实时刷新。
 * 设计原则:skill 是蒸馏会话的活产物 —— 蒸馏过程/说明/迭代都发生在会话
 * 对话里,卡片只做三件事:进度可见、跳转到蒸馏会话、待审查时给出
 * 「查看 diff / 应用」的落盘闸门入口。
 *
 * 触发会话(originSession)里的卡在蒸馏 session 就绪时自动把用户带过去
 * (一次性),之后的一切都在蒸馏会话里进行。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { GraduationCap, ArrowRight } from 'lucide-react';
import { toast } from '@/lib/toast';

import { Spinner } from '@/components/ui/spinner';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import type { LearnRunPublic } from '../../../shared/learnTypes';
import { useLearnRun } from './useLearnRun';
import { LearnReviewPanel } from './LearnReviewPanel';
import { learnApiFor } from './learnTransport';
import { getSessionDeviceId, remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { ERROR_REASON_I18N_KEYS } from '@/components/chat/errorReasonI18n';
import { getToolLoopI18nKey } from '@/components/chat/toolLoopI18n';
import { parseToolLoopErrorDetails } from '@cindy/maker-shared/tool-loop-error';

/** 首次跳转登记(模块级,跨组件重挂存活):自动带用户去蒸馏会话只发生一次。
 *  用 ref 会在"用户切回原会话 → 卡片重挂"时归零,把用户再次强行拽走
 *  (Codex review 修正)。 */
const autoNavigatedRuns = new Set<string>();

interface LearnStatusCardProps {
  data?: Record<string, unknown>;
  /** 卡片实际所在消息流的 sessionId(SystemCard 经 MessageStream 注入)。
   *  嵌入式视图(Orca split pane)里 URL 参数是 lead 而非本 pane,不能只靠
   *  useParams —— 归属判定 / device-link 路由都要用真实渲染上下文
   *  (Codex review #548)。缺失时回退 URL 参数(独立路由场景两者一致)。 */
  contextSessionId?: string;
}

export function LearnStatusCard({ data, contextSessionId }: LearnStatusCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  // 卡片归属会话 = 渲染所在消息流(prop 优先),URL 参数只作独立路由场景的回退。
  const cardSessionId = contextSessionId ?? routeSessionId;
  const runId = typeof data?.runId === 'string' ? data.runId : undefined;
  // cardSessionId 兼作路由上下文:device-link 远程会话时 learn run 的事实源在被控端。
  const run = useLearnRun(runId, cardSessionId);
  const [reviewOpen, setReviewOpen] = useState(false);

  // 触发会话里的卡:蒸馏 session 就绪即带用户过去(每个 run 仅一次,登记在
  // 模块级 Set —— 用户主动切回原会话时不再被拽走)。蒸馏会话是用户与 skill
  // 交互的主场,原会话只留这张卡作回程链接。
  const isOriginCard = !!run && run.originSessionId === cardSessionId && run.sessionId !== cardSessionId;
  // 远程上下文:蒸馏会话的 origin 注册是异步的(sessions:created push → 重拉),
  // 订阅镜像变化,注册后 effect 重跑再导航(Codex review #548)。
  const distillSessionOrigin = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    () => (run?.sessionId ? getSessionDeviceId(run.sessionId) : undefined),
  );
  useEffect(() => {
    if (!run || !isOriginCard) return;
    if (run.status !== 'distilling' || !run.sessionId) return;
    if (autoNavigatedRuns.has(run.runId)) return;
    // 远程 learn:蒸馏会话必须已注册进 remoteProjectsStore 才能导航 ——
    // learn:event 带来 run.sessionId 时,匹配的 sessions:created 重拉可能还没完成,
    // 提前导航会让 SessionView 把它当本机未知会话加载成空视图。未注册 → 主动
    // 重拉该设备会话列表,注册后 distillSessionOrigin 变化触发本 effect 重跑。
    const cardDeviceId = getStickySessionDeviceId(cardSessionId);
    if (cardDeviceId && distillSessionOrigin === undefined) {
      void refreshRemoteDeviceSessions(
        cardDeviceId,
        remoteProjectsStore.getDeviceName(cardDeviceId) ?? cardDeviceId,
      );
      return;
    }
    autoNavigatedRuns.add(run.runId);
    navigate(`/cc-agent/${run.sessionId}`);
  }, [isOriginCard, navigate, run, cardSessionId, distillSessionOrigin]);

  if (!runId || !run) return null;

  const isRunning = run.status === 'collecting' || run.status === 'distilling';
  const errorI18nKey = run.errorReason ? ERROR_REASON_I18N_KEYS[run.errorReason] : undefined;
  const toolLoop = parseToolLoopErrorDetails(run.toolLoop);
  const toolLoopI18nKey = run.errorReason === 'tool_use_loop_detected'
    ? getToolLoopI18nKey(toolLoop)
    : undefined;
  const errorText = toolLoopI18nKey && toolLoop
    ? t(toolLoopI18nKey, { count: toolLoop.count })
    : errorI18nKey
      ? t(errorI18nKey)
      : run.error;

  const handleCancel = async (): Promise<void> => {
    try {
      await learnApiFor(cardSessionId).cancel({ runId });
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { namespace: 'learn.ipcError', fallback: 'learn.toast.failed' })));
    }
  };

  return (
    <div className="my-2 rounded-lg border border-border bg-[var(--surface-chip)] px-3.5 py-3 text-sm">
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Spinner size={15} className="text-muted-foreground" />
        ) : (
          <GraduationCap size={15} className="shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 min-w-0 truncate font-medium">
          {t(statusTitleKey(run), { name: run.skillName ?? '' })}
        </span>
        {isRunning && (
          <button
            type="button"
            onClick={() => void handleCancel()}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50"
          >
            {t('learn.card.cancel')}
          </button>
        )}
        {isOriginCard && run.sessionId && (
          <button
            type="button"
            onClick={() => navigate(`/cc-agent/${run.sessionId}`)}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50"
          >
            {t('learn.card.openSession')}
            <ArrowRight size={12} />
          </button>
        )}
        {run.status === 'awaiting-review' && (
          <button
            type="button"
            onClick={() => setReviewOpen(true)}
            className="shrink-0 rounded-md bg-[var(--accent-cta-bg)] px-2.5 py-1 text-xs text-[var(--accent-pure-cta-fg)] hover:opacity-90"
          >
            {t('learn.card.review')}
          </button>
        )}
      </div>

      <p className="mt-1 truncate pl-[23px] text-xs text-muted-foreground">
        {run.status === 'awaiting-review' && !isOriginCard
          ? t('learn.card.continueHint')
          : run.sourceKind === 'hub' && run.hubSlug
            ? `hub:${run.hubCatalogScope ? `${run.hubCatalogScope}:` : ''}${run.hubSlug}`
            : run.sourceKind === 'session'
              ? t('learn.card.fromConversation')
              : run.input}
      </p>

      {/* failed 的错误;或上一轮对话改坏了提案(旧版保留)的提示 */}
      {errorText && (run.status === 'failed' || run.status === 'awaiting-review') && (
        <p className="mt-1.5 pl-[23px] text-xs text-[var(--error-fg)]">{errorText}</p>
      )}

      {run.status === 'awaiting-review' && (
        <LearnReviewPanel open={reviewOpen} onClose={() => setReviewOpen(false)} run={run} contextSessionId={cardSessionId} />
      )}
    </div>
  );
}

function statusTitleKey(run: LearnRunPublic): string {
  switch (run.status) {
    case 'collecting':
      return 'learn.card.collecting';
    case 'distilling':
      return 'learn.card.distilling';
    case 'awaiting-review':
      return 'learn.card.awaitingReview';
    case 'applied':
      return 'learn.card.applied';
    case 'discarded':
      return 'learn.card.discarded';
    case 'cancelled':
      return 'learn.card.cancelled';
    case 'expired':
      return 'learn.card.expired';
    case 'failed':
    default:
      return 'learn.card.failed';
  }
}
