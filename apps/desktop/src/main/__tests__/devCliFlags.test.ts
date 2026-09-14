import { describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  isIsolatedIdentityOnProductionProfile,
  resolveDevCliFlags,
  resolveDevProfileKind,
  resolveSingleInstanceLockUserDataDir,
  shouldEnforcePassiveMigrationCompatibility,
  shouldRequestSingleInstanceLock,
} from '../devCliFlags';


// Windows 上创建 symlink 需要管理员或开发者模式;拿不到权限时(EPERM)按仓内
// endpointManifestCache.test.ts 同款探测一次并降级 symlink 相关断言,其余检查照跑
// (review 反馈第三十六轮)。
const canSymlink = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'cindy-symlink-probe-'));
  try {
    symlinkSync(join(probeDir, 'target'), join(probeDir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

const base = {
  argv: ['electron', '.'] as readonly string[],
  isPackaged: false,
  envUserDataDir: undefined as string | undefined,
  defaultUserDataDir: '/AppData/Cindy',
  appDataDir: '/AppData',
  envIsolated: undefined as string | undefined,
  envIsolationName: undefined as string | undefined,
  envUserDataDirEpoch: undefined as string | undefined,
  envDeviceIdOverride: undefined as string | undefined,
  envSchedulerPassive: undefined as string | undefined,
  envEndpointsCdn: undefined as string | undefined,
};

describe('resolveDevCliFlags', () => {
  it('无参数无 env = 原行为(不覆写、不被动、不派生设备标识)', () => {
    expect(resolveDevCliFlags(base)).toEqual({
      schedulerPassive: false,
      isolated: false,
      profileKind: 'production-shared',
      isolatedOnProductionProfile: false,
      userDataDirOverride: null,
      isolatedDirIsEpochDerived: false,
      needsIsolatedDeviceId: false,
      isolationName: null,
      invalidIsolationName: null,
      endpointsCdn: false,
    });
  });

  it('原生自定义 userData 默认目录不是正式 profile', () => {
    const flags = resolveDevCliFlags({
      ...base,
      defaultUserDataDir: '/tmp/custom-profile',
    });
    expect(flags.profileKind).toBe('custom');
    expect(flags.isolatedOnProductionProfile).toBe(false);
    expect(flags.userDataDirOverride).toBeNull();
  });

  it('原生 --user-data-dir 自定义默认 + XDT_USER_DATA_DIR 指向正式目录,仍判正式 profile',
    () => {
      const flags = resolveDevCliFlags({
        ...base,
        defaultUserDataDir: '/tmp/custom-profile',
        appDataDir: '/AppData',
        argv: [...base.argv, '--isolated'],
        envUserDataDir: '/AppData/Cindy',
      });
      expect(flags.profileKind).toBe('production-shared');
      expect(flags.isolatedOnProductionProfile).toBe(true);
      expect(flags.needsIsolatedDeviceId).toBe(true);
    },
  );

  it('--passive 只开被动,不动 userData / 设备标识', () => {
    const flags = resolveDevCliFlags({ ...base, argv: [...base.argv, '--passive'] });
    expect(flags.schedulerPassive).toBe(true);
    expect(flags.isolated).toBe(false);
    expect(flags.userDataDirOverride).toBeNull();
    expect(flags.needsIsolatedDeviceId).toBe(false);
  });

  it('XDT_SCHEDULER_PASSIVE=1 与 --passive 等价，其他字符串不误开启', () => {
    expect(resolveDevCliFlags({ ...base, envSchedulerPassive: '1' }).schedulerPassive).toBe(true);
    for (const value of ['0', 'false', 'true']) {
      expect(resolveDevCliFlags({ ...base, envSchedulerPassive: value }).schedulerPassive).toBe(
        false,
      );
    }
  });

  it('CindyDev 纪元判定:派生路径与 env 传入同一路径命中,自定义目录不命中', () => {
    // 标准 restart 脚本流程经 env 传入与派生一字不差的路径 → 命中;用户显式指向
    // 其它目录 → 不命中(不标记 CindyDev,防多启动形态双身份互踩)。
    const derived = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated'] });
    expect(derived.isolatedDirIsEpochDerived).toBe(true);
    const viaEnvSame = resolveDevCliFlags({
      ...base,
      envIsolated: '1',
      envUserDataDir: '/AppData/Cindy-dev2',
      envUserDataDirEpoch: '1',
    });
    expect(viaEnvSame.isolatedDirIsEpochDerived).toBe(true);
    // 同一路径但没有可信纪元信号(人肉覆写 / 旧 checkout 形态)→ 观察模式:
    // 旧代码不认标记、以默认身份打开同一显式路径,认领 CindyDev 会双身份互写
    // (#912 review P1 第三十二轮)。
    const viaEnvUntrusted = resolveDevCliFlags({
      ...base,
      envIsolated: '1',
      envUserDataDir: '/AppData/Cindy-dev2',
    });
    expect(viaEnvUntrusted.isolatedDirIsEpochDerived).toBe(false);
    const custom = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated'],
      envUserDataDir: '/tmp/my-own-dir',
    });
    expect(custom.isolated).toBe(true);
    expect(custom.isolatedDirIsEpochDerived).toBe(false);
    const notIsolated = resolveDevCliFlags({ ...base, envUserDataDir: '/AppData/Cindy-dev2' });
    expect(notIsolated.isolatedDirIsEpochDerived).toBe(false);
  });

  it('纪元判定按规范化路径:尾斜杠 / "." 段的等价写法同样命中(#912 review P2 第十九轮)', () => {
    // 字符串全等会把标准纪元目录的等价写法误判成"其它目录"→ 观察模式给空沙箱
    // 抢注默认身份标记,该沙箱永久回到共享 Cindy 钥匙串。
    for (const dir of [
      '/AppData/Cindy-dev2/',
      '/AppData/./Cindy-dev2',
      '/AppData/other/../Cindy-dev2',
    ]) {
      const flags = resolveDevCliFlags({
        ...base,
        envIsolated: '1',
        envUserDataDir: dir,
        envUserDataDirEpoch: '1',
      });
      expect(flags.isolatedDirIsEpochDerived, dir).toBe(true);
      // 覆写值本身保持原样传递(app.setPath 消化),只有判等做规范化。
      expect(flags.userDataDirOverride, dir).toBe(dir);
    }
    // 真正的不同目录(前缀相同的兄弟目录)不受规范化影响,仍不命中。
    const sibling = resolveDevCliFlags({
      ...base,
      envIsolated: '1',
      envUserDataDir: '/AppData/Cindy-dev2-extra',
      envUserDataDirEpoch: '1',
    });
    expect(sibling.isolatedDirIsEpochDerived).toBe(false);
  });

  it('大小写判定交给文件系统真值:不敏感卷收敛同一目录,敏感卷保持不同(#912 review 第二十/二十一轮)', () => {
    // 大小写不敏感卷(macOS 默认 APFS / NTFS):realpath 把等价写法收敛到磁盘真实
    // 大小写 → 命中;大小写敏感卷:仅大小写不同的是另一个真实目录,标成纪元目录
    // 会让不认标记的旧 checkout 与 CindyDev 身份互写密文 → 必须不命中。
    const insensitiveVolume = (p: string) => p.toLowerCase();
    const hit = resolveDevCliFlags({
      ...base,
      envIsolated: '1',
      envUserDataDir: '/AppData/CINDY-DEV2',
      envUserDataDirEpoch: '1',
      canonicalizePath: insensitiveVolume,
    });
    expect(hit.isolatedDirIsEpochDerived).toBe(true);
    const sensitiveVolume = (p: string) => p;
    const miss = resolveDevCliFlags({
      ...base,
      envIsolated: '1',
      envUserDataDir: '/AppData/CINDY-DEV2',
      envUserDataDirEpoch: '1',
      canonicalizePath: sensitiveVolume,
    });
    expect(miss.isolatedDirIsEpochDerived).toBe(false);
    // 缺省实现:路径与全部有字母的祖先都不存在时无从探测卷语义 → 保守不折叠
    // (/AppData 在测试机不存在,最近存在祖先是根目录,无字母可翻转)。
    const unprobeable = resolveDevCliFlags({
      ...base,
      envIsolated: '1',
      envUserDataDir: '/AppData/CINDY-DEV2',
      envUserDataDirEpoch: '1',
    });
    expect(unprobeable.isolatedDirIsEpochDerived).toBe(false);
  });

  it('缺省实现:首启(目录不存在)按最近存在祖先的卷语义探测(#912 review P2 第二十二轮)', () => {
    // 在真实文件系统上建一个临时祖先目录:目标 -dev2 目录不存在,大小写变体写法
    // 是否命中应跟随该卷的真实语义——macOS 默认 APFS(不敏感)命中,linux(敏感)
    // 不命中。期望值用同一套"翻转大小写后是否同一目录"探测独立求得,不猜平台。
    const ancestor = mkdtempSync(join(tmpdir(), 'epoch-vol-Probe-'));
    try {
      const flippedAncestor = join(
        dirname(ancestor),
        basename(ancestor).replace(/[a-zA-Z]/g, (ch) =>
          ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(),
        ),
      );
      let volumeInsensitive = false;
      try {
        volumeInsensitive =
          realpathSync.native(flippedAncestor) === realpathSync.native(ancestor);
      } catch {
        volumeInsensitive = false;
      }
      const flags = resolveDevCliFlags({
        ...base,
        defaultUserDataDir: join(ancestor, 'xdt-maker'),
        envIsolated: '1',
        envUserDataDir: join(ancestor, 'XDT-MAKER-DEV2'),
      envUserDataDirEpoch: '1',
      });
      expect(flags.isolatedDirIsEpochDerived).toBe(volumeInsensitive);
      // 祖先是符号链接:canonical 以链接目标(realpath)为基,链接写法与真身
      // 写法收敛到同一纪元路径(卷语义也按目标卷探测,#912 review P1 第二十四轮)。
      const linkAncestor = join(dirname(ancestor), `${basename(ancestor)}-link`);
      if (canSymlink) {
        symlinkSync(ancestor, linkAncestor);
        try {
          const viaLink = resolveDevCliFlags({
            ...base,
            defaultUserDataDir: join(ancestor, 'xdt-maker'),
            envIsolated: '1',
            envUserDataDir: join(linkAncestor, 'xdt-maker-dev2'),
            envUserDataDirEpoch: '1',
          });
          expect(viaLink.isolatedDirIsEpochDerived).toBe(true);
        } finally {
          // 指向目录的 symlink 要走 rmdir 语义:不带 recursive 的 rmSync 按
          // unlink 处理,Windows 上直接抛 EISDIR(Path is a directory),把整个
          // pnpm test:unit 门禁带红。只有拿到 symlink 权限的开发机(canSymlink
          // 为 true)会走到这里,CI 拿不到权限所以看不见这条。recursive 对
          // symlink 只删链接本身,不跟随进目标目录(已实测)。
          rmSync(linkAncestor, { recursive: true, force: true });
        }
      }
      // TOCTOU 稳定性:目录被并发进程创建前后,同一写法的判定结果一致——
      // 存在与不存在分支产出同一种规范形式(#912 review P1 第二十六轮)。
      const variantInput = {
        ...base,
        defaultUserDataDir: join(ancestor, 'xdt-maker'),
        envIsolated: '1',
        envUserDataDir: join(ancestor, 'XDT-MAKER-DEV2'),
      envUserDataDirEpoch: '1',
      };
      const beforeCreate = resolveDevCliFlags(variantInput).isolatedDirIsEpochDerived;
      mkdirSync(join(ancestor, 'xdt-maker-dev2'));
      try {
        const afterCreate = resolveDevCliFlags(variantInput).isolatedDirIsEpochDerived;
        expect(afterCreate).toBe(beforeCreate);
      } finally {
        rmSync(join(ancestor, 'xdt-maker-dev2'), { recursive: true, force: true });
      }
      // 等价写法(尾斜杠)在同一缺省实现下不受卷语义影响,恒命中。
      const slash = resolveDevCliFlags({
        ...base,
        defaultUserDataDir: join(ancestor, 'xdt-maker'),
        envIsolated: '1',
        envUserDataDir: join(ancestor, 'xdt-maker-dev2') + '/',
      envUserDataDirEpoch: '1',
      });
      expect(slash.isolatedDirIsEpochDerived).toBe(true);
    } finally {
      rmSync(ancestor, { recursive: true, force: true });
    }
  });

  it('--isolated 默认沙箱:目录 <userData>-dev2,要求派生设备标识,无名字', () => {
    const flags = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated'] });
    expect(flags.userDataDirOverride).toBe('/AppData/Cindy-dev2');
    expect(flags.isolated).toBe(true);
    expect(flags.needsIsolatedDeviceId).toBe(true);
    expect(flags.isolationName).toBeNull();
  });

  it('--isolated=<名字> 命名沙箱:目录 <userData>-dev2-<名字>,带出名字', () => {
    const flags = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated=feature-a'] });
    expect(flags.userDataDirOverride).toBe('/AppData/Cindy-dev2-feature-a');
    expect(flags.needsIsolatedDeviceId).toBe(true);
    expect(flags.isolationName).toBe('feature-a');
    expect(flags.invalidIsolationName).toBeNull();
  });

  it('--isolated=<非法名字> 回落默认沙箱并带出非法名(不回落到不隔离)', () => {
    const bad = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated=我的沙箱'] });
    expect(bad.userDataDirOverride).toBe('/AppData/Cindy-dev2');
    expect(bad.needsIsolatedDeviceId).toBe(true);
    expect(bad.isolationName).toBeNull();
    expect(bad.invalidIsolationName).toBe('我的沙箱');
    // 超长(33 字符)同样非法
    const long = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, `--isolated=${'a'.repeat(33)}`],
    });
    expect(long.invalidIsolationName).toBe('a'.repeat(33));
    expect(long.userDataDirOverride).toBe('/AppData/Cindy-dev2');
  });

  it('XDT_ISOLATED=1(restart 脚本默认沙箱路径)等价 --isolated', () => {
    const flags = resolveDevCliFlags({ ...base, envIsolated: '1' });
    expect(flags.userDataDirOverride).toBe('/AppData/Cindy-dev2');
    expect(flags.needsIsolatedDeviceId).toBe(true);
    expect(flags.isolationName).toBeNull();
  });

  it('XDT_ISOLATED=1 + XDT_ISOLATED_NAME(restart 脚本命名沙箱路径)等价 --isolated=<名字>', () => {
    const flags = resolveDevCliFlags({ ...base, envIsolated: '1', envIsolationName: 'feature-b' });
    expect(flags.userDataDirOverride).toBe('/AppData/Cindy-dev2-feature-b');
    expect(flags.isolationName).toBe('feature-b');
  });

  it('名叫 "1" 的沙箱不与开关标记值撞车(codex review P2 回归)', () => {
    // argv 路径
    const viaArgv = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated=1'] });
    expect(viaArgv.isolationName).toBe('1');
    expect(viaArgv.userDataDirOverride).toBe('/AppData/Cindy-dev2-1');
    // restart env 路径:开关与名字分离,名字 '1' 原样生效
    const viaEnv = resolveDevCliFlags({ ...base, envIsolated: '1', envIsolationName: '1' });
    expect(viaEnv.isolationName).toBe('1');
    expect(viaEnv.userDataDirOverride).toBe('/AppData/Cindy-dev2-1');
  });

  it('XDT_ISOLATED 开关严格等于 "1" 才生效("0"/"false"/名字串都视为关)', () => {
    for (const v of ['0', 'false', 'true', 'feature-b']) {
      const flags = resolveDevCliFlags({ ...base, envIsolated: v });
      expect(flags.userDataDirOverride).toBeNull();
      expect(flags.needsIsolatedDeviceId).toBe(false);
    }
  });

  it('env 名字非法时回落默认沙箱并带出非法名', () => {
    const flags = resolveDevCliFlags({ ...base, envIsolated: '1', envIsolationName: '我的沙箱' });
    expect(flags.userDataDirOverride).toBe('/AppData/Cindy-dev2');
    expect(flags.invalidIsolationName).toBe('我的沙箱');
  });

  it('argv 的隔离意图优先于 env(两条入口同时给时不混合)', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated=from-argv'],
      envIsolated: '1',
      envIsolationName: 'from-env',
    });
    expect(flags.isolationName).toBe('from-argv');
  });

  it('空白 XDT_USER_DATA_DIR 视作未设置:--isolated 回落默认沙箱目录', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated'],
      envUserDataDir: '   ',
    });
    expect(flags.userDataDirOverride).toBe('/AppData/Cindy-dev2');
  });

  it('显式 XDT_DEVICE_ID_OVERRIDE 时隔离模式不再派生设备标识', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated=feature-a'],
      envDeviceIdOverride: 'my-device',
    });
    expect(flags.needsIsolatedDeviceId).toBe(false);
    // 空白串视作未设置,仍要派生
    const blank = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated'],
      envDeviceIdOverride: '   ',
    });
    expect(blank.needsIsolatedDeviceId).toBe(true);
  });

  it('显式 XDT_USER_DATA_DIR 优先于沙箱默认目录(设备标识照常派生)', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated=feature-a'],
      envUserDataDir: '/custom/sandbox',
    });
    expect(flags.userDataDirOverride).toBe('/custom/sandbox');
    expect(flags.needsIsolatedDeviceId).toBe(true);
    expect(flags.profileKind).toBe('custom');
    expect(flags.isolatedOnProductionProfile).toBe(false);
  });

  it('--isolated + 正式 profile 目录判定为非法第三态', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated'],
      envUserDataDir: '/AppData/Cindy',
    });
    expect(flags.isolated).toBe(true);
    expect(flags.needsIsolatedDeviceId).toBe(true);
    expect(flags.profileKind).toBe('production-shared');
    expect(flags.isolatedOnProductionProfile).toBe(true);
    expect(flags.isolatedDirIsEpochDerived).toBe(false);
  });

  it('--isolated 指向另一地区正式目录也是非法第三态', () => {
    const toCn = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated'],
      envUserDataDir: '/AppData/Cindy',
    });
    expect(toCn.profileKind).toBe('production-shared');
    expect(toCn.isolatedOnProductionProfile).toBe(true);
    expect(toCn.needsIsolatedDeviceId).toBe(true);

    const toGlobal = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated'],
      envUserDataDir: '/AppData/CindyGlobal',
    });
    expect(toGlobal.profileKind).toBe('production-shared');
    expect(toGlobal.isolatedOnProductionProfile).toBe(true);
  });

  it('--isolated 默认沙箱是 isolated-sandbox,不是正式 profile', () => {
    const flags = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated'] });
    expect(flags.profileKind).toBe('isolated-sandbox');
    expect(flags.isolatedOnProductionProfile).toBe(false);
  });

  it('仅设 XDT_USER_DATA_DIR(无隔离意图)沿用原语义,不派生设备标识', () => {
    // device-link 多实例联调的既有工作流:userData 与 deviceId 由用户各自显式控制。
    const flags = resolveDevCliFlags({ ...base, envUserDataDir: '/custom/sandbox' });
    expect(flags.userDataDirOverride).toBe('/custom/sandbox');
    expect(flags.needsIsolatedDeviceId).toBe(false);
  });

  it('packaged 版本一律不覆写(线上零影响)', () => {
    const flags = resolveDevCliFlags({
      ...base,
      isPackaged: true,
      argv: [...base.argv, '--passive', '--isolated=feature-a'],
      envUserDataDir: '/custom/sandbox',
      envIsolated: '1',
      envIsolationName: 'feature-b',
    });
    expect(flags).toEqual({
      schedulerPassive: false,
      isolated: false,
      profileKind: 'production-shared',
      isolatedOnProductionProfile: false,
      userDataDirOverride: null,
      isolatedDirIsEpochDerived: false,
      needsIsolatedDeviceId: false,
      isolationName: null,
      invalidIsolationName: null,
      endpointsCdn: false,
    });
  });

  it('--endpoints-cdn / XDT_ENDPOINTS_CDN=1 双通道(与 --passive 同款);开关非 "1" 视为关', () => {
    expect(
      resolveDevCliFlags({ ...base, argv: [...base.argv, '--endpoints-cdn'] }).endpointsCdn,
    ).toBe(true);
    expect(resolveDevCliFlags({ ...base, envEndpointsCdn: '1' }).endpointsCdn).toBe(true);
    for (const v of ['0', 'false', 'true', 'yes']) {
      expect(resolveDevCliFlags({ ...base, envEndpointsCdn: v }).endpointsCdn).toBe(false);
    }
    // packaged 恒 false(packaged 本来就走 CDN,该标志无意义)
    const packaged = resolveDevCliFlags({
      ...base,
      isPackaged: true,
      argv: [...base.argv, '--endpoints-cdn'],
      envEndpointsCdn: '1',
    });
    expect(packaged.endpointsCdn).toBe(false);
  });

  it('--passive 与命名沙箱可组合', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--passive', '--isolated=feature-a'],
    });
    expect(flags.schedulerPassive).toBe(true);
    expect(flags.isolated).toBe(true);
    expect(flags.profileKind).toBe('isolated-sandbox');
    expect(flags.userDataDirOverride).toBe('/AppData/Cindy-dev2-feature-a');
    expect(flags.isolationName).toBe('feature-a');
  });
});

