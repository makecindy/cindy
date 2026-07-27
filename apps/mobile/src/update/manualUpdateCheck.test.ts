import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import {
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
    fetchOtaUpdate: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
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
      message: '无法检查整包更新，请稍后重试',
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
});
