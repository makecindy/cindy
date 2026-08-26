// 本机 Android 冷更(release-android-local.mjs)的 helper —— 纯函数为主,便于单测。
// 涉及 buildNumber/versionCode 单调、CDN 基线、release 记录组装的逻辑与平台无关,直接复用
// ./ios-local.mjs(不重复实现);本文件只放 Android 特有的:committed versionCode 读取、
// 生成的 android/app/build.gradle 签名 patch、keystore 签名环境解析。

import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ANDROID_ARTIFACT_KINDS = Object.freeze(['apk', 'aab']);

/**
 * 解析 Android 构建产物集合。默认按地区选择:cn/dev 只出 APK,global 同时出 APK + AAB;
 * --artifacts 可显式覆盖,但 AAB 仅允许 global 身份,避免误把国内包当成 Play 产物。
 * 返回顺序固定为 apk → aab,让 Gradle task / 日志 / 复制顺序保持确定性。
 * @param {string} authRegion
 * @param {string|boolean|undefined} rawArtifacts
 * @returns {Array<'apk'|'aab'>}
 */
export function resolveAndroidArtifactKinds(authRegion, rawArtifacts) {
  const region = String(authRegion ?? '').trim();
  const source = rawArtifacts == null
    ? (region === 'global' ? 'apk,aab' : 'apk')
    : String(rawArtifacts).trim();
  if (!source || rawArtifacts === true) {
    throw new Error('--artifacts 必须指定 apk、aab 或 apk,aab');
  }

  const requested = source.split(',').map((item) => item.trim()).filter(Boolean);
  if (!requested.length) throw new Error('--artifacts 不能为空');
  const duplicates = requested.filter((kind, index) => requested.indexOf(kind) !== index);
  if (duplicates.length) {
    throw new Error(`--artifacts 含重复产物:${[...new Set(duplicates)].join(', ')}`);
  }
  const unknown = requested.filter((kind) => !ANDROID_ARTIFACT_KINDS.includes(kind));
  if (unknown.length) {
    throw new Error(`--artifacts 仅支持 ${ANDROID_ARTIFACT_KINDS.join(',')},收到:${unknown.join(',')}`);
  }
  if (region !== 'global' && requested.includes('aab')) {
    throw new Error(`AAB 仅用于 global Google Play 产物,当前 region=${region || '(空)'}`);
  }
  return ANDROID_ARTIFACT_KINDS.filter((kind) => requested.includes(kind));
}

/** @param {Array<'apk'|'aab'>} kinds */
export function androidGradleTasksForArtifacts(kinds) {
  const selected = Array.isArray(kinds) ? kinds : [];
  if (!selected.length) throw new Error('Android 构建至少需要一种产物');
  return selected.map((kind) => kind === 'apk' ? 'assembleRelease' : 'bundleRelease');
}

export const ANDROID_UPLOAD_CERT_SHA256_ENV = 'XDT_ANDROID_UPLOAD_CERT_SHA256';

/**
 * 归一化 Play Console / keytool 常见的 SHA-256 证书指纹格式。证书指纹是公开身份 pin,
 * 不是 keystore 口令；允许裸 64 位 hex、冒号分隔和 SHA256: 前缀。
 * @param {unknown} raw
 * @param {string} [source]
 */
