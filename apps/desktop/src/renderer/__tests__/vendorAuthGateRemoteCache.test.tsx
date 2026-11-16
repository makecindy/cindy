// @vitest-environment jsdom
/**
 * device-link 新建任务的就绪门禁复用模型选择器已读到的来源快照:快照显示已就绪时不再经隧道
 * 重拉 provider:list(实测 1–5 秒,整段挡在远程新建任务第一步);快照缺失或未就绪仍实时探测,
 * 旧快照只能放行、不能误弹「未连接」。
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const confirm = vi.fn(async () => true);
const navigate = vi.fn();
const revalidate = vi.fn();
const cachedProviders = vi.fn<(deviceId: string) => unknown>(() => null);

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));
// Most cases isolate the gate; `realReadiness` runs the production readiness hook.
let realReadiness = false;
vi.mock('@/hooks/useVendorReadiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useVendorReadiness')>();
  return {
    ...actual,
    useVendorReadiness: (vendor: 'cc' | 'codex' | 'pi') =>
      realReadiness ? actual.useVendorReadiness(vendor) : { revalidate },
  };
});
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { getDeviceName: () => 'Mac mini' },
}));
vi.mock('@/hooks/useDeviceProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDeviceProviders')>()),
  getCachedDeviceProviders: (deviceId: string) => cachedProviders(deviceId),
}));

import { useVendorAuthGate } from '@/hooks/useVendorAuthGate';
import { modelCatalogKey } from '../../shared/controlledModelCatalog';
import { createControlledModelCatalogReader } from '../../main/maker-ipc/controlledModelCatalog';

const provider = (over: Partial<ProviderView>): ProviderView =>
  ({
    id: 'p',
    name: 'P',
    agents: ['claude-code', 'codex'],
    routing: { 'claude-code': {}, codex: {} },
    models: { 'claude-code': [], codex: [] },
    connected: true,
    ...over,
  }) as ProviderView;

const defaultInvoke = async (_deviceId: string, channel: string, _args: unknown[]): Promise<unknown> => {
  if (channel === 'maker:agent:status') return { binaryReady: true, authReady: true };
  if (channel === 'maker:provider:list') return { providers: [provider({})] };
  throw new Error('unexpected channel ' + channel);
};
const invoke = vi.fn(defaultInvoke);

function channels(): string[] {
  return invoke.mock.calls.map((call) => call[1]);
}

beforeEach(() => {
  invoke.mockImplementation(defaultInvoke);
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
});

afterEach(() => {
  realReadiness = false;
  vi.unstubAllGlobals();
  invoke.mockClear();
  confirm.mockClear();
  navigate.mockClear();
  revalidate.mockReset();
  cachedProviders.mockReset();
  cachedProviders.mockReturnValue(null);
});

describe('useVendorAuthGate device-link 来源快照复用', () => {
  // #8010 / unit: run the real send gate through the real B catalog reader.
  // Earlier tests mocked only direct reads; a working picker could still fail at send time.
  // Minimum input: source A (or B-only share), task B, no cached provider snapshot.
  it.each([
    ['cc', 'claude-code', 'self-a'],
    ['codex', 'codex', 'self-a'],
    ['pi', 'pi', 'share:b-only'],
  ] as const)('checks %s on %s through the task host without using local credentials', async (vendor, agent, source) => {
    const sourceRead = vi.fn(async (_id: string, channel: string) => ({
      ok: true as const,
      result: channel === 'maker:agent:status'
        ? { binaryReady: true, authReady: false }
        : { providers: [provider({ agents: [agent], routing: { [agent]: {} }, models: { [agent]: [] } })] },
    }));
    const read = createControlledModelCatalogReader({
      assertCaller: () => {}, captureOwner: () => () => {},
      locations: async () => ({ status: 'complete', locations: [{ agentDeviceId: source, name: 'Source' }] }),
      invoke: sourceRead,
    });
    invoke.mockImplementation(async (host, channel, args) => {
      if (host !== 'host-b' || channel !== 'maker:model-catalog:read') throw new Error('wrong execution host');
      return read(args[0]);
    });
    const { result } = renderHook(() => useVendorAuthGate());
    await expect(result.current.checkAndConfirm(vendor, { deviceId: modelCatalogKey(source, 'host-b') }))
      .resolves.toEqual({ proceed: true });
    expect(sourceRead).toHaveBeenCalledWith(source, 'maker:agent:status', [agent], expect.any(Function));
    expect(confirm).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the scoped cache optimization but blocks a missing source binary without opening local settings', async () => {
    const key = modelCatalogKey('self-a', 'host-b')!;
    cachedProviders.mockImplementation(id => id === key ? { providers: [provider({})] } : null);
    invoke.mockResolvedValueOnce({ binaryReady: false, authReady: true });
    const { result } = renderHook(() => useVendorAuthGate());
    await expect(result.current.checkAndConfirm('codex', { deviceId: key })).resolves.toEqual({ proceed: false });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('host-b', 'maker:model-catalog:read', [{
      op: 'read', agentDeviceId: 'self-a', channel: 'maker:agent:status', args: ['codex'],
    }]);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'logic.confirm.remoteCodexBinaryMissingTitle' }));
    expect(revalidate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('blocks a failed host read even when the controller is ready', async () => {
    revalidate.mockResolvedValue('ready');
    invoke.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useVendorAuthGate());
    await expect(result.current.checkAndConfirm('cc', { deviceId: modelCatalogKey('self-a', 'host-b') }))
      .resolves.toEqual({ proceed: false });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'newChat.modelSelector.remoteLoadFailedShort' }));
    expect(revalidate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('cc:快照已有可用来源时直接放行,不发任何隧道请求', async () => {
    cachedProviders.mockReturnValue({ providers: [provider({})] });
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('cc', { deviceId: 'dev' })).resolves.toEqual({
      proceed: true,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('codex:快照已就绪时只查 agent:status 的二进制轴,缺二进制仍拦下', async () => {
    cachedProviders.mockReturnValue({ providers: [provider({})] });
    invoke.mockImplementationOnce(async () => ({ binaryReady: false, authReady: true }));
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('codex', { deviceId: 'dev' })).resolves.toEqual({
      proceed: false,
    });
    expect(channels()).toEqual(['maker:agent:status']);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('快照显示未就绪时实时探测,被控端刚连上来源不会被旧快照误拦', async () => {
    cachedProviders.mockReturnValue({ providers: [provider({ connected: false })] });
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('cc', { deviceId: 'dev' })).resolves.toEqual({
      proceed: true,
    });
    expect(channels().sort()).toEqual(['maker:agent:status', 'maker:provider:list']);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('没有快照时保持原有实时探测', async () => {
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('cc', { deviceId: 'dev' })).resolves.toEqual({
      proceed: true,
    });
    expect(channels().sort()).toEqual(['maker:agent:status', 'maker:provider:list']);
  });
});

describe('useVendorAuthGate 本机恢复引导', () => {
  it('Pi 组件缺失时确认进入设置 → 关于', async () => {
    revalidate.mockResolvedValue('binary-missing');
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('pi')).resolves.toEqual({ proceed: false });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/settings?tab=about');
  });

  it('Pi 组件缺失时取消不导航', async () => {
    revalidate.mockResolvedValue('binary-missing');
    confirm.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('pi')).resolves.toEqual({ proceed: false });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Pi 来源不足仍进入模型供应商页', async () => {
    revalidate.mockResolvedValue('unauthenticated');
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('pi')).resolves.toEqual({ proceed: false });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/settings?tab=providers');
  });

  it('远程 Pi 缺少组件时只显示信息，不导航控制端设置', async () => {
    invoke.mockImplementation(async (_deviceId: string, channel: string) => {
      if (channel === 'maker:agent:status') return { binaryReady: false, authReady: true };
      if (channel === 'maker:provider:list')
        return {
          providers: [
            provider({
              agents: ['pi'],
              routing: { pi: { upstream: '', authStrategy: 'none' } },
              models: { pi: [] },
            }),
          ],
        };
      throw new Error('unexpected channel ' + channel);
    });
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('pi', { deviceId: 'dev' })).resolves.toEqual({
      proceed: false,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('useVendorAuthGate 本机运行时轴', () => {
  // PR #9983 Greptile P1 / unit: an offline install may lack local Claude Code.
  // SSH tasks run the remote runtime, so only local tasks may be blocked by it.
  it('SSH 任务不被本机缺失的 Claude Code 拦截，本机任务引导到关于页', async () => {
    realReadiness = true;
    const getStatus = vi.fn(async () => ({ binaryReady: false, authReady: true }));
    vi.stubGlobal('electronAPI', {
      deviceLink: { invoke },
      maker: { agent: { getStatus }, listProviders: async () => ({ providers: [provider({})] }) },
    });
    const { result } = renderHook(() => useVendorAuthGate());
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(3));
    getStatus.mockClear();

    await expect(result.current.checkAndConfirm('cc', { remoteHostId: 'ssh-host' }))
      .resolves.toEqual({ proceed: true });
    expect(getStatus).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    await expect(result.current.checkAndConfirm('cc')).resolves.toEqual({ proceed: false });
    expect(getStatus).toHaveBeenCalledExactlyOnceWith('claude-code');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'logic.confirm.ccBinaryMissingTitle' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/settings?tab=about');
  });
});

// #9952 / unit: the real inline gate must explain the failed voice service and
// navigate to its recovery page. Existing tests cover auth/settingsTab alone,
// and the overlay resolver tests never exercise this hook's confirmation path.
// Minimum regression: BYOK custom ASR, missing config/key, legacy providers tab.
describe('useVendorAuthGate voice input recovery', () => {
  type VoiceReadiness = Awaited<ReturnType<typeof window.electronAPI.voiceInput.getReadiness>>;
  const missingCustomConfig: VoiceReadiness = {
    ok: false,
    serviceMode: 'byok',
    provider: 'custom-realtime-asr',
    providerModel: 'custom-realtime-asr',
    auth: 'api-key',
    settingsTab: 'providers',
    failureReason: 'custom-asr-config-missing',
  };

  function mockVoiceInput(readiness: VoiceReadiness, cached: VoiceReadiness | null = null) {
    const getReadiness = vi.fn(async () => readiness);
    vi.stubGlobal('electronAPI', {
      voiceInput: { getReadinessCached: () => cached, getReadiness },
    });
    return getReadiness;
  }

  it.each([
    [{}, 'settings.voiceInput.serviceSource.credentialError.customAsrConfigMissing', 'voice-input'],
    [{ failureReason: 'custom-asr-key-missing' }, 'settings.voiceInput.serviceSource.credentialError.customAsrKeyMissing', 'voice-input'],
    [{ serviceMode: 'cindy', provider: 'litellm-gpt-realtime-whisper', failureReason: undefined }, 'voiceInputOverlay.cindyServiceUnavailable', 'voice-input'],
    [{ auth: 'codex', provider: 'openai-realtime-whisper', failureReason: 'codex-realtime-unsupported' }, 'settings.voiceInput.serviceSource.credentialError.codexRealtimeUnsupported', 'voice-input'],
    [{ auth: 'codex', provider: 'openai-realtime-whisper', failureReason: undefined }, 'settings.voiceInput.serviceSource.credentialError.codexMissing', 'providers'],
    [{ provider: 'elevenlabs-scribe-realtime', failureReason: undefined }, 'settings.voiceInput.serviceSource.credentialError.elevenlabsMissing', 'voice-input'],
    [{ provider: 'litellm-gpt-realtime-whisper', failureReason: undefined }, 'settings.voiceInput.serviceSource.credentialError.gatewayMissing', 'providers'],
  ] satisfies [Partial<VoiceReadiness>, string, string][])(
    'explains %j and opens its recovery settings', async (overrides, messageKey, settingsTab) => {
      mockVoiceInput({ ...missingCustomConfig, ...overrides });
      const { result } = renderHook(() => useVendorAuthGate());

      await expect(result.current.checkAndConfirm('codex', { purpose: 'voice-input' }))
        .resolves.toEqual({ proceed: false });
      expect(confirm).toHaveBeenCalledExactlyOnceWith({
        title: 'settings.voiceInput.title',
        description: messageKey,
        confirmText: 'logic.confirm.goToSettings',
        cancelText: 'logic.confirm.cancel',
        autoFocusConfirm: true,
      });
      expect(navigate).toHaveBeenCalledExactlyOnceWith(`/settings?tab=${settingsTab}`);
    },
  );

  it('cancels without navigating or starting voice input', async () => {
    mockVoiceInput(missingCustomConfig);
    confirm.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('codex', { purpose: 'voice-input' }))
      .resolves.toEqual({ proceed: false });
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([false, true])('allows a ready service (cached=%s) without prompting', async (cached) => {
    const ready = { ...missingCustomConfig, ok: true, failureReason: undefined };
    const getReadiness = mockVoiceInput(ready, cached ? ready : missingCustomConfig);
    const { result } = renderHook(() => useVendorAuthGate());

    await expect(result.current.checkAndConfirm('codex', { purpose: 'voice-input' }))
      .resolves.toEqual({ proceed: true });
    expect(getReadiness).toHaveBeenCalledTimes(cached ? 0 : 1);
    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
