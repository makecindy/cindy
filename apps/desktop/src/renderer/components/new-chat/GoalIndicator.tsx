/**
 * GoalIndicator —— 会话内 /goal 进行中的状态 chip(composer 上方)。
 *
 * 数据来自 useGoalStatus(getGoalStatus + onGoalStatusChanged push)。无 goal 时
 * 返回 null(不渲染、不占位)。展示:状态 + 目标文本(截断)+ 轮数 + token 用量 +
 * Pause/Resume + 清除按钮。
 *
 * 颜色全走主题 token(规则 16):常规态用 surface-chip / text-secondary;blocked /
 * budgetLimited 用 error 系(规则 16 明确豁免的语义色,跨主题一致);Resume 用 accent。
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Pause, Play, SquarePen, Target, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useGoalStatus } from '@/hooks/useGoalStatus';
import { goalApiFor } from '@/lib/makerTransport';
import { isGoalCapacityBackoff } from '@/utils/overloadError';
import { GoalAdvancedLimits, type GoalLimitValues } from './GoalAdvancedLimits';
import { ListComposerTextarea } from './ListComposerTextarea';

interface GoalIndicatorProps {
  sessionId: string | null | undefined;
}

/** 非常规态(需用户注意)用 error 前景色。 */
function isAttentionStatus(status: GoalStatusPayload['status']): boolean {
  return status === 'blocked' || status === 'budgetLimited' || status === 'usageLimited';
}

