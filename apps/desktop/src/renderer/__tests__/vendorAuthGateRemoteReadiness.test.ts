/**
 * vendorAuthGateRemoteReadiness.test.ts
 * ---------------------------------------------------------------------------
 * device-link:新建 / 发送远程会话时,vendor 就绪态必须以**被控端**为准
 * (控制端本机有没有连 XD Gateway / 连 Codex 无关)。这里覆盖纯函数
 * deriveRemoteReadiness:来源判定以被控端 provider 目录(sourceReady,与本地 /
 * 手机端同源)为唯一真相;maker:agent:status 的 authReady 只是老被控端回退口径。
 */
import { describe, it, expect } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import { VOICE_INPUT_ASR_PROFILES } from '../../shared/voiceInputAsrProfiles';
import {
  deriveRemoteReadiness,
  pickVoiceInputDialogCopy,
  sourceReadyFromProviderList,
} from '@/hooks/useVendorAuthGate';
import { readinessFromBinaryStatus } from '@/hooks/useVendorReadiness';

describe('readinessFromBinaryStatus（本地运行时就绪推导）', () => {
  it('Codex 与 Pi 缺少本地二进制时都返回 binary-missing', () => {
    expect(readinessFromBinaryStatus('codex', false)).toBe('binary-missing');
    expect(readinessFromBinaryStatus('pi', false)).toBe('binary-missing');
  });

  it('Claude 不依赖该二进制轴，已就绪时不产生覆盖状态', () => {
    expect(readinessFromBinaryStatus('cc', false)).toBeNull();
    expect(readinessFromBinaryStatus('codex', true)).toBeNull();
    expect(readinessFromBinaryStatus('pi', true)).toBeNull();
  });
});

describe('deriveRemoteReadiness（被控端就绪推导）', () => {
  it('sourceReady 可用时是唯一真相(cc / codex 同构),authReady 不参与', () => {
    // 核心回归:被控端没登 Codex(authReady=false)但 provider 目录里有已连接的
    // 其他来源(sourceReady=true)→ ready,不再误弹「被控端 Codex 未登录」。
    expect(
      deriveRemoteReadiness('codex', { binaryReady: true, sourceReady: true, authReady: false }),
    ).toBe('ready');
    expect(
      deriveRemoteReadiness('cc', { binaryReady: true, sourceReady: true, authReady: false }),
    ).toBe('ready');
    // 反向:OAuth 口径 ready 但 provider 目录无已连接来源 → 以 provider 目录为准。
    expect(
      deriveRemoteReadiness('codex', { binaryReady: true, sourceReady: false, authReady: true }),
    ).toBe('unauthenticated');
    expect(
      deriveRemoteReadiness('cc', { binaryReady: true, sourceReady: false, authReady: true }),
    ).toBe('unauthenticated');
  });

  it('sourceReady 不可用(老被控端 / 查询失败)→ 回退 authReady 旧口径', () => {
    expect(
      deriveRemoteReadiness('codex', { binaryReady: true, sourceReady: null, authReady: true }),
    ).toBe('ready');
    expect(
      deriveRemoteReadiness('codex', { binaryReady: true, sourceReady: null, authReady: false }),
    ).toBe('unauthenticated');
    expect(
      deriveRemoteReadiness('cc', { binaryReady: true, sourceReady: null, authReady: false }),
    ).toBe('unauthenticated');
  });

  it('全部判定不可用 → ready(控制端不臆断,交给被控端权威校验)', () => {
    expect(
      deriveRemoteReadiness('codex', { binaryReady: null, sourceReady: null, authReady: null }),
    ).toBe('ready');
    expect(
      deriveRemoteReadiness('cc', { binaryReady: null, sourceReady: null, authReady: null }),
    ).toBe('ready');
  });

  it('codex:binaryReady=false 优先返回 binary-missing;null(status 失败)不触发', () => {
    expect(
      deriveRemoteReadiness('codex', { binaryReady: false, sourceReady: true, authReady: true }),
    ).toBe('binary-missing');
    expect(
      deriveRemoteReadiness('codex', { binaryReady: null, sourceReady: true, authReady: null }),
    ).toBe('ready');
  });

  it('pi:binaryReady=false 报组件缺失,不伪装成未授权', () => {
    expect(
      deriveRemoteReadiness('pi', { binaryReady: false, sourceReady: true, authReady: true }),
    ).toBe('binary-missing');
  });

  it('cc:binary 随包,binaryReady 不参与判定', () => {
    expect(
      deriveRemoteReadiness('cc', { binaryReady: false, sourceReady: true, authReady: null }),
    ).toBe('ready');
    expect(
      deriveRemoteReadiness('cc', { binaryReady: false, sourceReady: false, authReady: null }),
    ).toBe('unauthenticated');
  });
});

