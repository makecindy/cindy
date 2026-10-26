import type { CompanionCallDialogue } from './dialogue.js';
import {
  VoiceConversationInput,
  type AsrProvider,
  type AudioGate,
  type AudioTrace,
} from '@cindy/voice-input-core';
import {
  voiceModelKey,
  type SpeechModelSelection,
  type SpeechPreviewStart,
  type SpeechVoiceCatalog,
  type SpeechStartResult,
  type SpeechAudioResult,
  type VoiceExitDecision,
} from '../../shared/voiceConversation.js';
import type {
  VoiceConversationEvent,
  VoiceConversationModel,
  VoiceConversationStart,
} from '../../shared/voiceConversation.js';
import { acquireVoiceConversationLease, releaseVoiceConversationLease } from './lease.js';
import { SpeechSynthesisSession, type SpeechConnection } from './speech.js';
import { SpeechSynthesisQueue } from './speechQueue.js';
import { loadSpeechVoices } from './voices.js';
import type { Logger } from '../logger.js';
import type { VoiceExitClassification } from './semanticExit.js';
import { SEMANTIC_VOICE_EXIT_MAX_CHARACTERS } from './semanticExitConfig.js';

type Call = {
  id: string;
  kind: 'conversation' | 'playback';
  sender: number;
  owner: string;
  input: VoiceConversationInput | null;
  inputGeneration: number;
  inputTeardown: Promise<unknown>;
  inputReady: Promise<void>;
  speech: SpeechSynthesisQueue;
  selection: VoiceConversationStart;
  exitUtterance: { id: string; text: string } | null;
  exitJudgment: AbortController | null;
  dialogue?: CompanionCallDialogue;
};
type Preview = {
  id: string;
  sender: number;
  owner: string;
  speech: SpeechSynthesisSession;
  timer?: ReturnType<typeof setTimeout>;
};

/** One local call or message playback owns the voice lease. Cancellation invalidates pending work. */
export class VoiceConversationService {
  private call: Call | null = null;
  private preview: Preview | null = null;

  constructor(
    private readonly deps: {
      owner(): string;
      hasDictation(): boolean;
      assertCompanion(botId: string, sessionId: string): Promise<void>;
      models(): VoiceConversationModel[];
      createDialogue?(selection: VoiceConversationStart, emit: (record: import("@cindy/maker-core").VoiceCallRecord) => void): CompanionCallDialogue;
      createProvider(): Promise<AsrProvider>;
      createAudioGate?(): AudioGate | undefined;
      connection(selection: SpeechModelSelection): SpeechConnection;
      fetch: typeof fetch;
      hasReplyHook?(): boolean;
      classifyExit?(input: VoiceExitClassification): Promise<VoiceExitDecision>;
      emit(sender: number, event: VoiceConversationEvent): void;
      log?: Pick<Logger, 'debug' | 'info' | 'warn'>;
    },
  ) {}

  models(): VoiceConversationModel[] {
    return this.deps.models();
  }

  async voices(selection: SpeechModelSelection): Promise<SpeechVoiceCatalog> {
    const owner = this.deps.owner();
    const connection = this.deps.connection(selection);
    const identity = JSON.stringify(connection);
    return loadSpeechVoices(
      connection,
      selection.modelId,
      this.deps.fetch,
      () => {
        if (
          this.deps.owner() !== owner ||
          JSON.stringify(this.deps.connection(selection)) !== identity
        )
          throw new Error('connection_changed');
      },
      selection.providerId ?? 'xd',
    );
  }