export function normalizeAndroidCertificateSha256(raw, source = 'Android 证书 SHA-256') {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/^sha-?256\s*:/i, '')
    .replace(/[\s:]/g, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${source} 必须是 64 位十六进制 SHA-256 指纹`);
  }
  return normalized;
}

/**
 * 从独立 env 读取 Google Play 上传证书 pin。它不能从本次选择的 JKS 动态计算，否则
 * keystorePath / alias 本身配错时会把错误证书同时当作“期望值”，失去发布身份保护。
 * @param {string} authRegion
 * @param {NodeJS.ProcessEnv} [baseEnv]
 */
export function resolveAndroidUploadCertificateSha256(authRegion, baseEnv = process.env) {
  const suffix = String(authRegion ?? '').trim().toUpperCase();
  const envName = `${ANDROID_UPLOAD_CERT_SHA256_ENV}_${suffix}`;
  const raw = String(baseEnv[envName] ?? '').trim();
  if (!raw) {
    throw new Error(`${envName} 未设置(AAB 构建必须独立 pin Google Play「上传密钥证书」SHA-256,不要填应用签名密钥证书)`);
  }
  return normalizeAndroidCertificateSha256(raw, envName);
}

/**
 * 解析 `keytool -printcert -jarfile <aab> -rfc` 输出中的首张(签名者 leaf)证书。
 * 未签名 JAR/AAB 的 keytool 也可能退出 0,但不会输出 PEM；这里必须 fail closed。
 * @param {unknown} rawOutput
 * @param {string} [source]
 */
export function readAndroidCertificateSha256FromPemOutput(rawOutput, source = 'AAB 签名证书') {
  const pem = String(rawOutput ?? '').match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  )?.[0];
  if (!pem) throw new Error(`${source} 未找到 PEM 证书(产物可能未签名)`);
  try {
    return normalizeAndroidCertificateSha256(new X509Certificate(pem).fingerprint256, source);
  } catch (err) {
    throw new Error(`${source} 解析失败:${err?.message ?? err}`);
  }
}

export function assertAndroidUploadCertificateSha256(actual, expected) {
  const actualSha256 = normalizeAndroidCertificateSha256(actual, 'AAB 实际签名证书 SHA-256');
  const expectedSha256 = normalizeAndroidCertificateSha256(expected, '预期上传证书 SHA-256');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`AAB 上传证书不符:期望 ${expectedSha256},实际 ${actualSha256}`);
  }
  return actualSha256;
}

// 签名配置零代码默认值:keystore 路径 / alias / 两个口令全部由 XDT_ANDROID_* 环境变量提供,
// 缺任一项即抛错(fail-closed)。签名套件本体(CindyMobileCer/Android/,含 signing-info.txt)
// 在打包机的仓库外目录,口令**绝不**写进代码,只从 env 读。

/**
 * 读 committed android-version.json 的 versionCode(单调递增整数,语义对齐 iOS buildNumber)。
 * app.config.js 不直接读本文件,由发布脚本读后经 env XDT_ANDROID_VERSION_CODE 注入,
 * 故本文件对 @expo/fingerprint 不可见(红线 1)。
 * @param {string} mobileDir apps/mobile 目录
 * @returns {number} 正整数 versionCode
 */
export function readAndroidVersionCode(mobileDir) {
  const file = resolve(mobileDir, 'android-version.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读取/解析 ${file} 失败:${err?.message ?? err}`);
  }
  const vc = raw?.versionCode;
  if (!Number.isInteger(vc) || vc <= 0) {
    throw new Error(`android-version.json 的 versionCode 必须是正整数,当前为 ${JSON.stringify(vc)}`);
  }
  return vc;
}

/**
 * 计算下一个 Android 冷更 versionCode:max(current, previous) + 1。
 * android-version.json 的既有约定是小整数顺序递增(1、2、3…),与 iOS 的日期基 buildNumber
 * 不同,自动 bump 保持各自惯例。current/previous 必须是正整数(previous 来自 CDN 记录,
 * 可能是数字串);非整数抛错回退手动 bump,不静默产出错误版号。
 * @param {string|number} current 本地 android-version.json 当前值
 * @param {string|number|null} previous 线上冷更基线值(可为空 = 首发)
 * @returns {number}
 */
export function nextSequentialVersionCode(current, previous) {
  const floors = [current, previous]
    .filter((v) => v != null && v !== '')
    .map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || !/^\d+$/.test(String(v))) {
        throw new Error(`无法自动 bump:versionCode ${JSON.stringify(String(v))} 不是正整数,请手动 bump 后重试`);
      }
      return n;
    });
  if (!floors.length) throw new Error('nextSequentialVersionCode 需要至少一个有效的 current/previous');
  return Math.max(...floors) + 1;
}

