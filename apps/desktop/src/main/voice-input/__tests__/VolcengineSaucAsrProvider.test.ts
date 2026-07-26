import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';

import {
  decodeVolcengineMessage,
  encodeAudioOnlyRequest,
  encodeFullClientRequest,
  VolcengineSaucAsrProvider,
} from '../VolcengineSaucAsrProvider.js';
import { mergeRecoveredTranscript } from '../transcriptMerge.js';

describe('VolcengineSaucAsrProvider protocol helpers', () => {
  it('encodes the initial provider-native request as Volcengine binary protocol JSON', () => {
    const packet = encodeFullClientRequest({
      audio: {
        format: 'pcm',
        rate: 16_000,
      },
      request: {
        enable_punc: true,
      },
    });

    expect(packet[0]).toBe(0x11);
    expect(packet[1]).toBe(0x10);
    expect(packet[2]).toBe(0x11);
    expect(packet.length).toBeGreaterThan(8);
  });

  it('encodes audio chunks with positive and negative sequence numbers', () => {
    const audio = encodeAudioOnlyRequest(Buffer.from([1, 2, 3, 4]), 7);
    const final = encodeAudioOnlyRequest(Buffer.alloc(0), -8);

    expect(audio[1]).toBe(0x21);
    expect(audio.readInt32BE(4)).toBe(7);
    expect(final[1]).toBe(0x23);
    expect(final.readInt32BE(4)).toBe(-8);
    expect(final.readUInt32BE(8)).toBe(0);
    expect(final).toHaveLength(12);
  });

  it('decodes compressed JSON server responses', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({
      result: {
        text: '你好，今天我们测试豆包流式语音识别模型。',
        is_final: true,
      },
    })));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);
    const packet = Buffer.concat([
      Buffer.from([0x11, 0x90, 0x11, 0x00]),
      size,
      payload,
    ]);

    const decoded = decodeVolcengineMessage(packet);

    expect(decoded.messageType).toBe(0x9);
    expect(decoded.payload).toEqual({
      result: {
        text: '你好，今天我们测试豆包流式语音识别模型。',
        is_final: true,
      },
    });
  });

  it('decodes server error frames with Volcengine error code payload layout', () => {
    const payload = gzipSync(Buffer.from('decode ws request failed', 'utf8'));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);
    const code = Buffer.alloc(4);
    code.writeInt32BE(1001, 0);
    const packet = Buffer.concat([
      Buffer.from([0x11, 0xf0, 0x01, 0x00]),
      code,
      size,
      payload,
    ]);

    const decoded = decodeVolcengineMessage(packet);

    expect(decoded.messageType).toBe(0xf);
    expect(decoded.payload).toEqual({
      code: 1001,
      message: 'decode ws request failed',
    });
  });

  it('merges recovered session text without dropping or duplicating the delivered prefix', () => {
    expect(mergeRecoveredTranscript('写一下6月4日的工作日志。', '工作日志。今天小镇周会'))
      .toBe('写一下6月4日的工作日志。今天小镇周会');
    expect(mergeRecoveredTranscript('Hello world', 'world again'))
      .toBe('Hello world again');
    expect(mergeRecoveredTranscript('Hello', 'world'))
      .toBe('Hello world');
    expect(mergeRecoveredTranscript('玩法本身', '的耐玩度不够'))
      .toBe('玩法本身的耐玩度不够');
  });

  it('recovers by replaying unconfirmed audio and preserving the visible transcript prefix', async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    const messageCounts: number[] = [];
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket) => {
      const index = sockets.length;
      sockets.push(socket);
      messageCounts[index] = 0;
      socket.send(serverAckPacket());
      socket.on('message', () => {
        messageCounts[index] += 1;
      });
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      const events: Array<{ type: string; text?: string }> = [];
      provider = new VolcengineSaucAsrProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        resourceId: 'volc.test',
      });
      provider.onEvent((event) => events.push(event));

      await provider.start();
      await waitFor(() => sockets.length === 1);
      provider.appendAudio(makePcmChunk(), makeTrace(0));
      provider.appendAudio(makePcmChunk(), makeTrace(1));
      await waitFor(() => (messageCounts[0] ?? 0) >= 2);
      sockets[0].send(serverTranscriptPacket('你好，今天', false));
      await waitFor(() => events.some((event) => event.text === '你好，今天'));

      provider.appendAudio(makePcmChunk(), makeTrace(2));
      sockets[0].close(1011, 'WebSocket passthrough error');
      await waitFor(() => events.some((event) => event.type === 'disconnected'));

      const recoverPromise = provider.recover();
      provider.appendAudio(makePcmChunk(), makeTrace(3));
      await recoverPromise;
      await waitFor(() => sockets.length === 2);
      await waitFor(() => (messageCounts[1] ?? 0) >= 5);
      sockets[1].send(serverTranscriptPacket('今天小镇周会', false));

      await waitFor(() => events.some((event) => event.text === '你好，今天小镇周会'));
    } finally {
      await provider?.stop();
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('requests a fresh one-shot connection ticket when transport recovery reconnects', async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    const authorizations: Array<string | undefined> = [];
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket, request) => {
      sockets.push(socket);
      authorizations.push(request.headers.authorization);
      socket.send(serverAckPacket());
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');
      let ticketNumber = 0;
      provider = new VolcengineSaucAsrProvider({
        connectionProvider: async () => ({
          websocketUrl: `ws://127.0.0.1:${address.port}/api/voice/asr`,
          authorizationToken: `ticket-${++ticketNumber}`,
        }),
        resourceId: 'volc.test',
      });
      const events: string[] = [];
      provider.onEvent((event) => events.push(event.type));

      await provider.start();
      await waitFor(() => sockets.length === 1);
      sockets[0].close(1011, 'drop');
      await waitFor(() => events.includes('disconnected'));
      await provider.recover();
      await waitFor(() => sockets.length === 2);

      expect(authorizations).toEqual(['Bearer ticket-1', 'Bearer ticket-2']);
    } finally {
      await provider?.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('waits for a provider protocol response before reporting connected', async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      const events: string[] = [];
      provider = new VolcengineSaucAsrProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        resourceId: 'volc.test',
        connectTimeoutMs: 1_000,
      });
      provider.onEvent((event) => events.push(event.type));

      const started = provider.start();
      await waitFor(() => sockets.length === 1);
      await expect(Promise.race([
        started.then(() => 'resolved'),
        sleep(30).then(() => 'pending'),
      ])).resolves.toBe('pending');
      expect(events).not.toContain('connected');

      sockets[0].send(serverAckPacket());
      await expect(started).resolves.toBeUndefined();
      expect(events).toContain('connected');
    } finally {
      await provider?.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not open a managed socket when stopped during session allocation', async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.send(serverAckPacket());
    });
    let allocationStarted = false;
    let releaseAllocation: ((value: { websocketUrl: string; authorizationToken: string }) => void) | undefined;
    const connectionProvider = vi.fn(() => new Promise<{ websocketUrl: string; authorizationToken: string }>((resolve) => {
      allocationStarted = true;
      releaseAllocation = resolve;
    }));
    let provider: VolcengineSaucAsrProvider | undefined;

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');
      provider = new VolcengineSaucAsrProvider({
        connectionProvider,
        resourceId: 'volc.test',
      });

      const started = provider.start();
      await waitFor(() => allocationStarted);
      await provider.stop();
      releaseAllocation?.({
        websocketUrl: `ws://127.0.0.1:${address.port}/api/voice/asr`,
        authorizationToken: 'stale-ticket',
      });

      await expect(started).rejects.toThrow('stopped');
      expect(sockets).toHaveLength(0);
    } finally {
      await provider?.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('waits for the protocol last response before completing flush', async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.send(serverAckPacket());
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new VolcengineSaucAsrProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        resourceId: 'volc.test',
      });
      provider.onEvent(() => {});

      await provider.start();
      await waitFor(() => sockets.length === 1);
      provider.appendAudio(makePcmChunk(), makeTrace(0));

      const flushPromise = provider.flushAudio();
      sockets[0].send(serverTranscriptPacket('你好，今天', true, 0x1));

      await expect(Promise.race([
        flushPromise.then(() => 'resolved'),
        sleep(80).then(() => 'pending'),
      ])).resolves.toBe('pending');

      sockets[0].send(serverTranscriptPacket('你好，今天', true, 0x3));

      await expect(Promise.race([
        flushPromise.then(() => 'resolved'),
        sleep(1_000).then(() => 'timeout'),
      ])).resolves.toBe('resolved');
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
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.send(serverAckPacket());
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      const events: Array<{ type: string }> = [];
      provider = new VolcengineSaucAsrProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        resourceId: 'volc.test',
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

  it('fails startup instead of hanging when the provider-native socket does not open in time', async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        setTimeout(() => done(true), 200);
      },
    });
    const sockets: WebSocket[] = [];
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.send(serverAckPacket());
    });

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new VolcengineSaucAsrProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        resourceId: 'volc.test',
        connectTimeoutMs: 25,
      });
      provider.onEvent(() => {});

      await expect(provider.start()).rejects.toThrow('Volcengine SAUC ASR connection timed out after 25ms');
      await sleep(250);

      expect(sockets).toHaveLength(0);
    } finally {
      await provider?.stop();
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports provider-native handshake failures without waiting for the connect timeout', async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient(_info, done) {
        done(false, 403, 'Forbidden');
      },
    });
    let provider: VolcengineSaucAsrProvider | undefined;

    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local test server address.');

      provider = new VolcengineSaucAsrProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        resourceId: 'volc.test',
        connectTimeoutMs: 2_000,
      });
      provider.onEvent(() => {});

      // The dialed host/path must ride along so a route-level 404/403 can be
      // attributed to the exact gateway address (issue #220 diagnosability).
      await expect(provider.start()).rejects.toThrow(
        `Volcengine SAUC ASR handshake failed: HTTP 403 Forbidden (127.0.0.1:${address.port}/volcengine/api/v3/sauc/bigmodel_async)`,
      );
    } finally {
      await provider?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});

function serverTranscriptPacket(text: string, isFinal: boolean, flags = 0x0): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify({
    result: {
      text,
      utterances: [
        {
          text,
          definite: isFinal,
        },
      ],
    },
  })));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  const sequence = flags === 0x1 || flags === 0x3 ? Buffer.alloc(4) : Buffer.alloc(0);
  if (sequence.length > 0) sequence.writeInt32BE(flags === 0x3 ? -2 : 2, 0);
  return Buffer.concat([
    Buffer.from([0x11, 0x90 | flags, 0x11, 0x00]),
    sequence,
    size,
    payload,
  ]);
}

function serverAckPacket(): Buffer {
  return Buffer.from([0x11, 0xb0, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

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
