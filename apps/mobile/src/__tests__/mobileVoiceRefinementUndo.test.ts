import { gzip } from 'pako';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: {
    nativeAppVersion: '1.2.3',
    expoConfig: { version: '1.2.3' },
  },
}));
vi.mock('@/config/env', () => ({
  AUTH_REGION: 'global',
  VOICE_API_BASE_URL: 'https://voice.example.com/',
}));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async () => null),
  setSecureItem: vi.fn(async () => undefined),
  deleteSecureItem: vi.fn(async () => undefined),
}));

import type { AsrEvent } from '@cindy/voice-input-core';
import {
  DEFAULT_MOBILE_VOICE_MAX_SESSION_MS,
  MobileCindyVoiceRunContext,
  createMobileCindyVoiceCredential,
} from '@/session/mobileCindyVoiceSession';
import { MobileVolcengineSaucAsrProvider } from '@/session/mobileRealtimeAsrProvider';
import { applyMobileVoiceRefinementUndoToDraft } from '@/session/useMobileVoiceRefinementUndo';

// 测试价值：验证移动端润色还原原文纯逻辑、服务端 maxSessionMs 感知以及 MobileVolcengineSaucAsrProvider 先建后拆轮换与 429 回退。
// 依据：语音输入优化 ⑤⑧ 要求移动端同样支持 180s 前主动无感切流与轻量“还原原文”能力。
// 缺口：既有移动单测未覆盖 applyMobileVoiceRefinementUndoToDraft、maxSessionMs() 与移动端 SAUC rotateSession()。
// 最小输入：草稿区间替换、带 maxSessionMs 的会话响应与假 WebSocket 工厂双连接切换。
// tier: unit，纯内存执行，无原生模块或外部网络依赖。
describe('applyMobileVoiceRefinementUndoToDraft', () => {
  it('restores raw ASR text in place while preserving surrounding draft text', () => {
    const result = applyMobileVoiceRefinementUndoToDraft('前缀：使用 Cloud Code。后缀', {
      draft: '前缀：使用 Cloud Code。后缀',
      rawTranscriptText: '呃使用 cloud code',
      refinedText: '使用 Cloud Code。',
      start: 3,
      end: 17,
    });

    expect(result).toEqual({
      nextDraft: '前缀：呃使用 cloud code后缀',
      nextStart: 3,
      nextEnd: 17,
      replacement: {
        start: 3,
        end: 17,
        text: '呃使用 cloud code',
      },
    });
  });

  it('refuses to overwrite when the user already edited the refined span or when raw equals refined', () => {
    expect(applyMobileVoiceRefinementUndoToDraft('用户已经改过了', {
      draft: '使用 Cloud Code。',
      rawTranscriptText: '使用 cloud code',
      refinedText: '使用 Cloud Code。',
      start: 0,
      end: 14,
    })).toBeNull();

    expect(applyMobileVoiceRefinementUndoToDraft('原样文本', {
      draft: '原样文本',
      rawTranscriptText: '原样文本',
      refinedText: '原样文本',
      start: 0,
      end: 4,
    })).toBeNull();
  });
});

describe('MobileCindyVoiceRunContext.maxSessionMs', () => {
  it('defaults to 180s and adopts server-reported maxSessionMs', async () => {
    const apiFetch = vi.fn(async () => ({
      sessionId: 'session-rot',
      ticket: 'ticket-rot',
      expiresAt: '2026-07-21T14:00:00.000Z',
      maxSessionMs: 120_000,
      asr: {
        provider: 'litellm-volcengine-sauc-asr',
        websocketUrl: 'wss://voice.example.com/api/voice/asr',
        protocolProfile: 'volcengine-sauc-duration',
        sampleRate: 16_000,
      },
    }));
    const ctx = new MobileCindyVoiceRunContext(
      async () => 'tok',
      async () => 'tok2',
      apiFetch as ConstructorParameters<typeof MobileCindyVoiceRunContext>[2],
      'zh-CN',
      'auto',
    );
    expect(ctx.maxSessionMs()).toBe(DEFAULT_MOBILE_VOICE_MAX_SESSION_MS);
    await ctx.createAsrConnection('litellm-volcengine-sauc-asr');
    expect(ctx.maxSessionMs()).toBe(120_000);
  });
});

