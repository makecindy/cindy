import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// sim-rebuild.mjs 是纯 dev 工具脚本(依赖 booted 模拟器 + Xcode,无法在 CI 里真跑),
// 用源码检查锁住两个提速机制的关键不变量,防止后续改动无意退化:
// 1. pod install 必须有界(超时 + SIGKILL)且显式 UTF-8 LANG —— 曾发生 CDN 连接
//    挂死干等 20 分钟、以及空 LANG 触发 CocoaPods Encoding::CompatibilityError。
// 2. fingerprint 产物缓存 —— 新 worktree 未动原生层时跳过整个冷构建。
describe('sim-rebuild script invariants', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/sim-rebuild.mjs'), 'utf8');

  it('runs pod install itself via the bounded runner, instead of letting prebuild own it', () => {
    expect(source).toContain('const buildEnv = withLocalMobileRegionConfig(');
    // prebuild 不再隐式跑 pod install(它的失败重试会带 --repo-update 打 CDN 且无界)。
    expect(source).toContain("['exec', 'expo', 'prebuild', '-p', 'ios', '--no-install']");
    // pod 执行策略(本地 specs 优先 / --repo-update 重试 / 空转看门狗 / UTF-8 LANG)
    // 收敛在 sim-pod-install.mjs,行为由 simPodInstall.test.ts 用假 pod 二进制真实覆盖。
    expect(source).toContain("import { podInstallBounded } from './sim-pod-install.mjs';");
    expect(source).toContain('await podInstallBounded({ iosDir, env: devProcessEnv })');
  });

  it('reuses built .app via the @expo/fingerprint cache with a force-build escape hatch', () => {
    // 计算失败必须降级为完整构建而不是中断。
    expect(source).toContain('回退完整构建');
    // 缓存键必须用**当前环境**算 fingerprint:ci-fingerprint 默认 runner 是
    // production 口径(剥离 EXPO_PUBLIC_*),而 prebuild 继承当前环境,beta 变体
    // (EXPO_PUBLIC_APP_VARIANT)会改原生 name——不跟 env 走会互相污染缓存。
    expect(source).toContain('run: runFingerprintWithCurrentEnv');
    expect(source).toContain('env: devProcessEnv');
    // --force-build 只跳过缓存"读",构建结果仍写回同一条目覆盖坏缓存;
    // 否则逃生舱跑完一次,坏条目还在,下次普通 rebuild 又命中它。
    expect(source).toContain("passthrough.includes('--force-build')");
    expect(source).toContain('if (cacheDir && !forceBuild) {');
    expect(source).toContain(
      'if (cacheDir) storeAppCacheEntry(cacheDir, scheme, app, readAppBundleIdentifier(app));',
    );
    // global 产物的 bundle id 不同于 app.json 默认 cn 值，必须从实际 .app 读。
    expect(source).toContain("'CFBundleIdentifier'");
    expect(source).toContain('const bundleId = readAppBundleIdentifier(app);');
    expect(source).toContain('readAppCacheEntry(cacheDir, simArch)');
    expect(source).toContain('assertAppSupportsArchitecture(app, simArch)');
    expect(source).toContain("capture('lipo', ['-archs'");
    // 缓存条目按 fingerprint + 架构定位,meta.json 是条目完整性标记。
    expect(source).toContain('sim-app-cache');
    expect(source).toContain('ios-${simArch}-${fingerprintHash}');
    expect(source).toContain("join(dir, 'meta.json')");
    // 有上限的 LRU 清理,不能无限积累 .app;且带最小年龄护栏,不删可能正被
    // 另一个并发 rebuild 使用的条目(命中方会先 touch mtime)。
    expect(source).toContain('APP_CACHE_KEEP');
    expect(source).toContain('entries.slice(APP_CACHE_KEEP)');
    expect(source).toContain('APP_CACHE_PRUNE_MIN_AGE_MS) continue;');
  });

  it('uses an exact simulator destination when the Host supplies a UDID', () => {
    expect(source).toContain("passthrough.indexOf('--udid')");
    expect(source).toContain('Simulator UUID');
    expect(source).toContain('`platform=iOS Simulator,id=${simulatorUdid}`');
    expect(source).toContain("'-destination', simulatorDestination");
  });
});
