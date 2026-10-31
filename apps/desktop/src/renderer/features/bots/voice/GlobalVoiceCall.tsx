import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type {
  VoiceCallBot,
  VoiceCallCommand,
  VoiceCallStatus,
} from '@/../shared/voiceConversation';
import type { VoiceQuestionBridge } from '@/components/new-chat/voiceQuestionSelection';
import { useSessionBinding } from '@/hooks/useSessionBinding';
import { makerChatStore } from '@/lib/makerChatStore';
import { requestChatTaskFocus } from '@/features/right-sidebar/plugins/background-tasks/chatTaskFocusIntent';
import {
  SECTION_COLLAPSE_DURATION_MS,
  SectionCollapse,
} from '../../cc-agent/sidebar/SectionCollapse';
import {
  CompanionVoicePanel,
  type VoiceCallControls,
  type VoicePresentation,
} from './CompanionVoicePanel';
import { CompanionVoiceToolbar } from './CompanionVoiceToolbar';
import {
  installVoiceCallHost,
  publishVoiceCallStatus,
  registerVoiceCallSlot,
  sendVoiceCallCommand,
  useFloatingVoiceCallSlot,
  useFloatingVoiceCallSlotElement,
  useVoiceCallSlot,
  useVoiceCallStatus,
  useVoiceCallSummary,
} from './voiceCallStore';

const LEVEL_PUBLISH_INTERVAL_MS = 100;

const conversationPath = (botId: string, sessionId: string) =>
  `/bots/${encodeURIComponent(botId)}/session/${encodeURIComponent(sessionId)}`;
const settingsPath = (botId: string, sessionId: string) =>
  `${conversationPath(botId, sessionId)}?settings=1&settingsPage=voice`;

function sameExceptLevel(a: VoiceCallStatus, b: VoiceCallStatus): boolean {
  const { state: stateA, ...restA } = a;
  const { state: stateB, ...restB } = b;
  return (
    (Object.keys(restA) as (keyof typeof restA)[]).every((key) => restA[key] === restB[key]) &&
    (Object.keys(stateA) as (keyof typeof stateA)[]).every(
      (key) => key === 'level' || stateA[key] === stateB[key],
    )
  );
}

/** Mirrors the host's call to the other windows, coalescing level-only updates. */
function useVoiceCallPublisher() {
  const last = useRef<VoiceCallStatus | null>(null);
  const levelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return useCallback((next: VoiceCallStatus | null) => {
    const api = window.electronAPI.voiceConversation;
    const previous = last.current;
    last.current = next;
    if (previous && next && sameExceptLevel(previous, next)) {
      if (previous.state.level === next.state.level || levelTimer.current) return;
      levelTimer.current = setTimeout(() => {
        levelTimer.current = undefined;
        if (last.current) api.publishCallStatus?.({ level: last.current.state.level });
      }, LEVEL_PUBLISH_INTERVAL_MS);
      return;
    }
    clearTimeout(levelTimer.current);
    levelTimer.current = undefined;
    api.publishCallStatus?.({ status: next });
  }, []);
}

type HostedCallProps = {
  bot: VoiceCallBot;
  sessionId: string;
  open: boolean;
  controlsRef: React.RefObject<VoiceCallControls | null>;
  onClose(): void;
  onStatus(status: VoiceCallStatus): void;
};

