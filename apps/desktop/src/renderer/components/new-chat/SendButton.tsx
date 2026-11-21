import { forwardRef, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, AudioLines, Check, Clock } from 'lucide-react';

import { cn } from '@/lib/utils';

interface SendButtonProps {
  disabled: boolean;
  /** The event lets callers read modifier keys (modifier+click sends the other way). */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** When true, renders the streaming Stop variant. */
  isStreaming?: boolean;
  /** Highlighted while voice long-press is hovering over this button as a release target. */
  highlighted?: boolean;
  /** Override for the accessible action name when Send visually means Queue. */
  ariaLabel?: string;
  /** Save reuses the send button shell while queue content is edited in the composer. */
  action?: 'send' | 'save' | 'voice';
  /** Companion call/send share one stationary 30px target; other composers stay unchanged. */
  companionVoice?: boolean;
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
  /**
   * 发送键上的投递提示（SendDeliveryTip）指向「另一种方式」时，纸飞机换成那种方式的图标：
   * steer 用 ↑（与排队消息上的「插话」同一个图标），queue 用时钟。
   */
  alternateGlyph?: 'steer' | 'queue' | null;
}

export function CreateAgentSendIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
      <path d="M2.6 3.35a1 1 0 0 1 1.08-.13l17.2 8a.88.88 0 0 1 0 1.56l-17.2 8A1 1 0 0 1 2.3 19.6l2.04-6.44L13 12 4.34 10.84 2.3 4.4a1 1 0 0 1 .3-1.05Z" />
    </svg>
  );
}

/**
 * Covers the settle choreography in globals.css (`.composer-send[data-settling]`): the stop
 * square leaves, the plane glides back after --motion-instant, the button dims after
 * --motion-enter, and the working glow keeps turning while it fades out.
 */
const SETTLE_MS = 700;

/**
 * Send / Stop button — 30×30 circle (DESIGN.md §14.4「Desktop composer send / stop」).
 *
 * Send: filled paper plane on the neutral-inverse fill; nothing to send keeps 40% opacity.
 * Stop (streaming): the plane flies out, a 10×10 square lands, and the registered working
 * glow (`.composer-send-beam`) turns around the edge. When work ends the button settles back.
 * Motion lives in globals.css so durations stay on the motion tokens.
 */
