#!/usr/bin/env node
// =============================================================================
// build-ios.mjs —— iOS 纯构建(本机出签名 .ipa,不含任何上传 / 分发 / 发布)
//
// 流程(--execute):git 闸门 → expo prebuild → pod install → xcodebuild archive/export
//       → .ipa → 从 .ipa 回读内嵌 runtimeVersion(EXUpdates.bundle/fingerprint,仅报告)
//       → 产物留在导出目录并打印路径(--out 可另拷一份)。
// dry-run 纯本地:校验配置 + 打印计划,git 闸门(含 origin/main 远端比对)只在
// --execute 时执行,分支/离线环境也能直接看计划。
//
// 与发布无关:不读写任何远端(无版本基线拉取、无 OSS/CDN、无分发平台),
// 版本号(app.json 的 expo.version / expo.ios.buildNumber)按仓内现值烤入,
// 需要变更请先改 app.json。
//
// 用法:
//   node scripts/build-ios.mjs --region cn                 # dry-run:校验 + 打印计划
//   node scripts/build-ios.mjs --region cn --execute       # 真正构建(需 macOS + Xcode)
//
// 参数:
//   --region cn|global|dev     必填。从 scripts/self-host-regions.json 取应用身份
//                              (iosBundleId)与签名描述符(iosSigning)。该文件不入仓
//                              (gitignore),按 self-host-regions.json.example 复制填写;
//                              构建必填 authRegion / iosBundleId / iosSigning,以及
//                              selfhost 包烘焙必填的 tapdb 两字段(global 另需 google
//                              三字段)——prebuild 期 app.config.js 硬校验,本脚本
//                              dry-run 预告缺失、--execute 前置拦截;商店 ID / OSS /
//                              npkgExpectBundle 等纯发布字段可留空。dev 区域还需先按
//                              config/endpoint.dev.json.example 复制出
//                              config/endpoint.dev.json(同样 gitignore),并把
//                              cdnBaseUrl 换成实际的无凭据 HTTPS 基址
//                              (example 里的 localhost 占位过不了加载校验)。
//   --execute                  真正构建;缺省 dry-run 只打印计划。
//   --desktop-version x.y.z    可选。配对的桌面产品线版本号(设置页展示用),
//                              不传则不注入、设置页不显示该行。
//   --out <dir>                可选。构建完把 .ipa 另拷到该目录。
//   --skip-git-gate            跳过 --execute 的 main/clean/HEAD 校验(仅本地迭代用;
//                              dry-run 本就不校验)。
//
// 签名配置(全部本地,仓内零敏感值):
//   self-host-regions.json 的 <region>.iosSigning:
//     teamId / profileName / signIdentity   必填(--execute 时校验)
//     profilePath                           可选;有值时自动安装描述文件到系统目录
//     exportMethod                          可选;development / ad-hoc / enterprise /
//                                           app-store,留空默认 development(与旧发布
//                                           线一致,产物交发布方重签;描述文件为分发
//                                           类型时填对应值直接出分发签名 .ipa)
//   证书 p12 / 描述文件本体在仓库外目录,须预先装入本机钥匙串。
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import {
  parseArgs,
  assertProductionGitGate,
  assertPublicEnv,
  SELF_HOST_PUBLIC_ENV_KEYS,
  formatBakedEnvLines,
} from './release-lib.mjs';
import { buildExportOptionsPlist, resolveIosSigningEnv } from './lib/ios-local.mjs';
import { clearBundlerCache } from './lib/bundler-cache.mjs';
import { readEmbeddedRuntimeVersionFromIpa } from './lib/embedded-runtime.mjs';
import {
  mobileClientBundleEnv,
  mobileClientBundleProcessEnv,
} from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { SELF_HOST_REGIONS, loadSelfHostRegions, missingSelfHostBakeFields, stripSelfHostRegionEnv } from './lib/self-host-region.mjs';

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function log(msg) { console.error(msg); }

const IOS_BUILD_FAILURE_STAGE = Object.freeze({
  arguments: 'arguments',
  regionConfig: 'region-config',
  buildPlan: 'build-plan',
  preflight: 'preflight',
  toolchain: 'toolchain',
  artifactValidation: 'artifact-validation',
  output: 'output',
});

let iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.arguments;