/** Reads task state from the shared store, because the task page may not be mounted. */
function HostedVoiceCall({
  bot,
  sessionId,
  open,
  controlsRef,
  onClose,
  onStatus,
}: HostedCallProps) {
  const navigate = useNavigate();
  const light = useSyncExternalStore(
    (listener) => makerChatStore.subscribeLight(sessionId, listener),
    () => makerChatStore.getLightSnapshot(sessionId),
  );
  const { messages } = useSyncExternalStore(
    (listener) => makerChatStore.subscribe(sessionId, listener),
    () => makerChatStore.getSnapshot(sessionId),
  );
  const binding = useSessionBinding(sessionId);
  const slot = useVoiceCallSlot(sessionId);
  const floating = useFloatingVoiceCallSlot();
  const [callId, setCallId] = useState<string | null>(null);
  const [frame, setFrame] = useState<VoicePresentation | null>(null);
  const blocked = Boolean(
    light.pendingPermission ||
    light.pendingPlanReview ||
    light.pendingPluginSetup ||
    light.pendingIssueConfirm ||
    light.pendingRenameSessionsConfirm ||
    light.pendingGhostGrantConfirm ||
    light.pendingRemoteDesktopConfirmation ||
    light.pendingInputHandoff ||
    binding.attached ||
    light.queuePaused,
  );
  const questionAsked = light.pendingAskUser !== null;
  // Only a card on screen in this window can take a voice answer.
  const questionElsewhere = questionAsked && !slot;
  useEffect(() => {
    if (frame) onStatus({ open, bot, sessionId, callId, ...frame, questionElsewhere });
  }, [open, bot, sessionId, callId, frame, questionElsewhere, onStatus]);
  const openConversation = useCallback(
    () => navigate(conversationPath(bot.id, sessionId)),
    [navigate, bot.id, sessionId],
  );
  const openSettings = useCallback(
    () => navigate(settingsPath(bot.id, sessionId)),
    [navigate, bot.id, sessionId],
  );
  return (
    <CompanionVoicePanel
      open={open}
      bot={bot}
      sessionId={sessionId}
      messages={messages}
      blocked={blocked}
      questionPending={questionAsked && !!slot}
      questionElsewhere={questionElsewhere}
      questionBridge={slot?.questionBridge}
      // Calls hand work over through submitTurn, which tracks its own activity.
      taskBusy={false}
      onSend={async () => false}
      onClose={onClose}
      onConfigure={() => {
        onClose();
        openSettings();
      }}
      onOpenSettings={openSettings}
      onOpenConversation={slot ? undefined : openConversation}
      onOpenTask={(clientId) => {
        if (slot) slot.openTask(clientId);
        else {
          openConversation();
          requestChatTaskFocus(sessionId, clientId);
        }
      }}
      onCallIdChange={setCallId}
      onPresentation={setFrame}
      controlsRef={controlsRef}
      surface={slot?.element ?? floating}
    />
  );
}

type Hosted = { bot: VoiceCallBot; sessionId: string; phase: 'mounting' | 'open' | 'closing' };

/**
 * The one live call of this app. It stays mounted across every route, so moving between
 * tasks, pages and windows only changes where the toolbar is drawn.
 */
export function GlobalVoiceCallHost() {
  const [hosted, setHosted] = useState<Hosted | null>(null);
  const hostedRef = useRef(hosted);
  hostedRef.current = hosted;
  const controlsRef = useRef<VoiceCallControls | null>(null);
  const publishRemote = useVoiceCallPublisher();
  const close = useCallback(() => {
    setHosted((value) => (value ? { ...value, phase: 'closing' } : value));
  }, []);
  const handleCommand = useCallback(
    (command: VoiceCallCommand): boolean => {
      const current = hostedRef.current;
      if (command.type === 'start') {
        // The call in progress keeps the line until the user ends it.
        if (current && current.phase !== 'closing') return false;
        setHosted({ bot: command.bot, sessionId: command.sessionId, phase: 'mounting' });
        return true;
      }
      if (!current || current.phase === 'closing' || current.sessionId !== command.sessionId)
        return false;
      const controls = controlsRef.current;
      if (command.type === 'end') close();
      else if (command.type === 'mute') controls?.mute();
      else if (command.type === 'interrupt') controls?.interrupt();
      else if (command.type === 'send') controls?.send();
      else if (command.type === 'cancel-exit') controls?.cancelExit();
      else if (command.type === 'resume') controls?.resume();
      else controls?.pause();
      return true;
    },
    [close],
  );
  useEffect(() => {
    const dispose = installVoiceCallHost(handleCommand);
    const removeCommands = window.electronAPI.voiceConversation.onCallCommand?.(handleCommand);
    return () => {
      removeCommands?.();
      dispose();
      publishRemote(null);
    };
  }, [handleCommand, publishRemote]);
  const phase = hosted?.phase;
  useEffect(() => {
    // Mount collapsed first, so the toolbar plays its normal entrance.
    if (phase === 'mounting') setHosted((value) => (value ? { ...value, phase: 'open' } : value));
    if (phase !== 'closing') return;
    const timer = setTimeout(() => {
      setHosted(null);
      publishVoiceCallStatus(null);
      publishRemote(null);
    }, SECTION_COLLAPSE_DURATION_MS + 50);
    return () => clearTimeout(timer);
  }, [phase, publishRemote]);
  const onStatus = useCallback(
    (status: VoiceCallStatus) => {
      publishVoiceCallStatus(status);
      publishRemote(status);
    },
    [publishRemote],
  );
  return hosted ? (
    <HostedVoiceCall
      key={`${hosted.bot.id}:${hosted.sessionId}`}
      bot={hosted.bot}
      sessionId={hosted.sessionId}
      open={hosted.phase === 'open'}
      controlsRef={controlsRef}
      onClose={close}
      onStatus={onStatus}
    />
  ) : null;
}

