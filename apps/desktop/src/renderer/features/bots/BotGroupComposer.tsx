/**
 * 群聊输入框：纯文本，Enter 发送、Shift+Enter 换行，IME 组合中不发送
 * （DESIGN.md §14.3）。输入 `@` 弹出点名候选，第一项固定是「所有人」，上下键移动、
 * Enter / Tab 选中、Esc 收起。
 *
 * 发送时以正文重新解析点名（见 botGroupMentions.ts），clientId 作为幂等键：同一段
 * 文字发送失败后重发沿用同一个 clientId，main 会返回第一次写入的那条消息。一轮进行
 * 中输入框为空时，发送按钮变成停止；有文字时照常发送——插话本身就会作废当前一轮
 * （docs/product-rules/bot-group-chat.md §4.4）。
 *
 * 「+」菜单里的「安排分工」（§7.2）给输入框加上「分工」标签：带标签发出的消息一定交给
 * 负责人出安排（`division: true`），发出后标签清掉。安排进行中或等继续时不能再安排新的，
 * 菜单项置灰并说明原因。占位文字跟随未结束的安排，告诉用户这时说的话会交给谁。
 *
 * 附件（§3.1）与普通聊天同一套：托盘状态来自页面持有的 `useAttachments`（整页拖入也能
 * 加），缩略图与拒收提示复用 ComposerAttachments；「+」→「添加文件、图片或视频…」、粘贴
 * 文件或截图都进托盘。有附件时可以不写字。发送前烧录图片标注，发出去之后才从托盘移走
 * 这一批；没发出去就原样留着。
 */
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { Paperclip, Plus, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AttachmentRejectionStrip, ThumbnailStrip } from '@/components/new-chat/ComposerAttachments';
import { SendButton } from '@/components/new-chat/SendButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { currentSelectedOption } from '@/components/ui/dropdown-menu-highlight';
import {
  COMPOSER_MENU_ROW,
  MenuHighlightLayer,
  menuPanelAttrs,
  menuRowAttrs,
  useMenuPanel,
  withMenuLabels,
} from '@/components/ui/menu-row';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import type { UseAttachmentsReturn } from '@/hooks/useAttachments';
import { isAnnotationBurnInError, materializeAnnotatedAttachmentsForSend } from '@/lib/annotationBurnIn';
import type { AttachedFile } from '@/lib/fileTypes';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  BOT_GROUP_ATTACHMENTS_MAX,
  BOT_GROUP_MESSAGE_MAX_CHARS,
  type BotGroupMemberView,
} from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { botGroupAttachmentSignature, toBotGroupAttachmentInputs } from './botGroupAttachments';
import {
  filterBotGroupMentionCandidates,
  findBotGroupMentionQuery,
  insertBotGroupMention,
  resolveBotGroupMentions,
  retainBotGroupTrackedMentions,
  type BotGroupTrackedMention,
} from './botGroupMentions';
import {
  botGroupErrorKey,
  isActiveBotGroupMember,
  isBotGroupDivisionBlocked,
  type BotGroupComposerPlanState,
} from './botGroupPresentation';
import { botGroupApi } from './botGroupStore';

type MentionOption =
  | { kind: 'all'; label: string }
  | { kind: 'member'; label: string; member: BotGroupMemberView };

