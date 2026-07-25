import { describe, expect, it } from 'vitest';
import { resolveRegionUserDataDirName } from '../regionUserData';

/**
 * 同机双装的核心不变量:cn 构建 / dev 完全不动 Electron 默认 userData
 * (线上 cn 包行为零变化),global packaged 构建切到独立目录。
 * 这个函数跑在 main 入口最早期,回归 = 两个区域的包共库串台(P0),
 * 所以把所有象限全部锁死。
 */
describe('resolveRegionUserDataDirName', () => {
  const ARGV = ['Cindy.exe'] as const;

  it('packaged + global → 覆写为 CindyGlobal(与 cn 分库)', () => {
    expect(
      resolveRegionUserDataDirName({ isPackaged: true, region: 'global', argv: ARGV }),
    ).toBe('CindyGlobal');
  });

  it('packaged + cn → null(区域目录名 = productName 默认,保持原生行为)', () => {
    expect(
      resolveRegionUserDataDirName({ isPackaged: true, region: 'cn', argv: ARGV }),
    ).toBeNull();
  });

  it('dev(非 packaged)任何区域都不覆写(隔离语义归 --isolated)', () => {
    expect(
      resolveRegionUserDataDirName({ isPackaged: false, region: 'cn', argv: ARGV }),
    ).toBeNull();
    expect(
      resolveRegionUserDataDirName({ isPackaged: false, region: 'global', argv: ARGV }),
    ).toBeNull();
  });

  it('显式 --user-data-dir(smoke 脚本临时目录)时不覆写,尊重调用方', () => {
    expect(
      resolveRegionUserDataDirName({
        isPackaged: true,
        region: 'global',
        argv: ['Cindy.exe', '--smoke-test', '--user-data-dir=C:\\tmp\\xdt-smoke-x'],
      }),
    ).toBeNull();
    // 空格分隔形态同样尊重。
    expect(
      resolveRegionUserDataDirName({
        isPackaged: true,
        region: 'global',
        argv: ['Cindy.exe', '--user-data-dir', 'C:\\tmp\\xdt-smoke-x'],
      }),
    ).toBeNull();
  });
});
