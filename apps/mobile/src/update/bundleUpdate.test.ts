import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  evaluateBundleUpdate,
  parseLatestRelease,
  preferredInstallUrl,
  shouldCheckBundleUpdate,
} from './bundleUpdate';

const VALID = {
  version: '1.2.0',
  buildNumber: '2026070101',
  runtimeVersion: 'rtv-new',
  installUrl: 'https://npkg.example.com/install/42',
  itmsUrl: 'itms-services://?action=download-manifest&url=https%3A%2F%2Fx%2Fplist%2F42',
};

describe('shouldCheckBundleUpdate', () => {
  it.each([
    ['非自建分发', false, false, false, false],
    ['正式自建分发', true, false, false, true],
    ['审核模式', true, true, false, false],
    ['TestFlight', true, false, true, false],
  ] as const)(
    '%s → %s',
    (_label, isSelfHosted, isReviewMode, isTestFlightBuild, expected) => {
      expect(shouldCheckBundleUpdate({
        isSelfHosted,
        isReviewMode,
        isTestFlightBuild,
      })).toBe(expected);
    },
  );
});

describe('parseLatestRelease', () => {
  it('接受完整记录', () => {
    expect(parseLatestRelease(VALID)?.runtimeVersion).toBe('rtv-new');
  });
  it('缺 runtimeVersion 或安装地址 → null', () => {
    expect(parseLatestRelease({ ...VALID, runtimeVersion: '' })).toBeNull();
    expect(parseLatestRelease({ ...VALID, installUrl: '', itmsUrl: '' })).toBeNull();
  });
  it('非对象 → null', () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('x')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('语义化比较', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('2.0', '1.9.9')).toBe(1);
  });
});

describe('evaluateBundleUpdate', () => {
  it('runtimeVersion 相同 → 无整包更新(交给 JS OTA)', () => {
    const r = evaluateBundleUpdate({ currentRuntimeVersion: 'rtv-new', currentVersion: '1.1.0', latest: VALID });
    expect(r.needsUpdate).toBe(false);
    expect(r.target).toBeNull();
  });

  it('runtimeVersion 不同 → 需要整包更新', () => {
    const r = evaluateBundleUpdate({ currentRuntimeVersion: 'rtv-old', currentVersion: '1.1.0', latest: VALID });
    expect(r.needsUpdate).toBe(true);
    expect(r.forced).toBe(false);
    expect(r.target?.itmsUrl).toBe(VALID.itmsUrl);
  });

  it('minVersion 高于当前 → 强制', () => {
    const r = evaluateBundleUpdate({
      currentRuntimeVersion: 'rtv-old',
      currentVersion: '1.0.0',
      latest: { ...VALID, minVersion: '1.2.0' },
    });
    expect(r.needsUpdate).toBe(true);
    expect(r.forced).toBe(true);
  });

  it('minVersion 不高于当前 → 不强制', () => {
    const r = evaluateBundleUpdate({
      currentRuntimeVersion: 'rtv-old',
      currentVersion: '1.2.0',
      latest: { ...VALID, minVersion: '1.2.0' },
    });
    expect(r.forced).toBe(false);
  });

  it('runtimeVersion 相同但低于 minVersion → 仍然强更(门槛不经指纹门闸)', () => {
    // 服务端可以对某个已发布版本事后下发门槛;此时装机指纹与 /latest 一致,但 version
    // 低于门槛 —— 必须命中强更,否则发布链写了 minVersion 也拦不住同指纹的旧构建。
    const r = evaluateBundleUpdate({
      currentRuntimeVersion: 'rtv-new',
      currentVersion: '1.0.0',
      latest: { ...VALID, minVersion: '1.2.0' },
    });
    expect(r.needsUpdate).toBe(true);
    expect(r.forced).toBe(true);
    // 同指纹强更时 target.runtimeVersion 就等于当前值,消费方不得据此判断"换了指纹"。
    expect(r.target?.runtimeVersion).toBe('rtv-new');
  });

  it('runtimeVersion 相同且不低于 minVersion → 无更新', () => {
    const r = evaluateBundleUpdate({
      currentRuntimeVersion: 'rtv-new',
      currentVersion: '1.2.0',
      latest: { ...VALID, minVersion: '1.2.0' },
    });
    expect(r.needsUpdate).toBe(false);
    expect(r.target).toBeNull();
  });

  it('record 缺 version 但带 minVersion → 不强更(退化成普通提示,不造无法自愈的阻断)', () => {
    // 无目标版本就无法证明"装上它能解除阻断",阻断态的自愈也失去比较基准。
    // 发布链侧 assertMinVersionUsable 已保证有 minVersion 必有 version,这里是客户端兜底。
    const r = evaluateBundleUpdate({
      currentRuntimeVersion: 'rtv-old',
      currentVersion: '1.0.0',
      latest: { ...VALID, version: '', minVersion: '1.2.0' },
    });
    expect(r.forced).toBe(false);
    expect(r.needsUpdate).toBe(true); // runtimeVersion 不同 → 仍是可跳过的普通更新
  });

  it('minVersion 高于该记录自己的 version → 不强更(装完仍低于门槛,阻断屏会没有出口)', () => {
    // 发布链侧 assertMinVersionUsable 已禁止这种记录;客户端兜底手工改过 / 历史遗留的指针。
    const r = evaluateBundleUpdate({
      currentRuntimeVersion: 'rtv-old',
      currentVersion: '1.0.0',
      latest: { ...VALID, version: '1.1.0', minVersion: '1.2.0' },
    });
    expect(r.forced).toBe(false);
    expect(r.needsUpdate).toBe(true); // 仍是可跳过的普通更新
  });

  it('minVersion 等于该记录的 version → 正常强更(边界)', () => {
    const r = evaluateBundleUpdate({
      currentRuntimeVersion: 'rtv-old',
      currentVersion: '1.0.0',
      latest: { ...VALID, version: '1.2.0', minVersion: '1.2.0' },
    });
    expect(r.forced).toBe(true);
  });

  it('缺 currentVersion → 不强更(无法比较,fail-open)', () => {
    const r = evaluateBundleUpdate({
      currentRuntimeVersion: 'rtv-new',
      currentVersion: null,
      latest: { ...VALID, minVersion: '1.2.0' },
    });
    expect(r.needsUpdate).toBe(false);
    expect(r.forced).toBe(false);
  });

  it('拿不到当前 runtimeVersion(dev / 未启用)→ 无更新', () => {
    expect(evaluateBundleUpdate({ currentRuntimeVersion: null, currentVersion: '1.0.0', latest: VALID }).needsUpdate).toBe(false);
    expect(evaluateBundleUpdate({ currentRuntimeVersion: '', currentVersion: '1.0.0', latest: VALID }).needsUpdate).toBe(false);
  });

  it('/latest 无效 → 无更新', () => {
    expect(evaluateBundleUpdate({ currentRuntimeVersion: 'rtv-old', currentVersion: '1.0.0', latest: {} }).needsUpdate).toBe(false);
  });
});

describe('preferredInstallUrl', () => {
  it('优先 itms,回退 installUrl', () => {
    expect(preferredInstallUrl(VALID)).toBe(VALID.itmsUrl);
    expect(preferredInstallUrl({ installUrl: 'https://web' })).toBe('https://web');
    expect(preferredInstallUrl({})).toBeNull();
  });
});