// 只按脚本控制的阶段输出固定诊断，不打印异常消息或环境变量值。
function reportIosBuildFailure() {
  switch (iosBuildFailureStage) {
    case IOS_BUILD_FAILURE_STAGE.arguments:
      console.error('iOS 构建失败（参数检查）：请确认已传 --region cn|global|dev，且其它参数合法。');
      break;
    case IOS_BUILD_FAILURE_STAGE.regionConfig:
      console.error('iOS 构建失败（区域配置）：请检查 apps/mobile/scripts/self-host-regions.json 及对应 endpoint 配置是否存在且有效。');
      break;
    case IOS_BUILD_FAILURE_STAGE.buildPlan:
      console.error('iOS 构建失败（构建计划）：请检查 apps/mobile/app.json 与区域产物配置。');
      break;
    case IOS_BUILD_FAILURE_STAGE.preflight:
      console.error('iOS 构建失败（构建前检查）：请检查 Git 门禁、签名描述符、macOS/Xcode 与必需的 EXPO_PUBLIC_* 配置。');
      break;
    case IOS_BUILD_FAILURE_STAGE.toolchain:
      console.error('iOS 构建失败（工具链）：请查看上方 Expo/CocoaPods/Xcode 输出；若无输出，请检查 npx、CocoaPods、Xcode 与本机签名材料。');
      break;
    case IOS_BUILD_FAILURE_STAGE.artifactValidation:
      console.error('iOS 构建失败（产物校验）：请检查 IPA 路径与内嵌 runtimeVersion。');
      break;
    case IOS_BUILD_FAILURE_STAGE.output:
      console.error('iOS 构建失败（复制产物）：请检查 --out 目录权限与磁盘空间。');
      break;
    default:
      console.error('iOS 构建失败；未能确定失败阶段。');
  }
}

// self-host 变体的构建环境(与原发布线同源:prebuild/fingerprint 与安装包一致)。
function selfhostEnv(region, desktopVersion) {
  const env = {
    ...mobileClientBundleProcessEnv({ authRegion: region.authRegion }),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
  };
  // 防止本机 shell / 旧 .env 残留变量混入构建;真实地址只认 config/endpoint*.json。
  delete env.EXPO_PUBLIC_XDT_OTA_URL;
  // 二级版本号:仅显式传入时注入(空则设置页不显示该行);构建脚本不做任何远端解析。
  if (desktopVersion) env.EXPO_PUBLIC_DESKTOP_VERSION = desktopVersion;
  return stripSelfHostRegionEnv(env);
}

// 供 dry-run 展示的「本脚本注入的 baked 变量」——只从非 process.env 来源(region
// JSON / endpoint 文件 / 字面量 / CLI 参数)构造,不把打包机 process.env(含 keystore
// 口令等机密)引入日志(与 selfhostEnv 注入的同名值一致)。
function bakedDisplayEnv(region, desktopVersion) {
  return {
    ...mobileClientBundleEnv({ authRegion: region.authRegion }),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
    ...(desktopVersion ? { EXPO_PUBLIC_DESKTOP_VERSION: desktopVersion } : {}),
  };
}

function readAppJson() {
  return JSON.parse(readFileSync(resolve(MOBILE_DIR, 'app.json'), 'utf8'));
}

function findWorkspace() {
  const iosDir = resolve(MOBILE_DIR, 'ios');
  if (!existsSync(iosDir)) return null;
  const ws = readdirSync(iosDir).find((f) => f.endsWith('.xcworkspace'));
  if (!ws) return null;
  return { path: join(iosDir, ws), scheme: basename(ws, '.xcworkspace') };
}

function ensureProfileInstalled(sign) {
  if (!sign.profilePath) {
    log('  warn: 未配 iosSigning.profilePath;假设描述文件已装入系统(~/Library/MobileDevice/Provisioning Profiles)');
    return;
  }
  if (!existsSync(sign.profilePath)) throw new Error(`描述文件不存在:${sign.profilePath}`);
  const dest = join(homedir(), 'Library/MobileDevice/Provisioning Profiles');
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  copyFileSync(sign.profilePath, join(dest, basename(sign.profilePath)));
  log(`  ✓ 已安装描述文件 ${basename(sign.profilePath)}`);
}

function run(cmd, args, opts = {}) {
  log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: MOBILE_DIR, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`命令失败(${r.status}): ${cmd} ${args.join(' ')}`);
}

