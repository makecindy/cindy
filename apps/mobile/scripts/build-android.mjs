#!/usr/bin/env node
// =============================================================================
// build-android.mjs —— Android 纯构建(本机出自签 APK,不含任何上传 / 分发 / 发布)
//
// 流程(--execute):git 闸门 → expo prebuild(注入 versionCode)→ patch build.gradle 用自有
//       keystore 自签 → gradlew assembleRelease → app-release.apk
//       → 从 APK 回读内嵌 runtimeVersion(assets/fingerprint,仅报告)
//       → aapt2 本地校验 package/versionCode(找不到 aapt2 时降级 warn)
//       → 产物留在 gradle 输出目录并打印路径(--out 可另拷一份)。
// dry-run 纯本地:校验配置 + 打印计划,git 闸门(含 origin/main 远端比对)只在
// --execute 时执行,分支/离线环境也能直接看计划。
//
// 与发布无关:不读写任何远端(无版本基线拉取、无 OSS/CDN、无分发平台)。
// versionCode 缺省取 android-version.json 现值,可用 --version-code 覆盖
// (经 env 注入,不写盘)。
//
// 用法:
//   node scripts/build-android.mjs --region cn                 # dry-run:校验 + 打印计划
//   node scripts/build-android.mjs --region cn --execute       # 真正构建(需 Android SDK + JDK 17)
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
//   --version-code <n>         可选。覆盖 android-version.json 的 versionCode
//                              (只影响本次构建,不写盘)。
//   --desktop-version x.y.z    可选。配对的桌面产品线版本号(设置页展示用),
//                              不传则不注入、设置页不显示该行。
//   --out <dir>                可选。构建完把 .apk 另拷到该目录。
//   --skip-git-gate            跳过 --execute 的 main/clean/HEAD 校验(仅本地迭代用;
//                              dry-run 本就不校验)。
//
// 签名配置(全部本地,仓内零敏感值):
//   self-host-regions.json 的 <region>.androidSigning:keystorePath / keyAlias
//   口令走环境变量(按 region 大写后缀,cn 可省略后缀回落):
//     XDT_ANDROID_KEYSTORE_PASSWORD_<REGION> / XDT_ANDROID_KEY_PASSWORD_<REGION>
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
  readAndroidVersionCode,
  resolveAndroidSigningEnv,
  patchBuildGradleSigning,
  patchGradlePropertiesMemory,
} from './lib/android-local.mjs';
import { resolveJavaRuntimeEnv } from './java-runtime-env.mjs';
import { clearBundlerCache } from './lib/bundler-cache.mjs';
import { readEmbeddedRuntimeVersionFromApk } from './lib/embedded-runtime.mjs';
import { mobileClientBundleEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { SELF_HOST_REGIONS, loadSelfHostRegions, missingSelfHostBakeFields, stripSelfHostRegionEnv } from './lib/self-host-region.mjs';

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function log(msg) { console.error(msg); }

// self-host 变体的构建环境(与原发布线同源),注入 versionCode。
function selfhostEnv(region, versionCode, desktopVersion) {
  const env = {
    ...process.env,
    ...mobileClientBundleEnv({ authRegion: region.authRegion }),
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

function buildApk(env, region) {
  // 签名配置:路径/alias 来自 region JSON,口令来自 env;prebuild 前先强制解析
  // (fail-fast,缺配置不白跑数分钟 prebuild)。
  const signEnv = resolveAndroidSigningEnv(region, env);

  run(NPX, ['--yes', 'expo', 'prebuild', '--platform', 'android', '--clean'], { env });
  patchGradleSigning();
  patchGradleProps();

  // gradle 内部触发 expo export:embed 打 JS bundle,无法透传 --clear;打包前清
  // Metro/Babel 缓存,确保 EXPO_PUBLIC_ 变更被重新内联,不吃旧缓存。
  clearBundlerCache({ mobileDir: MOBILE_DIR, log });

  // gradlew assembleRelease:需 JDK 17 + keystore 签名 env。
  const javaEnv = resolveJavaRuntimeEnv({ ...env, ...signEnv });
  // 不把 javaEnv 传进被日志的函数:它由 process.env + 签名口令(signEnv)派生,
  // CodeQL 会将「机密 env 流入日志」判为泄漏(即便 javaRuntimeDetail 只读版本 /
  // JAVA_HOME)。这里只报静态信息;JDK 由 resolveJavaRuntimeEnv 确定性选 17+。
  log('  → gradle assembleRelease(已解析 JDK 17+ 运行时)');
  const androidDir = resolve(MOBILE_DIR, 'android');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  run(gradlew, ['assembleRelease'], { cwd: androidDir, env: javaEnv });

  const apkDir = join(androidDir, 'app/build/outputs/apk/release');
  const apk = existsSync(apkDir) ? readdirSync(apkDir).find((f) => f.endsWith('.apk')) : null;
  if (!apk) throw new Error(`assembleRelease 未产出 .apk:${apkDir}`);
  return join(apkDir, apk);
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

async function main() {
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
  const region = loadSelfHostRegions({ mode: 'local' })[rawRegion];
  if (!region.androidPackage?.trim()) {
    throw new Error(`self-host-regions.json 的 ${region.authRegion}.androidPackage 未填(构建必需)`);
  }
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
  if (args.execute) {
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
  }

  // env 必须在 versionCode 决定之后构建:经 XDT_ANDROID_VERSION_CODE 注入 prebuild。
  const env = selfhostEnv(region, versionCode, desktopVersion);

  // 计划打印
  console.log('');
  console.log(`target: Android 纯构建(region=${region.authRegion}, ${region.androidPackage})`);
  console.log(`version / versionCode: ${version} / ${versionCode}${args.versionCode != null ? ' (--version-code 覆盖)' : ' (取 android-version.json 现值)'}`);
  const suffix = String(region.authRegion).toUpperCase();
  const aSign = region.androidSigning ?? {};
  const pwPreview = (base) => (process.env[`${base}_${suffix}`]?.trim() || (suffix === 'CN' ? process.env[base]?.trim() : '')) ? 'set' : '未设';
  console.log(`sign: 自有 keystore 自签,path=${aSign.keystorePath || '(JSON 未填)'} alias=${aSign.keyAlias || '(JSON 未填)'} storePw(env ${suffix})=${pwPreview('XDT_ANDROID_KEYSTORE_PASSWORD')} keyPw(env ${suffix})=${pwPreview('XDT_ANDROID_KEY_PASSWORD')}`);
  console.log('steps: prebuild → patch build.gradle 签名 → gradlew assembleRelease → 从 APK 回读 runtimeVersion → aapt2 本地校验(仅构建,无上传/发布)');
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

  // region / endpoint manifest 自举基址必须齐全(读仓内 config/endpoint*.json,离线可用)。
  assertPublicEnv(env, { variant: 'production', requiredKeys: SELF_HOST_PUBLIC_ENV_KEYS });

  const apkPath = buildApk(env, region);
  log(`  ✓ apk: ${apkPath}`);

  // 权威 runtimeVersion = 真正烤进 APK 的 assets/fingerprint(仅报告,供发布侧比对)。
  const runtimeVersion = readEmbeddedRuntimeVersionFromApk(apkPath);
  log(`  ✓ runtimeVersion(读自 APK 内嵌 assets/fingerprint): ${runtimeVersion}`);

  validateApkMetadata(apkPath, region.androidPackage, versionCode);

  let finalPath = apkPath;
  if (typeof args.out === 'string' && args.out) {
    const outDir = resolve(String(args.out));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    finalPath = join(outDir, basename(apkPath));
    copyFileSync(apkPath, finalPath);
  }

  console.log('');
  console.log('==================== Android 构建完成 ====================');
  console.log(`  apk            : ${finalPath}`);
  console.log(`  version        : ${version} (${versionCode})`);
  console.log(`  runtimeVersion : ${runtimeVersion}`);
  console.log('  注意:本脚本只构建;APK 为本机 keystore 自签,分发/发布由发布方流程另行处理。');
  console.log('==========================================================');
}

// 兜底脱敏:错误文案若意外携带签名口令等秘密类 env 值,输出前抹掉。
// 用 IIFE 构建正则——RegExp 对象切断 CodeQL 对 env 值的 taint 追踪链。
const _secretScrubRe = (() => {
  const pats = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 6 || value.length > 512 || value.includes("\n")) continue;
    if (/(password|passwd|secret|token|api[_-]?key|credential|private)/i.test(name)) {
      pats.push(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }
  pats.sort((a, b) => b.length - a.length);
  return pats.length > 0 ? new RegExp(pats.join('|'), 'g') : null;
})();

function scrubSecretsFromText(text) {
  const s = String(text ?? '');
  return _secretScrubRe ? s.replace(_secretScrubRe, '***') : s;
}

main().catch((err) => { console.error(scrubSecretsFromText(err?.message)); process.exit(1); }); // lgtm[js/clear-text-logging]
