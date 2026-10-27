export type MobileVoiceConversationState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'processing'
  | 'sending'
  | 'waiting'
  | 'speaking'
  | 'paused';

export type MobileVoiceConversationReply = { id: string; text: string };

export type MobileVoiceConversationOptions = {
  startListening(): Promise<void>;
  /** Must stop microphone capture before resolving with the final transcript. */
  finishListening(): Promise<string | null>;
  cancelListening(): void | Promise<void>;
  /** Reject if delivery fails; resolving means the message was accepted. */
  send(text: string): Promise<void>;
  /** Resolve on playback completion, not when playback is queued. */
  speak(text: string): Promise<void>;
  stopSpeaking(): void | Promise<void>;
  onStateChanged?(state: MobileVoiceConversationState): void;
  onError?(error: unknown): void;
};

export type MobileVoiceConversation = {
  begin(options?: { waiting?: boolean; initialDraft?: string }): Promise<void>;
  submit(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  pause(error?: unknown): Promise<void>;
  onTranscriptChanged(text: string): void;
  /** Supply only the completed assistant reply associated with this voice turn. */
  onReply(reply: MobileVoiceConversationReply): Promise<void>;
  getState(): MobileVoiceConversationState;
  currentDraft(): string;
};

const TRANSCRIPT_PAUSE_MS = 1_800;
const NO_SPEECH_TIMEOUT_MS = 30_000;

/**
 * Foreground-only turn orchestration. The screen owns ASR, reply association,
 * navigation and TTS; this controller keeps capture and playback mutually
 * exclusive, and invalidates pending work when that screen loses ownership.
 */
export function createMobileVoiceConversation(
  options: MobileVoiceConversationOptions,
): MobileVoiceConversation {
  let state: MobileVoiceConversationState = 'idle';
  let draft = '';
  let generation = 0;
  let disposed = false;
  let heardSpeech = false;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
  let listeningWork: Promise<void> | undefined;
  let cleanupWork: Promise<void> = Promise.resolve();
  let queuedReply: MobileVoiceConversationReply | undefined;
  const spokenReplyIds = new Set<string>();

  const isCurrent = (run: number) => !disposed && generation === run;
  const changeState = (next: MobileVoiceConversationState) => {
    if (state === next) return;
    state = next;
    options.onStateChanged?.(next);
  };
  const clearTimers = () => {
    clearTimeout(silenceTimer);
    clearTimeout(noSpeechTimer);
    silenceTimer = undefined;
    noSpeechTimer = undefined;
  };
  // Stop both resources even if one adapter throws. Starting the next capture
  // waits for this release and all previous capture operations to settle.
  const release = () => {
    const preceding = cleanupWork;
    cleanupWork = (async () => {
      await preceding;
      await Promise.allSettled([
        Promise.resolve().then(() => options.cancelListening()),
        Promise.resolve().then(() => options.stopSpeaking()),
      ]);
    })();
    return cleanupWork;
  };

  const end = async (next: 'idle' | 'paused', error?: unknown) => {
    generation += 1;
    clearTimers();
    queuedReply = undefined;
    changeState(next);
    if (error !== undefined) options.onError?.(error);
    await release();
  };

  const armNoSpeechTimeout = (run: number) => {
    clearTimeout(noSpeechTimer);
    noSpeechTimer = setTimeout(() => {
      if (isCurrent(run) && !heardSpeech && (state === 'starting' || state === 'listening')) {
        void end('idle');
      }
    }, NO_SPEECH_TIMEOUT_MS);
  };

  const armTranscriptPause = (run: number) => {
    clearTimeout(silenceTimer);
    if (!heardSpeech || !draft.trim() || state !== 'listening') return;
    silenceTimer = setTimeout(() => {
      if (isCurrent(run) && state === 'listening') void submit();
    }, TRANSCRIPT_PAUSE_MS);
  };

  const openListening = async (run: number) => {
    const preceding = listeningWork;
    clearTimers();
    heardSpeech = false;
    changeState('starting');
    armNoSpeechTimeout(run);
    const operation = (async () => {
      await preceding;
      await cleanupWork;
      if (!isCurrent(run)) return;
      try {
        await options.startListening();
        if (!isCurrent(run)) {
          // A native start can complete after cancellation. Release again before
          // another begin is allowed to acquire the microphone.
          await release();
          return;
        }
        changeState('listening');
        armTranscriptPause(run);
      } catch (error) {
        if (isCurrent(run)) await end('paused', error);
        else await release();
      }
    })();
    listeningWork = operation;
    await operation;
    if (listeningWork === operation) listeningWork = undefined;
  };

  const playReply = async (reply: MobileVoiceConversationReply, run: number) => {
    if (!isCurrent(run) || state !== 'waiting') return;
    spokenReplyIds.add(reply.id);
    changeState('speaking');
    try {
      await options.speak(reply.text.trim());
      if (!isCurrent(run)) return;
      draft = '';
      await openListening(run);
    } catch (error) {
      if (isCurrent(run)) await end('paused', error);
    }
  };

  async function submit(): Promise<void> {
    const run = generation;
    if (disposed) return;
    if (state === 'starting') await listeningWork;
    if (!isCurrent(run) || state !== 'listening') return;
    clearTimers();
    changeState('processing');
    let finalText: string | null = null;
    const operation = (async () => {
      try {
        finalText = await options.finishListening();
      } catch (error) {
        if (isCurrent(run)) await end('paused', error);
      }
    })();
    listeningWork = operation;
    await operation;
    if (listeningWork === operation) listeningWork = undefined;
    if (!isCurrent(run)) return;
    const text = (finalText as string | null)?.trim();
    if (!text) {
      // Keep any previously recognized draft available for manual correction.
      await end('paused');
      return;
    }
    draft = text;
    changeState('sending');
    try {
      await options.send(text);
      if (!isCurrent(run)) return;
      changeState('waiting');
      const reply = queuedReply;
      queuedReply = undefined;
      if (reply) await playReply(reply, run);
    } catch (error) {
      if (isCurrent(run)) await end('paused', error);
    }
  }

  return {
    async begin(input = {}) {
      if (disposed || (state !== 'idle' && state !== 'paused')) return;
      const run = ++generation;
      draft = input.initialDraft ?? '';
      queuedReply = undefined;
      if (input.waiting) {
        changeState('starting');
        await listeningWork;
        await cleanupWork;
        if (isCurrent(run)) changeState('waiting');
      } else {
        await openListening(run);
      }
    },
    submit,
    stop: () => end('idle'),
    async dispose() {
      const pendingCapture = listeningWork;
      disposed = true;
      await end('idle');
      // A replacement screen must not acquire capture until a late native start
      // has completed its second cancellation. Do not wait for network delivery.
      await pendingCapture;
      await cleanupWork;
    },
    pause: (error) => disposed || state === 'idle' || state === 'paused'
      ? Promise.resolve()
      : end('paused', error),
    onTranscriptChanged(text) {
      if (disposed || (state !== 'starting' && state !== 'listening') || text === draft) return;
      draft = text;
      heardSpeech = text.trim().length > 0;
      if (heardSpeech) clearTimeout(noSpeechTimer);
      else armNoSpeechTimeout(generation);
      armTranscriptPause(generation);
    },
    async onReply(reply) {
      if (disposed || !reply.id || !reply.text.trim() || spokenReplyIds.has(reply.id)) return;
      if (state === 'sending') {
        queuedReply ??= reply;
      } else if (state === 'waiting') {
        await playReply(reply, generation);
      }
    },
    getState: () => state,
    currentDraft: () => draft,
  };
}