/**
 * 在 android-version.json 原文上就地替换 versionCode —— 纯字符串替换而非 parse→stringify,
 * 保留 _comment 等其余内容与格式零改动、diff 只有一行。
 * 要求全文恰好一处 "versionCode";0 处或多处一律抛错防误替换。
 * @param {string} rawText android-version.json 原文
 * @param {number} nextVersionCode 正整数
 * @returns {string}
 */
export function replaceVersionCodeInAndroidVersionJson(rawText, nextVersionCode) {
  if (!Number.isInteger(nextVersionCode) || nextVersionCode <= 0) {
    throw new Error(`replaceVersionCodeInAndroidVersionJson:新 versionCode 必须是正整数,收到 ${JSON.stringify(nextVersionCode)}`);
  }
  const matches = String(rawText).match(/"versionCode"\s*:\s*\d+/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(`android-version.json 中 "versionCode" 出现 ${matches.length} 处(期望恰好 1 处),拒绝自动替换,请手动 bump`);
  }
  return String(rawText).replace(/("versionCode"\s*:\s*)\d+/, `$1${nextVersionCode}`);
}

/**
 * 解析 keystore 签名环境(供 gradlew assembleRelease 消费,build.gradle 用 System.getenv 读)。
 * 按 region 分离:非机密的 keystorePath / keyAlias 从 self-host-regions.json 的 androidSigning 取值;
 * 两个**口令是机密、不入仓**,从 env 按 region 后缀读 —— XDT_ANDROID_KEYSTORE_PASSWORD_<SUFFIX> /
 * XDT_ANDROID_KEY_PASSWORD_<SUFFIX>(SUFFIX = authRegion 大写,如 CN / GLOBAL);cn 额外回落到
 * 无后缀旧名(现有 cn 打包 env 不用改)。缺任一项即抛错(fail-closed)。
 * 返回的 env 只在构建子进程内传入,绝不落盘、绝不写进 build.gradle。
 * @param {{ authRegion?: string, androidSigning?: { keystorePath?: string, keyAlias?: string } }} regionConfig
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {{ XDT_ANDROID_KEYSTORE_PATH: string, XDT_ANDROID_KEYSTORE_PASSWORD: string, XDT_ANDROID_KEY_ALIAS: string, XDT_ANDROID_KEY_PASSWORD: string }}
 */
export function resolveAndroidSigningEnv(regionConfig, baseEnv = process.env) {
  const s = regionConfig?.androidSigning ?? {};
  const region = regionConfig?.authRegion ?? '?';
  const suffix = String(region).toUpperCase();
  const keystorePath = String(s.keystorePath ?? '').trim();
  const keyAlias = String(s.keyAlias ?? '').trim();
  // 口令走 env(机密不入仓):region 后缀优先;cn 回落到无后缀旧名。
  const pickSecret = (base) => {
    const suffixed = String(baseEnv[`${base}_${suffix}`] ?? '').trim();
    if (suffixed) return suffixed;
    return suffix === 'CN' ? String(baseEnv[base] ?? '').trim() : '';
  };
  const storePassword = pickSecret('XDT_ANDROID_KEYSTORE_PASSWORD');
  const keyPassword = pickSecret('XDT_ANDROID_KEY_PASSWORD');
  const missing = [];
  if (!keystorePath) missing.push(`${region}.androidSigning.keystorePath (JSON)`);
  if (!keyAlias) missing.push(`${region}.androidSigning.keyAlias (JSON)`);
  if (!storePassword) missing.push(`XDT_ANDROID_KEYSTORE_PASSWORD_${suffix} (env)`);
  if (!keyPassword) missing.push(`XDT_ANDROID_KEY_PASSWORD_${suffix} (env)`);
  if (missing.length) {
    throw new Error(
      `Android 签名配置缺失(${region}):${missing.join(', ')}(路径/alias 走 region JSON,两个口令走 env、凭证不入仓)`,
    );
  }
  return {
    XDT_ANDROID_KEYSTORE_PATH: keystorePath,
    XDT_ANDROID_KEYSTORE_PASSWORD: storePassword,
    XDT_ANDROID_KEY_ALIAS: keyAlias,
    XDT_ANDROID_KEY_PASSWORD: keyPassword,
  };
}