describe('sourceReadyFromProviderList（隧道 provider:list 响应解析）', () => {
  // 与被控端 dispatch 剥离执行字段后的回显结构一致,判定只消费 connected + agents。
  const provider = (over: Partial<ProviderView>): ProviderView =>
    ({
      id: 'p',
      name: 'P',
      agents: ['codex'],
      routing: { codex: {} },
      connected: true,
      ...over,
    }) as ProviderView;

  it('该 agent 有已连接来源 → true;来源都未连接 / 不支持该 agent → false', () => {
    expect(sourceReadyFromProviderList({ providers: [provider({})] }, 'codex')).toBe(true);
    expect(
      sourceReadyFromProviderList({ providers: [provider({ connected: false })] }, 'codex'),
    ).toBe(false);
    expect(
      sourceReadyFromProviderList({ providers: [provider({ agents: ['claude-code'] })] }, 'codex'),
    ).toBe(false);
  });

  it('协议异常(providers 缺失 / 非数组 / 响应为 null)→ null(判定不可用,回退旧口径)', () => {
    expect(sourceReadyFromProviderList(null, 'codex')).toBe(null);
    expect(sourceReadyFromProviderList({}, 'codex')).toBe(null);
    expect(sourceReadyFromProviderList({ providers: 'oops' }, 'codex')).toBe(null);
  });
});

describe('Codex voice input settings target', () => {
  it('routes the Codex ASR profile to Providers, matching the dialog copy', () => {
    expect(VOICE_INPUT_ASR_PROFILES['openai-realtime-whisper'].settingsTab).toBe('providers');
  });
});

describe('pickVoiceInputDialogCopy（语音输入缺认证文案）', () => {
  const copy: Parameters<typeof pickVoiceInputDialogCopy>[0] = {
    'no-source': { title: 'no-source', description: '', confirmText: '', cancelText: '', settingsTab: 'providers' },
    'voice-api-key-unauth': { title: 'gateway', description: '', confirmText: '', cancelText: '', settingsTab: 'providers' },
    'voice-direct-api-key-unauth': { title: 'direct-key', description: '', confirmText: '', cancelText: '', settingsTab: 'api-keys' },
    'codex-voice-unauth': { title: 'codex', description: '', confirmText: '', cancelText: '', settingsTab: 'providers' },
    'codex-binary-missing': { title: 'binary', description: '', confirmText: '', cancelText: '', settingsTab: 'providers' },
    'pi-binary-missing': { title: 'pi-binary', description: '', confirmText: '', cancelText: '', settingsTab: 'providers' },
  };

  it('api-key + providers 使用 XD Gateway 文案', () => {
    expect(pickVoiceInputDialogCopy(copy, { auth: 'api-key', settingsTab: 'providers' }).title)
      .toBe('gateway');
  });

  it('api-key + api-keys 使用直连 API key 文案', () => {
    expect(pickVoiceInputDialogCopy(copy, { auth: 'api-key', settingsTab: 'api-keys' }).title)
      .toBe('direct-key');
  });

  it('codex 认证失败继续使用 Codex 连接文案', () => {
    expect(pickVoiceInputDialogCopy(copy, { auth: 'codex', settingsTab: 'connections' }))
      .toEqual(expect.objectContaining({ title: 'codex', settingsTab: 'providers' }));
  });
});
