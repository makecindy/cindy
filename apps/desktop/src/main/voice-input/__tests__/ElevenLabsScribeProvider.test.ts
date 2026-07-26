import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import {
  buildElevenLabsScribeRealtimeUrl,
  composeScribeTranscript,
  ElevenLabsScribeProvider,
} from '../ElevenLabsScribeProvider.js';

describe('ElevenLabsScribeProvider helpers', () => {
  it('builds the Scribe realtime websocket URL with VAD and language settings', () => {
    const url = new URL(buildElevenLabsScribeRealtimeUrl({
      baseUrl: 'https://api.elevenlabs.io/',
      sourceLanguage: 'zh-CN',
      vadSilenceThresholdSecs: 1.5,
    }));

    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v1/speech-to-text/realtime');
    expect(url.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(url.searchParams.get('audio_format')).toBe('pcm_16000');
    expect(url.searchParams.get('commit_strategy')).toBe('vad');
    expect(url.searchParams.get('language_code')).toBe('zho');
    expect(url.searchParams.get('vad_silence_threshold_secs')).toBe('1.50');
  });

  it('composes committed text and mutable partial snapshots into one draft', () => {
    expect(composeScribeTranscript(['你好，'], '世界')).toBe('你好，世界');
    expect(composeScribeTranscript(['Hello,'], 'world.')).toBe('Hello, world.');
  });

  it('recovers by replaying uncommitted audio and preserving the current partial prefix', async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    const messageCounts: number[] = [];
    let provider: ElevenLabsScribeProvider | undefined;
    server.on('connection', (socket) => {
      const index = sockets.length;
      sockets.push(socket);
      messageCounts[index] = 0;
      socket.send(JSON.stringify({ message_type: 'session_started' }));
      socket.on('message', () => {
        messageCounts[index] += 1;
      });
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      const events: Array<{ type: string; text?: string }> = [];
      provider = new ElevenLabsScribeProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        sourceLanguage: 'zh-CN',
      });
      provider.onEvent((event) => events.push(event));

      await provider.start();
      await waitFor(() => sockets.length === 1);
      provider.appendAudio(makePcmChunk(), makeTrace(0));
      await waitFor(() => (messageCounts[0] ?? 0) >= 1);
      sockets[0].send(JSON.stringify({ message_type: 'partial_transcript', text: '你好，今天' }));
      await waitFor(() => events.some((event) => event.text === '你好，今天'));

      provider.appendAudio(makePcmChunk(), makeTrace(1));
      sockets[0].close(1011, 'WebSocket passthrough error');
      await waitFor(() => events.some((event) => event.type === 'disconnected'));

      const recoverPromise = provider.recover();
      provider.appendAudio(makePcmChunk(), makeTrace(2));
      await recoverPromise;
      await waitFor(() => sockets.length === 2);
      await waitFor(() => (messageCounts[1] ?? 0) >= 2);
      sockets[1].send(JSON.stringify({ message_type: 'partial_transcript', text: '今天小镇周会' }));

      await waitFor(() => events.some((event) => event.text === '你好，今天小镇周会'));
    } finally {
      await provider?.stop();
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not reopen a socket after stop while recovery is connecting', async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        setTimeout(() => done(true), 80);
      },
    });
    const sockets: WebSocket[] = [];
    let provider: ElevenLabsScribeProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.send(JSON.stringify({ message_type: 'session_started' }));
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      const events: Array<{ type: string }> = [];
      provider = new ElevenLabsScribeProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        sourceLanguage: 'zh-CN',
      });
      provider.onEvent((event) => events.push(event));

      await provider.start();
      await waitFor(() => sockets.length === 1);
      provider.appendAudio(makePcmChunk(), makeTrace(0));
      sockets[0].close(1011, 'WebSocket passthrough error');
      await waitFor(() => events.some((event) => event.type === 'disconnected'));

      const recoverPromise = provider.recover().catch(() => undefined);
      await sleep(10);
      await provider.stop();
      await recoverPromise;
      await sleep(120);

      const connectedAfterStop = events.slice(1).some((event) => event.type === 'connected');
      expect(connectedAfterStop).toBe(false);
      expect(sockets.every((socket) => socket.readyState === 2 || socket.readyState === 3)).toBe(true);
    } finally {
      await provider?.stop();
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails startup with a clear timeout when the websocket handshake stalls', async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        setTimeout(() => done(true), 100);
      },
    });
    let provider: ElevenLabsScribeProvider | undefined;

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new ElevenLabsScribeProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        sourceLanguage: 'zh-CN',
        connectTimeoutMs: 25,
      });
      provider.onEvent(() => {});

      await expect(provider.start()).rejects.toThrow('ElevenLabs Scribe connection timed out after 25ms');
    } finally {
      await provider?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails startup with a clear handshake error when upstream rejects the websocket upgrade', async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        done(false, 403, 'Forbidden');
      },
    });
    let provider: ElevenLabsScribeProvider | undefined;

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new ElevenLabsScribeProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        sourceLanguage: 'zh-CN',
        connectTimeoutMs: 2_000,
      });
      provider.onEvent(() => {});

      await expect(provider.start()).rejects.toThrow('ElevenLabs Scribe handshake failed: HTTP 403 Forbidden');
    } finally {
      await provider?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('waits for application authentication and rejects an auth error after the websocket opens', async () => {
    const server = new WebSocketServer({ port: 0 });
    let provider: ElevenLabsScribeProvider | undefined;
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ message_type: 'auth_error', error: 'Invalid API key' }));
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      const events: Array<{ type: string }> = [];
      provider = new ElevenLabsScribeProvider({
        proxyApiKey: 'invalid-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        connectTimeoutMs: 2_000,
      });
      provider.onEvent((event) => events.push(event));

      await expect(provider.start()).rejects.toThrow('Invalid API key');
      expect(events.some((event) => event.type === 'connected')).toBe(false);
      expect(events.some((event) => event.type === 'error')).toBe(true);
    } finally {
      await provider?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function makePcmChunk(): ArrayBuffer {
  const buffer = new ArrayBuffer(320);
  new Int16Array(buffer).fill(256);
  return buffer;
}

function makeTrace(chunkIndex: number) {
  return {
    capturedAt: Date.now(),
    convertedAt: Date.now(),
    chunkIndex,
    sampleRate: 16_000,
    durationMs: 10,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for test condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
