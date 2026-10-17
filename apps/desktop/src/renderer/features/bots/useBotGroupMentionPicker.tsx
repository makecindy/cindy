/**
 * 群聊 @ 点名候选：主群输入框与 Thread 回复框共用的一套状态与候选列表。
 *
 * 输入 `@` 弹出候选，第一项固定是「所有人」，上下键移动、Enter / Tab 选中、Esc 收起；
 * 收起只对当次的 `@` 生效。选中候选时记下 botId（绑定到正文里那一个点名，随编辑移动、
 * 删改即忘记），发送时与正文一起交给 resolveBotGroupMentions，同名伙伴靠它区分。
 * 解析规则本身在 botGroupMentions.ts（Desktop 与手机同一套）。
 *
 * 宿主只负责文字状态、发送与 IME 判断：输入框的新值交给 `onChange`，键盘事件先交给
 * `onKeyDown`，返回 true 表示候选已经处理了这个键（例如候选打开时的 Enter 是选中而不是发送）。
 */
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { currentSelectedOption } from '@/components/ui/dropdown-menu-highlight';
import {
  COMPOSER_MENU_ROW,
  MenuHighlightLayer,
  menuPanelAttrs,
  menuRowAttrs,
  useMenuPanel,
  withMenuLabels,
} from '@/components/ui/menu-row';
import { cn } from '@/lib/utils';
import type { BotGroupMemberView } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import {
  filterBotGroupMentionCandidates,
  findBotGroupMentionQuery,
  insertBotGroupMention,
  resolveBotGroupMentions,
  retainBotGroupTrackedMentions,
  type BotGroupTrackedMention,
} from './botGroupMentions';
import { isActiveBotGroupMember } from './botGroupPresentation';

type MentionOption =
  | { kind: 'all'; label: string }
  | { kind: 'member'; label: string; member: BotGroupMemberView };

const withoutSelf = (members: readonly BotGroupMemberView[]) => members.filter((member) => member.isSelf !== true);