  /** Preview uses the exact synthesis adapter without starting ASR or submitting a task. */
  async startPreview(
    sender: number,
    selection: SpeechPreviewStart,
  ): Promise<SpeechAudioResult> {
    if (this.call || this.preview || this.deps.hasDictation()) throw new Error('busy');
    if (!this.models().some((model) => voiceModelKey(model) === voiceModelKey(selection)))
      throw new Error('model_unavailable');
    const binding = this.deps.connection(selection);
    const identity = JSON.stringify(binding);
    const owner = this.deps.owner();
    if (!acquireVoiceConversationLease(selection.previewId)) throw new Error('busy');
    const preview: Preview = {
      id: selection.previewId,
      sender,
      owner,
      speech: new SpeechSynthesisSession({
        diagnostic: (event) =>
          this.deps.log?.[event.stage === 'error' ? 'warn' : 'info']('speech transport', {
            previewId: selection.previewId,
            ...event,
          }),
        connection: () => binding,
        fetch: this.deps.fetch,
        assertCurrent: () => {
          if (
            this.preview !== preview ||
            this.deps.owner() !== owner ||
            JSON.stringify(this.deps.connection(selection)) !== identity
          )
            throw new Error('preview_ended');
        },
      }),
    };
    this.preview = preview;
    // A crashed/hidden renderer must not retain the global voice lease indefinitely.
    preview.timer = setTimeout(() => this.stopPreview(sender, preview.id), 60_000);
    try {
      await this.deps.assertCompanion(selection.botId, selection.sessionId);
      return await preview.speech.start({
        requestId: preview.id,
        modelId: selection.modelId,
        voice: selection.voice,
        speed: selection.speed,
        text: selection.text,
      });
    } catch (error) {
      if (this.preview === preview) this.stopPreview(sender, preview.id);
      throw error;
    }
  }

  async readPreview(sender: number, id: string): Promise<{ pcm: ArrayBuffer; done: boolean }> {
    const preview = this.preview;
    if (!preview || preview.sender !== sender || preview.id !== id)
      throw new Error('preview_ended');
    try {
      if (preview.owner !== this.deps.owner()) throw new Error('preview_ended');
      return await preview.speech.read(id);
    } catch (error) {
      if (this.preview === preview) this.stopPreview(sender, id);
      throw error;
    }
  }

  stopPreview(sender: number, id?: string): void {
    const preview = this.preview;
    if (!preview || preview.sender !== sender || (id && preview.id !== id)) return;
    this.preview = null;
    clearTimeout(preview.timer);
    preview.speech.cancel();
    releaseVoiceConversationLease(preview.id);
  }

  async start(sender: number, selection: VoiceConversationStart): Promise<{ callId: string }> {
    return this.open(sender, selection, 'conversation');
  }

  async startPlayback(
    sender: number,
    selection: VoiceConversationStart,
  ): Promise<{ callId: string }> {
    return this.open(sender, selection, 'playback');
  }

  private async open(
    sender: number,
    selection: VoiceConversationStart,
    kind: Call['kind'],
  ): Promise<{ callId: string }> {
    if (this.call || this.preview || this.deps.hasDictation()) throw new Error('busy');
    if (!this.models().some((model) => voiceModelKey(model) === voiceModelKey(selection)))
      throw new Error('model_unavailable');
    const binding = this.deps.connection(selection);
    const bindingIdentity = JSON.stringify(binding);
    const id = selection.callId;
    const owner = this.deps.owner();
    if (!acquireVoiceConversationLease(id)) throw new Error('busy');
    const assertCurrent = (): void => {
      if (this.call?.id !== id || this.deps.owner() !== owner) throw new Error('call_ended');
    };
    const speech = new SpeechSynthesisQueue(
      () =>
        new SpeechSynthesisSession({
          diagnostic: (event) =>
            this.deps.log?.[event.stage === 'error' ? 'warn' : 'info']('speech transport', {
              callId: id,
              ...event,
            }),
          connection: () => binding,
          fetch: this.deps.fetch,
          assertCurrent: () => {
            assertCurrent();
            // Resolving the selected binding rechecks its current catalog, route and key.
            if (JSON.stringify(this.deps.connection(selection)) !== bindingIdentity)
              throw new Error('connection_changed');
          },
        }),
    );
    const call: Call = {
      id,
      kind,
      owner,
      sender,
      selection,
      exitUtterance: null,
      exitJudgment: null,
      speech,
      input: null,
      inputGeneration: 0,
      inputTeardown: Promise.resolve(),
      inputReady: Promise.resolve(),
    };
    this.call = call;
    const startedAt = Date.now();
    let stage: 'companion' | 'call_record' | 'input' = 'companion';
    this.deps.log?.info('call starting', { callId: id, kind, protocol: binding.protocol });
    try {
      await this.deps.assertCompanion(selection.botId, selection.sessionId);
      assertCurrent();
      if (kind === 'conversation') {
        stage = 'call_record';
        call.dialogue = this.deps.createDialogue?.(selection, record => {
          if (call.owner === this.deps.owner()) this.deps.emit(sender, { callId: id, event: { type: 'call-record', record } });
        });
        await call.dialogue?.start();
        assertCurrent();
        stage = 'input';
        const input = this.createInput(call);
        call.input = input;
        call.inputReady = input.start();
        await call.inputReady;
      }
      assertCurrent();
      this.deps.log?.info('call ready', { callId: id, elapsedMs: Date.now() - startedAt });
      return { callId: id };
    } catch (error) {
      this.deps.log?.warn('call start failed', { callId: id, stage, elapsedMs: Date.now() - startedAt });
      await this.end(sender, id);
      throw error;
    }
  }