export const SendButton = forwardRef<HTMLButtonElement, SendButtonProps>(function SendButton(
  {
    disabled,
    onClick,
    isStreaming = false,
    highlighted = false,
    ariaLabel,
    action = 'send',
    companionVoice = false,
    alternateGlyph = null,
  },
  ref,
) {
  const { t } = useTranslation();
  const isVoice = action === 'voice' && !isStreaming;
  const currentAction = isStreaming ? 'stop' : action;
  const pressedAction = useRef<typeof currentAction | null>(null);
  const showAlternate = Boolean(alternateGlyph) && action === 'send' && !isStreaming;
  // Keep the last glyph while its layer fades out, so it does not flip mid-transition.
  const lastAlternateGlyph = useRef<'steer' | 'queue'>('steer');
  if (alternateGlyph) lastAlternateGlyph.current = alternateGlyph;
  // Derived during render so data-settling lands in the same commit that clears
  // streaming: the glow's animation must not detach for a frame and jump.
  const [prevStreaming, setPrevStreaming] = useState(isStreaming);
  const [settling, setSettling] = useState(false);
  if (prevStreaming !== isStreaming) {
    setPrevStreaming(isStreaming);
    setSettling(prevStreaming && !isStreaming);
  }
  useEffect(() => {
    if (!settling) return undefined;
    const timer = window.setTimeout(() => setSettling(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settling]);
  const iconTransition =
    'transition-[opacity,transform] duration-[var(--motion-enter)] ease-[var(--motion-ease-move)] motion-reduce:transform-none';
  const hiddenIcon = 'scale-[0.55] opacity-0';
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      data-send-action={currentAction}
      data-companion={companionVoice ? 'true' : undefined}
      data-settling={settling ? 'true' : undefined}
      data-release={highlighted && !disabled && !isStreaming ? 'true' : undefined}
      data-send-alternate={showAlternate ? 'true' : undefined}
      // A draft can change between press and release (ASR, attachments, keyboard or
      // the turn ending). Never turn that press into a different action, such as
      // Stop -> Send or Send -> Start call.
      onPointerDown={() => {
        pressedAction.current = currentAction;
      }}
      onPointerCancel={() => {
        pressedAction.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          // Holding Enter across a successful send must not fire the action the shared button
          // turns into (start a call, or Stop a turn the press just started or queued) when
          // the composer state changes the focused button's action under the key.
          if (event.repeat) {
            event.preventDefault();
            return;
          }
          pressedAction.current = currentAction;
        }
      }}
      onBlur={() => {
        pressedAction.current = null;
      }}
      onClick={(event) => {
        const initialAction = pressedAction.current;
        pressedAction.current = null;
        if (initialAction !== null && initialAction !== currentAction) return;
        onClick(event);
      }}
      className={cn(
        'composer-send relative flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chat-input-bg)]',
        companionVoice && 'group/composer-action',
        disabled && 'cursor-not-allowed',
        disabled && !isStreaming && 'opacity-40',
      )}
      aria-label={
        ariaLabel ??
        (isStreaming
          ? t('newChat.sendButton.stop')
          : isVoice
            ? t('bots.voiceMode.startConversation')
            : t('newChat.sendButton.send'))
      }
    >
      {companionVoice ? (
        <>
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 rounded-full border border-[var(--border-default)] bg-[var(--composer-pill-bg)]',
              'transition-opacity duration-[var(--motion-enter)] ease-[var(--motion-ease-move)]',
              !disabled && 'group-hover/composer-action:bg-[var(--model-trigger-hover)]',
              isVoice ? 'opacity-100' : 'opacity-0',
            )}
          />
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 rounded-full bg-[var(--send-btn-bg)]',
              'transition-opacity duration-[var(--motion-enter)] ease-[var(--motion-ease-move)]',
              !disabled &&
                'group-hover/composer-action:bg-[var(--send-btn-hover-bg)] group-active/composer-action:bg-[var(--send-btn-pressed-bg)]',
              isVoice ? 'opacity-0' : 'opacity-100',
            )}
          />
        </>
      ) : (
        // Press retracts only this fill by 1px; icon and hit region stay (§4 Button feedback).
        <span aria-hidden className="composer-send-face" />
      )}
      <span aria-hidden className="composer-send-beam" data-active={isStreaming ? 'true' : undefined}>
        <span className="composer-send-beam-glow">
          <span className="composer-send-beam-counter" />
        </span>
        <span className="composer-send-beam-rim">
          <span className="composer-send-beam-counter" />
          <span className="composer-send-beam-highlight" />
        </span>
        <span className="composer-send-beam-bloom" />
      </span>
      <span aria-hidden className="composer-send-ring" />
      <span className="relative grid h-4 w-4 place-items-center" aria-hidden>
        {companionVoice && (
          <span
            className={cn(
              'col-start-1 row-start-1 flex items-center justify-center text-[var(--composer-pill-icon)]',
              iconTransition,
              isVoice ? 'scale-100 opacity-100' : hiddenIcon,
            )}
          >
            <AudioLines size={15} />
          </span>
        )}
        <span
          data-send-icon="plane"
          className="col-start-1 row-start-1 flex items-center justify-center text-[var(--send-btn-icon)]"
        >
          {action === 'save' ? (
            <Check className="h-4 w-4" strokeWidth={2.4} />
          ) : (
            <CreateAgentSendIcon />
          )}
        </span>
        <span
          data-send-icon="alternate"
          className="col-start-1 row-start-1 flex items-center justify-center text-[var(--send-btn-icon)]"
        >
          {lastAlternateGlyph.current === 'queue' ? (
            <Clock className="h-4 w-4" strokeWidth={2.4} />
          ) : (
            <ArrowUp className="h-4 w-4" strokeWidth={2.4} />
          )}
        </span>
        <span
          // design: intrinsic-geometry — the stop glyph's softened corner, not a control frame
          data-send-icon="stop"
          className="col-start-1 row-start-1 block h-[10px] w-[10px] rounded-[1.5px] bg-[var(--send-btn-icon)]"
        />
      </span>
    </button>
  );
});
