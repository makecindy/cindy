import { VoiceConversationInput, type AsrProvider, type AudioTrace } from '@cindy/voice-input-core';
import type {
  VoiceConversationEvent,
  VoiceConversationModel,
  VoiceConversationStart,
} from '../../shared/voiceConversation.js';
import { acquireVoiceConversationLease, releaseVoiceConversationLease } from './lease.js';
import { SpeechSynthesisSession, type SpeechConnection } from './speech.js';

type Call = {
  id: string;
  sender: number;
  owner: string;
  input: VoiceConversationInput;
  speech: SpeechSynthesisSession;
  selection: VoiceConversationStart;
};

/** One local call owns the microphone. Cancellation invalidates all pending starts and audio reads. */
export class VoiceConversationService {
  private call: Call | null = null;

  constructor(
    private readonly deps: {
      owner(): string;
      hasDictation(): boolean;
      assertCompanion(botId: string, sessionId: string): Promise<void>;
      models(): VoiceConversationModel[];
      createProvider(): Promise<AsrProvider>;
      connection(): SpeechConnection;
      fetch: typeof fetch;
      emit(sender: number, event: VoiceConversationEvent): void;
    },
  ) {}

  models(): VoiceConversationModel[] {
    return this.deps.models();
  }

  async start(sender: number, selection: VoiceConversationStart): Promise<{ callId: string }> {
    if (this.call || this.deps.hasDictation()) throw new Error('busy');
    if (!this.models().some((model) => model.id === selection.modelId))
      throw new Error('model_unavailable');
    const id = selection.callId;
    const owner = this.deps.owner();
    if (!acquireVoiceConversationLease(id)) throw new Error('busy');
    const assertCurrent = (): void => {
      if (this.call?.id !== id || this.deps.owner() !== owner) throw new Error('call_ended');
    };
    const input = new VoiceConversationInput({
      createProvider: async () => {
        assertCurrent();
        return this.deps.createProvider();
      },
      emit: (event) => {
        if (this.call?.id !== id) return;
        if (this.deps.owner() !== owner) {
          void this.end(sender, id);
          return;
        }
        this.deps.emit(sender, { callId: id, event });
        if (event.type === 'error') void this.end(sender, id);
      },
    });
    const speech = new SpeechSynthesisSession({
      connection: this.deps.connection,
      fetch: this.deps.fetch,
      assertCurrent: () => {
        assertCurrent();
        if (!this.models().some((model) => model.id === selection.modelId))
          throw new Error('model_unavailable');
      },
    });
    this.call = { id, owner, sender, selection, input, speech };
    try {
      await this.deps.assertCompanion(selection.botId, selection.sessionId);
      assertCurrent();
      await input.start();
      assertCurrent();
      return { callId: id };
    } catch (error) {
      await this.end(sender, id);
      throw error;
    }
  }

  audio(sender: number, id: string, pcm: ArrayBuffer, trace?: AudioTrace): void {
    this.requireCall(sender, id).input.appendAudio(pcm, trace);
  }

  finishUtterance(sender: number, id: string): void {
    this.requireCall(sender, id).input.finishUtterance(true);
  }

  async speak(
    sender: number,
    id: string,
    requestId: string,
    text: string,
  ): Promise<{ sampleRate: number }> {
    const call = this.requireCall(sender, id);
    return call.speech.start({
      requestId,
      text,
      modelId: call.selection.modelId,
      voice: call.selection.voice,
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

  async end(sender: number, id?: string): Promise<void> {
    const call = this.call;
    if (!call || call.sender !== sender || (id && call.id !== id)) return;
    this.call = null;
    this.deps.emit(call.sender, { callId: call.id, event: { type: 'ended' } });
    call.speech.cancel();
    try {
      await call.input.stop();
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
