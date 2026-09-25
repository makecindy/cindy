import { gzipSync, gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { VolcengineSaucAsrProvider } from '../VolcengineSaucAsrProvider.js';

// Opt-in local protocol benchmark. This is NOT a cloud recognition benchmark:
// transcript and network delays are controlled fixtures, not model outputs.
// CINDY_VOICE_AB_LOCAL=1 pnpm --dir apps/desktop exec vitest run --pool=threads
//   src/main/voice-input/__tests__/VolcengineSaucAsrProvider.ab.test.ts
it.skipIf(process.env.CINDY_VOICE_AB_LOCAL !== '1')(
  'compares identical buffered PCM through the production provider in ABBA order',
  async () => {
    const results: Array<{
      mode: string;
      server: string;
      firstTextMs: number;
      firstAudioMs: number;
    }> = [];
    const pcm = Buffer.alloc(1280);
    for (let i = 0; i < pcm.length / 2; i++)
      pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 4000), i * 2);
    for (const gateMs of [0, 1000]) {
      for (const early of [false, true, true, false, false, true, true, false]) {
        const server = new WebSocketServer({ port: 0 });
        const sockets: WebSocket[] = [];
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));
        let firstAudioMs = -1;
        let textAt = -1;
        let initAt = 0;
        let firstAudioSeen = false;
        let received: Buffer | undefined;
        let provider: VolcengineSaucAsrProvider | undefined;
        const startedAt = performance.now();
        server.on('connection', (socket) => {
          sockets.push(socket);
          socket.on('message', (raw) => {
            const packet = Buffer.from(raw as Buffer);
            // Simulate a 250 ms uplink and a 250 ms downlink independently.
            later(() => {
              if (packet[1] >> 4 === 1) {
                initAt = performance.now();
                later(() => socket.send(Buffer.from([0x11, 0xb0, 0x10, 0, 0, 0, 0, 0])), 250);
              } else if (!firstAudioSeen) {
                firstAudioSeen = true;
                firstAudioMs = performance.now() - startedAt;
                const body = packet.subarray(12);
                received = (packet[2] & 0xf) === 1 ? gunzipSync(body) : body;
                // Compare an immediately available server with one that cannot
                // process audio until its own initialization has finished.
                const remainingGate = Math.max(0, initAt + gateMs - performance.now());
                later(
                  () => {
                    const body = gzipSync(
                      Buffer.from(JSON.stringify({ result: { text: 'fixed protocol fixture' } })),
                    );
                    const size = Buffer.alloc(4);
                    size.writeUInt32BE(body.length);
                    socket.send(Buffer.concat([Buffer.from([0x11, 0x90, 0x11, 0]), size, body]));
                  },
                  remainingGate + 200 + 250,
                );
              }
            }, 250);
          });
        });
        try {
          await new Promise<void>((resolve) => server.once('listening', resolve));
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Missing test server');
          provider = new VolcengineSaucAsrProvider({
            baseUrl: `http://127.0.0.1:${address.port}`,
            endpointPath: '/asr',
            proxyApiKey: 'invalid-test-only',
            resourceId: 'test',
            sendAudioBeforeAck: early,
          });
          const transcript = new Promise<string>((resolve, reject) => {
            later(() => reject(new Error('Benchmark timed out')), 4000);
            provider!.onEvent((event) => {
              if (event.type === 'error') reject(new Error(event.message));
              if (event.type === 'partial') {
                textAt = performance.now() - startedAt;
                resolve(event.text);
              }
            });
          });
          await provider.start();
          // Identical pre-captured PCM, same chunking and order in both modes.
          for (let i = 0; i < 2; i++) {
            provider.appendAudio(
              pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length) as ArrayBuffer,
            );
          }
          expect(await transcript).toBe('fixed protocol fixture');
          expect(received).toEqual(pcm);
          results.push({
            mode: early ? 'early' : 'wait-ack',
            server: gateMs ? 'initialization-gated' : 'ready',
            firstTextMs: Math.round(textAt),
            firstAudioMs: Math.round(firstAudioMs),
          });
        } finally {
          timers.forEach(clearTimeout);
          await provider?.stop();
          sockets.forEach((socket) => socket.terminate());
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }
    const summary = ['ready', 'initialization-gated'].map((server) => {
      const mean = (mode: string) => {
        const selected = results.filter((r) => r.server === server && r.mode === mode);
        return Math.round(selected.reduce((sum, r) => sum + r.firstTextMs, 0) / selected.length);
      };
      return {
        server,
        waitAckMs: mean('wait-ack'),
        earlyMs: mean('early'),
        savedMs: mean('wait-ack') - mean('early'),
      };
    });
    const report = {
      kind: 'LOCAL_SIMULATION_NOT_CLOUD',
      assumptions: { oneWayNetworkMs: 250, inferenceMs: 200 },
      results,
      summary,
    };
    const output = process.env.CINDY_VOICE_AB_REPORT;
    if (output) writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  },
  40_000,
);
