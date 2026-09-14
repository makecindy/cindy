#!/usr/bin/env node
// =============================================================================
// build-android.mjs —— Android 纯构建(本机出自签 APK / AAB,不含上传 / 分发 / 发布)
//
// 流程(--execute):git 闸门 → expo prebuild(注入 versionCode)→ patch build.gradle 用自有
//       keystore 自签 → 按地区 / --artifacts 执行 assembleRelease / bundleRelease
//       → 从 APK / AAB 回读内嵌 runtimeVersion并交叉核对
//       → 本地校验 package/versionCode/签名 → 打印全部产物路径(--out 可另拷一份)。
// dry-run 纯本地:校验配置 + 打印计划,git 闸门(含 origin/main 远端比对)只在
// --execute 时执行,分支/离线环境也能直接看计划。
//
// 与发布无关:不读写任何远端(无版本基线拉取、无 OSS/CDN、无分发平台)。
// versionCode 缺省取 android-version.json 现值,可用 --version-code 覆盖
// (经 env 注入,不写盘)。
//
// 用法:
//   node scripts/build-android.mjs --region cn                 # 默认 APK
//   node scripts/build-android.mjs --region global --execute   # 默认 APK + AAB
//
// 参数:
//   --region cn|global|dev     必填。从 scripts/self-host-regions.json 取应用身份
//                              (androidPackage)与签名配置(androidSigning)。该文件
//                              不入仓(gitignore),按 self-host-regions.json.example
//                              复制填写;构建必填 authRegion / androidPackage /
//                              androidSigning,以及 selfhost 包烘焙必填的 tapdb 两字段
//                              (global 另需 google 三字段)——prebuild 期 app.config.js
//                              硬校验,本脚本 dry-run 预告缺失、--execute 前置拦截;
//                              商店 ID / OSS / npkgExpectBundle 等纯发布字段可留空。
//                              dev 区域还需先按 config/endpoint.dev.json.example
//                              复制出 config/endpoint.dev.json(同样 gitignore),
//                              并把 cdnBaseUrl 换成实际的无凭据 HTTPS 基址
//                              (example 里的 localhost 占位过不了加载校验)。
//   --execute                  真正构建;缺省 dry-run 只打印计划。
//   --artifacts <csv>          可选:apk / aab / apk,aab。缺省按 region 选择:
//                              cn/dev=apk,global=apk,aab;AAB 仅允许 global。
//   --version-code <n>         可选。覆盖 android-version.json 的 versionCode
//                              (只影响本次构建,不写盘;APK/AAB 始终共用同一值)。
//   --desktop-version x.y.z    可选。配对的桌面产品线版本号(设置页展示用),
//                              不传则不注入、设置页不显示该行。
//   --out <dir>                可选。构建完把本次所有 .apk/.aab 另拷到该目录。
//   --skip-git-gate            跳过 --execute 的 main/clean/HEAD 校验(仅本地迭代用;
//                              dry-run 本就不校验)。
//
// 签名配置(全部本地,仓内零敏感值):
//   self-host-regions.json 的 <region>.androidSigning:keystorePath / keyAlias
//   口令走环境变量(按 region 大写后缀,cn 可省略后缀回落):
//     XDT_ANDROID_KEYSTORE_PASSWORD_<REGION> / XDT_ANDROID_KEY_PASSWORD_<REGION>
//   Global AAB 还必须独立 pin Play Console「上传密钥证书」的公开 SHA-256(不要填
//   「应用签名密钥证书」;不得从当前 JKS 动态计算,否则配错 JKS 时无法拦截):
//     XDT_ANDROID_UPLOAD_CERT_SHA256_GLOBAL
//   keystore 本体在仓库外目录,不入仓。
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  assertProductionGitGate,
  assertPublicEnv,
  SELF_HOST_PUBLIC_ENV_KEYS,
  formatBakedEnvLines,
} from './release-lib.mjs';
import {
  assertAndroidUploadCertificateSha256,
  readAndroidVersionCode,
  readAndroidCertificateSha256FromPemOutput,
  resolveAndroidArtifactKinds,
  resolveAndroidUploadCertificateSha256,
  androidGradleTasksForArtifacts,
  resolveAndroidSigningEnv,
  patchBuildGradleSigning,
  patchGradlePropertiesMemory,
} from './lib/android-local.mjs';
import { resolveJavaRuntimeEnv } from './java-runtime-env.mjs';
import { clearBundlerCache } from './lib/bundler-cache.mjs';
import {
  readEmbeddedRuntimeVersionFromAab,
  readEmbeddedRuntimeVersionFromApk,
} from './lib/embedded-runtime.mjs';
import {
  mobileClientBundleEnv,
  mobileClientBundleProcessEnv,
} from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { SELF_HOST_REGIONS, loadSelfHostRegions, missingSelfHostBakeFields, stripSelfHostRegionEnv } from './lib/self-host-region.mjs';

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function log(msg) { console.error(msg); }

