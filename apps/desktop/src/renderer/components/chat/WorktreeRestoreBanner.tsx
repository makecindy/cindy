import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
/**
 * 「工作区已被回收 / 有未应用快照」恢复横幅(P1,输入框上方,与 InterruptedTurnBanner 同位置)
 * ---------------------------------------------------------------------------
 * 自足组件(仿 UpgradeBanner):按 sessionId 自查 worktree:restore-status,两种
 * 状态渲染(其余自渲染 null,父级无需条件编排):
 *   - restorable(目录没了但 cindy/<name> 或历史 xdt/<name> 分支还在)→恢复入口;
 *   - present + hasSnapshot(目录还在,但残留待 apply 的快照——典型是回收时
 *     stash 成功但目录删除失败,或上次恢复只重建了目录、快照 apply 失败)
 *     →「有未应用的更改快照 → 恢复更改」,文案不再谎称"目录不存在"。
 *
 * 「恢复」= worktree:restore-for-session:目录缺失时 git worktree add 重建 +
 * 回收快照(refs/xdt/snapshots/<sessionId> 或 stash 兜底)apply + store 重新登记;
 * 目录已在时只做快照 apply。成功后该会话可直接继续发消息,并刷新侧栏徽标。
 * apply 失败(冲突/文件锁)时 main 返回 ok+snapshotApplied=false 且保留快照——
 * 此时横幅**保持可见**切到 pending 态供用户重试,不能隐藏入口。
 *
 * 远程(device-link)会话:status IPC 查本机 DB 查不到行 → no-worktree → null,
 * 天然安全降级,无需显式分支。
 *
 * 红点(2026-07 统一):横幅要展示时给该会话打 'error' attention,处置(恢复成功 /
 * 用户点 X)后清 —— 与错误三条共享「不处置就不消失」的语义,展示不构成已读。
 * 与那三条的区别是**不进 main 侧的 pending-alerts 批量查询**:worktree 状态要
 * fs.access 探目录 + spawn git 查分支/快照 ref,对未打开会话批量算比纯读 sessions 表
 * 贵一个数量级(见 main/worktree/restore.ts)。故未打开的会话不主动亮点,红点只在
 * 会话被打开、自查出结果后建立。
 *
 * 点 X = 用户已处置这条提示:记到本机(lib/worktreeRestoreBannerDismissal),重开
 * 任务、重启应用后同一条提示都不再弹出,也不再打红点。不恢复并不丢东西 —— 继续
 * 发消息时发送链会自动重建 worktree。记录在自查到「目录已在且无待应用快照」时清掉,
 * 所以恢复之后再次被回收、或提示内容变了(目录不存在 → 有未应用快照)仍会照常提示。
 *
 * 颜色走主题 token(规则 16):error 语义豁免色组(工作区缺失属破坏性状态提示)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderX, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useRefreshWorktreeForSession } from '@/contexts/WorktreeContext';
import { addSessionAttention } from '@/lib/sessionAttentionStore';
import { ackErrorAlertHandled } from '@/lib/errorAlertAck';
import { refreshPendingAlerts } from '@/hooks/usePendingAlertAttention';
import {
  clearWorktreeRestoreBannerDismissal,
  dismissWorktreeRestoreBanner,
  isWorktreeRestoreBannerDismissed,
  worktreeRestoreBannerSignature,
} from '@/lib/worktreeRestoreBannerDismissal';

type BannerPhase = 'hidden' | 'restorable' | 'restoring';
/** missing = 目录不存在需重建;pending = 目录在但有未应用快照。决定文案与按钮词。 */
type BannerVariant = 'missing' | 'pending';
type RestoreFailureReason = 'gone' | 'no-worktree' | 'git-error' | 'unknown';