describe('resolveDevProfileKind / isIsolatedIdentityOnProductionProfile', () => {
  it('正式目录一律是 production-shared,isolated 旗标不能把它变成沙箱', () => {
    expect(
      resolveDevProfileKind({
        isolatedDirIsEpochDerived: false,
        effectiveUserDataDir: '/AppData/Cindy',
        productionUserDataDir: '/AppData/Cindy',
      }),
    ).toBe('production-shared');
    expect(
      isIsolatedIdentityOnProductionProfile({
        isolated: true,
        effectiveUserDataDir: '/AppData/Cindy',
        productionUserDataDir: '/AppData/Cindy',
      }),
    ).toBe(true);
  });

  it('另一地区正式目录也算正式 profile,不能当成 custom', () => {
    expect(
      resolveDevProfileKind({
        isolatedDirIsEpochDerived: false,
        effectiveUserDataDir: '/AppData/Cindy',
        productionUserDataDir: '/AppData/CindyGlobal',
      }),
    ).toBe('production-shared');
    expect(
      resolveDevProfileKind({
        isolatedDirIsEpochDerived: false,
        effectiveUserDataDir: '/AppData/CindyGlobal',
        productionUserDataDir: '/AppData/Cindy',
      }),
    ).toBe('production-shared');
    expect(
      isIsolatedIdentityOnProductionProfile({
        isolated: true,
        effectiveUserDataDir: '/AppData/Cindy',
        productionUserDataDir: '/AppData/CindyGlobal',
      }),
    ).toBe(true);
  });
});

