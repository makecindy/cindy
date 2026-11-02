import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ArrowUpRight, MessageSquareText, Mic, MicOff, PhoneOff, Send, Settings2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { BotAvatar } from '../BotAvatar';
import type { VoiceCallBot } from '@/../shared/voiceConversation';
import type { VoiceSnapshot } from './VoiceConversationController';
import './voiceConversation.css';
import { VoiceCallDuration, VoiceCallTranscript } from './VoiceCallTranscript';

type Props = {
  callOpen?: boolean;
  bot: VoiceCallBot;
  state: VoiceSnapshot;
  loading: boolean;
  blocked: boolean;
  questionPending?: boolean;
  questionElsewhere?: boolean;
  configurationError: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onResume(): void;
  onMute(): void;
  onInterrupt(): void;
  onSend(): void;
  onCancelExit(): void;
  onClose(): void;
  onConfigure(): void;
  onOpenTask?(clientId: string): void;
  onOpenConversation?(): void;
};

/** Presentation only: expanding details must never recreate capture, playback or exit timers. */
export function CompanionVoiceToolbar(props: Props) {
  const { t } = useTranslation();
  const { state } = props;
  const labelId = useId();
  const detailsId = useId();
  const hintId = useId();
  const detailsButton = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const controlPointerDown = useRef<PointerEvent | null>(null);
  const [expanded, setExpanded] = useState(false);
  // The call's exit animation retains its last frame. A portalled transcript
  // must close immediately instead of escaping the inert presence wrapper.
  const callOpen = props.callOpen !== false;
  useEffect(() => {
    if (!callOpen) setExpanded(false);
  }, [callOpen]);
  const active =
    !props.blocked &&
    (props.loading ||
      ['connecting', 'microphone', 'listening', 'thinking', 'preparing', 'speaking'].includes(
        state.phase,
      ));
  const status = props.blocked
    ? 'confirmation'
    : props.loading && state.phase === 'idle'
      ? 'loading'
      : state.muted && state.phase === 'listening'
        ? 'muted'
        : props.questionPending && state.phase === 'listening'
          ? 'question'
        : props.questionElsewhere && state.phase === 'listening'
          ? 'questionElsewhere'
          : state.phase;
  const waiting = ['loading', 'connecting', 'microphone', 'thinking', 'preparing'].includes(status);
  const wave =
    status === 'listening' ||
    status === 'speaking' ||
    status === 'question' ||
    status === 'questionElsewhere';
  // A late send failure can coexist with new input. Keep both visible; the
  // controller still owns their ordering and the existing retry/send action.
  const text = [state.unsent, state.questionDraft, state.transcript].filter(Boolean).join('\n');
  const detailsLabel = t(expanded ? 'bots.voiceMode.hideDetails' : 'bots.voiceMode.showDetails');
  const muteLabel = t(state.muted ? 'bots.voiceMode.unmute' : 'bots.voiceMode.mute');
  const hint = t(
    state.exitCountdown
      ? state.muted
        ? 'bots.voiceMode.exit.mutedHint'
        : 'bots.voiceMode.exit.hint'
      : state.muted
        ? 'bots.voiceMode.mutedHint'
        : 'bots.voiceMode.hint',
  );
  const detailsHint = state.exitCountdown || state.muted ? hint : null;
  const send = (iconOnly = false) =>
    text && active ? (
      <Button
        variant="secondary"
        tone="quiet"
        size="md"
        compact
        className={iconOnly ? 'w-8 px-0' : undefined}
        aria-label={t('bots.voiceMode.send')}
        disabled={state.microphonePending}
        onClick={props.onSend}
      >
        <Send size={14} aria-hidden="true" />
        {!iconOnly && t('bots.voiceMode.send')}
      </Button>
    ) : null;
  const compactSend = !expanded ? send(true) : null;
  const detailsSend = expanded ? send() : null;

  return (
    <Popover open={expanded && callOpen} onOpenChange={setExpanded}>
      <section
        className="companion-voice-toolbar"
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onKeyDown={(event) => {
          // Escape dismisses only the disclosure, never the live call or a pending exit.
          if (event.key === 'Escape' && expanded) {
            event.stopPropagation();
            setExpanded(false);
            detailsButton.current?.focus();
          }
        }}
      >
        <h2 ref={props.titleRef} tabIndex={-1} id={labelId} className="sr-only outline-none">
          {t('bots.voiceMode.title')}
        </h2>
        <p id={hintId} className="sr-only">
          {hint}
        </p>
        <PopoverContent
          id={detailsId}
          inert={!expanded || !callOpen}
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="companion-voice-details"
          aria-label={t('bots.voiceMode.callRecord')}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            // Ending the call restores the composer, not a disappearing trigger.
            if (!callOpen) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            // Radix defers outside pointer handling until click. A control may
            // replace its icon or unmount by then, so retain the original event
            // as well as checking containment for keyboard focus changes.
            const originalEvent = event.detail.originalEvent;
            if (
              originalEvent === controlPointerDown.current ||
              (event.target instanceof Node && bar.current?.contains(event.target))
            )
              event.preventDefault();
          }}
        >
          <div className="companion-voice-details-heading flex items-center gap-2 text-12 text-[var(--text-secondary)]">
            <span>{t('bots.voiceMode.callRecord')}</span>
            {state.callRecord && <VoiceCallDuration record={state.callRecord} live />}
            <Tip text={t('bots.voiceMode.openSettings')}>
              <Button
                variant="secondary"
                tone="quiet"
                size="md"
                className="ml-auto w-8 px-0"
                aria-label={t('bots.voiceMode.openSettings')}
                onClick={props.onConfigure}
              >
                <Settings2 size={16} aria-hidden="true" />
              </Button>
            </Tip>
          </div>
          <VoiceCallTranscript
            record={state.callRecord}
            live
            unsent={state.unsent}
            questionDraft={state.questionDraft}
            transcript={state.transcript}
            onOpenTask={
              props.onOpenTask
                ? (clientId) => {
                    setExpanded(false);
                    props.onOpenTask?.(clientId);
                    detailsButton.current?.focus();
                  }
                : undefined
            }
          />
          {(detailsHint || detailsSend) && (
            <div className="companion-voice-details-feedback flex items-center justify-end gap-2 text-12 text-[var(--text-secondary)]">
              {detailsHint && <span className="mr-auto">{detailsHint}</span>}
              {detailsSend}
            </div>
          )}
        </PopoverContent>
        <PopoverAnchor asChild>
          <div
            ref={bar}
            className="companion-voice-bar"
            onPointerDownCapture={(event) => {
              controlPointerDown.current = event.nativeEvent;
            }}
          >
            <div className="companion-voice-identity">
              <BotAvatar bot={props.bot} size="sm" className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-13 font-medium">{props.bot.name}</span>
                </div>
                <p
                  className="text-11 leading-4 text-[var(--text-secondary)]"
                  role="status"
                  aria-live="polite"
                >
                  {state.exitCountdown
                    ? t(
                        state.exitCountdown.waitingForSend
                          ? 'bots.voiceMode.exit.sending'
                          : `bots.voiceMode.exit.${state.exitCountdown.reason}`,
                      )
                    : t(`bots.voiceMode.status.${status}`)}
                </p>
                {state.exitCountdown && !state.exitCountdown.waitingForSend ? (
                  <p
                    role="timer"
                    aria-live="off"
                    className="mt-0.5 text-12 tabular-nums text-[var(--text-secondary)]"
                  >
                    {t('bots.voiceMode.exit.countdown', {
                      seconds: state.exitCountdown.secondsRemaining,
                    })}
                  </p>
                ) : state.muted && status !== 'muted' ? (
                  <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
                    {t('bots.voiceMode.microphoneMuted')}
                  </p>
                ) : state.speakerFiltered ? (
                  <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
                    {t('voiceInputOverlay.speakerFiltered')}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="companion-voice-actions">
              {state.exitCountdown ? (
                <Button variant="secondary" size="md" compact onClick={props.onCancelExit}>
                  {t('bots.voiceMode.exit.cancel')}
                </Button>
              ) : !active ? (
                <Button
                  variant="secondary"
                  size="md"
                  compact
                  onClick={props.onResume}
                  disabled={props.loading || props.blocked}
                >
                  {t(
                    state.unsent || state.questionDraft
                      ? 'bots.voiceMode.retrySend'
                      : 'bots.voiceMode.resume',
                  )}
                </Button>
              ) : (
                <div className="companion-voice-activity" aria-hidden="true" data-activity={status}>
                  {waiting ? (
                    <Spinner size={18} />
                  ) : wave ? (
                    <div className="companion-voice-meter">
                      {[0.4, 0.7, 1, 0.65, 0.9, 0.5, 0.75].map((weight, index) => (
                        <span
                          key={index}
                          style={{ transform: `scaleY(${0.12 + state.level * weight * 0.88})` }}
                        />
                      ))}
                    </div>
                  ) : (
                    <MicOff size={18} />
                  )}
                </div>
              )}
              {props.onOpenConversation ? (
                <Tip text={t('bots.voiceMode.openConversation')}>
                  <Button
                    variant="secondary"
                    tone="quiet"
                    size="md"
                    className="w-8 px-0"
                    aria-label={t('bots.voiceMode.openConversation')}
                    onClick={props.onOpenConversation}
                  >
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </Button>
                </Tip>
              ) : null}
              <Tip text={detailsLabel}>
                <PopoverTrigger asChild>
                  <Button
                    ref={detailsButton}
                    variant="secondary"
                    tone="quiet"
                    size="md"
                    className="companion-voice-details-trigger w-8 px-0"
                    aria-label={detailsLabel}
                    aria-expanded={expanded}
                    aria-controls={expanded ? detailsId : undefined}
                  >
                    <MessageSquareText size={16} aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
              </Tip>
              {compactSend ? <Tip text={t('bots.voiceMode.send')}>{compactSend}</Tip> : null}
              {active ? (
                <Tip text={muteLabel}>
                  <Button
                    variant="secondary"
                    tone="quiet"
                    size="md"
                    className="w-8 px-0"
                    aria-label={muteLabel}
                    aria-pressed={state.muted}
                    onClick={props.onMute}
                    loading={state.microphonePending}
                    disabled={
                      props.loading || state.phase === 'connecting' || state.phase === 'microphone'
                    }
                  >
                    {state.muted ? (
                      <MicOff size={16} aria-hidden="true" />
                    ) : (
                      <Mic size={16} aria-hidden="true" />
                    )}
                  </Button>
                </Tip>
              ) : null}
              {state.phase === 'speaking' || state.phase === 'preparing' ? (
                <Tip text={t('bots.voiceMode.interrupt')}>
                  <Button
                    variant="secondary"
                    tone="quiet"
                    size="md"
                    className="w-8 px-0"
                    aria-label={t('bots.voiceMode.interrupt')}
                    onClick={props.onInterrupt}
                  >
                    <VolumeX size={16} aria-hidden="true" />
                  </Button>
                </Tip>
              ) : null}
              <span
                className="mx-1 h-5 w-px shrink-0 bg-[var(--border-default)]"
                aria-hidden="true"
              />
              <Button variant="secondary" size="md" compact onClick={props.onClose}>
                <PhoneOff size={16} aria-hidden="true" />
                {t('bots.voiceMode.end')}
              </Button>
            </div>
          </div>
        </PopoverAnchor>
        {state.error ? (
          <p role="alert" className="companion-voice-error">
            {t(`bots.voiceMode.errors.${state.error}`)}
          </p>
        ) : null}
        {state.microphoneError ? (
          <p role="alert" className="companion-voice-error">
            {t('bots.voiceMode.microphoneResumeError')}
          </p>
        ) : null}
        {props.configurationError ? (
          <p role="alert" className="companion-voice-error">
            {t('bots.voiceMode.preferenceError')}
          </p>
        ) : null}
      </section>
    </Popover>
  );
}
