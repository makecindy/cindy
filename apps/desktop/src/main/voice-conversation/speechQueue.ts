import { SpeechSynthesisSession } from './speech.js';
import { SpeechError } from './speechError.js';
import type { SpeechAudioResult } from '../../shared/voiceConversation.js';

/** Two independent transports: the playing segment and at most one lookahead.
 * Readers still apply backpressure; cancellation revokes both, including pending headers.
 * Preview continues to use a single SpeechSynthesisSession.
 */
export class SpeechSynthesisQueue {
  private sessions = new Map<string, SpeechSynthesisSession>();

  constructor(private readonly create: () => SpeechSynthesisSession) {}

  async start(
    input: Parameters<SpeechSynthesisSession['start']>[0],
  ): Promise<SpeechAudioResult> {
    if (this.sessions.has(input.requestId) || this.sessions.size >= 2)
      throw new SpeechError('request');
    const session = this.create();
    this.sessions.set(input.requestId, session);
    try {
      const result = await session.start(input);
      // Encoded audio has reached EOF during prefetch; there is no PCM reader
      // to drain later. Only release this session, never a replacement request.
      if ('format' in result && this.sessions.get(input.requestId) === session) {
        this.sessions.delete(input.requestId);
        session.cancel();
      }
      return result;
    } catch (error) {
      if (this.sessions.get(input.requestId) === session) this.sessions.delete(input.requestId);
      session.cancel();
      throw error;
    }
  }

  async read(requestId: string): Promise<{ pcm: ArrayBuffer; done: boolean }> {
    const session = this.sessions.get(requestId);
    if (!session) throw new SpeechError('cancelled');
    try {
      const chunk = await session.read(requestId);
      if (chunk.done && this.sessions.get(requestId) === session) this.sessions.delete(requestId);
      return chunk;
    } catch (error) {
      // Authorization/route failures invalidate the lookahead as well as playback.
      // Do not let a late old read cancel a new generation reusing the same queue.
      if (this.sessions.get(requestId) === session) this.cancel();
      throw error;
    }
  }

  cancel(): void {
    for (const session of this.sessions.values()) session.cancel();
    this.sessions.clear();
  }
}
