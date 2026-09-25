import { gzipSync, gunzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';

const diagnosticLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => diagnosticLog }));

import {
  decodeVolcengineMessage,
  encodeAudioOnlyRequest,
  encodeFullClientRequest,
  getTranscriptConfirmation,
  VolcengineSaucAsrProvider,
} from '../VolcengineSaucAsrProvider.js';
import { volcengineSaucLanguageCode } from '../language.js';
import { mergeRecoveredTranscript } from '../transcriptMerge.js';

describe('VolcengineSaucAsrProvider protocol helpers', () => {
  it('requires all utterances to cover the aggregate transcript', () => {
    const check = (utterances: unknown[]) => getTranscriptConfirmation({ result: { text: '一句。二句。', utterances } }, '一句。二句。');
    expect(check([{ text: '一句。', definite: true }, { text: '二句。', definite: false }]).confirmed).toBe(false);
    expect(check([{ text: '一句。', definite: true }]).confirmed).toBe(false);
    expect(check([{ text: '一句。', definite: true }, { text: '二句。', definite: true, end_time: 1000 }]))
      .toEqual({ confirmed: true, endMs: 1000 });
    expect(check([{ text: '一句。二句。', definite: true }])).toEqual({ confirmed: true, endMs: 0 });
  });
  it('normalizes Traditional Chinese to the documented provider hint', () => {
    expect(volcengineSaucLanguageCode('auto')).toBeUndefined();
    expect(volcengineSaucLanguageCode('zh-TW')).toBe('zh-CN');
    expect(volcengineSaucLanguageCode('Traditional Chinese')).toBe('zh-CN');
    expect(volcengineSaucLanguageCode('zh-CN')).toBe('zh-CN');
    expect(volcengineSaucLanguageCode('en')).toBe('en');
  });

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

  it.each(['ack', 'timeout', 'stop'] as const)('early audio preserves request order and handles %s before protocol readiness', async (outcome) => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    const packets: Buffer[] = [];
    const events: Array<{ type: string; message?: string }> = [];
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (data) => packets.push(Buffer.from(data as Buffer)));
    });
    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected server address.');
      provider = new VolcengineSaucAsrProvider({
        proxyApiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        resourceId: 'volc.test',
        sendAudioBeforeAck: true,
        endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
        connectTimeoutMs: 250,
      });
      provider.onEvent((event) => events.push(event));
      await provider.start();
      provider.appendAudio(makePcmChunk(), makeTrace(0));
      provider.appendAudio(makePcmChunk(), makeTrace(1));
      await waitFor(() => packets.length === 3);
      expect(packets.map((packet) => packet[1] >> 4)).toEqual([1, 2, 2]);
      expect(events.filter((event) => event.type === 'connected')).toHaveLength(1);
      if (outcome === 'ack') {
        sockets[0].send(serverAckPacket());
        sockets[0].send(serverTranscriptPacket('提前发送测试', false));
        await waitFor(() => events.some((event) => event.type === 'partial'));
        await sleep(300);
        expect(events.some((event) => event.type === 'error')).toBe(false);
        expect(events.filter((event) => event.type === 'connected')).toHaveLength(1);
      } else if (outcome === 'timeout') {
        await waitFor(() => events.some((event) => event.type === 'error'));
        expect(events.find((event) => event.type === 'error')?.message).toContain('timed out');
        await waitFor(() => sockets[0].readyState === 3);
      } else {
        await provider.stop();
        await sleep(300);
        expect(events.some((event) => event.type === 'error')).toBe(false);
        await waitFor(() => sockets[0].readyState === 3);
      }
    } finally {
      await provider?.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends the first real audio without a second append and finalizes without duplicating it', async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    const audio: Buffer[] = [];
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.send(serverAckPacket());
      socket.on('message', (raw) => {
        const packet = Buffer.from(raw as Buffer);
        if (packet[1] >> 4 !== 2) return;
        audio.push(packet);
        if ((packet[1] & 0xf) === 3) socket.send(serverTranscriptPacket('完成', true, 0x3));
      });
    });
    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected server address');
      provider = new VolcengineSaucAsrProvider({
        proxyApiKey: 'test-key', baseUrl: `http://127.0.0.1:${address.port}`,
        endpointPath: '/asr', resourceId: 'volc.test',
      });
      await provider.start();
      const pcm = makePcmChunk();
      provider.appendAudio(pcm, makeTrace(0));
      await waitFor(() => audio.length === 1);
      expect(audio[0].readInt32BE(4)).toBe(2);
      expect(gunzipSync(audio[0].subarray(12))).toEqual(Buffer.from(pcm));
      await provider.flushAudio();
      expect(audio).toHaveLength(2);
      expect(audio[1].readInt32BE(4)).toBe(-3);
      expect(gunzipSync(audio[1].subarray(12))).toEqual(Buffer.alloc(16000 * 0.3 * 2));
    } finally {
      await provider?.stop();
      sockets.forEach((socket) => socket.terminate());
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

  it.each(['confirmed', 'new_sound', 'missing_time', 'partial_tail', 'short_pause', 'uncovered_audio', 'recovered', 'future_time', 'isolated_click'])
  ('only skips final response when audio and text are both confirmed: %s', async (scenario) => {
    diagnosticLog.debug.mockClear();
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    let provider: VolcengineSaucAsrProvider | undefined;
    server.on('connection', (socket) => { sockets.push(socket); socket.send(serverAckPacket()); });
    try {
      await waitFor(() => server.address() !== null);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local server');
      provider = new VolcengineSaucAsrProvider({ proxyApiKey: 'test', baseUrl: `http://127.0.0.1:${address.port}`, endpointPath: '/asr', resourceId: 'test' });
      const events: Array<{ type: string }> = [];
      provider.onEvent((event) => events.push(event));
      await provider.start();
      provider.appendAudio(new Int16Array(1600).fill(512).buffer);
      sockets[0].send(serverTranscriptPacket('一句。', false));
      await waitFor(() => events.some((e) => e.type === 'partial'));
      sockets[0].send(serverTranscriptPacket('一句。', true, 0,
        scenario === 'missing_time' ? undefined : scenario === 'uncovered_audio' ? 50 : scenario === 'future_time' ? 10000 : 100));
      await waitFor(() => events.some((e) => e.type === 'stable'));
      if (scenario === 'recovered') {
        await provider.recover();
        sockets[1].send(serverTranscriptPacket('一句。', true, 0, 100));
        await waitFor(() => events.filter((e) => e.type === 'stable').length === 2);
      }
      if (scenario === 'new_sound') provider.appendAudio(new Int16Array(160).fill(40).buffer);
      if (scenario === 'isolated_click') {
        provider.appendAudio(new Int16Array(1600).buffer);
        const click = new Int16Array(160);
        click[0] = 30000;
        provider.appendAudio(click.buffer);
      }
      if (scenario === 'partial_tail') {
        sockets[0].send(serverTranscriptPacket('一句。新尾句', false));
        await waitFor(() => events.filter((e) => e.type === 'partial').length === 2);
      }
      provider.appendAudio(new Int16Array(scenario === 'short_pause' ? 1600 : 32000).buffer);
      let settled = false;
      const flushing = provider.flushAudio().then(() => { settled = true; });
      await sleep(30);
      const fastFinish = scenario === 'confirmed' || scenario === 'isolated_click';
      expect(settled).toBe(fastFinish);
      const decision = diagnosticLog.debug.mock.calls.find(([name]) => name === 'stop finalization decision')?.[1];
      const expectedReason: Record<string, string> = {
        new_sound: 'sound_after_confirmed_audio', missing_time: 'no_confirmed_audio_position',
        partial_tail: 'transcript_not_fully_confirmed', short_pause: 'silence_under_2000ms',
        uncovered_audio: 'sound_after_confirmed_audio', recovered: 'recovered_audio_clock',
        future_time: 'confirmed_position_beyond_sent_audio',
      };
      expect(decision).toMatchObject({
        lastSoundEndMs: scenario === 'new_sound' ? 110 : 100,
        silenceMs: scenario === 'short_pause' ? 100 : scenario === 'isolated_click' ? 2110 : 2000,
        fastFinish,
        soundDetection: 'rms_duration_v1',
      });
      if (fastFinish) {
        expect(decision).toMatchObject({ confirmedEndMs: 100, sentAudioMs: scenario === 'isolated_click' ? 2210 : 2100, missedReasons: [] });
      } else {
        expect(decision.missedReasons).toContain(expectedReason[scenario]);
      }
      sockets[sockets.length - 1].send(serverTranscriptPacket('一句。', true, 3));
      await flushing;
      expect(diagnosticLog.debug.mock.calls.find(([name]) => name === 'flush settled')?.[1].stopDecision).toEqual(decision);
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

function serverTranscriptPacket(text: string, isFinal: boolean, flags = 0x0, endTime?: number): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify({
    result: {
      text,
      utterances: [
        {
          text,
          definite: isFinal,
          end_time: endTime,
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