  private createInput(call: Call): VoiceConversationInput {
    const inputGeneration = call.inputGeneration;
    const current = () => this.call === call && call.inputGeneration === inputGeneration;
    const audioGate = this.deps.createAudioGate?.();
    this.deps.log?.info('input filter configured', {
      callId: call.id,
      inputGeneration,
      speakerFilterActive: Boolean(audioGate),
    });
    return new VoiceConversationInput({
      audioGate,
      isCurrent: () => current() && this.deps.owner() === call.owner,
      diagnostic: (event) =>
        this.deps.log?.info('input settled', { callId: call.id, inputGeneration, ...event }),
      blockedDiagnostic: (event) =>
        this.deps.log?.debug('input settlement blocked', { callId: call.id, inputGeneration, ...event }),
      failureDiagnostic: (event) =>
        this.deps.log?.warn('input failed', { callId: call.id, inputGeneration, ...event }),
      createProvider: async () => {
        this.requireCall(call.sender, call.id);
        if (!current()) throw new Error('input_ended');
        return this.deps.createProvider();
      },
      emit: (event) => {
        if (!current()) return;
        if (this.deps.owner() !== call.owner) {
          void this.end(call.sender, call.id);
          return;
        }
        if (
          event.type === 'speech-started' ||
          (event.type === 'draft' && event.text.trim()) ||
          event.type === 'utterance'
        ) {
          this.cancelExitJudgment(call);
          // Only the most recent ASR final is eligible, once. The renderer
          // supplies its ID, never an arbitrary prompt or a provider route.
          if (event.type === 'utterance' && event.text.length <= SEMANTIC_VOICE_EXIT_MAX_CHARACTERS)
            call.exitUtterance = { id: event.id, text: event.text };
        }
        if (event.type !== 'draft')
          this.deps.log?.[event.type === 'error' ? 'warn' : 'info']('input event', {
            callId: call.id,
            inputGeneration,
            event: event.type,
            ...(event.type === 'utterance'
              ? { utteranceId: event.id, characters: event.text.length }
              : {}),
          });
        this.deps.emit(call.sender, { callId: call.id, inputGeneration, event });
        // The renderer decides whether a capture failure ends the call. A failed
        // unmute must leave an already playing reply and its TTS transport alive.
        if (event.type === 'error') void this.stopInput(call);
      },
    });
  }

  private async stopInput(call: Call): Promise<void> {
    this.cancelExitJudgment(call);
    const input = call.input;
    call.input = null;
    ++call.inputGeneration;
    // stop() invalidates the input immediately and disposes a late allocation
    // when it arrives. Do not block End on an outstanding provider dial.
    call.inputTeardown = Promise.allSettled([call.inputTeardown, input?.stop()]);
    await call.inputTeardown;
  }

  /** Keep the call, reply ownership and synthesis queue while releasing only ASR. */
  async setInputMuted(
    sender: number,
    id: string,
    muted: boolean,
  ): Promise<{ inputGeneration: number }> {
    const call = this.requireCall(sender, id);
    if (call.kind !== 'conversation') throw new Error('playback_only');
    const startedAt = Date.now();
    if (muted) {
      await this.stopInput(call);
    } else if (call.input) {
      await call.inputReady;
    } else {
      ++call.inputGeneration;
      const input = this.createInput(call);
      call.input = input;
      call.inputReady = (async () => {
        await call.inputTeardown;
        if (this.call !== call || call.input !== input) throw new Error('input_ended');
        await input.start();
        if (this.call !== call || call.input !== input) throw new Error('input_ended');
      })();
      try {
        await call.inputReady;
      } catch (error) {
        if (call.input === input) await this.stopInput(call);
        throw error;
      }
    }
    this.requireCall(sender, id);
    this.deps.log?.info('input mute changed', {
      callId: id,
      muted,
      inputGeneration: call.inputGeneration,
      elapsedMs: Date.now() - startedAt,
    });
    return { inputGeneration: call.inputGeneration };
  }

