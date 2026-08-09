/**
 * UserMessageEditBox
 * ---------------------------------------------------------------------------
 * edit-last-message: 最后一条 user 消息的 inline 编辑态(Codex 同款交互)。
 *
 * UserMessage 点铅笔后原地把文本气泡替换成本组件:textarea 预填原文 +
 * 右下 [取消][发送]。运行中点铅笔时 UserMessage 已立即中断当前 turn(产品
 * 决策,对齐 Codex 调研:点编辑的意图就是"停下来我要改";取消编辑 AI 不会
 * 继续工作——interrupt 终止性、无恢复原语,Codex 同语义)。rewind + 重发只在
 * 点「发送」时执行,取消对**对话历史**零副作用(原样恢复),比 Codex 的
 * "确认瞬间就裁历史"更安全。
 *
 * 发送时序:若 renderer 仍观察到 sessionRunning(点铅笔的 stop 还在收尾),
 * 先经 onRequestStop 再补一次中断(幂等保险),挂起等 idle(spinner 常亮),
 * 翻 false 后由 effect 接力提交,15s 超时兜底报错退回编辑态。main 侧
 * isTurnRunning 与 renderer 状态的毫秒级尾差由
 * commitEditAndResendWithRunningRetry 的有限重试消化。
 *
 * 文件回滚提示:mount 时静默跑一次 rewindPreview(dryRun),上一轮有文件改动
 * 时在按钮左侧给一行小字("发送将撤销上一轮 N 个文件的改动"),不弹完整
 * Dialog —— 这是相对 Codex(完全不提示文件不会回滚)的体验差异化。preview
 * 失败(老消息无 checkpoint 等)只是不显示提示,不阻塞发送(commit 链路自带
 * forkSession 兜底,与 RewindPreviewDialog 的 Empty 态同语义)。
 *
 * 键盘:Enter 发送(与主 composer 一致)、Shift+Enter 换行、Esc 取消。
 * 附件:v1 不支持编辑态增删,原消息附件由编排层原样重建重发(chips 在
 * UserMessage 里保持只读展示)。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { ListComposerTextarea } from '@/components/new-chat/ListComposerTextarea';
import { toast } from '@/lib/toast';
import { ApiError } from '@/lib/httpClient';
import { rewindPreview } from '@/lib/sessionService';
import { commitEditAndResendWithRunningRetry } from '@/lib/editLastUserMessage';
import type { RewindDraftImage } from '@/lib/rewindDraftAttachments';
import type { FileRef, PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import type { AgentInputReference } from '../../../shared/agentInputQueue';

// 运行中发送的等待兜底:stop 发出后 renderer 迟迟观察不到 idle(远端断链、
// stop 丢失等)时,超过该时长报错退回编辑态,不让 spinner 永转。
const STOP_WAIT_TIMEOUT_MS = 15_000;

interface UserMessageEditBoxProps {
  sessionId: string;
  /** clientId of the message being edited (rewind target). */
  messageClientId: string;
  /** 原消息文本 — 预填进 textarea。 */
  initialText: string;
  /**
   * 可见文本未编辑时实际提交的原文。引用消息用它保留私有 marker / 交错顺序，
   * 同时 textarea 只展示剥过 marker 的 initialText。
   */
  initialSubmitText?: string;
  /** 原消息附件 — 只透传给编排层重建重发,本组件不渲染。 */
  images?: readonly RewindDraftImage[];
  files?: readonly FileRef[];
  /** Session workingDir(UserMessage prop)— session 行缺 workingDir 时兜底。 */
  workingDir: string;
  /** 原消息带「选中引用」编码标志(引用胶囊渲染门控)。可见文本未修改时
   *  原样携带；一旦编辑成 markerless 文本就移除，避免手写 blockquote 被误解析。 */
  quotesEncoded?: boolean;
  /** 原消息语义引用 range；可见文本未修改时原样携带。 */
  agentReferences?: readonly AgentInputReference[];
  /** 原消息长粘贴 range；可见文本未修改时原样携带。 */
  pastedTextRanges?: readonly PastedTextRange[];
  /** 原消息 slash range；undefined 表示旧消息缺少显式 marker，空数组也需保留。 */
  slashCommandRanges?: readonly SlashCommandRange[];
  /** 会话是否有 in-flight turn(renderer 视角)。发送时若为 true,先经
   *  onRequestStop 中断,再挂起等它翻 false 后提交。 */
  sessionRunning?: boolean;
  /** 发送时中断运行中 turn 的回调(UserMessage 注入,Stop 按钮同款语义,
   *  含"有队列则暂停队列"分支)。 */
  onRequestStop: () => void;
  /** 取消编辑(未发生任何副作用)。 */
  onCancel: () => void;
  /** rewind + 重发已成功发起,父组件退出编辑态。 */
  onSent: () => void;
  /**
   * 提交覆盖(被拦消息专用):被意识钩子拦下的消息从未落库、无 turn 可 rewind,
   * 常规 rewind 提交会抛 EDIT_NOT_LAST_MESSAGE。给它时 doCommit 改调本回调
   * (普通重发,失败抛错保留编辑态),不走 rewind 链路。
   */
  onCommitOverride?: (submission: {
    text: string;
    quotesEncoded?: boolean;
    agentReferences?: AgentInputReference[];
    pastedTextRanges?: PastedTextRange[];
    slashCommandRanges?: SlashCommandRange[];
  }) => Promise<void>;
}

