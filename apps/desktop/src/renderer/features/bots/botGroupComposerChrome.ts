/**
 * 群聊输入框的外观：主群（BotGroupComposer）与 Thread 回复（ChatThreadPanel）共用同一张
 * 卡片、同一个输入区和同一行操作，发送按钮都在卡片右下角（SendButton）。两处只引用这里，
 * 不各写一份，免得卡片描边、字号和按钮位置再次走样。
 *
 * 输入框贴在面板底部，不另画分隔线；卡片自己的描边就是边界。
 */
import { useEffect, type MouseEvent, type RefObject } from 'react';

/** Docked under the message list; no top rule — the card's border is the boundary. */
export const BOT_GROUP_COMPOSER_DOCK = 'shrink-0 px-5 pb-4 pt-2';

/** Centers the card in a wide main column; a narrow Thread panel simply fills it. */
export const BOT_GROUP_COMPOSER_COLUMN = 'relative mx-auto w-full max-w-[760px]';

export const BOT_GROUP_COMPOSER_CARD =
  'relative flex flex-col gap-2 rounded-xl border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] px-3.5 pb-2.5 pt-3 transition-colors focus-within:border-[var(--chat-input-border-focus)]';

/** Starts at one line and grows with the text (see fitBotGroupComposerInput); max-h caps it and scrolls. */
export const BOT_GROUP_COMPOSER_INPUT =
  'max-h-60 min-h-6 w-full resize-none overflow-y-auto bg-transparent text-15 leading-[1.6] text-[var(--chat-input-text)] outline-none placeholder:text-[var(--chat-input-placeholder)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

/** Left: tools and hints; right: the send button. */
export const BOT_GROUP_COMPOSER_FOOTER = 'flex min-h-7 items-center justify-between gap-3';

/**
 * The footer's left slot, before the send button: 「+」, hints, or a send option such as a
 * checkbox. Its content shrinks or truncates first, so the button never leaves the row.
 */
export const BOT_GROUP_COMPOSER_FOOTER_START = 'flex min-w-0 items-center gap-2';

/**
 * `onMouseDown` for the wrapper around the send button. A click would move focus from the input
 * to the button before `onClick`, and the button then disables itself while sending — leaving no
 * caret. Only while the input has focus is that default suppressed; the click still fires and
 * Tab focus is unchanged (as ChatInput's send button).
 */
export function keepBotGroupComposerInputFocus(ref: RefObject<HTMLTextAreaElement | null>) {
  return (event: MouseEvent) => {
    if (ref.current && document.activeElement === ref.current) event.preventDefault();
  };
}

/** Auto-grow: call from a layout effect whenever the text changes. */
export function fitBotGroupComposerInput(element: HTMLTextAreaElement): void {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

/**
 * A wider or narrower input rewraps its text, so fit it again when its width changes (window
 * resize, Thread panel opening). Only width counts: the fit itself changes the height.
 * `mounted` re-attaches after the textarea is replaced (e.g. by the share bar and back).
 */
export function useRefitBotGroupComposerInputOnResize(
  ref: RefObject<HTMLTextAreaElement | null>,
  mounted = true,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!mounted || !element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fitBotGroupComposerInput(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, mounted]);
}
