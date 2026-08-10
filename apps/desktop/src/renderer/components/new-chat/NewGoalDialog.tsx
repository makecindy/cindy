/**
 * NewGoalDialog —— 从 composer 「+」菜单新建目标的弹窗(create 模式)。
 *
 * 只输入目标内容;安全上限走 main 的 getDefaults() 默认(想改用 chip 的 ✏️ 编辑入口)。
 * 保存调 maker.setGoal({sessionId, objective})。视觉与 GoalIndicator 里的「编辑目标」
 * 弹窗一致(confirm-bg / 12px 圆角 / settings-input 输入面 / pill 按钮,全走主题 token)。
 *
 * 受控组件:open / onOpenChange 由父组件(ChatInput)持有,触发器在「+」菜单里。
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { goalApiFor } from '@/lib/makerTransport';
import { GoalAdvancedLimits, DEFAULT_GOAL_LIMITS, type GoalLimitValues } from './GoalAdvancedLimits';
import { ListComposerTextarea } from './ListComposerTextarea';

interface NewGoalDialogProps {
  /** 会话态:有 sessionId → 直接 setGoal。首页草稿态:不传 sessionId,改走 onCreate。 */
  sessionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 首页草稿态用:没有 sessionId 时由父组件负责"先建会话再 setGoal"。
   * 提供 objective + limits,父组件 createSession → maker.setGoal → navigate。
   */
  onCreate?: (objective: string, limits: GoalLimitValues) => Promise<void>;
  /** 打开时输入框的默认目标内容(点「新建目标」时输入框里已有的文字)。 */
  initialObjective?: string;
  /**
   * 目标创建成功后触发(setGoal / onCreate 任一路径成功)。会话内场景用它清空 composer
   * (目标的默认文字来自 composer,创建成功后原文该清掉)。
   */
  onCreated?: () => void;
}

export function NewGoalDialog({ sessionId, open, onOpenChange, onCreate, initialObjective, onCreated }: NewGoalDialogProps): React.ReactElement {
  const { t } = useTranslation();
  const [objective, setObjective] = useState('');
  const [limits, setLimits] = useState<GoalLimitValues>(DEFAULT_GOAL_LIMITS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      // 打开时用输入框里已有的文字作默认目标内容(没有则空)。
      setObjective(initialObjective ?? '');
    } else {
      setObjective('');
      setLimits(DEFAULT_GOAL_LIMITS);
      setError(null);
      setSaving(false);
    }
    // initialObjective 只在打开瞬间取一次(打开前父组件已设好),不随后续变化覆盖用户编辑,
    // 故依赖仅 [open]。
  }, [open]);

  const trimmed = objective.trim();

  const save = async () => {
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      if (sessionId) {
        await goalApiFor(sessionId).setGoal({ sessionId, objective: trimmed, limits });
      } else if (onCreate) {
        await onCreate(trimmed, limits);
      }
      onCreated?.(); // 创建成功 → 通知父组件清空 composer(默认目标文字的来源)
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('goal.newGoalDialog.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-[10001] flex w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border p-4 shadow-[var(--confirm-shadow)]"
          style={{ backgroundColor: 'var(--confirm-bg)', borderColor: 'var(--border-default)' }}
          onOpenAutoFocus={(event) => {
            // 打开时焦点直接落在目标输入框(否则 radix 默认聚焦取消按钮)。
            event.preventDefault();
            textareaRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            // 启动中不许 Esc 关掉(Codex review):AlertDialog 默认拦外部点击、但 Esc 照样生效,
            // 于是用户能在「创建远程会话 → 起目标」的异步过程中按 Esc 把弹窗关掉,以为取消了 ——
            // 实际那次创建仍会跑完并跳转。取消按钮在 saving 期间已 disabled,Esc 也该同口径。
            // (真正防止「关掉后改目标设备」的是调用方的在途锁;这里只是不让 UI 撒谎。)
            if (saving) event.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-15 font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('goal.newGoalDialog.title')}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-12 leading-5" style={{ color: 'var(--confirm-desc)' }}>
            {t('goal.newGoalDialog.description')}
          </AlertDialog.Description>
          <ListComposerTextarea
            ref={textareaRef}
            value={objective}
            placeholder={t('goal.newGoalDialog.placeholder')}
            onChange={(event) => setObjective(event.target.value)}
            onKeyDown={(event) => {
              // 跟聊天输入框一致:Enter 发送,Shift+Enter 换行;IME 组字中的 Enter 不触发。
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
                {t('goal.newGoalDialog.cancel')}
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              className="h-8 rounded-full px-4 text-12 font-medium transition-opacity hover:opacity-85 disabled:opacity-45"
              style={{ backgroundColor: 'var(--accent-cta-bg-pure)', color: 'var(--accent-pure-cta-fg)' }}
              disabled={saving || !trimmed}
              onClick={() => {
                void save();
              }}
            >
              {saving ? t('goal.newGoalDialog.starting') : t('goal.newGoalDialog.start')}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
