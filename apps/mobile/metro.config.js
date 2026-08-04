const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, '../..');
const workspaceNodeModules = path.join(workspaceRoot, 'node_modules');
const appNodeModules = path.join(__dirname, 'node_modules');
const sharedArrayBufferPolyfill = path.join(__dirname, 'src/polyfills/sharedArrayBuffer.js');

// mobile 直接吃 TS 源码的 workspace 包(见下方 .js→.ts resolveRequest 分流)。
const workspaceTsSourcePackages = [
  'auth-client',
  'device-link',
  'maker-shared',
  'model-providers',
];

// cindy-protocol submodule 里的源码直发协议包中,源码内部用**显式 .js 扩展名**的那些
// (为满足服务端 moduleResolution: node16 的类型检查)。esbuild / Vite 会自动把
// ./x.js 回落到 ./x.ts,Metro 不会——所以这些包也必须走下方 .js→.ts 分流。
// 边界:只列内部用 .js 扩展名的包。device-link-protocol 用无扩展名相对导入,
// 走 Metro 默认解析即可,不在此列。
const protocolTsSourcePackages = [
  'model-access-protocol',
];

config.resolver.disableHierarchicalLookup = true;
// 关掉层级查找后,Metro 只查显式列出的 node_modules。pnpm hoisted 布局(根 .npmrc
// node-linker=hoisted)下,workspace:* 依赖**不会**提升到根 node_modules,只链接在消费方包
// 自己的 node_modules 下(如 packages/device-link/node_modules/@cindy/device-link-protocol →
// cindy-protocol submodule)——不把这些目录列进来,TS 源码包引用的任何 workspace 依赖在
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
    'cindy-protocol/packages/device-link-protocol',
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
  if (workspaceTsSourcePackages.some((packageName) => (
    originModulePath.includes(`${path.sep}packages${path.sep}${packageName}${path.sep}`)
  ))) {
    return true;
  }
  return protocolTsSourcePackages.some((packageName) => (
    originModulePath.includes(
      `${path.sep}cindy-protocol${path.sep}packages${path.sep}${packageName}${path.sep}`,
    )
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