/** 托管 worktree 的名字就是目录名(`<baseRepo>/.cindy-worktrees/<name>`),兼容两种分隔符。 */
function worktreeNameFromPath(worktreePath: string): string {
  return worktreePath.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function restoreFailureKey(reason: RestoreFailureReason | undefined): string {
  switch (reason) {
    case 'gone':
      return 'chat.worktreeRestoreBanner.failures.gone';
    case 'no-worktree':
      return 'chat.worktreeRestoreBanner.failures.noWorktree';
    case 'git-error':
      return 'chat.worktreeRestoreBanner.failures.gitError';
    default:
      return 'chat.worktreeRestoreBanner.failures.unknown';
  }
}

export function WorktreeRestoreBanner({
  sessionId,
  className,
  style,
}: {
  sessionId: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const refreshWorktreeForSession = useRefreshWorktreeForSession();
  const [phase, setPhase] = useState<BannerPhase>('hidden');
  const [variant, setVariant] = useState<BannerVariant>('missing');
  /** 自查到的 worktree 目录:文案里的名字与关闭记录的身份都从它来。 */
  const [worktreePath, setWorktreePath] = useState('');
  /** 本组件给哪个会话打过红点 —— 清点只清自己打的,不误伤 live error 等其它来源。 */
  const markedSessionRef = useRef<string | null>(null);

  /**
   * 处置完成:清掉本组件打的红点(没打过则 no-op),然后立刻重算 pending-alerts。
   *
   * attentionMap 每会话只有**一条** entry,worktree 告警与错误尾行告警共享它 ——
   * 单靠 ackErrorAlertHandled 会把同会话仍未处理的错误横幅红点一起清掉。重算让
   * 派生腿把那些仍在库里的告警点立刻重建回来(usePendingAlertAttention 每轮无条件
   * 重打点,不会因为「上轮已 owned」而跳过)。
   */
  const clearOwnAttentionFor = useCallback((target: string) => {
    // 只在 ref 仍指向 target 时清:本组件在会话间复用,「恢复 A 时切到 B」会让 B 的
    // 状态查询先占据 ref,A 的迟到完成若照清 ref 里的值就会误清 B 的红点
    // (PR #879 review P1)。ref 已被别人占据 = 本次完成已过期,直接忽略。
    if (markedSessionRef.current !== target) return;
    markedSessionRef.current = null;
    ackErrorAlertHandled(target);
    void refreshPendingAlerts();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase('hidden');
    if (!sessionId) return;
    void (async () => {
      try {
        const status = (await window.electronAPI.worktreeRestoreStatus(sessionId)) as {
          state?: string;
          hasSnapshot?: boolean;
          worktreePath?: string;
        };
        if (cancelled) return;
        let nextVariant: BannerVariant;
        if (status?.state === 'restorable') {
          nextVariant = 'missing';
        } else if (status?.state === 'present' && status.hasSnapshot) {
          nextVariant = 'pending';
        } else {
          // worktree 确认已在且没有待应用快照 = 上一条提示已成过去,清掉关闭记录,
          // 之后再次被回收时照常提示。其余状态(查不到、分支已没)不动记录:它们
          // 可能只是一次查询失败,清了会让已关闭的提示又弹出来。
          if (status?.state === 'present') clearWorktreeRestoreBannerDismissal(sessionId);
          return;
        }
        const nextPath = status.worktreePath ?? '';
        // 用户关过这条提示 → 不再弹出,也不打红点。
        if (
          isWorktreeRestoreBannerDismissed(
            sessionId,
            worktreeRestoreBannerSignature(nextVariant, nextPath),
          )
        ) {
          return;
        }
        setWorktreePath(nextPath);
        setVariant(nextVariant);
        setPhase('restorable');
        // 横幅要展示 = 有未处理告警 → 打红点(与错误三条同一个 'error' 语义色)。
        markedSessionRef.current = sessionId;
        addSessionAttention(sessionId, 'error');
      } catch {
        // 老被控端 / IPC 异常 → 不显示,保持旧行为
      }
    })();
    return () => {
      cancelled = true;
      // 本组件无 key,会话切换时是**复用**而非重建:必须在这里交还上一个会话的
      // 所有权,否则新会话的查询会覆盖 markedSessionRef,旧会话的红点再没人认领
      // 而永久残留。清掉而不是留着 —— worktree 告警本就不覆盖未打开的会话
      // (状态判定要扫盘 + git 子进程,不进 pending-alerts 批量查询),离开会话后
      // 不亮点与该声明一致;下次打开该会话时自查会重新命中并重新打点。
      const marked = markedSessionRef.current;
      if (marked) {
        markedSessionRef.current = null;
        ackErrorAlertHandled(marked);
        void refreshPendingAlerts();
      }
    };
  }, [sessionId]);

  const handleRestore = useCallback(async () => {
    // 捕获发起时的会话:恢复是异步的,期间用户可能切走,组件被复用到别的会话。
    const target = sessionId;
    setPhase('restoring');
    try {
      const result = await window.electronAPI.worktreeRestoreForSession(target);
      if (result.ok) {
        if (result.snapshotApplied === false) {
          // 目录已就位但快照 apply 失败(冲突/锁),main 侧保留了快照——
          // 横幅切到 pending 态留住重试入口,不能隐藏(review 反馈)。
          toast.warning(t('chat.worktreeRestoreBanner.restoredNoSnapshot'));
          setVariant('pending');
          setPhase('restorable');
        } else {
          toast.success(t('chat.worktreeRestoreBanner.restored'));
          setPhase('hidden');
          // 恢复成功 = 告警消失,清**发起时那个会话**的红点(过期完成会被忽略)。
          clearOwnAttentionFor(target);
          clearWorktreeRestoreBannerDismissal(target);
        }
        void refreshWorktreeForSession(target);
      } else {
        toast.error(
          t('chat.worktreeRestoreBanner.failed', {
            message: t(restoreFailureKey(result.reason as RestoreFailureReason | undefined)),
          }),
        );
        setPhase('restorable');
      }
    } catch {
      toast.error(
        t('chat.worktreeRestoreBanner.failed', {
          message: t('chat.worktreeRestoreBanner.failures.unknown'),
        }),
      );
      setPhase('restorable');
    }
  }, [clearOwnAttentionFor, refreshWorktreeForSession, sessionId, t]);

  if (phase === 'hidden') return null;
  const restoring = phase === 'restoring';
  const pending = variant === 'pending';
  const name = worktreeNameFromPath(worktreePath);

  return (
    <ErrorNotice
      className={cn('mx-auto', className)}
      style={style}
      data-testid="worktree-restore-banner"
      icon={<FolderX size={16} />}
      message={
        pending
          ? t('chat.worktreeRestoreBanner.textPendingSnapshot', { name })
          : t('chat.worktreeRestoreBanner.text', { name })
      }
      onDismiss={() => {
        setPhase('hidden');
        if (!sessionId) return;
        dismissWorktreeRestoreBanner(
          sessionId,
          worktreeRestoreBannerSignature(variant, worktreePath),
        );
        clearOwnAttentionFor(sessionId);
      }}
      dismissLabel={t('chat.worktreeRestoreBanner.dismissTitle')}
      actions={
        <Button
          size="sm"
          compact
          onClick={() => void handleRestore()}
          loading={restoring}
          title={t('chat.worktreeRestoreBanner.restoreTitle')}
        >
          <RefreshCw size={12} />
          {pending
            ? t('chat.worktreeRestoreBanner.applySnapshotAction')
            : t('chat.worktreeRestoreBanner.restoreAction')}
        </Button>
      }
    />
  );
}