/** A window without the call's capture draws the same toolbar and forwards its operations. */
export function RemoteVoiceCallSurface() {
  const navigate = useNavigate();
  const status = useVoiceCallStatus();
  const slot = useVoiceCallSlot(status?.sessionId);
  const floating = useFloatingVoiceCallSlot();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const surface = slot?.element ?? floating;
  if (!status || !surface) return null;
  const { bot, sessionId } = status;
  const send = (type: Exclude<VoiceCallCommand['type'], 'start'>) =>
    void sendVoiceCallCommand({ type, sessionId } as VoiceCallCommand).catch(() => undefined);
  const openConversation = () => navigate(conversationPath(bot.id, sessionId));
  return createPortal(
    <SectionCollapse
      collapsed={!status.open}
      inert={!status.open}
      className="companion-voice-presence"
      innerClassName="companion-voice-presence-content"
    >
      <CompanionVoiceToolbar
        callOpen={status.open}
        bot={bot}
        state={status.state}
        loading={status.loading}
        blocked={status.blocked}
        questionPending={status.questionPending}
        questionElsewhere={status.questionElsewhere}
        configurationError={status.configurationError}
        titleRef={titleRef}
        onResume={() => send('resume')}
        onMute={() => send('mute')}
        onInterrupt={() => send('interrupt')}
        onSend={() => send('send')}
        onCancelExit={() => send('cancel-exit')}
        onClose={() => send('end')}
        onConfigure={() => navigate(settingsPath(bot.id, sessionId))}
        onOpenConversation={slot ? undefined : openConversation}
        onOpenTask={(clientId) => {
          if (slot) slot.openTask(clientId);
          else {
            openConversation();
            requestChatTaskFocus(sessionId, clientId);
          }
        }}
      />
    </SectionCollapse>,
    surface,
  );
}

/** Where the toolbar goes while the call's own task is not on screen in this window. */
export function VoiceCallFloatingSlot() {
  const summary = useVoiceCallSummary();
  const slot = useVoiceCallSlot(summary.sessionId);
  const setElement = useFloatingVoiceCallSlotElement();
  if (!summary.sessionId || slot) return null;
  return <div ref={setElement} className="companion-voice-floating-slot" data-no-drag />;
}

/** Marks this task page's composer as the place to draw the call of its task. */
export function VoiceCallComposerSlot({
  sessionId,
  questionBridge,
  openTask,
}: {
  sessionId: string;
  questionBridge: VoiceQuestionBridge;
  openTask(clientId: string): void;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const latestOpenTask = useRef(openTask);
  latestOpenTask.current = openTask;
  useEffect(() => {
    if (!element) return;
    return registerVoiceCallSlot(sessionId, {
      element,
      questionBridge,
      openTask: (clientId) => latestOpenTask.current(clientId),
    });
  }, [element, questionBridge, sessionId]);
  return <div ref={setElement} className="contents" />;
}