/**
 * 运行时长(ms)→ 紧凑展示,**始终显示秒**(每秒 tick):
 *   <60s → `9s`;<60m → `5m 09s`;否则 → `2h 05m 09s`。
 * 秒(及小时档的分)零补两位,避免位数变化导致每秒宽度抖动。
 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${ss}s`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${s}s`;
}

/** 限额重置时刻 → 本地"时:分"(跨天则带日期);拿不到返回空。 */
function formatResetTime(resetAtMs: number | null): string {
  if (resetAtMs == null || !Number.isFinite(resetAtMs)) return '';
  const d = new Date(resetAtMs);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function GoalEditor({
  sessionId,
  goal,
}: {
  sessionId: string;
  goal: GoalStatusPayload;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [objective, setObjective] = useState(goal.objective);
  const [limits, setLimits] = useState<GoalLimitValues>({
    maxTurns: goal.maxTurns,
    budgetTokens: goal.budgetTokens,
    noProgressLimit: goal.noProgressLimit,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) {
      setObjective(goal.objective);
      setLimits({
        maxTurns: goal.maxTurns,
        budgetTokens: goal.budgetTokens,
        noProgressLimit: goal.noProgressLimit,
      });
      setError(null);
    }
  }, [goal.budgetTokens, goal.maxTurns, goal.noProgressLimit, goal.objective, open]);

  const trimmedObjective = objective.trim();
  const isValid = trimmedObjective.length > 0;
  // 与 chip 的 isAttentionStatus 一致:blocked / budgetLimited / usageLimited 都算"需关注"。
  const attention = isAttentionStatus(goal.status);

  const save = async () => {
    if (!isValid) {
      setError(t('goal.editGoal.invalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await goalApiFor(sessionId).updateGoal(sessionId, {
        objective: trimmedObjective,
        maxTurns: limits.maxTurns,
        budgetTokens: limits.budgetTokens,
        noProgressLimit: limits.noProgressLimit,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('goal.editGoal.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>
        <button
          type="button"
          aria-label={t('goal.editGoal.trigger')}
          title={t('goal.editGoal.trigger')}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-elevated)]"
          style={{ color: attention ? 'var(--error-fg)' : 'var(--text-tertiary)' }}
        >
          <SquarePen size={12} strokeWidth={2} />
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-[10001] flex w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border p-4 shadow-[var(--confirm-shadow)]"
          style={{ backgroundColor: 'var(--confirm-bg)', borderColor: 'var(--border-default)' }}
          onOpenAutoFocus={(event) => {
            // 打开时焦点直接落在目标输入框。
            event.preventDefault();
            textareaRef.current?.focus();
          }}
        >
          <AlertDialog.Title className="text-15 font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('goal.editGoal.title')}
          </AlertDialog.Title>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="goal-objective"
              className="text-12 font-medium"
              style={{ color: 'var(--text-primary)' }}
            >
              {t('goal.editGoal.objectiveLabel')}
            </label>
            <ListComposerTextarea
              id="goal-objective"
              ref={textareaRef}
              value={objective}
              placeholder={t('goal.editGoal.objectivePlaceholder')}
              onChange={(event) => setObjective(event.target.value)}
              onKeyDown={(event) => {
                // 跟聊天输入框一致:Enter 保存,Shift+Enter 换行;IME 组字中的 Enter 不触发。
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void save();
                }
              }}
              className="min-h-[112px] w-full resize-none rounded-lg border p-2.5 text-13 leading-5 outline-none placeholder:text-[var(--text-placeholder)]"
              style={{
                backgroundColor: 'var(--settings-input-bg)',
                borderColor: 'var(--settings-input-border)',
                color: 'var(--settings-input-text)',
              }}
            />
          </div>
          <GoalAdvancedLimits value={limits} onChange={setLimits} />
          {error && (
            <div className="text-12" style={{ color: 'var(--error-fg)' }}>
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="h-8 rounded-full border px-3 text-12 transition-colors hover:bg-[var(--surface-elevated)]"
                style={{
                  backgroundColor: 'var(--surface-elevated)',
                  borderColor: 'var(--border-default)',
                  color: 'var(--text-primary)',
                }}
                disabled={saving}
              >
                {t('goal.editGoal.cancel')}
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              className="h-8 rounded-full px-4 text-12 font-medium transition-opacity hover:opacity-85 disabled:opacity-45"
              style={{ backgroundColor: 'var(--accent-cta-bg-pure)', color: 'var(--accent-pure-cta-fg)' }}
              disabled={saving || !isValid}
              onClick={() => {
                void save();
              }}
            >
              {saving ? t('goal.editGoal.saving') : t('goal.editGoal.save')}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function GoalIndicator({ sessionId }: GoalIndicatorProps): React.ReactElement | null {
  const { t } = useTranslation();
  const goal = useGoalStatus(sessionId);
  // 实时运行时长:仅 active 时每秒 tick(非 active 冻结时长无意义,不显示也不计时)。
  const active = goal?.status === 'active';
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!goal || !sessionId) return null;

  const attention = isAttentionStatus(goal.status);
  // 过载与账号限流共用 usageLimited(都是可恢复 + 到点自动续跑), 但说法必须分开:
  // 账号从没被限流时说「用量受限 / X 点恢复」是假信息 —— 那个时刻只是"现在 + 60s 后
  // 重试", 不是任何额度重置点(review #844 codex P1)。
  const isCapacityBackoff = isGoalCapacityBackoff(goal.status, goal.lastReason);
  const statusLabel = isCapacityBackoff
    ? t('goal.status.capacityLimited')
    : t(`goal.status.${goal.status}`);
  // 只算一次: formatResetTime 内部会取 new Date()(判"是否今天"), 条件与插值各算一次不仅
  // 多余, 跨午夜那一刻两次结果还可能不一致(copilot 低置信提示; 双取是既有写法)。
  const resetTimeText = formatResetTime(goal.usageResetAt);
  const elapsedMs = active ? Math.max(0, nowMs - goal.startedAt) : 0;

  return (
    <div
      className="mx-auto mb-1.5 flex max-w-full select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-12"
      style={{
        backgroundColor: 'var(--surface-chip)',
        border: `1px solid ${attention ? 'var(--error-border)' : 'var(--border-default)'}`,
      }}
    >
      {/* 目标 icon(替代状态点):标识这是目标模式;attention 态用 error 色。 */}
      <Target
        size={13}
        strokeWidth={2}
        aria-hidden
        className="shrink-0"
        style={{ color: attention ? 'var(--error-fg)' : 'var(--text-secondary)' }}
      />
      {/* 状态标签 */}
      <span
        className="shrink-0 font-medium"
        style={{ color: attention ? 'var(--error-fg)' : 'var(--text-secondary)' }}
      >
        {statusLabel}
      </span>
      {/* usageLimited:显示恢复 / 重试时刻(知道才显示)。过载那条是重试时刻, 不是额度重置。 */}
      {goal.status === 'usageLimited' && resetTimeText && (
        <span className="shrink-0" style={{ color: 'var(--error-fg)' }}>
          {t(isCapacityBackoff ? 'goal.capacityRetryAt' : 'goal.usageLimitedUntil', {
            time: resetTimeText,
          })}
        </span>
      )}
      {/* 目标文本(截断) */}
      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }} title={goal.objective}>
        {goal.objective}
      </span>
      {/* 续跑轮数。设了 maxTurns 时直接显示 used/max,让默认上限可见。 */}
      <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
        {goal.maxTurns == null
          ? t('goal.turns', { used: goal.turnsUsed })
          : t('goal.turnsWithMax', { used: goal.turnsUsed, max: goal.maxTurns })}
      </span>
      {/* 实时运行时长(仅 active 时每秒刷新) */}
      {active && (
        <span
          className="shrink-0 tabular-nums"
          style={{ color: 'var(--text-tertiary)' }}
          title={t('goal.elapsedTooltip')}
        >
          {formatElapsed(elapsedMs)}
        </span>
      )}
      <GoalEditor sessionId={sessionId} goal={goal} />
      {/* 暂停(仅 active):保留计数停续跑,可 resume */}
      {goal.status === 'active' && (
        <button
          type="button"
          aria-label={t('goal.pause')}
          title={t('goal.pause')}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-elevated)]"
          style={{ color: 'var(--text-tertiary)' }}
          onClick={() => {
            void goalApiFor(sessionId).pauseGoal(sessionId);
          }}
        >
          <Pause size={12} strokeWidth={2} />
        </button>
      )}
      {/* 恢复(paused / blocked / usageLimited):保留计数继续推进 */}
      {(goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'usageLimited') && (
        <button
          type="button"
          aria-label={t('goal.resume')}
          title={t('goal.resume')}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:opacity-80"
          style={{ color: 'var(--accent-cta-bg)' }}
          onClick={() => {
            void goalApiFor(sessionId).resumeGoal(sessionId);
          }}
        >
          <Play size={12} strokeWidth={2.5} />
        </button>
      )}
      {/* 清除 */}
      <button
        type="button"
        aria-label={t('goal.clear')}
        title={t('goal.clear')}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-elevated)]"
        style={{ color: 'var(--text-tertiary)' }}
        onClick={() => {
          void goalApiFor(sessionId).clearGoal(sessionId);
        }}
      >
        <Trash2 size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