function buildVolcServerPacket(text: string): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify({
    result: {
      text,
      utterances: [{ text, start_time: 0, end_time: 100, definite: true }],
    },
  }));
  const compressed = gzip(jsonBytes);
  const packet = new Uint8Array(8 + compressed.length);
  packet.set([0x11, 0x90, 0x11, 0x00], 0);
  new DataView(packet.buffer).setUint32(4, compressed.length, false);
  packet.set(compressed, 8);
  return packet.buffer;
}

describe('MobileVolcengineSaucAsrProvider.rotateSession', () => {
  it('rotates make-before-break without emitting disconnected and falls back on 429 concurrency limit', async () => {
    type FakeWs = {
      readyState: number;
      binaryType?: string;
      sent: Array<string | ArrayBuffer>;
      send(data: string | ArrayBuffer): void;
      close(): void;
      onopen: ((event: unknown) => void) | null;
      onmessage: ((event: { data: unknown }) => void) | null;
      onerror: ((event: { message?: string; error?: unknown }) => void) | null;
      onclose: ((event: { code?: number; reason?: string }) => void) | null;
    };

    const sockets: FakeWs[] = [];
    let rejectConcurrentWith429 = false;
    class FakeWebSocket implements FakeWs {
      readyState = 0;
      binaryType?: string;
      sent: Array<string | ArrayBuffer> = [];
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { message?: string; error?: unknown }) => void) | null = null;
      onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

      constructor(_url: string) {
        sockets.push(this);
        queueMicrotask(() => {
          const openOthers = sockets.filter((s) => s !== this && s.readyState === 1).length;
          if (rejectConcurrentWith429 && openOthers > 0) {
            this.readyState = 3;
            this.onerror?.({ message: 'HTTP 429 Too Many Requests' });
            this.onclose?.({ code: 1006, reason: '429 Too Many Requests' });
            return;
          }
          this.readyState = 1;
          this.onopen?.({});
        });
      }

      send(data: string | ArrayBuffer): void {
        this.sent.push(data);
      }

      close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: '' });
      }
    }

    const credential = createMobileCindyVoiceCredential('host-1');
    const events: AsrEvent[] = [];
    const provider = new MobileVolcengineSaucAsrProvider({
      credential,
      websocketFactory: FakeWebSocket as never,
      connectionProvider: async () => ({
        websocketUrl: 'wss://voice.example.com/asr',
        authorizationToken: 'ticket-1',
      }),
    });
    provider.onEvent((event) => events.push(event));

    await provider.start();
    expect(sockets).toHaveLength(1);
    sockets[0].onmessage?.({ data: buildVolcServerPacket('第一句。') });
    expect(events.at(-1)).toMatchObject({ type: 'stable', text: '第一句。' });

    // Make-before-break rotation: socket[1] opens, socket[0] closes quietly, no disconnected event.
    await provider.rotateSession();
    expect(sockets).toHaveLength(2);
    expect(sockets[0].readyState).toBe(3);
    expect(sockets[1].readyState).toBe(1);
    expect(events.some((event) => event.type === 'disconnected')).toBe(false);
    sockets[1].onmessage?.({ data: buildVolcServerPacket('第二句。') });
    expect(events.at(-1)).toMatchObject({ type: 'stable', text: '第一句。第二句。' });

    // Concurrency limit (429) triggers break-before-make fallback seamlessly.
    rejectConcurrentWith429 = true;
    await provider.rotateSession();
    expect(sockets).toHaveLength(4); // sockets[2] rejected with 429 -> recover closes sockets[1] & opens sockets[3]
    expect(sockets[3].readyState).toBe(1);
    sockets[3].onmessage?.({ data: buildVolcServerPacket('第三句。') });
    expect(events.at(-1)).toMatchObject({ type: 'stable', text: '第一句。第二句。第三句。' });

    await provider.stop();
  });
});