// 注入进 signingConfigs 块的 release 签名(从 System.getenv 读,gradlew 子进程 env 传入,
// 口令不落盘、不写进被 patch 的文件——文件里只有 property 名)。
const RELEASE_SIGNING_CONFIG_SNIPPET = `        release {
            storeFile file(System.getenv("XDT_ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("XDT_ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("XDT_ANDROID_KEY_ALIAS")
            keyPassword System.getenv("XDT_ANDROID_KEY_PASSWORD")
        }
`;

/**
 * 幂等 patch 生成的 android/app/build.gradle,使 release 构建用自有 keystore 自签:
 *   1. 在 signingConfigs { 块内插入 release {...}(env 驱动);
 *   2. 把 release buildType 的 `signingConfig signingConfigs.debug` 改成 `.release`。
 * 已 patch(出现 signingConfigs.release)则原样返回。找不到锚点则抛错(不静默出未签名/debug 签名包)。
 * 纯函数,便于单测。
 * @param {string} source build.gradle 原文
 * @returns {string}
 */
export function patchBuildGradleSigning(source) {
  if (typeof source !== 'string' || !source) throw new Error('patchBuildGradleSigning: 空 build.gradle');
  if (source.includes('signingConfigs.release')) return source; // 幂等:已 patch

  // 1) 在 signingConfigs { 之后插入 release 配置(只认第一处 signingConfigs 块)。
  const signingBlock = /signingConfigs\s*\{/;
  if (!signingBlock.test(source)) {
    throw new Error('patchBuildGradleSigning: 未找到 signingConfigs { 块(Expo prebuild 模板结构变化?)');
  }
  let patched = source.replace(signingBlock, (m) => `${m}\n${RELEASE_SIGNING_CONFIG_SNIPPET}`);

  // 2) 把 buildTypes 里 release 块的 signingConfig 从 debug 切到 release。
  //    lazy 匹配确保停在 release 块内首个 signingConfig 行;模板中 debug buildType 在前、release 在后,
  //    debug 的 signingConfig 不受影响。\brelease\s*\{ 避免误命中 enableProguardInReleaseBuilds 等。
  const flip = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?signingConfig\s+signingConfigs\.)debug/;
  if (!flip.test(patched)) {
    throw new Error('patchBuildGradleSigning: 未找到 release buildType 的 signingConfig signingConfigs.debug(模板结构变化?)');
  }
  patched = patched.replace(flip, '$1release');
  return patched;
}

/**
 * 幂等 patch 生成的 android/gradle.properties 的 org.gradle.jvmargs,调大 heap / metaspace,
 * 避免大型多模块 + KSP 编译时 Metaspace OOM。保留该行其它已有 flag,只 bump 两个数值(缺则补)。
 * @param {string} source gradle.properties 原文
 * @param {{ xmxMb?: number, metaspaceMb?: number }} [opts]
 * @returns {string}
 */
export function patchGradlePropertiesMemory(source, { xmxMb = 4096, metaspaceMb = 2048 } = {}) {
  if (typeof source !== 'string') throw new Error('patchGradlePropertiesMemory: 非字符串');
  const line = source.match(/^org\.gradle\.jvmargs=.*$/m);
  if (!line) {
    return `${source.replace(/\n?$/, '\n')}org.gradle.jvmargs=-Xmx${xmxMb}m -XX:MaxMetaspaceSize=${metaspaceMb}m\n`;
  }
  let val = line[0];
  val = /-Xmx\d+[kmgKMG]/.test(val) ? val.replace(/-Xmx\d+[kmgKMG]/, `-Xmx${xmxMb}m`) : `${val} -Xmx${xmxMb}m`;
  val = /-XX:MaxMetaspaceSize=\d+[kmgKMG]/.test(val)
    ? val.replace(/-XX:MaxMetaspaceSize=\d+[kmgKMG]/, `-XX:MaxMetaspaceSize=${metaspaceMb}m`)
    : `${val} -XX:MaxMetaspaceSize=${metaspaceMb}m`;
  return source.replace(/^org\.gradle\.jvmargs=.*$/m, val);
}
