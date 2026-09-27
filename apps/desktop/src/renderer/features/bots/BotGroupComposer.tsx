/**
 * 群聊输入框：纯文本，Enter 发送、Shift+Enter 换行，IME 组合中不发送
 * （DESIGN.md §14.3）。输入 `@` 弹出点名候选，第一项固定是「所有人」，上下键移动、
 * Enter / Tab 选中、Esc 收起。
 *
 * 发送时以正文重新解析点名（见 botGroupMentions.ts），clientId 作为幂等键：同一段
 * 文字发送失败后重发沿用同一个 clientId，main 会返回第一次写入的那条消息。一轮进行
 * 中输入框为空时，发送按钮变成停止；有文字时照常发送——插话本身就会作废当前一轮
 * （docs/product-rules/bot-group-chat.md §4.4）。
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SendButton } from '@/components/new-chat/SendButton';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { BOT_GROUP_MESSAGE_MAX_CHARS, type BotGroupMemberView } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import {
  filterBotGroupMentionCandidates,
  findBotGroupMentionQuery,
  insertBotGroupMention,
  resolveBotGroupMentions,
  type BotGroupTrackedMention,
} from './botGroupMentions';
import { botGroupErrorKey, isActiveBotGroupMember } from './botGroupPresentation';
import { botGroupApi } from './botGroupStore';

type MentionOption =
  | { kind: 'all'; label: string }
  | { kind: 'member'; label: string; member: BotGroupMemberView };

function isComposingKey(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

export function BotGroupComposer({
  groupId,
  members,
  running,
  onSent,
}: {
  groupId: string;
  members: readonly BotGroupMemberView[];
  running: boolean;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
  /** Idempotency key for the text currently being (re)sent. */
  const attemptRef = useRef<{ text: string; clientId: string } | null>(null);

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
  const canSend = trimmed.length > 0 && !tooLong && hasMembers;
  const showStop = running && trimmed.length === 0;

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
    if (element) setCaret(element.selectionStart ?? element.value.length);
  };

  const choose = (option: MentionOption | undefined) => {
    if (!option || !query) return;
    const next = insertBotGroupMention(text, { start: query.start, end: caret }, option.label);
    pendingCaretRef.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setHighlight(0);
    if (option.kind === 'member') {
      setTracked((current) => [
        ...current.filter((mention) => mention.botId !== option.member.botId),
        { botId: option.member.botId, label: option.label },
      ]);
    }
    textareaRef.current?.focus();
  };

  const send = async () => {
    if (!canSend || sendingRef.current) return;
    const api = botGroupApi();
    if (!api) {
      toast.error(t('bots.groupChat.composer.sendFailed'));
      return;
    }
    const attempt =
      attemptRef.current?.text === trimmed
        ? attemptRef.current
        : { text: trimmed, clientId: crypto.randomUUID() };
    attemptRef.current = attempt;
    const mentions = resolveBotGroupMentions(trimmed, {
      members: members.map((member) => ({ botId: member.botId, name: member.name })),
      allLabels: [allLabel],
      tracked,
    });
    const draft = text;
    sendingRef.current = true;
    // Clear at once like any chat; a failed send puts the draft back if the
    // user has not started typing something else meanwhile.
    setText('');
    setCaret(0);
    setTracked([]);
    setDismissedStart(null);
    const owner = getDataOwnerGeneration();
    const restore = () => {
      setText((current) => (current ? current : draft));
    };
    try {
      const result = await api.sendBotGroupMessage({
        groupId,
        text: attempt.text,
        mentions,
        clientId: attempt.clientId,
      });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) {
        restore();
        toast.error(t(botGroupErrorKey(result.errorCode, 'bots.groupChat.composer.sendFailed')));
        return;
      }
      attemptRef.current = null;
      onSent();
    } catch {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      restore();
      toast.error(t('bots.groupChat.composer.sendFailed'));
    } finally {
      sendingRef.current = false;
    }
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
      : null;
  const actionLabel = showStop ? t('bots.groupChat.composer.stop') : t('bots.send');

  return (
    <div className="shrink-0 px-5 pb-4 pt-2">
      <div className="relative mx-auto w-full max-w-[760px]">
        {popoverOpen ? (
          <div
            id={listboxId}
            role="listbox"
            aria-label={t('bots.groupChat.mention.label')}
            className="absolute bottom-full left-0 z-20 mb-2 flex w-64 max-w-full flex-col gap-0.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5"
          >
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
                className={cn(
                  'flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-13 text-[var(--text-primary)]',
                  index === activeIndex && 'bg-[var(--model-item-hover)]',
                )}
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
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.kind === 'all' ? (
                  <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                    {t('bots.groupChat.mention.allHint')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] px-3.5 pb-2.5 pt-3 transition-colors focus-within:border-[var(--chat-input-border-focus)]">
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            aria-label={t('bots.groupChat.composer.label')}
            aria-autocomplete="list"
            aria-controls={popoverOpen ? listboxId : undefined}
            aria-activedescendant={popoverOpen ? `${listboxId}-${activeIndex}` : undefined}
            placeholder={
              hasMembers ? t('bots.groupChat.composer.placeholder') : t('bots.groupChat.composer.noMembers')
            }
            onChange={(event) => {
              const value = event.target.value;
              const nextCaret = event.target.selectionStart ?? value.length;
              setText(value);
              setCaret(nextCaret);
              setHighlight(0);
              // A dismissed picker stays closed only for the `@` it was closed on.
              if (findBotGroupMentionQuery(value, nextCaret)?.start !== dismissedStart) {
                setDismissedStart(null);
              }
            }}
            onSelect={syncCaret}
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
              }
            }}
            className="max-h-60 min-h-6 w-full resize-none overflow-y-auto bg-transparent text-15 leading-[1.6] text-[var(--chat-input-text)] outline-none placeholder:text-[var(--chat-input-placeholder)] focus-visible:outline-none"
          />
          <div className="flex min-h-7 items-center justify-between gap-3">
            <span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]" aria-live="polite">
              {hint}
            </span>
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