function isComposingKey(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** The composer's slice of `useAttachments`, owned by the page so a drop anywhere adds files. */
export type BotGroupComposerAttachments = Pick<
  UseAttachmentsReturn,
  | 'attachments'
  | 'addFiles'
  | 'addClipboardImage'
  | 'rejections'
  | 'dismissRejection'
  | 'removeFile'
  | 'updateFile'
  | 'restoreFiles'
  | 'clearFiles'
>;

/** Real path of a pasted or dropped file; empty for an in-memory bitmap. */
function filePathOf(file: File): string {
  try {
    return window.electronAPI.getFilePath(file);
  } catch {
    return '';
  }
}

export function BotGroupComposer({
  groupId,
  members,
  running,
  planState = null,
  attachments: attachmentState,
  attachmentScope,
  dragOver = false,
  onSent,
}: {
  groupId: string;
  members: readonly BotGroupMemberView[];
  running: boolean;
  /** The group's open plan, for placeholders and the 「安排分工」 gate. */
  planState?: BotGroupComposerPlanState | null;
  attachments: BotGroupComposerAttachments;
  /** Scope for writing annotated images before send (see botGroupAttachmentScope). */
  attachmentScope: string;
  /** Files are being dragged over the page: the card shows the same drop hint as a task's. */
  dragOver?: boolean;
  /** Called after main accepted the message, so the view can re-read at once. */
  onSent: () => void;
}) {
  const { t } = useTranslation();
  const listboxId = useId();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [tracked, setTracked] = useState<BotGroupTrackedMention[]>([]);
  const [stopping, setStopping] = useState(false);
  /** A send is in flight: its attachments stay in the tray but cannot change. */
  const [sending, setSending] = useState(false);
  /** 「分工」 tag from 「+」→「安排分工」: this message goes to the organizer for a plan. */
  const [division, setDivision] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // @ list: glide highlight on the aria-selected option; arrow keys stay in the textarea.
  const mentionListRef = useMenuPanel<HTMLDivElement>(undefined, {
    lockWidth: false,
    options: {
      current: currentSelectedOption,
      currentAttributes: ['aria-selected'],
      keyboardSource: document,
    },
  });
  const textRef = useRef(text);
  textRef.current = text;
  const selectionRef = useRef({ start: 0, end: 0 });
  const attachmentsRef = useRef(attachmentState.attachments);
  attachmentsRef.current = attachmentState.attachments;
  const focusInputOnMenuCloseRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
  /** Idempotency key for the text, targets and attachments currently being (re)sent. */
  const attemptRef = useRef<{
    text: string;
    clientId: string;
    division: boolean;
    attachments: string;
    mentionSignature: string;
  } | null>(null);

  const activeMembers = useMemo(() => members.filter(isActiveBotGroupMember), [members]);
  const allLabel = t('bots.groupChat.mention.all');
  const query = focused ? findBotGroupMentionQuery(text, caret) : null;
  const options = useMemo<MentionOption[]>(() => {
    if (!query || activeMembers.length === 0) return [];
    const everyone: MentionOption[] =
      filterBotGroupMentionCandidates(query.query, [{ name: allLabel }]).length > 0
        ? [{ kind: 'all', label: allLabel }]
        : [];
    const people = filterBotGroupMentionCandidates(query.query, activeMembers).map(
      (member): MentionOption => ({ kind: 'member', label: member.name, member }),
    );
    return [...everyone, ...people];
  }, [activeMembers, allLabel, query]);
  const popoverOpen = query !== null && options.length > 0 && dismissedStart !== query.start;
  const activeIndex = Math.min(highlight, Math.max(0, options.length - 1));

  const trimmed = text.trim();
  const tooLong = trimmed.length > BOT_GROUP_MESSAGE_MAX_CHARS;
  const hasMembers = activeMembers.length > 0;
  const attachmentCount = attachmentState.attachments.length;
  const tooManyAttachments = attachmentCount > BOT_GROUP_ATTACHMENTS_MAX;
  const canSend =
    (trimmed.length > 0 || attachmentCount > 0) && !tooLong && !tooManyAttachments && hasMembers;
  const showStop = running && trimmed.length === 0 && attachmentCount === 0;
  const divisionBlocked = isBotGroupDivisionBlocked(planState);

  // Auto-grow; the CSS max height caps it and turns on scrolling.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
    const nextCaret = pendingCaretRef.current;
    if (nextCaret !== null) {
      pendingCaretRef.current = null;
      element.setSelectionRange(nextCaret, nextCaret);
    }
  }, [text]);

  const syncCaret = () => {
    const element = textareaRef.current;
    if (element) {
      selectionRef.current = { start: element.selectionStart ?? element.value.length, end: element.selectionEnd ?? element.value.length };
      setCaret(selectionRef.current.start);
    }
  };

  const choose = (option: MentionOption | undefined) => {
    if (!option || !query) return;
    const next = insertBotGroupMention(text, { start: query.start, end: caret }, option.label);
    pendingCaretRef.current = next.caret;
    setText(next.text);
    selectionRef.current = { start: next.caret, end: next.caret };
    setCaret(next.caret);
    setHighlight(0);
    setTracked(current => {
      const remaining = retainBotGroupTrackedMentions(text, next.text, { members, allLabels: [allLabel], tracked: current, editStart: query.start, editEnd: caret });
      return option.kind === 'member' ? [...remaining, { botId: option.member.botId, label: option.label, start: query.start }] : remaining;
    });
    textareaRef.current?.focus();
  };

  const send = async () => {
    if (!canSend || sendingRef.current) return;
    const api = botGroupApi();
    if (!api) {
      toast.error(t('bots.groupChat.composer.sendFailed'));
      return;
    }
    const files: readonly AttachedFile[] = attachmentState.attachments;
    const signature = botGroupAttachmentSignature(files);
    // The tag changes what main does with the text, so it is part of the idempotency key;
    // so are the attachments that go with it.
    const mentions = resolveBotGroupMentions(text, {
      members,
      allLabels: [allLabel],
      tracked,
    });
    const mentionSignature = JSON.stringify([mentions.all, mentions.botIds]);
    const attempt =
      attemptRef.current?.text === trimmed &&
      attemptRef.current.division === division &&
      attemptRef.current.attachments === signature &&
      attemptRef.current.mentionSignature === mentionSignature
        ? attemptRef.current
        : { text: trimmed, clientId: crypto.randomUUID(), division, attachments: signature, mentionSignature };
    attemptRef.current = attempt;
    const draft = text;
    sendingRef.current = true;
    setSending(true);
    // Clear at once like any chat; a failed send puts the draft back if the
    // user has not started typing something else meanwhile. Attachments stay in
    // the tray until main has them.
    setText('');
    setCaret(0);
    setTracked([]);
    setDismissedStart(null);
    setDivision(false);
    const owner = getDataOwnerGeneration();
    const restore = () => {
      // The tag comes back only with its own draft, never onto newly typed text.
      if (!textRef.current) {
        if (attempt.division) setDivision(true);
        setTracked(tracked);
      }
      setText((current) => (current ? current : draft));
    };
    try {
      // Drawn annotations are burned in first, as in a task; a failure keeps everything for a retry.
      const prepared =
        files.length > 0
          ? ((await materializeAnnotatedAttachmentsForSend(files, attachmentScope, { burnFailure: 'abort' })) ?? [])
          : [];
      const result = await api.sendBotGroupMessage({
        groupId,
        text: attempt.text,
        mentions,
        clientId: attempt.clientId,
        ...(attempt.division ? { division: true } : {}),
        ...(prepared.length > 0 ? { attachments: toBotGroupAttachmentInputs(prepared) } : {}),
      });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) {
        restore();
        toast.error(
          t(
            result.errorCode === 'INVALID_PARAMS' && prepared.length > 0
              ? 'bots.groupChat.composer.attachmentsFailed'
              : botGroupErrorKey(result.errorCode, 'bots.groupChat.composer.sendFailed'),
          ),
        );
        return;
      }
      attemptRef.current = null;
      if (files.length > 0) {
        // Main now holds these files; take only this batch out of the tray (never delete
        // them) and keep anything added while the message was on its way.
        const sentIds = new Set(files.map((file) => file.id));
        const remaining = attachmentsRef.current.filter((file) => !sentIds.has(file.id));
        attachmentState.clearFiles();
        attachmentState.restoreFiles(remaining);
      }
      onSent();
    } catch (error) {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      restore();
      toast.error(
        t(isAnnotationBurnInError(error) ? 'chat.media.annotateBurnFailedNotSent' : 'bots.groupChat.composer.sendFailed'),
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  /** Files copied in a file manager attach by path; a screenshot or copied image attaches as an image. */
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items || items.length === 0) return;
    const filesWithPath: File[] = [];
    let handled = false;
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      // A group has no folder reference; a copied folder pastes as its text.
      if (item.webkitGetAsEntry?.()?.isDirectory) continue;
      if (filePathOf(file)) {
        filesWithPath.push(file);
        handled = true;
      } else if (item.type.startsWith('image/')) {
        void attachmentState.addClipboardImage(file);
        handled = true;
      }
    }
    if (filesWithPath.length > 0) void attachmentState.addFiles(filesWithPath);
    // The file is an attachment, not text; text in the same paste is dropped, as in a task.
    if (handled) event.preventDefault();
  };

  const stop = async () => {
    if (stoppingRef.current) return;
    const api = botGroupApi();
    if (!api) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      const result = await api.stopBotGroupRound(groupId);
      if (!result.ok) toast.error(t('bots.groupChat.composer.stopFailed'));
    } catch {
      toast.error(t('bots.groupChat.composer.stopFailed'));
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };

  const hint = !hasMembers
    ? t('bots.groupChat.composer.noMembers')
    : tooLong
      ? t('bots.groupChat.composer.tooLong', { max: BOT_GROUP_MESSAGE_MAX_CHARS })
      : tooManyAttachments
        ? t('bots.groupChat.composer.tooManyAttachments', { max: BOT_GROUP_ATTACHMENTS_MAX })
        : null;
  const actionLabel = showStop ? t('bots.groupChat.composer.stop') : t('bots.send');
  const moreLabel = t('bots.groupChat.composer.more');
  const removeDivisionLabel = t('bots.groupChat.composer.removeDivision');
  const placeholder = !hasMembers
    ? t('bots.groupChat.composer.noMembers')
    : division
      ? t('bots.groupChat.composer.placeholderDivision')
      : planState?.kind === 'proposed'
        ? t('bots.groupChat.composer.placeholderPlanProposed')
        : planState?.kind === 'running' && planState.botName
          ? t('bots.groupChat.composer.placeholderPlanRunning', { name: planState.botName })
          : planState?.kind === 'waiting' && planState.stepDone && planState.botName
            ? t('bots.groupChat.composer.placeholderPlanWaiting', { name: planState.botName })
            : t('bots.groupChat.composer.placeholder');

  const noop = () => undefined;

  return (
    <div className="shrink-0 px-5 pb-4 pt-2">
      <div className="relative mx-auto w-full max-w-[760px]">
        {/* Same floating slot above the card as a task's composer: files that did not attach. */}
        {attachmentState.rejections.length > 0 ? (
          <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-2 flex flex-col items-center gap-1 px-3">
            <AttachmentRejectionStrip
              rejections={attachmentState.rejections}
              onDismiss={attachmentState.dismissRejection}
            />
          </div>
        ) : null}
        {popoverOpen ? (
          <div
            ref={mentionListRef}
            id={listboxId}
            role="listbox"
            aria-label={t('bots.groupChat.mention.label')}
            {...menuPanelAttrs}
            // Shared menu panel (DESIGN §4): Board border and menu surface; no shadow, per the
            // zero-shadow Bot surfaces (botDesignContract.test.ts).
            className="absolute bottom-full left-0 z-20 mb-2 flex w-64 max-w-full flex-col gap-0.5 rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1.5"
          >
            <MenuHighlightLayer />
            {options.map((option, index) => (
              <div
                key={option.kind === 'all' ? 'all' : option.member.botId}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // Keep focus (and the caret) in the textarea while picking.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => choose(option)}
                {...menuRowAttrs()}
                className={cn(COMPOSER_MENU_ROW, 'flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5')}
              >
                {option.kind === 'all' ? (
                  <span
                    aria-hidden
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
                  >
                    <Users size={13} />
                  </span>
                ) : (
                  <BotAvatar bot={option.member} size="xs" className="h-6 w-6 text-12" />
                )}
                {withMenuLabels(<span className="min-w-0 flex-1 truncate">{option.label}</span>)}
                {option.kind === 'all' ? (
                  <span className="shrink-0 text-12 font-normal leading-[1.33] text-[var(--cmd-palette-item-meta)]">
                    {t('bots.groupChat.mention.allHint')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="relative flex flex-col gap-2 rounded-xl border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] px-3.5 pb-2.5 pt-3 transition-colors focus-within:border-[var(--chat-input-border-focus)]">
          {dragOver ? (
            <div
              data-testid="bot-group-drop-hint"
              className="pointer-events-none absolute inset-0 z-10 rounded-[12px]"
              style={{
                backgroundColor: 'var(--drop-overlay-bg)',
                border: '2px dashed var(--drop-overlay-border)',
              }}
            />
          ) : null}
          {division ? (
            <div className="flex">
              <span
                data-testid="bot-group-division-tag"
                className="inline-flex h-6 select-none items-center gap-1 rounded-full bg-[var(--surface-chip)] pl-2 pr-0.5 text-12 font-medium text-[var(--text-primary)]"
              >
                <Users size={12} aria-hidden className="text-[var(--text-secondary)]" />
                {t('bots.groupChat.composer.divisionTag')}
                <Tip text={removeDivisionLabel}>
                  <button
                    type="button"
                    aria-label={removeDivisionLabel}
                    onClick={() => {
                      setDivision(false);
                      textareaRef.current?.focus();
                    }}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--button-primary-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    <X size={12} />
                  </button>
                </Tip>
              </span>
            </div>
          ) : null}
          {attachmentCount > 0 ? (
            <ThumbnailStrip
              attachments={attachmentState.attachments}
              onRemove={sending ? noop : attachmentState.removeFile}
              onUpdate={sending ? noop : attachmentState.updateFile}
            />
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            aria-label={t('bots.groupChat.composer.label')}
            aria-autocomplete="list"
            aria-controls={popoverOpen ? listboxId : undefined}
            aria-activedescendant={popoverOpen ? `${listboxId}-${activeIndex}` : undefined}
            placeholder={placeholder}
            onChange={(event) => {
              const value = event.target.value;
              const nextCaret = event.target.selectionStart ?? value.length;
              const editStart = Math.min(selectionRef.current.start, nextCaret);
              const editEnd = selectionRef.current.end;
              setText(value);
              setTracked(current => retainBotGroupTrackedMentions(text, value, { members, allLabels: [allLabel], tracked: current, editStart, editEnd }));
              selectionRef.current = { start: nextCaret, end: nextCaret };
              setCaret(nextCaret);
              setHighlight(0);
              // A dismissed picker stays closed only for the `@` it was closed on.
              if (findBotGroupMentionQuery(value, nextCaret)?.start !== dismissedStart) {
                setDismissedStart(null);
              }
            }}
            onSelect={syncCaret}
            onPaste={handlePaste}
            onFocus={() => {
              setFocused(true);
              syncCaret();
            }}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (isComposingKey(event)) return;
              if (popoverOpen && query) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  setHighlight((activeIndex + step + options.length) % options.length);
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  choose(options[activeIndex]);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setDismissedStart(query.start);
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
                return;
              }
              // Backspace at the very start of an empty input takes the 「分工」 tag off.
              if (event.key === 'Backspace' && division && !text) {
                event.preventDefault();
                setDivision(false);
              }
            }}
            className="max-h-60 min-h-6 w-full resize-none overflow-y-auto bg-transparent text-15 leading-[1.6] text-[var(--chat-input-text)] outline-none placeholder:text-[var(--chat-input-placeholder)] focus-visible:outline-none"
          />
          <div className="flex min-h-7 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  if (files.length > 0) void attachmentState.addFiles(files);
                }}
              />
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Tip text={moreLabel}>
                    <button
                      type="button"
                      aria-label={moreLabel}
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        menuOpen && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
                      )}
                    >
                      <Plus size={16} />
                    </button>
                  </Tip>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-72"
                  onCloseAutoFocus={(event) => {
                    if (!focusInputOnMenuCloseRef.current) return;
                    focusInputOnMenuCloseRef.current = false;
                    event.preventDefault();
                    textareaRef.current?.focus();
                  }}
                >
                  <DropdownMenuItem
                    className={cn(MENU_ITEM_CLASS, 'gap-2.5')}
                    onSelect={() => {
                      focusInputOnMenuCloseRef.current = true;
                      fileInputRef.current?.click();
                    }}
                  >
                    <Paperclip size={16} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
                    <span className="min-w-0 truncate">
                      {t('extraDirs.addFiles')}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={divisionBlocked}
                    className={cn(MENU_ITEM_CLASS, 'h-auto items-start gap-2.5 py-2')}
                    onSelect={() => {
                      focusInputOnMenuCloseRef.current = true;
                      setDivision(true);
                    }}
                  >
                    <Users size={16} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span>
                        {t('bots.groupChat.composer.division')}
                      </span>
                      <span className="text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">
                        {t(
                          divisionBlocked
                            ? 'bots.groupChat.composer.divisionBusy'
                            : 'bots.groupChat.composer.divisionDescription',
                        )}
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]" aria-live="polite">
                {hint}
              </span>
            </div>
            <Tip text={actionLabel}>
              <SendButton
                disabled={showStop ? stopping : !canSend}
                isStreaming={showStop}
                ariaLabel={actionLabel}
                onClick={() => void (showStop ? stop() : send())}
              />
            </Tip>
          </div>
        </div>
      </div>
    </div>
  );
}
