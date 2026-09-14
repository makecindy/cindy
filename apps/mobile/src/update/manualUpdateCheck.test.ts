import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import {
  manualUpdateCheckMessage,
  runManualUpdateCheck,
  type BundleUpdateCheckOutcome,
  type ManualUpdateCheckDeps,
} from './manualUpdateCheck';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

/** 创建保留字面量结果类型的整包检查 mock。 */
const bundleCheck = (outcome: BundleUpdateCheckOutcome) =>
  vi.fn(async (): Promise<BundleUpdateCheckOutcome> => outcome);

/** 构造统一更新检查依赖,单测只覆写当前场景关心的能力。 */
function deps(overrides: Partial<ManualUpdateCheckDeps> = {}): ManualUpdateCheckDeps {
  return {
    otaEnabled: true,
    checkOtaUpdate: vi.fn(async () => ({ isAvailable: false })),
    fetchOtaUpdate: vi.fn(async () => ({ isNew: true })),
    reload: vi.fn(async () => undefined),
    isEmergencyLaunch: vi.fn(() => false),
    onPhase: vi.fn(),
    ...overrides,
  };
}

describe('runManualUpdateCheck', () => {
  it('stops after finding a full-package update', async () => {
    const input = deps({
      checkBundleUpdate: bundleCheck('update-available'),
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'bundle-update-available' });
    expect(input.checkBundleUpdate).toHaveBeenCalledOnce();
    expect(input.checkOtaUpdate).not.toHaveBeenCalled();
    expect(input.fetchOtaUpdate).not.toHaveBeenCalled();
  });

  it('checks and applies OTA only after the full package is current', async () => {
    const phases: string[] = [];
    const input = deps({
      checkBundleUpdate: bundleCheck('up-to-date'),
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
      onPhase: vi.fn((phase) => phases.push(phase)),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'reloading' });
    expect(phases).toEqual(['checking', 'downloading']);
    expect(input.checkBundleUpdate).toHaveBeenCalledOnce();
    expect(input.checkOtaUpdate).toHaveBeenCalledOnce();
    expect(input.fetchOtaUpdate).toHaveBeenCalledOnce();
    expect(input.reload).toHaveBeenCalledOnce();
  });

  it('reports current only after both update channels have no update', async () => {
    const input = deps({ checkBundleUpdate: bundleCheck('up-to-date') });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'up-to-date' });
    expect(input.checkOtaUpdate).toHaveBeenCalledOnce();
  });

  it('does not hide a failed full-package check by continuing to OTA', async () => {
    const input = deps({ checkBundleUpdate: bundleCheck('error') });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({
      kind: 'error',
      reason: 'bundle-check',
    });
    expect(input.checkOtaUpdate).not.toHaveBeenCalled();
  });

  it('keeps OTA checks available when the caller disables full-package checks', async () => {
    const input = deps();
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'up-to-date' });
    expect(input.checkOtaUpdate).toHaveBeenCalledOnce();
  });

  it('returns an explicit result when OTA is unavailable after the full-package check', async () => {
    const input = deps({
      checkBundleUpdate: bundleCheck('up-to-date'),
      otaEnabled: false,
    });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'ota-unavailable' });
    expect(input.checkOtaUpdate).not.toHaveBeenCalled();
  });

  it('skips OTA when consent is false at manifest time, before any request', async () => {
    const input = deps({
      checkBundleUpdate: bundleCheck('up-to-date'),
      isConsented: () => false,
    });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'ota-unavailable' });
    expect(input.checkOtaUpdate).not.toHaveBeenCalled();
  });

  it('re-checks consent before downloading after the manifest resolves', async () => {
    // manifest 请求期间用户登出撤销同意:下载前再问一次,不得继续拉取带标识的 bundle。
    let consented = true;
    const input = deps({
      isConsented: () => consented,
      checkOtaUpdate: vi.fn(async () => {
        consented = false;
        return { isAvailable: true };
      }),
    });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'ota-unavailable' });
    expect(input.checkOtaUpdate).toHaveBeenCalledOnce();
    expect(input.fetchOtaUpdate).not.toHaveBeenCalled();
  });

  it('自建线用同一个包装器覆盖完整 check → fetch → reload 事务', async () => {
    const wrappedCheck = vi.fn(async () => ({ isAvailable: true }));
    const wrappedFetch = vi.fn(async () => ({ isNew: true }));
    const wrappedReload = vi.fn(async () => undefined);
    const withOtaClient: NonNullable<ManualUpdateCheckDeps['withOtaClient']> =
      async (operation) => operation({
        checkForUpdateAsync: wrappedCheck,
        fetchUpdateAsync: wrappedFetch,
        reloadAsync: wrappedReload,
      });
    const input = deps({ withOtaClient });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'reloading' });
    expect(wrappedCheck).toHaveBeenCalledOnce();
    expect(wrappedFetch).toHaveBeenCalledOnce();
    expect(wrappedReload).toHaveBeenCalledOnce();
    expect(input.checkOtaUpdate).not.toHaveBeenCalled();
    expect(input.fetchOtaUpdate).not.toHaveBeenCalled();
    expect(input.reload).not.toHaveBeenCalled();
  });

  // emergency launch(没有 launchedUpdate)时 reloadAsync 会被原生层拒绝,但 bundle 已落盘:
  // 这不是一次失败的检查,必须导向"重开 App 生效",否则用户只看到一条无从下手的红字报错。
  it('asks for a manual restart when an emergency launch blocks reloading the downloaded bundle', async () => {
    const input = deps({
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
      fetchOtaUpdate: vi.fn(async () => ({ isNew: true })),
      reload: vi.fn(async () => {
        throw new Error("Call to function 'ExpoUpdates.reload' has been rejected.");
      }),
      isEmergencyLaunch: vi.fn(() => true),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'restart-required' });
    expect(input.fetchOtaUpdate).toHaveBeenCalledOnce();
    expect(input.reload).toHaveBeenCalledOnce();
  });

  it('does not reload when fetch reports that no new bundle was downloaded', async () => {
    const input = deps({
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
      fetchOtaUpdate: vi.fn(async () => ({ isNew: false })),
      reload: vi.fn(async () => {
        throw new Error('reload rejected');
      }),
      isEmergencyLaunch: vi.fn(() => true),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'up-to-date' });
    expect(input.reload).not.toHaveBeenCalled();
  });

  // 非应急启动下的 reload 失败原因未知,原始详情是唯一线索:不能被重启指引盖掉。
  it('keeps the reload failure detail when the app is not in an emergency launch', async () => {
    const input = deps({
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
      fetchOtaUpdate: vi.fn(async () => ({ isNew: true })),
      reload: vi.fn(async () => {
        throw new Error('Could not reload application; activity is null');
      }),
      isEmergencyLaunch: vi.fn(() => false),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({
      kind: 'error',
      reason: 'ota-check',
      detail: 'Could not reload application; activity is null',
    });
  });

  it('keeps OTA failure details unlocalized until the settings page renders them', async () => {
    const input = deps({
      checkOtaUpdate: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({
      kind: 'error',
      reason: 'ota-check',
      detail: 'offline',
    });
  });
});

describe('manualUpdateCheckMessage', () => {
  it('tells the user to fully reopen the app when reload was rejected', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(manualUpdateCheckMessage({ kind: 'restart-required' }, { isTestFlightBuild: false, t: i18n.t }))
      .toBe('更新已下载，完全退出 App 后重新打开即可生效');
  });

  it('uses the current language for an already completed TestFlight check', async () => {
    const outcome = { kind: 'up-to-date' } as const;

    await i18n.changeLanguage('zh-CN');
    expect(manualUpdateCheckMessage(outcome, { isTestFlightBuild: true, t: i18n.t }))
      .toBe('当前没有可用的内容更新。新测试版本请在 TestFlight 中查看。');

    await i18n.changeLanguage('en');
    expect(manualUpdateCheckMessage(outcome, { isTestFlightBuild: true, t: i18n.t }))
      .toBe('No content updates are available. Check TestFlight for new test builds.');
  });
});