const ANDROID_BUILD_FAILURE_STAGE = Object.freeze({
  arguments: 'arguments',
  regionConfig: 'region-config',
  buildPlan: 'build-plan',
  preflight: 'preflight',
  toolchain: 'toolchain',
  artifactValidation: 'artifact-validation',
  output: 'output',
});

let androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.arguments;

// 只按脚本控制的阶段输出固定诊断，不打印异常消息或环境变量值。
function reportAndroidBuildFailure() {
  switch (androidBuildFailureStage) {
    case ANDROID_BUILD_FAILURE_STAGE.arguments:
      console.error('Android 构建失败（参数检查）：请确认已传 --region cn|global|dev，且 --artifacts、--version-code 等参数合法。');
      break;
    case ANDROID_BUILD_FAILURE_STAGE.regionConfig:
      console.error('Android 构建失败（区域配置）：请检查 apps/mobile/scripts/self-host-regions.json 及对应 endpoint 配置是否存在且有效。');
      break;
    case ANDROID_BUILD_FAILURE_STAGE.buildPlan:
      console.error('Android 构建失败（构建计划）：请检查 apps/mobile/app.json、android-version.json 与区域产物配置。');
      break;
    case ANDROID_BUILD_FAILURE_STAGE.preflight:
      console.error('Android 构建失败（构建前检查）：请检查 Git 门禁、签名配置、JDK 17+ 与必需的 EXPO_PUBLIC_* 配置。');
      break;
    case ANDROID_BUILD_FAILURE_STAGE.toolchain:
      console.error('Android 构建失败（工具链）：请查看上方 Expo/Gradle 输出；若无输出，请检查 npx、JDK 17+、Android SDK 与 Gradle wrapper。');
      break;
    case ANDROID_BUILD_FAILURE_STAGE.artifactValidation:
      console.error('Android 构建失败（产物校验）：请检查 APK/AAB 路径、包名、versionCode、runtimeVersion 与签名证书配置。');
      break;
    case ANDROID_BUILD_FAILURE_STAGE.output:
      console.error('Android 构建失败（复制产物）：请检查 --out 目录权限与磁盘空间。');
      break;
    default:
      console.error('Android 构建失败；未能确定失败阶段。');
  }
}

// self-host 变体的构建环境(与原发布线同源),注入 versionCode。
function selfhostEnv(region, versionCode, desktopVersion) {
  const env = {
    ...mobileClientBundleProcessEnv({ authRegion: region.authRegion }),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
    XDT_ANDROID_VERSION_CODE: String(versionCode),
  };
  // 防止本机 shell / 旧 .env 残留变量混入构建;真实地址只认 config/endpoint*.json。
  delete env.EXPO_PUBLIC_XDT_OTA_URL;
  // 二级版本号:仅显式传入时注入;构建脚本不做任何远端解析。
  if (desktopVersion) env.EXPO_PUBLIC_DESKTOP_VERSION = desktopVersion;
  return stripSelfHostRegionEnv(env);
}

// 供 dry-run 展示的「本脚本注入的 baked 变量」——只从非 process.env 来源(region
// JSON / endpoint 文件 / 字面量 / CLI 参数)构造,不把打包机 process.env(含 keystore
// 口令等机密)引入日志(与 selfhostEnv 注入的同名值一致)。
function bakedDisplayEnv(region, versionCode, desktopVersion) {
  return {
    ...mobileClientBundleEnv({ authRegion: region.authRegion }),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
    ...(desktopVersion ? { EXPO_PUBLIC_DESKTOP_VERSION: desktopVersion } : {}),
    XDT_ANDROID_VERSION_CODE: String(versionCode),
  };
}