function buildIpa(env, region) {
  // 签名参数(非机密描述符)由 region JSON 提供,构建时强制解析。
  const sign = resolveIosSigningEnv(region);
  run(NPX, ['--yes', 'expo', 'prebuild', '--platform', 'ios', '--clean'], { env });
  run(NPX, ['--yes', 'pod-install'], { env });

  const ws = findWorkspace();
  if (!ws) throw new Error('prebuild 后未找到 ios/*.xcworkspace');
  log(`→ workspace=${basename(ws.path)} scheme=${ws.scheme}`);

  const outDir = mkdtempSync(join(tmpdir(), 'cindy-ios-build-'));
  const archivePath = join(outDir, 'app.xcarchive');
  const exportDir = join(outDir, 'export');
  const plistPath = join(outDir, 'ExportOptions.plist');
  writeFileSync(plistPath, buildExportOptionsPlist({
    teamId: sign.teamId,
    bundleId: region.iosBundleId,
    profileName: sign.profileName,
    // 与 archive 的 CODE_SIGN_IDENTITY 同一张证书:避免钥匙串多证书时 export 自选到 profile 外的那张。
    signingCertificate: sign.identity,
    // 分发方式来自 iosSigning.exportMethod(缺省 development,与旧发布线一致);
    // 描述文件为 ad-hoc / enterprise / app-store 时须填对应值,export 才能出分发签名 .ipa。
    method: sign.exportMethod,
  }));

  // xcodebuild 的 RN embed 阶段内部触发 expo export:embed 打 JS bundle,无法透传 --clear;
  // 构建前清 Metro/Babel 缓存,确保 EXPO_PUBLIC_ 变更被重新内联,不吃旧缓存。
  clearBundlerCache({ mobileDir: MOBILE_DIR, log });

  ensureProfileInstalled(sign);
  run('xcodebuild', [
    '-workspace', ws.path, '-scheme', ws.scheme, '-configuration', 'Release',
    '-archivePath', archivePath, '-sdk', 'iphoneos', 'archive',
    'CODE_SIGN_STYLE=Manual', `DEVELOPMENT_TEAM=${sign.teamId}`,
    `PROVISIONING_PROFILE_SPECIFIER=${sign.profileName}`, `CODE_SIGN_IDENTITY=${sign.identity}`,
    // Xcode 26 默认开 Explicitly Built Modules,冷构建下 Swift 预扫描解析不到
    // WechatOpenSDK(post_install 临时落位的手写 modulemap),报 unable to resolve
    // module dependency。回退隐式模块构建规避(命令行 override,不进包/不影响 fingerprint)。
    'SWIFT_ENABLE_EXPLICIT_MODULES=NO', 'CLANG_ENABLE_EXPLICIT_MODULES=NO',
  ], { env });
  run('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportOptionsPlist', plistPath, '-exportPath', exportDir], { env });

  const ipa = readdirSync(exportDir).find((f) => f.endsWith('.ipa'));
  if (!ipa) throw new Error(`export 未产出 .ipa:${exportDir}`);
  return join(exportDir, ipa);
}

