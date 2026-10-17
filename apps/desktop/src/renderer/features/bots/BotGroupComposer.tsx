/**
 * 群聊输入框：纯文本，Enter 发送、Shift+Enter 换行，IME 组合中不发送
 * （DESIGN.md §14.3）。输入 `@` 弹出点名候选（useBotGroupMentionPicker，主群与话题回复同一套）。
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
 * 「引用回复」（§10）：页面持有当前群的待发引用，输入框上方显示紧凑的引用块，× 或 Esc
 * 只取消引用、不动正文。引用随发送一起交给 main（只带消息 id，摘要由 main 从服务器读），
 * 也是幂等键的一部分；发送失败时与正文一同放回，原消息已不可用时只放回正文。
 *
 * 附件（§3.1）与普通聊天同一套：托盘状态来自页面持有的 `useAttachments`（整页拖入也能
 * 加），缩略图与拒收提示复用 ComposerAttachments；「+」→「添加文件、图片或视频…」、粘贴
 * 文件或截图都进托盘。有附件时可以不写字。发送即交给群聊发件箱，托盘马上空出；发件箱
 * 负责标注烧录、顺序提交、失败后的原样恢复和重试。
 *
 * 草稿随群持久（与普通任务一样存进 composerDraftStore，附件已经在同一个键下）：切走再回来、
 * 分享选择时输入框暂时卸载，文字都还在；群被删除时随草稿一起丢弃。
 *
 * 主群的乐观发送由 botGroupOutbox 统一管理；话题仍用 `onSendStart` / `onSendSettled`
 * 把本地副本与回执交给话题时间线。
 *
 * 话题模式（`mode="thread"`）：同一个输入框用于话题回复——没有「+」菜单（不能安排分工；
 * Chat Server 的话题回复不带附件）、没有引用回复，发送键是「发送回复」，失败原因写在输入框
 * 上方；同一段文字、按当次成员解析出的点名目标也不变时，重发沿用同一个 clientId 和点名。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import type { UseAttachmentsReturn } from '@/hooks/useAttachments';
import {
  captureDraftDiscardToken,
  getDraft,
  isDraftDiscardTokenCurrent,
  saveDraft,
} from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  BOT_GROUP_COMPOSER_CARD,
  BOT_GROUP_COMPOSER_COLUMN,
  BOT_GROUP_COMPOSER_DOCK,
  BOT_GROUP_COMPOSER_FOOTER,
  BOT_GROUP_COMPOSER_FOOTER_START,
  BOT_GROUP_COMPOSER_INPUT,
  fitBotGroupComposerInput,
  keepBotGroupComposerInputFocus,
  useRefitBotGroupComposerInputOnResize,
} from './botGroupComposerChrome';
import {
  BOT_GROUP_ATTACHMENTS_MAX,
  BOT_GROUP_MESSAGE_MAX_CHARS,
  type BotGroupAttachment,
  type BotGroupMemberView,
  type BotGroupMention,
  type BotGroupQuoteDisplay,
  type BotGroupQuoteView,
  type ChatServerResult,
} from '../../../shared/botGroupChat';
import { BotGroupQuotePreview } from './BotGroupQuote';
import {
  botGroupAttachmentSignature,
  botGroupDraftDoc,
  botGroupDraftText,
} from './botGroupAttachments';
import { chatErrorKey } from './chatError';
import {
  botGroupErrorKey,
  isActiveBotGroupMember,
  isBotGroupDivisionBlocked,
  type BotGroupComposerPlanState,
} from './botGroupPresentation';
import { botGroupApi } from './botGroupStore';
import { botGroupSendSignature, enqueueBotGroupSend, registerBotGroupComposer } from './botGroupOutbox';
import { useBotGroupMentionPicker } from './useBotGroupMentionPicker';

/** 话题 replies also accept the Chat Server's own 「everyone」 spellings. */
const THREAD_ALL_ALIASES = ['所有人', 'all', 'everyone'] as const;