export function useBotGroupMentionPicker({
  text,
  onTextChange,
  members,
  textareaRef,
  allLabels,
}: {
  text: string;
  /** Every text change from typing or picking goes through here. */
  onTextChange: (value: string) => void;
  /** Full roster: active members other than you are offered; everyone but you still resolves. */
  members: readonly BotGroupMemberView[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Labels that mean 「所有人」 when resolving; the first is the one offered. Defaults to the UI label. */
  allLabels?: readonly string[];
}) {
  const { t } = useTranslation();
  const listboxId = useId();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [tracked, setTracked] = useState<BotGroupTrackedMention[]>([]);
  const selectionRef = useRef({ start: 0, end: 0 });
  const pendingCaretRef = useRef<number | null>(null);
  // @ list: glide highlight on the aria-selected option; arrow keys stay in the textarea.
  const listRef = useMenuPanel<HTMLDivElement>(undefined, {
    lockWidth: false,
    options: {
      current: currentSelectedOption,
      currentAttributes: ['aria-selected'],
      keyboardSource: document,
    },
  });

  const allLabel = t('bots.groupChat.mention.all');
  const resolveLabels = useMemo(() => allLabels ?? [allLabel], [allLabels, allLabel]);
  // You never name yourself: the host drops you from the targets (as on mobile).
  const mentionMembers = useMemo(() => withoutSelf(members), [members]);
  const activeMembers = useMemo(() => mentionMembers.filter(isActiveBotGroupMember), [mentionMembers]);
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
  const open = query !== null && options.length > 0 && dismissedStart !== query.start;
  const activeIndex = Math.min(highlight, Math.max(0, options.length - 1));

  // Put the caret after a picked name once React has written the new value.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    const nextCaret = pendingCaretRef.current;
    if (!element || nextCaret === null) return;
    pendingCaretRef.current = null;
    element.setSelectionRange(nextCaret, nextCaret);
  }, [text, textareaRef]);

  // A long roster scrolls; keep the keyboard choice in view.
  useLayoutEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, listboxId]);

  const syncCaret = () => {
    const element = textareaRef.current;
    if (!element) return;
    selectionRef.current = {
      start: element.selectionStart ?? element.value.length,
      end: element.selectionEnd ?? element.value.length,
    };
    setCaret(selectionRef.current.start);
  };

  const choose = (option: MentionOption | undefined) => {
    if (!option || !query) return;
    const next = insertBotGroupMention(text, { start: query.start, end: caret }, option.label);
    // A pick obeys the field's own maxLength, as typing does (a programmatic value would skip it).
    const limit = textareaRef.current?.maxLength ?? -1;
    if (limit >= 0 && next.text.length > limit) return;
    // Re-picking a namesake can leave the text as is; then no re-render moves the caret.
    if (next.text === text) textareaRef.current?.setSelectionRange(next.caret, next.caret);
    else pendingCaretRef.current = next.caret;
    onTextChange(next.text);
    selectionRef.current = { start: next.caret, end: next.caret };
    setCaret(next.caret);
    setHighlight(0);
    setTracked((current) => {
      const remaining = retainBotGroupTrackedMentions(text, next.text, {
        members: mentionMembers,
        allLabels: resolveLabels,
        tracked: current,
        editStart: query.start,
        editEnd: caret,
      });
      return option.kind === 'member'
        ? [...remaining, { botId: option.member.botId, label: option.label, start: query.start }]
        : remaining;
    });
    textareaRef.current?.focus();
  };

  /** The textarea's new value; the caret is read from the element, which already has it. */
  const onChange = (value: string) => {
    const nextCaret = textareaRef.current?.selectionStart ?? value.length;
    const editStart = Math.min(selectionRef.current.start, nextCaret);
    const editEnd = selectionRef.current.end;
    onTextChange(value);
    setTracked((current) =>
      retainBotGroupTrackedMentions(text, value, {
        members: mentionMembers,
        allLabels: resolveLabels,
        tracked: current,
        editStart,
        editEnd,
      }),
    );
    selectionRef.current = { start: nextCaret, end: nextCaret };
    setCaret(nextCaret);
    setHighlight(0);
    // A dismissed picker stays closed only for the `@` it was closed on.
    if (findBotGroupMentionQuery(value, nextCaret)?.start !== dismissedStart) setDismissedStart(null);
  };

  /** Arrow keys, Enter / Tab and Esc while the list is open; true when the key was used. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !query) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((activeIndex + step + options.length) % options.length);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose(options[activeIndex]);
      return true;
    }
    if (event.key === 'Escape') {
      // Only the list closes; a panel listening for Esc sees defaultPrevented and stays.
      event.preventDefault();
      event.stopPropagation();
      setDismissedStart(query.start);
      return true;
    }
    return false;
  };

  /** Spread onto the textarea; the host wires `onChange` and composes `onKeyDown` itself. */
  const textareaProps = {
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listboxId : undefined,
    'aria-activedescendant': open ? `${listboxId}-${activeIndex}` : undefined,
    onSelect: syncCaret,
    onFocus: () => {
      setFocused(true);
      syncCaret();
    },
    onBlur: () => setFocused(false),
  };

  /** The text was sent or replaced from outside: forget picks and the caret. */
  const reset = () => {
    selectionRef.current = { start: 0, end: 0 };
    setCaret(0);
    setTracked([]);
    setDismissedStart(null);
  };

  const list = open ? (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={t('bots.groupChat.mention.label')}
      {...menuPanelAttrs}
      // Shared menu panel (DESIGN §4): Board border and menu surface; no shadow, per the
      // zero-shadow Bot surfaces (botDesignContract.test.ts). Capped and scrolling so a big
      // roster stays inside a short window or the narrow thread panel.
      className="absolute bottom-full left-0 z-20 mb-2 flex max-h-72 w-64 max-w-full flex-col gap-0.5 overflow-y-auto rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1.5"
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
          className={cn(COMPOSER_MENU_ROW, 'flex shrink-0 cursor-pointer items-center gap-2.5 px-2.5 py-1.5')}
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
  ) : null;

  return {
    list,
    textareaProps,
    onChange,
    onKeyDown,
    tracked,
    setTracked,
    reset,
    /** Resolve who the text addresses, using the picks; `roster` defaults to the current members. */
    resolve: (value: string, roster: readonly BotGroupMemberView[] = members) =>
      resolveBotGroupMentions(value, { members: withoutSelf(roster), allLabels: resolveLabels, tracked }),
  };
}
