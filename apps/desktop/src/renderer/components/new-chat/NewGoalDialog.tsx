import { Button } from '@/components/ui/button';
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
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { goalApiFor } from '@/lib/makerTransport';
import { extractIpcError } from '@/utils/ipcError';
import { isWritableDirectoryGrantErrorCode } from '../../../shared/writableDirectoryGrantError';
import { GoalAdvancedLimits, DEFAULT_GOAL_LIMITS, type GoalLimitValues } from './GoalAdvancedLimits';
import { ListComposerTextarea } from './ListComposerTextarea';
import { FieldVoiceInputNotice } from '@/voice-input/FieldVoiceInputNotice';
import { useFieldVoiceInput } from '@/voice-input/useFieldVoiceInput';
import { VoiceInputButton } from '@/voice-input/VoiceInputButton';

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
  creationProgress?: ReactNode;
  creationRecovery?: ReactNode;
  creationRecoveryBusy?: boolean;
}

interface GoalCreationError {
  message: string;
  pickerAuthorization: boolean;
}

export function NewGoalDialog({ sessionId, open, onOpenChange, onCreate, initialObjective, onCreated, creationProgress, creationRecovery, creationRecoveryBusy = false }: NewGoalDialogProps): React.ReactElement {
  const { t } = useTranslation();
  const [objective, setObjective] = useState('');
  const [limits, setLimits] = useState<GoalLimitValues>(DEFAULT_GOAL_LIMITS);
  const [saving, setSaving] = useState(false);
  const [stoppingVoice, setStoppingVoice] = useState(false);
  const [error, setError] = useState<GoalCreationError | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);

  const voice = useFieldVoiceInput({
    draftKey: `new-goal:${sessionId ?? 'draft'}:${open}`,
    inputRef: textareaRef,
    value: objective,
    onChange: (next) => setObjective(next),
    active: open,
    disabled: saving || creationRecoveryBusy,
  });

  useEffect(() => {
    if (open) {
      // 打开时用输入框里已有的文字作默认目标内容(没有则空)。
      setObjective(initialObjective ?? '');
    } else {
      setObjective('');
      setLimits(DEFAULT_GOAL_LIMITS);
      setError(null);
      setSaving(false);
      setStoppingVoice(false);
      submittingRef.current = false;
    }
    // initialObjective 只在打开瞬间取一次(打开前父组件已设好),不随后续变化覆盖用户编辑,
    // 故依赖仅 [open]。
  }, [open]);

  useEffect(() => {
    if (creationRecovery) {
      // The parent can publish recovery after this dialog's async catch ran.
      // Discard its handled picker error so returning to editing cannot reveal it.
      setError((current) => current?.pickerAuthorization ? null : current);
    }
  }, [creationRecovery, error?.pickerAuthorization]);

  const trimmed = voice.displayText.trim();
  const busy = saving || stoppingVoice;

  const save = async () => {
    if (!trimmed || busy || submittingRef.current || creationRecoveryBusy) return;
    submittingRef.current = true;
    let nextObjective = objective;
    if (voice.isBusy) {
      setStoppingVoice(true);
      try {
        nextObjective = await voice.stop();
      } finally {
        setStoppingVoice(false);
      }
    }
    const finalTrimmed = nextObjective.trim();
    if (!finalTrimmed) {
      submittingRef.current = false;
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (sessionId) {
        await goalApiFor(sessionId).setGoal({ sessionId, objective: finalTrimmed, limits });
      } else if (onCreate) {
        await onCreate(finalTrimmed, limits);
      }
      onCreated?.(); // 创建成功 → 通知父组件清空 composer(默认目标文字的来源)
      onOpenChange(false);
    } catch (err) {
      // The recovery notice explains the handled picker error. A later retry
      // can fail for another reason while that notice is still visible.
      setError({
        message: err instanceof Error ? err.message : t('goal.newGoalDialog.failed'),
        pickerAuthorization: isWritableDirectoryGrantErrorCode(extractIpcError(err)?.code),
      });
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <AlertDialog.Content
          className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 p-4"
          onOpenAutoFocus={(event) => {
            // 打开时焦点直接落在目标输入框(否则 radix 默认聚焦取消按钮)。
            event.preventDefault();
            textareaRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            // 启动中或听写中不许 Esc 关掉:听写时 Esc 由 useFieldVoiceInput 取消听写;
            // 启动中与取消按钮同口径禁用 Esc。
            if (busy || voice.isBusy) event.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-15 font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('goal.newGoalDialog.title')}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-12 leading-5" style={{ color: 'var(--confirm-desc)' }}>
            {t('goal.newGoalDialog.description')}
          </AlertDialog.Description>
          <div className="flex flex-col gap-1.5">
            <div
              className="flex flex-col rounded-xl border"
              style={{
                backgroundColor: 'var(--settings-input-bg)',
                borderColor: 'var(--settings-input-border)',
              }}
            >
              <ListComposerTextarea
                ref={textareaRef}
                value={voice.displayText}
                readOnly={voice.isBusy}
                placeholder={t('goal.newGoalDialog.placeholder')}
                onChange={(event) => setObjective(event.target.value)}
                onKeyDown={(event) => {
                  // 跟聊天输入框一致:Enter 发送,Shift+Enter 换行;IME 组字中的 Enter 不触发。
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void save();
                  }
                }}
                className="min-h-[96px] w-full resize-none bg-transparent px-2.5 pt-2.5 pb-1 text-13 leading-5 outline-none placeholder:text-[var(--text-placeholder)]"
                style={{ color: 'var(--settings-input-text)' }}
              />
              <div className="flex items-center justify-end px-2 pb-2 pt-1">
                <VoiceInputButton {...voice.buttonProps} testId="new-goal-voice" tipSide="top" />
              </div>
            </div>
            <FieldVoiceInputNotice error={voice.lastError} speakerFiltered={voice.speakerFiltered} />
          </div>
          <GoalAdvancedLimits value={limits} onChange={setLimits} />
          {creationProgress}
          {creationRecovery}
          {error && !(error.pickerAuthorization && creationRecovery) && (
            <div className="text-12" style={{ color: 'var(--error-fg)' }}>
              {error.pickerAuthorization ? t('goal.newGoalDialog.failed') : error.message}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" size="md" compact type="button"
                disabled={busy}
              >
                {t('goal.newGoalDialog.cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant="cta"
              size="md"
              compact
              loading={busy}
              type="button"
              disabled={busy || creationRecoveryBusy || !trimmed}
              onClick={() => {
                void save();
              }}
            >
              { t('goal.newGoalDialog.start')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