function readAppJson() {
  return JSON.parse(readFileSync(resolve(MOBILE_DIR, 'app.json'), 'utf8'));
}

function run(cmd, args, opts = {}) {
  log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: MOBILE_DIR, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`命令失败(${r.status}): ${cmd} ${args.join(' ')}`);
}

// patch 生成的 android/app/build.gradle,让 release 用自有 keystore 自签(幂等,纯函数在 lib/android-local)。
function patchGradleSigning() {
  const gradlePath = resolve(MOBILE_DIR, 'android/app/build.gradle');
  if (!existsSync(gradlePath)) throw new Error(`prebuild 后未找到 ${gradlePath}`);
  writeFileSync(gradlePath, patchBuildGradleSigning(readFileSync(gradlePath, 'utf8')));
  log('  ✓ 已 patch android/app/build.gradle:release 用自有 keystore 自签(口令走 env,不落盘)');
}

// 调大生成工程的 Gradle heap / metaspace。只动 prebuild 产物,不影响 fingerprint。
function patchGradleProps() {
  const props = resolve(MOBILE_DIR, 'android/gradle.properties');
  if (!existsSync(props)) throw new Error(`prebuild 后未找到 ${props}`);
  writeFileSync(props, patchGradlePropertiesMemory(readFileSync(props, 'utf8')));
  log('  ✓ 已 patch android/gradle.properties(bump heap/metaspace)');
}

function findSingleArtifact(dir, extension, taskName) {
  const matches = existsSync(dir)
    ? readdirSync(dir).filter((file) => file.endsWith(extension)).sort()
    : [];
  if (matches.length !== 1) {
    throw new Error(`${taskName} 期望唯一 ${extension} 产物,实际 ${matches.length} 个:${dir}`);
  }
  return join(dir, matches[0]);
}

function buildAndroidArtifacts(env, region, artifactKinds) {
  // 签名配置:路径/alias 来自 region JSON,口令来自 env;prebuild 前先强制解析
  // (fail-fast,缺配置不白跑数分钟 prebuild)。
  const signEnv = resolveAndroidSigningEnv(region, env);

  run(NPX, ['--yes', 'expo', 'prebuild', '--platform', 'android', '--clean'], { env });
  patchGradleSigning();
  patchGradleProps();

  // gradle 内部触发 expo export:embed 打 JS bundle,无法透传 --clear;打包前清
  // Metro/Babel 缓存,确保 EXPO_PUBLIC_ 变更被重新内联,不吃旧缓存。
  clearBundlerCache({ mobileDir: MOBILE_DIR, log });

  // assembleRelease / bundleRelease 共用同一次 prebuild、同一个 release signingConfig
  // 与同一份 env,保证 APK / AAB 的身份、versionCode、runtimeVersion 和签名源一致。
  const javaEnv = resolveJavaRuntimeEnv({ ...env, ...signEnv });
  // 不把 javaEnv 传进被日志的函数:它由 process.env + 签名口令(signEnv)派生,
  // CodeQL 会将「机密 env 流入日志」判为泄漏(即便 javaRuntimeDetail 只读版本 /
  // JAVA_HOME)。这里只报静态信息;JDK 由 resolveJavaRuntimeEnv 确定性选 17+。
  const tasks = androidGradleTasksForArtifacts(artifactKinds);
  log(`  → gradle ${tasks.join(' ')}(已解析 JDK 17+ 运行时)`);
  const androidDir = resolve(MOBILE_DIR, 'android');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  run(gradlew, tasks, { cwd: androidDir, env: javaEnv });

  const artifacts = {};
  if (artifactKinds.includes('apk')) {
    artifacts.apk = findSingleArtifact(
      join(androidDir, 'app/build/outputs/apk/release'),
      '.apk',
      'assembleRelease',
    );
  }
  if (artifactKinds.includes('aab')) {
    artifacts.aab = findSingleArtifact(
      join(androidDir, 'app/build/outputs/bundle/release'),
      '.aab',
      'bundleRelease',
    );
  }
  return { androidDir, artifacts, javaEnv };
}

