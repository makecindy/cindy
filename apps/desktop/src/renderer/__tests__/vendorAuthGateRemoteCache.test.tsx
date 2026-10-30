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
vi.mock('@/hooks/useVendorReadiness', () => ({
  useVendorReadiness: () => ({ revalidate }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { getDeviceName: () => 'Mac mini' },
}));
vi.mock('@/hooks/useDeviceProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDeviceProviders')>()),
  getCachedDeviceProviders: (deviceId: string) => cachedProviders(deviceId),
}));

import { useVendorAuthGate } from '@/hooks/useVendorAuthGate';

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

const defaultInvoke = async (_deviceId: string, channel: string) => {
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
  vi.unstubAllGlobals();
  invoke.mockClear();
  confirm.mockClear();
  navigate.mockClear();
  revalidate.mockReset();
  cachedProviders.mockReset();
  cachedProviders.mockReturnValue(null);
});

describe('useVendorAuthGate device-link 来源快照复用', () => {
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