  audio(
    sender: number,
    id: string,
    pcm: ArrayBuffer,
    trace?: AudioTrace,
    inputGeneration = 0,
  ): void {
    const call = this.requireCall(sender, id);
    if (inputGeneration === call.inputGeneration) call.input?.appendAudio(pcm, trace);
  }

  finishUtterance(sender: number, id: string): void {
    this.requireCall(sender, id).input?.finishUtterance(true);
  }

  private cancelExitJudgment(call: Call): void {
    call.exitUtterance = null;
    call.exitJudgment?.abort();
    call.exitJudgment = null;
  }

  async classifyExit(
    sender: number,
    id: string,
    utteranceId: string,
    inputGeneration: number,
  ): Promise<VoiceExitDecision> {
    const call = this.requireCall(sender, id);
    const utterance = call.exitUtterance;
    if (
      call.kind !== 'conversation' ||
      !call.input ||
      call.inputGeneration !== inputGeneration ||
      !utterance ||
      utterance.id !== utteranceId ||
      !this.deps.classifyExit
    )
      return false;
    this.cancelExitJudgment(call);
    const judgment = new AbortController();
    call.exitJudgment = judgment;
    const isCurrent = () =>
      this.call === call &&
      call.exitJudgment === judgment &&
      !judgment.signal.aborted &&
      call.input !== null &&
      call.inputGeneration === inputGeneration &&
      this.deps.owner() === call.owner;
    try {
      const shouldExit = await this.deps.classifyExit({
        callId: id,
        botId: call.selection.botId,
        sessionId: call.selection.sessionId,
        text: utterance.text,
        signal: judgment.signal,
        isCurrent,
      });
      // Fail open on unknown results; never treat a nonempty payload as EXIT.
      return isCurrent() && (shouldExit === true || shouldExit === 'submit_then_exit')
        ? shouldExit
        : false;
    } catch {
      return false;
    } finally {
      if (call.exitJudgment === judgment) call.exitJudgment = null;
    }
  }

  async speak(
    sender: number,
    id: string,
    requestId: string,
    text: string,
    streaming = false,
  ): Promise<SpeechStartResult> {
    const call = this.requireCall(sender, id);
    // The pending UI flag is set only after done. Check the actual hook before
    // every incremental request so unprocessed text never bypasses that boundary.
    if (streaming && (this.deps.hasReplyHook?.() ?? true)) {
      this.deps.log?.info('speech deferred', { callId: id, requestId, reason: 'reply_hook' });
      return { deferred: true };
    }
    return call.speech.start({
      requestId,
      text,
      modelId: call.selection.modelId,
      voice: call.selection.voice,
      speed: call.selection.speed,
    });
  }

  readSpeech(
    sender: number,
    id: string,
    requestId: string,
  ): Promise<{ pcm: ArrayBuffer; done: boolean }> {
    return this.requireCall(sender, id).speech.read(requestId);
  }

  interrupt(sender: number, id: string): void {
    this.requireCall(sender, id).speech.cancel();
  }

  async promoteTurn(sender: number, id: string, inputId: string): Promise<boolean> {
    return this.requireCall(sender, id).dialogue?.promote(inputId) ?? false;
  }

  async submitTurn(sender: number, id: string, inputId: string, text: string, forceHandoff: boolean): Promise<boolean> {
    const call = this.requireCall(sender, id);
    if (!call.dialogue || call.kind !== "conversation") return false;
    return call.dialogue.submit(inputId, text, forceHandoff);
  }

  async end(sender: number, id?: string): Promise<void> {
    if (!id) this.stopPreview(sender);
    const call = this.call;
    if (!call || call.sender !== sender || (id && call.id !== id)) return;
    this.call = null;
    this.deps.log?.info('call ended', { callId: call.id });
    this.deps.emit(call.sender, { callId: call.id, event: { type: 'ended' } });
    call.speech.cancel();
    const dialogueClosed = call.dialogue?.end();
    try {
      await this.stopInput(call);
      await dialogueClosed;
    } catch {
      /* Ownership release must survive provider teardown. */
    } finally {
      releaseVoiceConversationLease(call.id);
    }
  }

  private requireCall(sender: number, id: string): Call {
    const call = this.call;
    if (!call || call.sender !== sender || call.id !== id) throw new Error('call_ended');
    if (call.owner !== this.deps.owner()) {
      void this.end(sender, id);
      throw new Error('call_ended');
    }
    return call;
  }
}