describe('shouldEnforcePassiveMigrationCompatibility', () => {
  it('对正式 profile 与非隔离 custom 的 passive 启用，沙箱 / packaged 不启用', () => {
    expect(
      shouldEnforcePassiveMigrationCompatibility({
        isPackaged: false,
        schedulerPassive: true,
        profileKind: 'production-shared',
      }),
    ).toBe(true);
    expect(
      shouldEnforcePassiveMigrationCompatibility({
        isPackaged: false,
        schedulerPassive: true,
        profileKind: 'custom',
      }),
    ).toBe(true);
    expect(
      shouldEnforcePassiveMigrationCompatibility({
        isPackaged: false,
        schedulerPassive: true,
        profileKind: 'isolated-sandbox',
      }),
    ).toBe(false);
    expect(
      shouldEnforcePassiveMigrationCompatibility({
        isPackaged: true,
        schedulerPassive: true,
        profileKind: 'production-shared',
      }),
    ).toBe(false);
  });
});

describe('shouldRequestSingleInstanceLock', () => {
  it('正常 dev 与 packaged 都保持单实例', () => {
    expect(shouldRequestSingleInstanceLock({ isPackaged: false, schedulerPassive: false })).toBe(
      true,
    );
    expect(shouldRequestSingleInstanceLock({ isPackaged: true, schedulerPassive: false })).toBe(
      true,
    );
  });

  it('所有 passive dev 都跳过锁，允许多个 dev 与正式版共享同一 userData', () => {
    const passivePreviews = Array.from({ length: 3 }, () =>
      shouldRequestSingleInstanceLock({ isPackaged: false, schedulerPassive: true }),
    );
    expect(passivePreviews).toEqual([false, false, false]);
    // packaged 不接受 dev-only passive 语义，即使环境被污染也必须继续持锁。
    expect(shouldRequestSingleInstanceLock({ isPackaged: true, schedulerPassive: true })).toBe(
      true,
    );
  });
});