const sameBotGroupMentions = (a: BotGroupMention, b: BotGroupMention) =>
  a.all === b.all && a.botIds.length === b.botIds.length && a.botIds.every((botId, index) => botId === b.botIds[index]);

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

/** The local copy of a message being sent, for the timeline to show at once. */
export interface BotGroupOutgoingMessage {
  clientId: string;
  text: string;
  mentions: BotGroupMention;
  attachments: BotGroupAttachment[];
  quote: BotGroupQuoteView | null;
}

export type BotGroupSendOutcome = { ok: true; messageId: string } | { ok: false };

/** Drafts are written this long after the last keystroke (and on unmount). */
const DRAFT_SAVE_DELAY_MS = 300;

const NO_ATTACHMENTS: BotGroupComposerAttachments = {
  attachments: [],
  addFiles: async () => undefined,
  addClipboardImage: async () => undefined,
  rejections: [],
  dismissRejection: () => undefined,
  removeFile: () => undefined,
  updateFile: () => undefined,
  restoreFiles: () => undefined,
  clearFiles: () => undefined,
} as unknown as BotGroupComposerAttachments;

export function BotGroupComposer({
  groupId,
  mode = 'group',
  draftKey,
  members,
  running,
  disabled = false,
  planState = null,
  attachments: attachmentState = NO_ATTACHMENTS,
  attachmentScope = '',
  dragOver = false,
  quote = null,
  onQuoteChange,
  sendReply,
  onSendStart,
  onSendSettled,
  onSent,
  onSending,
  footerStart,
}: {
  groupId: string;
  /** `thread`: a 话题's reply box (no 「+」 menu, attachments or quotes). */
  mode?: 'group' | 'thread';
  /** Where the unsent text is kept (the group's attachment scope, or the 话题's own key). */
  draftKey: string;
  members: readonly BotGroupMemberView[];
  running: boolean;
  /** Archived group: nothing can be sent. */
  disabled?: boolean;
  /** The group's open plan, for placeholders and the 「安排分工」 gate. */
  planState?: BotGroupComposerPlanState | null;
  attachments?: BotGroupComposerAttachments;
  /** Scope for writing annotated images before send (see botGroupAttachmentScope). */
  attachmentScope?: string;
  /** Files are being dragged over the page: the card shows the same drop hint as a task's. */
  dragOver?: boolean;
  /** 引用回复 waiting to go with the next message, and how its original reads right now. */
  quote?: { view: BotGroupQuoteView; display: BotGroupQuoteDisplay } | null;
  onQuoteChange?: (quote: BotGroupQuoteView | null) => void;
  /** Thread mode: posts the reply. */
  sendReply?: (input: { text: string; clientId: string; mentions: BotGroupMention }) => Promise<ChatServerResult<{ messageId: string }>>;
  /** The message is on its way: show its local copy now. */
  onSendStart?: (message: BotGroupOutgoingMessage) => void;
  /** Main answered (or the send failed before reaching it). */
  onSendSettled?: (clientId: string, outcome: BotGroupSendOutcome) => void;
  /** Called after main accepted the message, so the view can re-read at once. */
  onSent?: () => void;
  /** Main-group send was queued; keep the timeline at the bottom. */
  onSending?: () => void;
  footerStart?: (sending: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  const thread = mode === 'thread';
  const [text, setText] = useState(() => botGroupDraftText(getDraft(draftKey)?.text));
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  /** Thread send in flight; group sends are owned by the outbox. */
  const [sending, setSending] = useState(false);
  /** 「分工」 tag from 「+」→「安排分工」: this message goes to the organizer for a plan. */
  const [division, setDivision] = useState(false);
  const divisionRef = useRef(division);
  divisionRef.current = division;
  const groupAttemptRef = useRef<{ clientId: string; signature: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const allLabel = t('bots.groupChat.mention.all');
  const threadAllLabels = useMemo(() => [allLabel, ...THREAD_ALL_ALIASES], [allLabel]);
  // Same @ picker in the group and in a 话题; the 话题 also resolves the server's aliases.
  const mention = useBotGroupMentionPicker({
    text,
    onTextChange: (value) => {
      // A 话题 reply is a new attempt as soon as its text changes (even if typed back the same).
      if (thread && attemptRef.current && attemptRef.current.text !== value.trim()) attemptRef.current = null;
      setText(value);
    },
    members,
    textareaRef,
    allLabels: thread ? threadAllLabels : undefined,
  });
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachmentState.attachments);
  attachmentsRef.current = attachmentState.attachments;
  const quoteRef = useRef(quote?.view ?? null);
  quoteRef.current = quote?.view ?? null;
  const quotedMessageId = quote?.view.messageId ?? null;
  const focusInputOnMenuCloseRef = useRef(false);
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
  /** Thread retry identity: text and targets resolved against the original roster. */
  const attemptRef = useRef<{
    text: string;
    clientId: string;
    /** 话题 replies keep the targets resolved on the first attempt, with the roster of that moment. */
    mentions?: BotGroupMention;
    roster?: readonly BotGroupMemberView[];
  } | null>(null);

  const activeMembers = useMemo(() => members.filter(isActiveBotGroupMember), [members]);

  const trimmed = text.trim();
  const tooLong = trimmed.length > BOT_GROUP_MESSAGE_MAX_CHARS;
  // A 话题 reply goes to the people in it; it does not need an active teammate.
  const hasMembers = thread || activeMembers.length > 0;
  const attachmentCount = attachmentState.attachments.length;
  const tooManyAttachments = attachmentCount > BOT_GROUP_ATTACHMENTS_MAX;
  const canSend =
    !disabled && (trimmed.length > 0 || attachmentCount > 0) && !tooLong && !tooManyAttachments && hasMembers;
  const showStop = !thread && running && trimmed.length === 0 && attachmentCount === 0;
  const divisionBlocked = isBotGroupDivisionBlocked(planState);

  // Picking 引用回复 brings the caret here, ready to type the reply.
  useEffect(() => {
    if (quotedMessageId) textareaRef.current?.focus();
  }, [quotedMessageId]);

  // Keep the unsent text with the group (or 话题), like a task's composer draft.
  const discardTokenRef = useRef(captureDraftDiscardToken(draftKey));
  const persistDraft = useRef((value: string) => {
    if (!isDraftDiscardTokenCurrent(discardTokenRef.current)) return;
    const existing = getDraft(draftKey);
    if (!existing && !value) return;
    saveDraft(
      draftKey,
      { ...existing, attachments: existing?.attachments ?? [], text: value ? botGroupDraftDoc(value) : null },
      { silent: true },
    );
  }).current;
  useEffect(() => {
    const timer = window.setTimeout(() => persistDraft(text), DRAFT_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [persistDraft, text]);
  useEffect(() => () => persistDraft(textRef.current), [persistDraft]);

  // Auto-grow; the CSS max height caps it and turns on scrolling. A width change (window
  // resize, the 话题 panel opening) rewraps the text, so the height is fitted again then.
  useLayoutEffect(() => {
    if (textareaRef.current) fitBotGroupComposerInput(textareaRef.current);
  }, [text]);
  useRefitBotGroupComposerInputOnResize(textareaRef);

  /**
   * 话题 reply: a retry reuses the attempt only for the same text and the same targets
   * (bot-group-chat.md). Targets are re-resolved against the attempt's own roster: a roster
   * refresh alone changes nothing and the host still rejects a departed target; re-picking
   * someone else gets a new clientId.
   */
  const sendThreadReply = async () => {
    if (!canSend || sendingRef.current || !sendReply) return;
    const previous = attemptRef.current;
    const attempt =
      previous?.mentions && previous.roster && previous.text === trimmed
      && sameBotGroupMentions(mention.resolve(text, previous.roster), previous.mentions)
        ? previous
        : {
            text: trimmed, clientId: crypto.randomUUID(),
            mentions: mention.resolve(text), roster: members,
          };
    attemptRef.current = attempt;
    const draft = text;
    const mentions = attempt.mentions!;
    const tracked = mention.tracked;
    sendingRef.current = true;
    setSending(true);
    setError('');
    setText('');
    mention.reset();
    onSendStart?.({ clientId: attempt.clientId, text: attempt.text, mentions, attachments: [], quote: null });
    const owner = getDataOwnerGeneration();
    const fail = (message: string) => {
      onSendSettled?.(attempt.clientId, { ok: false });
      if (!textRef.current) mention.setTracked(tracked);
      setText((current) => (current ? current : draft));
      setError(message);
    };
    try {
      const result = await sendReply({ text: attempt.text, clientId: attempt.clientId, mentions });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) { fail(t(chatErrorKey(result.errorCode))); return; }
      attemptRef.current = null;
      onSendSettled?.(attempt.clientId, { ok: true, messageId: result.messageId });
      onSent?.();
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) fail(t('bots.groupChat.server.requestFailed'));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // A message that did not go out comes back only into an empty input: never over new
  // text, a new tag or files added meanwhile. Pressing send again reuses its clientId.
  // Registered once per group (mount / group change): re-registering on every render would
  // pull a failed message back in the moment the user clears the input.
  const restoreAttachmentsRef = useRef(attachmentState.restoreFiles);
  restoreAttachmentsRef.current = attachmentState.restoreFiles;
  const tRef = useRef(t);
  tRef.current = t;
  const onQuoteChangeRef = useRef(onQuoteChange);
  onQuoteChangeRef.current = onQuoteChange;
  useEffect(
    () => thread ? undefined :
      registerBotGroupComposer(groupId, {
        restore: (entry) => {
          if (textRef.current || attachmentsRef.current.length > 0 || divisionRef.current) return false;
          groupAttemptRef.current = { clientId: entry.input.clientId, signature: entry.signature };
          textRef.current = entry.draft;
          setText(entry.draft);
          mention.setTracked([...entry.tracked]);
          const restoredDivision = entry.input.division === true;
          divisionRef.current = restoredDivision;
          if (restoredDivision) setDivision(true);
          // A quote picked meanwhile wins.
          if (entry.quote && !quoteRef.current) {
            quoteRef.current = entry.quote;
            onQuoteChangeRef.current?.(entry.quote);
          }
          if (entry.files.length > 0) attachmentsRef.current = restoreAttachmentsRef.current(entry.files);
          return true;
        },
        notifyFailed: (errorKey) => toast.error(tRef.current(errorKey)),
      }),
    [groupId, thread],
  );

  const send = () => {
    if (thread) { void sendThreadReply(); return; }
    // A second Enter before the cleared input has rendered must not send the same draft twice.
    if (!canSend || textRef.current !== text || attachmentsRef.current !== attachmentState.attachments) return;
    if (!botGroupApi()) {
      toast.error(t('bots.groupChat.composer.sendFailed'));
      return;
    }
    const files: readonly AttachedFile[] = attachmentState.attachments;
    const mentions = mention.resolve(text);
    const tracked = mention.tracked;
    // Every field main gets is part of the attempt's identity (the tag changes what main does
    // with the text, the quote is part of the message), and so are the attachments that go with it.
    const sentQuote = quoteRef.current;
    const fields = {
      groupId,
      text: trimmed,
      mentions,
      ...(division ? { division: true } : {}),
      ...(sentQuote ? { quote: { messageId: sentQuote.messageId } } : {}),
    };
    const signature = botGroupSendSignature({ ...fields, clientId: '' }, botGroupAttachmentSignature(files));
    const clientId = groupAttemptRef.current?.signature === signature ? groupAttemptRef.current.clientId : crypto.randomUUID();
    // The outbox owns this attempt now; a failure hands it back through `restore`.
    groupAttemptRef.current = null;
    enqueueBotGroupSend({
      input: { ...fields, clientId },
      signature,
      draft: text,
      tracked,
      quote: sentQuote,
      files,
      attachmentScope,
    });
    // Clear at once like any chat, so the next message can be written while this one
    // goes out. The batch leaves the tray without deleting its files: the message has them.
    textRef.current = '';
    setText('');
    mention.reset();
    setDivision(false);
    divisionRef.current = false;
    if (sentQuote) {
      quoteRef.current = null;
      onQuoteChange?.(null);
    }
    if (files.length > 0) {
      attachmentState.clearFiles();
      attachmentsRef.current = [];
    }
    onSending?.();
  };

  /** Files copied in a file manager attach by path; a screenshot or copied image attaches as an image. */
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // A 话题 reply carries text only; pasted files stay out of it.
    if (thread) return;
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
  const actionLabel = showStop
    ? t('bots.groupChat.composer.stop')
    : thread ? t('bots.groupChat.server.sendReply') : t('bots.send');
  const moreLabel = t('bots.groupChat.composer.more');
  const removeDivisionLabel = t('bots.groupChat.composer.removeDivision');
  const placeholder = thread
    ? t('bots.groupChat.server.replyPlaceholder')
    : !hasMembers
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
    <div className={cn(BOT_GROUP_COMPOSER_DOCK, thread && 'px-4')}>
      <div className={BOT_GROUP_COMPOSER_COLUMN}>
        {error ? <p role="alert" className="mb-2 text-13 text-[var(--error-fg)]">{error}</p> : null}
        {/* Same floating slot above the card as a task's composer: files that did not attach. */}
        {attachmentState.rejections.length > 0 ? (
          <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-2 flex flex-col items-center gap-1 px-3">
            <AttachmentRejectionStrip
              rejections={attachmentState.rejections}
              onDismiss={attachmentState.dismissRejection}
            />
          </div>
        ) : null}
        {mention.list}
        <div className={BOT_GROUP_COMPOSER_CARD}>
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
          {quote && onQuoteChange ? (
            <BotGroupQuotePreview
              display={quote.display}
              onRemove={() => {
                onQuoteChange(null);
                textareaRef.current?.focus();
              }}
            />
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
            disabled={disabled}
            aria-label={thread ? t('bots.groupChat.server.replyPlaceholder') : t('bots.groupChat.composer.label')}
            // The Chat Server caps a 话题 reply; the field enforces it as typing does (a pick obeys it too).
            maxLength={thread ? BOT_GROUP_MESSAGE_MAX_CHARS : undefined}
            {...mention.textareaProps}
            placeholder={placeholder}
            onChange={(event) => mention.onChange(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (isComposingKey(event)) return;
              if (mention.onKeyDown(event)) return;
              // Esc takes the quote off before anything else it would close; the text stays.
              if (event.key === 'Escape' && quote && onQuoteChange) {
                event.preventDefault();
                onQuoteChange(null);
                return;
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
            className={BOT_GROUP_COMPOSER_INPUT}
          />
          <div className={BOT_GROUP_COMPOSER_FOOTER}>
            <div className={BOT_GROUP_COMPOSER_FOOTER_START}>
              {footerStart?.(sending)}
              {thread ? null : (<>
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
              </>)}
              <span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]" aria-live="polite">
                {hint}
              </span>
            </div>
            {/* A mouse click must not move the caret out of the input (the button disables itself right after). */}
            <span className="inline-flex rounded-full" onMouseDown={keepBotGroupComposerInputFocus(textareaRef)}>
              <Tip text={actionLabel}>
                <SendButton
                  disabled={showStop ? stopping : !canSend}
                  isStreaming={showStop}
                  ariaLabel={actionLabel}
                  onClick={() => void (showStop ? stop() : send())}
                />
              </Tip>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