async function main() {
  iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.arguments;
  const args = parseArgs(process.argv.slice(2));
  // --region 必填(cn|global|dev):选出本次出包身份 + 签名描述符(见 lib/self-host-region.mjs)。
  // 不走 resolveSelfHostRegion:它对 dev 强校验发布专用的 npkgExpectBundle,与纯构建
  // 契约不符。这里等价解析 region,装载用 mode 'local'(纯发布字段——商店 ID / OSS /
  // npkgExpectBundle——允许留空);构建面身份与 selfhost 烘焙必填字段(tapdb,global
  // 另有 google)由本脚本自查,口径同 prebuild 期 app.config.js 的硬校验。
  const rawRegion = typeof args.region === 'string' ? args.region.trim() : '';
  if (!rawRegion) {
    throw new Error('必须显式指定 --region cn|global|dev(不提供默认值);例:pnpm mobile:build:ios -- --region global');
  }
  if (!SELF_HOST_REGIONS.includes(rawRegion)) {
    throw new Error(`--region 只能是 ${SELF_HOST_REGIONS.join(' 或 ')},收到: ${rawRegion}`);
  }
  iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.regionConfig;
  const region = loadSelfHostRegions({ mode: 'local' })[rawRegion];
  if (!region.iosBundleId?.trim()) {
    throw new Error(`self-host-regions.json 的 ${region.authRegion}.iosBundleId 未填(构建必需)`);
  }
  iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.buildPlan;
  const desktopVersion = typeof args.desktopVersion === 'string' ? args.desktopVersion : '';
  const env = selfhostEnv(region, desktopVersion);
  const appJson = readAppJson();
  const version = appJson?.expo?.version ?? '';
  const buildNumber = appJson?.expo?.ios?.buildNumber ?? '';

  // selfhost 烘焙必填字段(prebuild 期 app.config.js 硬校验)提前自查:dry-run 只预告,
  // --execute 在 prebuild 白跑数分钟之前 fail-fast。
  const missingBake = missingSelfHostBakeFields(region);

  // git 闸门只管真构建:dry-run 纯本地(不做 origin/main 远端比对,分支/离线可跑)。
  if (args.execute) {
    iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.preflight;
    if (!args.skipGitGate) assertProductionGitGate();
    else log('  warn: --skip-git-gate,跳过 main/clean/HEAD 校验(仅本地迭代用)');
    if (missingBake.length) {
      throw new Error(
        `self-host-regions.json 的 ${region.authRegion} 缺少 selfhost 构建必填字段: ${missingBake.join(', ')} ` +
          '(prebuild 期 app.config.js 硬校验; tapdb 为包内统计防漏填, global 的 google 为 Google 登录配置)',
      );
    }
    // 签名描述符预检:提前暴露缺配置(取用值在 buildIpa 内再解析一次)。
    resolveIosSigningEnv(region);
  }

  // 计划打印
  console.log('');
  console.log(`target: iOS 纯构建(region=${region.authRegion}, ${region.iosBundleId})`);
  console.log(`version / buildNumber: ${version} / ${buildNumber || '(app.json 未填)'}(取 app.json 现值,构建脚本不做版本决策)`);
  const sPreview = (name, value) => value?.trim() || `(${region.authRegion}.iosSigning.${name} 未填,--execute 时必填)`;
  const iosS = region.iosSigning ?? {};
  console.log(`sign: team=${sPreview('teamId', iosS.teamId)} profile=${sPreview('profileName', iosS.profileName)} identity="${sPreview('signIdentity', iosS.signIdentity)}" export=${iosS.exportMethod?.trim() || 'development'}(来自 self-host-regions.json 的 ${region.authRegion}.iosSigning)`);
  console.log('steps: prebuild → pod-install → xcodebuild archive/export → 从 .ipa 回读 runtimeVersion(仅构建,无上传/发布)');
  if (missingBake.length) {
    console.log(`selfhost 必填缺失: ${missingBake.join(', ')}(--execute 前须在 self-host-regions.json 补齐;prebuild 期 app.config.js 硬校验)`);
  }
  const display = bakedDisplayEnv(region, desktopVersion);
  for (const line of formatBakedEnvLines(display)) console.log(line);
  // 实际构建 env 从打包机 process.env 起步(微信 AppId 等公开配置本就由打包机 env 注入),
  // 计划里如实列出将一并烤入的继承键——只列键名不打值,不引机密入日志。
  const injectedKeys = new Set(Object.keys(display));
  const inheritedPublicKeys = Object.keys(env).filter((k) => k.startsWith('EXPO_PUBLIC_') && !injectedKeys.has(k)).sort();
  console.log(`打包机 env 继承的 EXPO_PUBLIC_*(将随构建一并烤入,仅列键名): ${inheritedPublicKeys.join(', ') || '(无)'}`);
  if (!args.execute) {
    console.log('dry-run: 传 --execute 才真正构建(需 macOS + Xcode + 已装证书/描述文件)');
    return;
  }

  iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.preflight;
  if (process.platform !== 'darwin') throw new Error('--execute 需在 macOS 上运行(xcodebuild)');

  // region / endpoint manifest 自举基址必须齐全(读仓内 config/endpoint*.json,离线可用)。
  assertPublicEnv(env, { variant: 'production', requiredKeys: SELF_HOST_PUBLIC_ENV_KEYS });

  iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.toolchain;
  const ipaPath = buildIpa(env, region);
  log(`  ✓ ipa: ${ipaPath}`);

  iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.artifactValidation;
  // 权威 runtimeVersion = 真正烤进 .ipa 的 EXUpdates.bundle/fingerprint(仅报告,供发布侧比对)。
  const runtimeVersion = readEmbeddedRuntimeVersionFromIpa(ipaPath);
  log(`  ✓ runtimeVersion(读自 .ipa 内嵌 fingerprint): ${runtimeVersion}`);

  let finalPath = ipaPath;
  if (typeof args.out === 'string' && args.out) {
    iosBuildFailureStage = IOS_BUILD_FAILURE_STAGE.output;
    const outDir = resolve(String(args.out));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    finalPath = join(outDir, basename(ipaPath));
    copyFileSync(ipaPath, finalPath);
  }

  console.log('');
  console.log('==================== iOS 构建完成 ====================');
  console.log(`  ipa            : ${finalPath}`);
  console.log(`  version        : ${version} (${buildNumber})`);
  console.log(`  runtimeVersion : ${runtimeVersion}`);
  console.log('  注意:本脚本只构建;签名为本机证书所签,分发/发布由发布方流程另行处理。');
  console.log('======================================================');
}

main().catch(() => {
  reportIosBuildFailure();
  process.exit(1);
});