export function UserMessageEditBox({
  sessionId,
  messageClientId,
  initialText,
  initialSubmitText,
  images,
  files,
  workingDir,
  quotesEncoded,
  agentReferences,
  pastedTextRanges,
  slashCommandRanges,
  sessionRunning,
  onRequestStop,
  onCancel,
  onSent,
  onCommitOverride,
}: UserMessageEditBoxProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);
  // state 版本驱动 UI(按钮 disable / spinner);ref 版本是同步防重入守卫——
  // rewindCommit 不幂等(第二次会打在已软删的消息上),不能赌 state 更新时序。
  const submittingRef = useRef(false);
  // 运行中发送的挂起标记:等 sessionRunning 翻 false 后由 effect 接力提交。
  const pendingSendRef = useRef(false);
  const waitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // null = preview 未返回/失败(不显示提示);number = 上一轮改动的文件数。
  const [rollbackFileCount, setRollbackFileCount] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 静默 preview 文件回滚影响。失败/软拒绝都归 null(不提示、不阻塞)。
  // 依赖里带 sessionRunning:用户可以在 turn 运行中先进编辑态(发送才被拦),
  // 此时 preview 会被 SESSION_RUNNING 拒绝——等暂停(sessionRunning 翻 false)
  // 后重跑一次,提示才不会在"运行中进编辑→暂停→发送"的路径上缺失。
  useEffect(() => {
    if (sessionRunning) return;
    let cancelled = false;
    rewindPreview(sessionId, messageClientId)
      .then((result) => {
        if (cancelled) return;
        const fileCount = result.filesChanged?.length ?? 0;
        if (result.canRewind && fileCount > 0) {
          setRollbackFileCount(fileCount);
        }
      })
      .catch(() => {
        // preview 只是提示性信息,静默失败。
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, messageClientId, sessionRunning]);

  // autofocus + 光标置尾(Codex 同款),只在 mount 时跑一次。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // autosize:高度跟随内容,上限交给 CSS max-h(超出转内部滚动)。
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const hasAttachments = (images?.length ?? 0) > 0 || (files?.length ?? 0) > 0;
  const canSend = (text.trim().length > 0 || hasAttachments) && !submitting;

  // 真正执行 rewind + 重发。前提:renderer 已观察到会话 idle(main 侧守卫的
  // 毫秒级尾差由 WithRunningRetry 内部有限重试消化)。
  const doCommit = useCallback(async () => {
    try {
      const visibleTextUnchanged = text === initialText;
      const submitText = visibleTextUnchanged ? (initialSubmitText ?? text) : text;
      const preserveQuoteMetadata = quotesEncoded && visibleTextUnchanged;
      const preservedAgentReferences =
        visibleTextUnchanged && agentReferences && agentReferences.length > 0
          ? [...agentReferences]
          : undefined;
      const preservedPastedTextRanges =
        visibleTextUnchanged && pastedTextRanges && pastedTextRanges.length > 0
          ? [...pastedTextRanges]
          : undefined;
      const preservedSlashCommandRanges =
        visibleTextUnchanged && slashCommandRanges !== undefined
          ? [...slashCommandRanges]
          : undefined;
      if (onCommitOverride) {
        // 被拦消息:普通重发(不 rewind)。失败抛错落入下方 catch 保留编辑态。
        await onCommitOverride({
          text: submitText,
          ...(preserveQuoteMetadata ? { quotesEncoded: true } : {}),
          ...(preservedAgentReferences ? { agentReferences: preservedAgentReferences } : {}),
          ...(preservedPastedTextRanges ? { pastedTextRanges: preservedPastedTextRanges } : {}),
          ...(preservedSlashCommandRanges !== undefined ? { slashCommandRanges: preservedSlashCommandRanges } : {}),
        });
      } else {
        await commitEditAndResendWithRunningRetry({
          sessionId,
          clientId: messageClientId,
          text: submitText,
          images,
          files,
          fallbackWorkingDir: workingDir,
          ...(preserveQuoteMetadata ? { quotesEncoded: true } : {}),
          ...(preservedAgentReferences ? { agentReferences: preservedAgentReferences } : {}),
          ...(preservedPastedTextRanges ? { pastedTextRanges: preservedPastedTextRanges } : {}),
          ...(preservedSlashCommandRanges !== undefined ? { slashCommandRanges: preservedSlashCommandRanges } : {}),
        });
      }
      // 先归零守卫再 onSent:onSent 让父组件立刻卸载本组件,晚于它的 setState
      // 在已卸载组件上是无效 no-op(bot review 指出的死代码顺序问题)。
      submittingRef.current = false;
      setSubmitting(false);
      onSent();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      const msg =
        code === 'SESSION_RUNNING'
          ? t('chat.userMessage.editStopTimeout')
          : code === 'EDIT_QUEUE_NOT_EMPTY'
            ? t('chat.userMessage.editQueueNotEmpty')
            : code === 'EDIT_NOT_LAST_MESSAGE' || code === 'REWIND_TARGET_NOT_LATEST'
              ? t('chat.userMessage.editNotLast')
              : code === 'NO_LIVE_QUERY'
              ? t('chat.rewind.errors.noLiveQuery')
              : code === 'NO_PRIOR_ASSISTANT'
                ? t('chat.rewind.errors.noPriorAssistantCommit')
                : t('chat.userMessage.editFailed');
      toast.error(msg);
      // 保持编辑态(文本不丢),用户可重试或取消。
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [sessionId, messageClientId, text, initialText, initialSubmitText, images, files, workingDir, quotesEncoded, agentReferences, pastedTextRanges, slashCommandRanges, onSent, onCommitOverride, t]);

  const handleSend = useCallback(() => {
    if (!canSend || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    if (sessionRunning) {
      // 点铅笔时 UserMessage 已发出中断;走到这里说明 stop 还在收尾(或极端
      // 情况下丢失),再补一次(幂等保险),挂起等 renderer 观察到 idle
      // (sessionRunning 翻 false → 下方 effect 接力提交)。15s 兜底:stop
      // 一直没生效(远端断链等)则报错退回编辑态,文本不丢。
      onRequestStop();
      pendingSendRef.current = true;
      waitTimeoutRef.current = setTimeout(() => {
        if (!pendingSendRef.current) return;
        pendingSendRef.current = false;
        submittingRef.current = false;
        setSubmitting(false);
        toast.error(t('chat.userMessage.editStopTimeout'));
      }, STOP_WAIT_TIMEOUT_MS);
      return;
    }
    void doCommit();
  }, [canSend, sessionRunning, onRequestStop, doCommit, t]);

  // 等待停止的接力:sessionRunning 翻 false 且有挂起发送 → 提交。
  useEffect(() => {
    if (sessionRunning || !pendingSendRef.current) return;
    pendingSendRef.current = false;
    if (waitTimeoutRef.current) {
      clearTimeout(waitTimeoutRef.current);
      waitTimeoutRef.current = null;
    }
    void doCommit();
  }, [sessionRunning, doCommit]);

  // 卸载时清理等待定时器(挂起的发送随组件一起消亡,不落孤儿 toast)。
  useEffect(
    () => () => {
      if (waitTimeoutRef.current) clearTimeout(waitTimeoutRef.current);
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!submitting) onCancel();
        return;
      }
      // Enter 发送 / Shift+Enter 换行 — 与主 composer 的提交习惯一致。
      // IME 组合中的 Enter(选字)不触发发送。
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [submitting, onCancel, handleSend],
  );

  return (
    <div
      className={cn(
        'w-full rounded-[12px]',
        'border border-[var(--msg-user-border)]',
        'bg-[var(--msg-user-bg)]',
        'px-4 pt-3 pb-2.5',
      )}
    >
      <ListComposerTextarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={submitting}
        spellCheck={false}
        rows={1}
        className={cn(
          'block w-full resize-none outline-none border-none bg-transparent p-0',
          'max-h-[40vh] overflow-y-auto',
          'text-15 font-normal leading-[1.6] text-[var(--msg-user-text)]',
          'disabled:opacity-60',
        )}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        {rollbackFileCount !== null && rollbackFileCount > 0 && (
          <span className="min-w-0 flex-1 truncate text-left text-11 text-[var(--text-tertiary)]">
            {t('chat.userMessage.editRollbackHint', { count: rollbackFileCount })}
          </span>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className={cn(
            'h-7 shrink-0 rounded-full px-3 text-12 font-medium',
            'border border-[var(--msg-user-border)] bg-transparent',
            'text-[var(--text-secondary)]',
            'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
            'disabled:opacity-40 disabled:pointer-events-none',
          )}
        >
          {t('chat.userMessage.editCancel')}
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3',
            'text-12 font-medium',
            'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
            'hover:opacity-90 transition-opacity',
            'disabled:opacity-40 disabled:pointer-events-none',
          )}
        >
          {submitting && <Spinner size={12} />}
          {t('chat.userMessage.editSend')}
        </button>
      </div>
    </div>
  );
}