describe('resolveSingleInstanceLockUserDataDir', () => {
  const userDataDir = join('/AppData', 'Cindy');

  it('packaged 锁真实 userData(release 之间单实例)', () => {
    expect(resolveSingleInstanceLockUserDataDir({ isPackaged: true, userDataDir })).toBe(
      userDataDir,
    );
  });

  it('dev 锁独立子目录,与共库的 packaged 分域互不阻塞', () => {
    const devScope = resolveSingleInstanceLockUserDataDir({ isPackaged: false, userDataDir });
    expect(devScope).toBe(join(userDataDir, 'dev-single-instance-lock'));
    // 与 packaged 的锁域必须不同——dev + release 共享 userData 双开是明确支持的工作流。
    expect(devScope).not.toBe(
      resolveSingleInstanceLockUserDataDir({ isPackaged: true, userDataDir }),
    );
  });

  it('dev 之间同一 userData 得到同一锁域(深链 second-instance 去重仍有效)', () => {
    const a = resolveSingleInstanceLockUserDataDir({ isPackaged: false, userDataDir });
    const b = resolveSingleInstanceLockUserDataDir({ isPackaged: false, userDataDir });
    expect(a).toBe(b);
  });

  it('isolated 沙箱 userData 独立,锁域随之独立', () => {
    const sandbox = resolveSingleInstanceLockUserDataDir({
      isPackaged: false,
      userDataDir: join('/AppData', 'Cindy-dev-foo'),
    });
    expect(sandbox).toBe(join('/AppData', 'Cindy-dev-foo', 'dev-single-instance-lock'));
    expect(sandbox).not.toBe(resolveSingleInstanceLockUserDataDir({ isPackaged: false, userDataDir }));
  });
});
