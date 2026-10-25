import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import type { ChatMessage } from '@/lib/makerChatStore';
import { WebMicAudioEngine } from '@/voice-input/WebMicAudioEngine';
import { getVoiceInputWorkletUrl } from '@/voice-input/workletUrl';
import type { BotChatIdentity } from '../BotSessionContentHeader';
import { SectionCollapse } from '../../cc-agent/sidebar/SectionCollapse';
import { VoiceConversationController } from './VoiceConversationController';
import { PcmSpeechPlayer } from './PcmSpeechPlayer';
import { resolveVoiceConfiguration } from './voiceConfiguration';
import { CompanionVoiceToolbar } from './CompanionVoiceToolbar';
import type { VoiceTaskFailure } from './VoiceReplyTracker';
import type { VoiceQuestionBridge } from '@/components/new-chat/voiceQuestionSelection';

type Props = {
  open: boolean;
  bot: BotChatIdentity;
  sessionId: string;
  messages: readonly ChatMessage[];
  blocked: boolean;
  questionPending?: boolean;
  questionBridge?: VoiceQuestionBridge;
  taskBusy: boolean;
  taskFailure?: VoiceTaskFailure | null;
  onClose(): void;
  onConfigure(): void;
  onCallIdChange?(callId: string | null): void;
  onOpenTask?(clientId: string): void;
  onSend(text: string, onCreated: (id: string) => void, isCurrent: () => boolean): Promise<boolean>;
};

export function CompanionVoicePanel(props: Props) {
  return (
    <SectionCollapse
      collapsed={!props.open}
      inert={!props.open}
      className="companion-voice-presence"
      innerClassName="companion-voice-presence-content"
    >
      <CompanionVoiceCall {...props} />
    </SectionCollapse>
  );
}

function CompanionVoiceCall(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const recordRef = useRef<import('@cindy/maker-core').VoiceCallRecord | undefined>(undefined);
  const ownsQuestion = () => {
    const input = latest.current.messages.findLast(message => message.role === 'user');
    return !window.electronAPI.voiceConversation.submitTurn || !!recordRef.current?.handoffs.some(task => task.id === input?.clientId);
  };
  const [loading, setLoading] = useState(true);
  const [configurationError, setConfigurationError] = useState(false);
  const launchVersion = useRef(0);
  const controller = useMemo(
    () =>
      new VoiceConversationController({
        api: window.electronAPI.voiceConversation,
        botId: props.bot.id,
        sessionId: props.sessionId,
        isTaskBusy: () => window.electronAPI.voiceConversation.submitTurn
          ? !!recordRef.current?.handoffs.some(task => task.state === 'accepted' || task.state === 'sending')
          : latest.current.taskBusy,
        isQuestionPending: () => (latest.current.questionPending ?? false) && ownsQuestion(),
        getQuestionTarget: () => ownsQuestion() ? latest.current.questionBridge?.current ?? null : null,
        onAutoEnd: () => latest.current.onClose(),
        onCallIdChange: (callId) => latest.current.onCallIdChange?.(callId),
        send: (...args) => latest.current.onSend(...args),
        microphone: (onInterrupted, onStateChange) =>
          new WebMicAudioEngine({
            workletUrl: getVoiceInputWorkletUrl(),
            deviceId: getVoiceInputSettings().microphoneDeviceId ?? undefined,
            chunkMs: 40,
            latencyMs: 10,
            keepAlive: false,
            audioProcessing: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: false,
            },
            onInterrupted,
            onStateChange,
          }),
        player: (onLevel) => new PcmSpeechPlayer(onLevel),
      }),
    [props.bot.id, props.sessionId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  recordRef.current = state.callRecord;
  const start = useCallback(async () => {
    if (!latest.current.open) return;
    const version = ++launchVersion.current;
    setLoading(true);
    setConfigurationError(false);
    try {
      const [models, preference] = await Promise.all([
        window.electronAPI.voiceConversation.models(),
        window.electronAPI.voiceConversation.preference(props.bot.id),
      ]);
      if (version !== launchVersion.current || !latest.current.open || latest.current.blocked)
        return;
      const { selection, protocol } = resolveVoiceConfiguration(models, preference.selection);
      if (!selection || !protocol) {
        latest.current.onConfigure();
        return;
      }
      controller.setBlocked(false);
      await controller.start(selection, preference.sentencePlayback ?? true);
      if (version === launchVersion.current && latest.current.open && !latest.current.blocked)
        controller.retryUnsent();
    } catch {
      if (version === launchVersion.current) setConfigurationError(true);
    } finally {
      if (version === launchVersion.current) setLoading(false);
    }
  }, [controller, props.bot.id]);

  useEffect(() => {
    if (!props.open) return;
    titleRef.current?.focus();
    void start();
    return () => {
      // Closing retains only the visual surface for its exit transition. Release
      // capture/playback now, and invalidate late loads before visual unmount.
      ++launchVersion.current;
      // Effect cleanup can also come from navigation or dev hot reload. Do not
      // diagnose these as an explicit End click from the shared default reason.
      controller.end(latest.current.open ? 'view_cleanup' : 'view_closed');
    };
  }, [controller, start, props.open]);
  useEffect(() => {
    if (!props.open) return;
    controller.setBlocked(props.blocked);
    if (props.blocked) {
      ++launchVersion.current;
      setLoading(false);
    }
  }, [controller, props.blocked, props.open]);
  useEffect(() => {
    if (props.open) controller.refreshQuestion();
  }, [controller, props.questionPending, props.messages, state.callRecord, props.open]);
  useEffect(() => {
    if (props.open && !window.electronAPI.voiceConversation.submitTurn)
      controller.updateMessages(props.messages, props.taskFailure ?? null);
  }, [controller, props.messages, props.taskFailure, props.open]);
  useEffect(() => {
    if (props.open) controller.refreshActivity();
  }, [controller, props.taskBusy, state.callRecord, props.open]);
  useEffect(() => {
    if (!props.open) return;
    const initialOwner = getDataOwnerGeneration();
    const owner = `${initialOwner.dataOwnerId}:${initialOwner.generation}`;
    const removeAuth = window.electronAPI.onAuthStateChange((next) => {
      if (next.ownerBoundaryPending || `${next.dataOwnerId}:${next.ownerGeneration}` !== owner) {
        ++launchVersion.current;
        controller.end('account_changed');
        latest.current.onClose();
      }
    });
    const removePower = window.electronAPI.voiceInput.onPowerStateChange(() => {
      ++launchVersion.current;
      setLoading(false);
      controller.setBlocked(true);
    });
    return () => {
      removeAuth();
      removePower();
    };
  }, [controller, props.open]);
  // end() resets the live controller immediately. Keep its last visible frame
  // while fading out so idle/Resume does not flash during the exit animation.
  const presentation = useRef({ state, loading, blocked: props.blocked, configurationError });
  if (props.open)
    presentation.current = { state, loading, blocked: props.blocked, configurationError };
  return (
    <CompanionVoiceToolbar
      callOpen={props.open}
      bot={props.bot}
      {...presentation.current}
      questionPending={props.questionPending && ownsQuestion()}
      titleRef={titleRef}
      onResume={() => void start()}
      onMute={() => void controller.toggleMute()}
      onInterrupt={() => controller.interrupt()}
      onSend={() => (state.transcript ? controller.finishUtterance() : controller.retryUnsent())}
      onCancelExit={() => {
        controller.cancelExit();
        titleRef.current?.focus();
      }}
      onClose={props.onClose}
      onConfigure={props.onConfigure}
      onOpenTask={props.onOpenTask}
    />
  );
}