// 定位 aapt2(Android SDK build-tools)。优先 ANDROID_HOME / ANDROID_SDK_ROOT 下最高
// 版本 build-tools,兜底 PATH;找不到返回 null(本地校验降级 warn,不阻断构建)。
function locateAapt2() {
  const bin = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    const btRoot = join(sdk, 'build-tools');
    if (existsSync(btRoot)) {
      const versions = readdirSync(btRoot).sort().reverse();
      for (const v of versions) {
        const p = join(btRoot, v, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  const probe = spawnSync(bin, ['version'], { encoding: 'utf8' });
  return probe.status === 0 ? bin : null;
}

// 本地校验 APK 内嵌 manifest 的 package / versionCode 与本次构建目标一致
// (纯本地防呆:prebuild 注入构造上一致,故降级 warn 不阻断)。
function validateApkMetadata(apkPath, expectPackage, expectVersionCode) {
  const aapt2 = locateAapt2();
  if (!aapt2) {
    log('  warn: aapt2 未找到(Android SDK build-tools 不在 ANDROID_HOME/PATH),跳过 APK manifest 校验');
    return;
  }
  const r = spawnSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`aapt2 dump badging 失败:${r.stderr || r.stdout || `exit ${r.status}`}`);
  const pkg = r.stdout.match(/^package: name='([^']+)' versionCode='([^']+)'/m);
  if (!pkg) throw new Error('无法从 aapt2 badging 输出解析 package/versionCode');
  if (pkg[1] !== expectPackage) throw new Error(`APK package 不符:期望 ${expectPackage},实际 ${pkg[1]}`);
  if (String(pkg[2]) !== String(expectVersionCode)) {
    throw new Error(`APK versionCode 不符:期望 ${expectVersionCode},实际 ${pkg[2]}`);
  }
  log(`  ✓ APK manifest 校验通过(package=${expectPackage}, versionCode=${expectVersionCode})`);
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${label}读取/解析失败(${filePath}):${err?.message ?? err}`);
  }
}

// AAB 的 manifest 是 protobuf,不能用 aapt2 dump badging。这里读取同一 bundleRelease
// 构建产生的 AGP metadata:bundle model 钉 applicationId / 输出文件,merged manifest metadata
// 钉 versionCode / versionName。任一文件缺失或结构漂移都 fail closed,不把未核验包交给上传侧。
function validateAabMetadata(aabPath, androidDir, expectPackage, expectVersionCode, expectVersionName) {
  const bundleMetadataPath = join(
    androidDir,
    'app/build/intermediates/bundle_ide_model/release/produceReleaseBundleIdeListingFile/output-metadata.json',
  );
  const manifestMetadataPath = join(
    androidDir,
    'app/build/intermediates/merged_manifests/release/processReleaseManifest/output-metadata.json',
  );
  const bundle = readJsonFile(bundleMetadataPath, 'AAB bundle metadata');
  const manifest = readJsonFile(manifestMetadataPath, 'AAB manifest metadata');
  const bundleElement = Array.isArray(bundle?.elements) && bundle.elements.length === 1
    ? bundle.elements[0]
    : null;
  const manifestElement = Array.isArray(manifest?.elements) && manifest.elements.length === 1
    ? manifest.elements[0]
    : null;
  if (bundle?.artifactType?.type !== 'BUNDLE' || !bundleElement) {
    throw new Error('AAB bundle metadata 结构无效(期望 artifactType=BUNDLE 且唯一 element)');
  }
  if (!manifestElement) {
    throw new Error('AAB manifest metadata 结构无效(期望唯一 element)');
  }
  if (bundle.applicationId !== expectPackage || manifest.applicationId !== expectPackage) {
    throw new Error(
      `AAB package 不符:期望 ${expectPackage},bundle=${bundle.applicationId ?? '(空)'},manifest=${manifest.applicationId ?? '(空)'}`,
    );
  }
  if (basename(String(bundleElement.outputFile ?? '')) !== basename(aabPath)) {
    throw new Error(
      `AAB metadata 输出文件不符:期望 ${basename(aabPath)},实际 ${String(bundleElement.outputFile ?? '(空)')}`,
    );
  }
  if (String(manifestElement.versionCode) !== String(expectVersionCode)) {
    throw new Error(
      `AAB versionCode 不符:期望 ${expectVersionCode},实际 ${String(manifestElement.versionCode ?? '(空)')}`,
    );
  }
  if (String(manifestElement.versionName ?? '') !== String(expectVersionName ?? '')) {
    throw new Error(
      `AAB versionName 不符:期望 ${expectVersionName},实际 ${String(manifestElement.versionName ?? '(空)')}`,
    );
  }
  log(`  ✓ AAB metadata 校验通过(package=${expectPackage}, version=${expectVersionName}, versionCode=${expectVersionCode})`);
}

function validateAabSignature(aabPath, javaEnv, expectedCertificateSha256) {
  const r = spawnSync('jarsigner', ['-verify', aabPath], { encoding: 'utf8', env: javaEnv });
  if (r.error?.code === 'ENOENT') {
    throw new Error('未找到 jarsigner(JDK 17+ 应自带),无法确认 AAB 已使用 release keystore 签名');
  }
  if (r.status !== 0) {
    throw new Error(`AAB jarsigner 校验失败:${r.stderr || r.stdout || `exit ${r.status}`}`);
  }

  // jarsigner 对“未签名 JAR”也可能打印警告后退出 0,因此不能把上面的零退出码当作
  // 已签名证据。keytool 的 RFC 输出必须包含实际 signer 证书,再与独立 Play upload cert
  // pin 比对；这样既拒绝未签名 AAB,也拒绝由错误 JKS 产生的结构合法签名。
  const cert = spawnSync('keytool', ['-printcert', '-jarfile', aabPath, '-rfc'], {
    encoding: 'utf8',
    env: javaEnv,
  });
  if (cert.error?.code === 'ENOENT') {
    throw new Error('未找到 keytool(JDK 17+ 应自带),无法读取 AAB 签名证书');
  }
  if (cert.status !== 0) {
    throw new Error(`AAB 签名证书读取失败:${cert.stderr || cert.stdout || `exit ${cert.status}`}`);
  }
  const actualCertificateSha256 = readAndroidCertificateSha256FromPemOutput(
    cert.stdout,
    'AAB 实际签名证书',
  );
  assertAndroidUploadCertificateSha256(actualCertificateSha256, expectedCertificateSha256);
  log('  ✓ AAB 签名完整且与已 pin 的 Google Play 上传证书一致');
}

async function main() {
  androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.arguments;
  const args = parseArgs(process.argv.slice(2));
  // --region 必填(cn|global|dev):选出本次出包身份 + 签名配置(见 lib/self-host-region.mjs)。
  // 不走 resolveSelfHostRegion:它对 dev 强校验发布专用的 npkgExpectBundle,与纯构建
  // 契约不符。这里等价解析 region,装载用 mode 'local'(纯发布字段——商店 ID / OSS /
  // npkgExpectBundle——允许留空);构建面身份与 selfhost 烘焙必填字段(tapdb,global
  // 另有 google)由本脚本自查,口径同 prebuild 期 app.config.js 的硬校验。
  const rawRegion = typeof args.region === 'string' ? args.region.trim() : '';
  if (!rawRegion) {
    throw new Error('必须显式指定 --region cn|global|dev(不提供默认值);例:pnpm mobile:build:android -- --region global');
  }
  if (!SELF_HOST_REGIONS.includes(rawRegion)) {
    throw new Error(`--region 只能是 ${SELF_HOST_REGIONS.join(' 或 ')},收到: ${rawRegion}`);
  }
  androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.regionConfig;
  const region = loadSelfHostRegions({ mode: 'local' })[rawRegion];
  if (!region.androidPackage?.trim()) {
    throw new Error(`self-host-regions.json 的 ${region.authRegion}.androidPackage 未填(构建必需)`);
  }
  androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.buildPlan;
  const artifactKinds = resolveAndroidArtifactKinds(region.authRegion, args.artifacts);
  const appJson = readAppJson();
  const version = appJson?.expo?.version ?? '';
  // --version-code 覆盖须是正整数且不超 Android 平台上限 2100000000:app.config.js
  // 对无效值会静默忽略,而 aapt2 校验在缺 build-tools 时降级 warn——不在入口拦住,
  // 坏值会烤出错版 APK / 让 assembleRelease 半途失败才被发现。
  const ANDROID_MAX_VERSION_CODE = 2100000000;
  const rawVersionCode = args.versionCode != null ? String(args.versionCode).trim() : '';
  if (args.versionCode != null && (!/^[1-9]\d*$/.test(rawVersionCode) || Number(rawVersionCode) > ANDROID_MAX_VERSION_CODE)) {
    throw new Error(`--version-code 必须是 1..${ANDROID_MAX_VERSION_CODE} 的正整数,收到: ${String(args.versionCode)}`);
  }
  const versionCode = rawVersionCode || readAndroidVersionCode(MOBILE_DIR);
  const desktopVersion = typeof args.desktopVersion === 'string' ? args.desktopVersion : '';

  // selfhost 烘焙必填字段(prebuild 期 app.config.js 硬校验)提前自查:dry-run 只预告,
  // --execute 在 prebuild 白跑数分钟之前 fail-fast。
  const missingBake = missingSelfHostBakeFields(region);

  // git 闸门只管真构建:dry-run 纯本地(不做 origin/main 远端比对,分支/离线可跑)。
  let expectedUploadCertificateSha256 = null;
  if (args.execute) {
    androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.preflight;
    if (!args.skipGitGate) assertProductionGitGate();
    else log('  warn: --skip-git-gate,跳过 main/clean/HEAD 校验(仅本地迭代用)');
    if (missingBake.length) {
      throw new Error(
        `self-host-regions.json 的 ${region.authRegion} 缺少 selfhost 构建必填字段: ${missingBake.join(', ')} ` +
          '(prebuild 期 app.config.js 硬校验; tapdb 为包内统计防漏填, global 的 google 为 Google 登录配置)',
      );
    }
    // 签名配置预检:缺配置尽早暴露,不白跑数分钟 prebuild(取用值在 buildApk 内再解析一次)。
    resolveAndroidSigningEnv(region, process.env);
    if (artifactKinds.includes('aab')) {
      expectedUploadCertificateSha256 = resolveAndroidUploadCertificateSha256(
        region.authRegion,
        process.env,
      );
    }
  }

  // env 必须在 versionCode 决定之后构建:经 XDT_ANDROID_VERSION_CODE 注入 prebuild。
  const env = selfhostEnv(region, versionCode, desktopVersion);

  // 计划打印
  console.log('');
  console.log(`target: Android 纯构建(region=${region.authRegion}, ${region.androidPackage})`);
  console.log(`artifacts: ${artifactKinds.join(' + ')}${args.artifacts == null ? ' (按 region 默认)' : ' (--artifacts 覆盖)'}`);
  console.log(`version / versionCode: ${version} / ${versionCode}${args.versionCode != null ? ' (--version-code 覆盖)' : ' (取 android-version.json 现值)'}`);
  const suffix = String(region.authRegion).toUpperCase();
  const aSign = region.androidSigning ?? {};
  const pwPreview = (base) => (process.env[`${base}_${suffix}`]?.trim() || (suffix === 'CN' ? process.env[base]?.trim() : '')) ? 'set' : '未设';
  const uploadCertPreview = artifactKinds.includes('aab')
    ? pwPreview('XDT_ANDROID_UPLOAD_CERT_SHA256')
    : '不适用';
  console.log(`sign: 自有 keystore 自签,path=${aSign.keystorePath || '(JSON 未填)'} alias=${aSign.keyAlias || '(JSON 未填)'} storePw(env ${suffix})=${pwPreview('XDT_ANDROID_KEYSTORE_PASSWORD')} keyPw(env ${suffix})=${pwPreview('XDT_ANDROID_KEY_PASSWORD')} uploadCertSha256(env ${suffix})=${uploadCertPreview}`);
  const gradleTasks = androidGradleTasksForArtifacts(artifactKinds);
  console.log(`steps: prebuild → patch build.gradle 签名 → gradlew ${gradleTasks.join(' ')} → 回读/核对 runtimeVersion → metadata/签名校验(仅构建,无上传/发布)`);
  if (missingBake.length) {
    console.log(`selfhost 必填缺失: ${missingBake.join(', ')}(--execute 前须在 self-host-regions.json 补齐;prebuild 期 app.config.js 硬校验)`);
  }
  const display = bakedDisplayEnv(region, versionCode, desktopVersion);
  for (const line of formatBakedEnvLines(display, { extraKeys: ['XDT_ANDROID_VERSION_CODE'] })) console.log(line);
  // 实际构建 env 从打包机 process.env 起步(微信 AppId 等公开配置本就由打包机 env 注入),
  // 计划里如实列出将一并烤入的继承键——只列键名不打值,不引机密入日志。
  const injectedKeys = new Set(Object.keys(display));
  const inheritedPublicKeys = Object.keys(env).filter((k) => k.startsWith('EXPO_PUBLIC_') && !injectedKeys.has(k)).sort();
  console.log(`打包机 env 继承的 EXPO_PUBLIC_*(将随构建一并烤入,仅列键名): ${inheritedPublicKeys.join(', ') || '(无)'}`);
  if (!args.execute) {
    console.log('dry-run: 传 --execute 才真正构建(需 Android SDK + JDK 17 + keystore 口令 env)');
    return;
  }

  androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.preflight;
  // region / endpoint manifest 自举基址必须齐全(读仓内 config/endpoint*.json,离线可用)。
  assertPublicEnv(env, { variant: 'production', requiredKeys: SELF_HOST_PUBLIC_ENV_KEYS });

  androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.toolchain;
  const built = buildAndroidArtifacts(env, region, artifactKinds);
  for (const kind of artifactKinds) log(`  ✓ ${kind}: ${built.artifacts[kind]}`);

  androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.artifactValidation;
  // 权威 runtimeVersion 始终从真正烤进产物的 fingerprint 回读。双产物必须一致,
  // 否则同一个 versionCode 会出现两条不兼容 OTA runtime,直接中止。
  const runtimeVersions = {};
  if (built.artifacts.apk) {
    runtimeVersions.apk = readEmbeddedRuntimeVersionFromApk(built.artifacts.apk);
    log(`  ✓ runtimeVersion(APK assets/fingerprint): ${runtimeVersions.apk}`);
    validateApkMetadata(built.artifacts.apk, region.androidPackage, versionCode);
  }
  if (built.artifacts.aab) {
    runtimeVersions.aab = readEmbeddedRuntimeVersionFromAab(built.artifacts.aab);
    log(`  ✓ runtimeVersion(AAB base/assets/fingerprint): ${runtimeVersions.aab}`);
    validateAabMetadata(
      built.artifacts.aab,
      built.androidDir,
      region.androidPackage,
      versionCode,
      version,
    );
    validateAabSignature(
      built.artifacts.aab,
      built.javaEnv,
      expectedUploadCertificateSha256,
    );
  }
  const uniqueRuntimeVersions = [...new Set(Object.values(runtimeVersions))];
  if (uniqueRuntimeVersions.length !== 1) {
    throw new Error(`APK/AAB runtimeVersion 不一致:${JSON.stringify(runtimeVersions)}`);
  }
  const runtimeVersion = uniqueRuntimeVersions[0];

  const finalArtifacts = { ...built.artifacts };
  if (typeof args.out === 'string' && args.out) {
    androidBuildFailureStage = ANDROID_BUILD_FAILURE_STAGE.output;
    const outDir = resolve(String(args.out));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    for (const kind of artifactKinds) {
      const source = built.artifacts[kind];
      const destination = join(outDir, basename(source));
      copyFileSync(source, destination);
      finalArtifacts[kind] = destination;
    }
  }

  console.log('');
  console.log('==================== Android 构建完成 ====================');
  for (const kind of artifactKinds) {
    console.log(`  ${kind.padEnd(14)} : ${finalArtifacts[kind]}`);
  }
  console.log(`  version        : ${version} (${versionCode})`);
  console.log(`  runtimeVersion : ${runtimeVersion}`);
  console.log('  注意:本脚本只构建;APK/AAB 使用同一 release keystore,分发/商店上传由发布方流程另行处理。');
  console.log('==========================================================');
}

main().catch(() => {
  reportAndroidBuildFailure();
  process.exit(1);
});
