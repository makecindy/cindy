const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const {
  assertMobileManifestBuildEnv,
  createMobileManifestBuildSnapshot,
} = require('../../scripts/shared/mobile-manifest-build-guard.cjs');

const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, '../..');
// Keep upload routing build-time-only, with the desktop validator as the single configuration source.
// Missing config is allowed for local/open-source builds; malformed or cross-region config is not.
const { mobileLogUploadBuildEnv, mobileLogUploadConfigRequired } = require('../../scripts/shared/log-upload-build-env.mjs');
Object.assign(process.env, mobileLogUploadBuildEnv({
  repoRoot: workspaceRoot,
  authRegion: process.env.EXPO_PUBLIC_CINDY_AUTH_REGION || 'global',
  allowMissing: !mobileLogUploadConfigRequired(),
}));
const workspaceNodeModules = path.join(workspaceRoot, 'node_modules');
const appNodeModules = path.join(__dirname, 'node_modules');
const sharedArrayBufferPolyfill = path.join(__dirname, 'src/polyfills/sharedArrayBuffer.js');

// 必须早于 Transformer 缓存键及 WorkerFarm 环境快照：仅在 transform 时校验 env
// 不能阻止已缓存的 Babel 结果内联旧地址。保留 Expo 既有 cacheVersion 并追加区域身份。
const manifestBuildSnapshot = createMobileManifestBuildSnapshot(process.env);
config.cacheVersion = `${config.cacheVersion}:${manifestBuildSnapshot.cacheKey}`;

const defaultGetTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (entryPoints, options, getDependencies) => {
  // dev 来自实际 bundle 请求，不能用 runner 的 NODE_ENV 代替：export:embed
  // 可能保留 NODE_ENV=development，仍在生成生产 bundle。开发 Metro / CindyDev
  // 保留端点覆盖；正式 bundle 的最终 env 必须与仓内两区清单一致。
  const authRegion = process.env.EXPO_PUBLIC_CINDY_AUTH_REGION?.trim();
  if (options.dev === false && authRegion !== 'dev') {
    if (authRegion !== 'cn' && authRegion !== 'global') {
      throw new Error('Mobile 构建配置错误：EXPO_PUBLIC_CINDY_AUTH_REGION 必须指定为 cn 或 global');
    }
    const { mobileClientBundleEnv } = await import('../../scripts/shared/client-endpoint-build-env.mjs');
    assertMobileManifestBuildEnv(process.env, mobileClientBundleEnv({
      authRegion,
    }));
  }
  if (options.dev === false) manifestBuildSnapshot.assertUnchanged(process.env);
  return defaultGetTransformOptions(entryPoints, options, getDependencies);
};

// mobile 直接吃 TS 源码的 workspace 包(见下方 .js→.ts resolveRequest 分流)。
const workspaceTsSourcePackages = [
  'auth-client',
  'device-link',
  'maker-shared',
  'model-providers',
];

config.resolver.disableHierarchicalLookup = true;
// 关掉层级查找后,Metro 只查显式列出的 node_modules。pnpm hoisted 布局(根 .npmrc
// node-linker=hoisted)下,workspace:* 依赖**不会**提升到根 node_modules,只链接在消费方包
// 自己的 node_modules 下(如 packages/device-link/node_modules/@cindy/device-link-protocol →
// packages/device-link-protocol)——不把这些目录列进来,TS 源码包引用的任何 workspace 依赖在
// 打 bundle 时都会 Unable to resolve(2026-07-16 iOS 冷更实踩)。
// 追加在末尾:常规依赖仍按 app → 根的原顺序命中,行为不变,只补此前查不到的路径。
// 边界:只覆盖这一层——若这些包的 workspace 依赖自己再新增 workspace 依赖(或新的 TS 源码包
// 未进上面的列表),同类问题会复发,需同步扩这里。
config.resolver.nodeModulesPaths = [
  appNodeModules,
  workspaceNodeModules,
  ...workspaceTsSourcePackages.map((packageName) => (
    path.join(workspaceRoot, 'packages', packageName, 'node_modules')
  )),
];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@cindy/device-link-protocol': path.join(
    workspaceRoot,
    'packages/device-link-protocol',
  ),
  react: path.join(appNodeModules, 'react'),
  'react-native': path.join(workspaceNodeModules, 'react-native'),
  'react-dom': path.join(appNodeModules, 'react-dom'),
};

const defaultGetPolyfills = config.serializer.getPolyfills;
config.serializer.getPolyfills = (ctx) => [
  sharedArrayBufferPolyfill,
  ...defaultGetPolyfills(ctx),
];

const defaultResolveRequest = config.resolver.resolveRequest;
const rnDevToolsSettingsManager = '../../src/private/devsupport/rndevtools/ReactDevToolsSettingsManager';

function isWorkspaceTsSourcePackage(originModulePath) {
  return workspaceTsSourcePackages.some((packageName) => (
    originModulePath.includes(`${path.sep}packages${path.sep}${packageName}${path.sep}`)
  ));
}

// 登录 scenario fixtures 的生产空 stub(implementation-plan Step 0 WHAT4 生产
// 排除双保险之 build-time 层;仅此一条 fixtures 排除条件)。expo export(release)
// 以 NODE_ENV=production 跑 Metro → 整模块替换为 stub;dev(metro dev server /
// expo export --dev)保留真模块。check-login-production-guard.mjs 以 sentinel
// 双断言校验本条生效。
const loginFixturesModule = '@cindy/auth-client/fixtures';
const loginFixturesStub = path.join(
  workspaceRoot,
  'packages/auth-client/fixtures/loginScenarios.production-stub.ts',
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === loginFixturesModule && process.env.NODE_ENV === 'production') {
    return { type: 'sourceFile', filePath: loginFixturesStub };
  }

  if (moduleName === rnDevToolsSettingsManager) {
    const nativePlatform = platform === 'android' ? 'android' : 'ios';
    return context.resolveRequest(context, `${moduleName}.${nativePlatform}.js`, platform);
  }

  if (moduleName.endsWith('.js') && isWorkspaceTsSourcePackage(context.originModulePath)) {
    try {
      return context.resolveRequest(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // Fall through to Metro's normal resolver so genuine .js files still work.
    }
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
