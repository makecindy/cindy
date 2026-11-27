import { RealtimeProtocolAdapter } from './realtimeProtocol.js';
import type WebSocket from 'ws';
import type { RealtimeConnection } from './realtimeModels.js';
import { connectRealtimeSocket } from './realtimeSocket.js';
import { SpeechError } from './speechError.js';

const SAMPLE_RATE = 24_000;
const MAX_BYTES = SAMPLE_RATE * 2 * 60;

/** One text turn on the selected realtime model. No audio input or companion context. */
export class RealtimeVoicePreview {
  private socket?: WebSocket;
  private reader?: ReadableStreamDefaultReader<ArrayBuffer>;
  private first?: ArrayBuffer;

  constructor(
    private readonly binding: RealtimeConnection,
    private readonly model: string,
    private readonly assertCurrent: () => void,
  ) {}

  async start({ voice, text }: { voice: string; text: string }) {
    const adapter = new RealtimeProtocolAdapter(this.binding.protocol);
    const socket = await connectRealtimeSocket(this.binding, this.assertCurrent);
    this.socket = socket;
    let received = 0;
    let requested = false;
    let ended = false;
    const stream = new ReadableStream<ArrayBuffer>({
      start: (controller) => {
        const finish = (error?: SpeechError) => {
          if (ended) return;
          ended = true;
          if (error) controller.error(error);
          else controller.close();
          socket.terminate();
        };
        const send = (event: object) => {
          this.assertCurrent();
          socket.send(adapter.encode(event));
        };
        socket.on('error', () => finish(new SpeechError('request')));
        socket.on('close', () => finish(new SpeechError('request')));
        socket.once('open', () => {
          try {
            send(adapter.start({ kind: 'preview', model: this.model, voice }));
          } catch {
            finish(new SpeechError('unavailable'));
          }
        });
        socket.on('message', (raw) => {
          if (ended) return;
          try {
            this.assertCurrent();
            const event = adapter.decode(raw.toString());
            if (event.type === 'session.updated' && !requested) {
              requested = true;
              send({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [
                    {
                      type: 'input_text',
                      text: 'Read this sample aloud exactly as written: ' + text,
                    },
                  ],
                },
              });
              send({ type: 'response.create' });
            } else if (
              requested &&
              event.type === 'response.audio.delta'
            ) {
              if (typeof event.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.delta))
                throw new Error('invalid_audio');
              const pcm = Buffer.from(event.delta, 'base64');
              received += pcm.length;
              if (!pcm.length || pcm.length % 2 || received > MAX_BYTES)
                throw new Error('invalid_audio');
              controller.enqueue(Uint8Array.from(pcm).buffer);
            } else if (event.type === 'response.done') {
              finish(
                received && event.response?.status === 'completed'
                  ? undefined
                  : new SpeechError('request'),
              );
            } else if (event.type === 'error') {
              finish(new SpeechError('request'));
            }
          } catch {
            finish(new SpeechError('request'));
          }
        });
      },
      cancel: () => {
        ended = true;
        socket.terminate();
      },
    });
    this.reader = stream.getReader();
    const first = await this.reader.read();
    this.assertCurrent();
    if (first.done) throw new SpeechError('cancelled');
    this.first = first.value;
    return { sampleRate: SAMPLE_RATE };
  }

  async read() {
    this.assertCurrent();
    if (this.first) {
      const pcm = this.first;
      this.first = undefined;
      return { pcm, done: false };
    }
    if (!this.reader) throw new SpeechError('cancelled');
    const { value, done } = await this.reader.read();
    this.assertCurrent();
    return { pcm: value ?? new ArrayBuffer(0), done };
  }

  cancel() {
    this.first = undefined;
    void this.reader?.cancel().catch(() => undefined);
    this.socket?.terminate();
  }
}
