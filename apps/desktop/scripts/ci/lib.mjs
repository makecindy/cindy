// =============================================================================
// 共享工具库 — CI 构建/发布脚本通用逻辑
//
// 这里只放纯辅助函数：哈希、压缩、OSS、CDN manifest、drizzle 校验、版本号写入等。
// 主流程逻辑由 build-* / publish-* 各自负责。
// =============================================================================

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// createGunzip / pipeline 供下方 immutable-guard 下载复核用;sha256 / gzipFile / OSS 原语
// 已抽到 scripts/shared/oss.mjs(下方 re-export),故不再本地 import crypto / createGzip。
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolveReleaseCdnBaseUrl } from '../../../../scripts/shared/release-env.mjs';
// OSS/CDN 原语(sha256 / gzip / ali-oss client / upload)已抽到仓库根 scripts/shared/oss.mjs,
// 供 desktop 与 mobile 共用;这里 re-export 保持既有 import 面(CDN_BASE / createOSSClient 等)不变。
import {
  CDN_BASE,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  resolveOssConfig,
  resolveOssCredentials,
  resolveReleaseRegion,
  refreshOssConfig,
  sha256,
  gzipFile,
  createOSSClient,
  uploadToOSS,
} from '../../../../scripts/shared/oss.mjs';

export {
  CDN_BASE,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  resolveOssConfig,
  resolveOssCredentials,
  resolveReleaseRegion,
  refreshOssConfig,
  sha256,
  gzipFile,
  createOSSClient,
  uploadToOSS,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.resolve(__dirname, '..');
export const DESKTOP_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const PROJECT_ROOT = path.resolve(DESKTOP_ROOT, '../..');
export const RELEASE_DIR = path.join(DESKTOP_ROOT, 'release');

/**
 * electron-forge 打包产物基名(2026-07-17 品牌翻转 xdt-maker → Cindy):
 *   - packaged 目录  out/<PACKAGED_APP_NAME>-<platform>-<arch>/
 *   - Windows exe    <packaged>/<PACKAGED_APP_NAME>.exe
 *   - macOS .app     <packaged>/<PACKAGED_APP_NAME>.app(Mach-O 同名)
 *   - Linux 二进制   <packaged>/<PACKAGED_APP_NAME>
 * ⚠️ 值必须与 packages/maker-shared/src/brandIdentity.ts 的
 * BRAND_IDENTITY.executableName(= apps/desktop/package.json productName)一致
 * ——.mjs 无法 import TS 单点,只能镜像字面量;一致性由
 * scripts/__tests__/brand-identity-sync.test.mjs 断言兜底。
 * ⚠️ 只描述「本地构建产物路径」。OSS/CDN 渠道前缀与发布产物文件名
 * (xdt-maker-<version>-Setup.exe / .dmg / .zip 等)仍留在老值:新渠道 bucket
 * 未就绪,发布目标另议,不随本次翻转。
 */
export const PACKAGED_APP_NAME = 'Cindy';

/**
 * 按区域取打包产物基名(exe / .app / 安装目录 / 快捷方式全部跟随)。
 * cn/global 同值 'Cindy'(2026-07-26 显示名统一决策,放弃文件层双装隔离),
 * dev 独立。镜像 brandIdentity.ts 的 executableNameByRegion,一致性由
 * scripts/__tests__/brand-identity-sync.test.mjs 断言兜底。
 * PACKAGED_APP_NAME 保留为 cn 基线值,供未传 region 的 legacy 脚本使用。
 */
export const PACKAGED_APP_NAME_BY_REGION = Object.freeze({
  cn: 'Cindy',
  global: 'Cindy',
  dev: 'CindyDev',
});

export function packagedAppName(region = 'cn') {
  const name = PACKAGED_APP_NAME_BY_REGION[region];
  if (!name) throw new Error(`unknown region: ${region}`);
  return name;
}

/**
 * 发布产物文件名基名(安装包 / 热更 zip / OSS key 里的文件名,用户下载可见)。
 * 老 'xdt-maker-*' 命名只属于已冻结的 /xdt-maker 渠道;新渠道(2026-07-19 实查
 * 现网 manifest 全 404,从零起步)统一用 cindy 命名,与 package-desktop.mjs 的
 * 本地产物命名对齐。
 */
export const RELEASE_ARTIFACT_BASENAME_BY_REGION = Object.freeze({
  cn: 'cindy',
  global: 'cindy-global',
  dev: 'cindy-dev',
});

export function releaseArtifactBasename(region = 'cn') {
  const name = RELEASE_ARTIFACT_BASENAME_BY_REGION[region];
  if (!name) throw new Error(`unknown region: ${region}`);
  return name;
}

// CDN_BASE / OSS_BUCKET / OSS_PREFIX / OSS_REGION 由 scripts/shared/oss.mjs 提供并在顶部 re-export。

/**
 * 渠道冻结硬闸(2026-07-17 身份翻转):老 /xdt-maker 渠道已冻结,存量 0.0.x
 * 用户的更新器按 --exe-name xdt-maker.exe 工作——把 Cindy 布局(Cindy.exe)
 * 的产物/manifest 发上老前缀,会让所有存量安装的自动更新当场断裂。
 * 在任何 desktop 发布/上传动作前调用;新渠道 bucket 就绪并把 OSS 前缀切走
 * 之前,发布一律拒绝。确需覆盖(如演练)显式设 XDT_ALLOW_LEGACY_CHANNEL_RELEASE=1。
 */
export function assertNotPublishingCindyToLegacyChannel(ossPrefix) {
  if (process.env.XDT_ALLOW_LEGACY_CHANNEL_RELEASE === '1') return;
  if (PACKAGED_APP_NAME === 'Cindy' && ossPrefix === 'xdt-maker') {
    throw new Error(
      '[channel-freeze] 拒绝把 Cindy 身份的产物发布到已冻结的 /xdt-maker 渠道:'
      + '存量用户更新器会因 exe 布局变化(Cindy.exe)当场断裂。'
      + '等新渠道 OSS 前缀就绪后再发布;演练可设 XDT_ALLOW_LEGACY_CHANNEL_RELEASE=1 覆盖。',
    );
  }
}

// ── Apple 公证/签名身份(macOS release / publish 共用;单点定义)────────────
// 均为公开身份信息(非密钥;APPLE_APP_PASSWORD 才是密钥,只从 env 读)。
// 2026-07-20 起**零代码默认值**:身份来自 release-regions.json 的 <region>.macSigning
// (经 applyReleaseRegionConfigToEnv / applyMacSigningConfigToEnv 注入 env)或显式
// env,缺失直接抛错——此前默认回落个人证书,会在密码/证书换主体后静默签错身份。
// 必须是函数而非模块级 const:env 在调用时读取——消费脚本先注入配置再调用。
export function resolveAppleIdentity() {
  const appleId = process.env.APPLE_ID?.trim();
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  const signIdentity = process.env.APPLE_SIGN_IDENTITY?.trim();
  const missing = [
    !appleId && 'APPLE_ID',
    !teamId && 'APPLE_TEAM_ID',
    !signIdentity && 'APPLE_SIGN_IDENTITY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `mac 签名/公证身份缺失: ${missing.join(' / ')}。` +
        '配置途径(推荐): apps/desktop/scripts/release-regions.json 的 <region>.macSigning' +
        '(appleId / teamId / signIdentity);或直接设置同名环境变量。身份无代码默认值。',
    );
  }
  return { appleId, teamId, signIdentity };
}

// ── .env 读取 ──────────────────────────────────────────────────────────────

export function loadDotenv(
  envFilePath = path.join(DESKTOP_ROOT, '.env'),
  { refreshReleaseConfig = true } = {},
) {
  try {
    const envFile = fs.readFileSync(envFilePath, 'utf8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch { /* no .env file, that's fine */ }
  if (refreshReleaseConfig) refreshOssConfig();
}

// ── 命令封装 ────────────────────────────────────────────────────────────────
// (sha256 / gzipFile 已移至 scripts/shared/oss.mjs,顶部 re-export)

export function exec(cmd, opts = {}) {
  console.log(`    $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

// ── package.json 版本号写入 (退出时自动恢复) ────────────────────────────────
//
// electron-packager 会把 package.json 拷到 asar 内部，运行时 app.getVersion()
// 优先读那里。占位符 0.0.0-dev 不改的话热更新版本比较全部失真。
// 任何 exit / SIGINT / SIGTERM 都恢复，保证 git 工作区干净。

const PACKAGE_JSON_PATH = path.join(DESKTOP_ROOT, 'package.json');
let originalPackageJson = null;

export function writePackageVersion(version) {
  if (originalPackageJson === null) {
    originalPackageJson = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
    process.on('exit', restorePackageJson);
    process.on('SIGINT', () => { restorePackageJson(); process.exit(130); });
    process.on('SIGTERM', () => { restorePackageJson(); process.exit(143); });
  }
  const pkg = JSON.parse(originalPackageJson);
  pkg.version = version;
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

function restorePackageJson() {
  if (originalPackageJson === null) return;
  try { fs.writeFileSync(PACKAGE_JSON_PATH, originalPackageJson); } catch { /* ignore */ }
}

// ── CDN manifest ───────────────────────────────────────────────────────────

// 基线 manifest 必须带 ?t= cache-bust:CDN 对裸 URL 有边缘缓存(源站 Cache-Control:
// no-cache 不一定被 CDN 尊重),客户端 manifestService 与 promote-canary-* 都带了,
// 唯独发布脚本此前漏了——2026-07-03 事故的直接诱因就是发版时读到陈旧基线,误判
// "版本变了" 而对已存在的版本化路径做了字节不同的覆盖上传。
export async function fetchExistingManifestIfAvailable(platformKey, region = 'cn') {
  const cdnBase = resolveReleaseCdnBaseUrl(region);
  const canaryUrl = `${cdnBase}/manifest-${platformKey}-canary.json?t=${Date.now()}`;
  const canaryRes = await fetch(canaryUrl);
  if (canaryRes.ok) {
    return await canaryRes.json();
  }
  if (canaryRes.status !== 404) {
    throw new Error(`Failed to fetch canary manifest (${canaryRes.status}): ${canaryUrl}`);
  }
  const stableUrl = `${cdnBase}/manifest-${platformKey}.json?t=${Date.now()}`;
  const stableRes = await fetch(stableUrl);
  if (stableRes.ok) {
    return await stableRes.json();
  }
  if (stableRes.status === 404) {
    return null;
  }
  throw new Error(`Failed to fetch stable manifest (${stableRes.status}): ${stableUrl}`);
}

export async function fetchExistingManifest(platformKey) {
  const manifest = await fetchExistingManifestIfAvailable(platformKey);
  if (manifest) return manifest;
  throw new Error(`No manifest found for ${platformKey}`);
}

export async function fetchReferenceManifest(platformKeys) {
  for (const platformKey of platformKeys) {
    const manifest = await fetchExistingManifestIfAvailable(platformKey);
    if (manifest) {
      return { manifest, platformKey };
    }
  }
  throw new Error(`No reference manifest found for: ${platformKeys.join(', ')}`);
}

export function createInitialManifest(version, options = {}) {
  return {
    app: {
      version,
      ...(options.releaseNotes ? { releaseNotes: options.releaseNotes } : {}),
    },
    claudeCode: {
      version: '0.0.0',
      file: '',
      sha256: '',
      size: 0,
    },
  };
}

/**
 * Linux first release is installer/manual-download only.
 * Reuse this helper anywhere we mint a Linux manifest so `app.hotfix` and
 * `app.requireRelogin` can never leak back in through copy/paste drift.
 */
export function createLinuxFirstReleaseManifest(version, baseManifest) {
  const releaseNotes = baseManifest?.app?.releaseNotes;
  const manifest = baseManifest
    ? JSON.parse(JSON.stringify(baseManifest))
    : createInitialManifest(version, { releaseNotes });
  manifest.app = {
    ...(manifest.app ?? {}),
    version,
  };
  delete manifest.app.hotfix;
  delete manifest.app.requireRelogin;
  delete manifest.app.installer;
  delete manifest.installer;
  // Packaged Linux resolves Claude/Codex from a compatible system install,
  // migrates the legacy local cache, or downloads the pinned official asset.
  // Ripgrep remains bundled in the .deb by forge and needs no manifest entry.
  delete manifest.claudeCode;
  delete manifest.codex;
  delete manifest.ripgrep;
  return manifest;
}

/**
 * 宿主 Linux 的 platform key。linux 不做交叉打包(原生模块与 vec0.so 都是
 * per-arch 预编译件),所以缺省校验对象就是宿主自身;写死 linux-x64 会让
 * aarch64 机器去查一份根本不进包的资产。编排层仍应显式传目标 arch。
 */
export function linuxHostPlatformKey() {
  return `linux-${process.arch}`;
}
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const MIN_LINUX_RUNTIME_ASSET_SIZE_BYTES = 1024;

function readFilePrefix(filePath, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function linuxRuntimeAssetPaths(platformKey = linuxHostPlatformKey()) {
  return [
    path.join(DESKTOP_ROOT, 'native', 'sqlite-vec', platformKey, 'vec0.so'),
  ];
}

export function collectLinuxRuntimeAssetProblems(assetPaths = linuxRuntimeAssetPaths()) {
  const missing = [];
  const invalid = [];
  for (const filePath of assetPaths) {
    if (!fs.existsSync(filePath)) {
      missing.push(filePath);
      continue;
    }
    const stat = fs.statSync(filePath);
    const prefix = readFilePrefix(filePath, LFS_POINTER_PREFIX.length);
    if (stat.size < MIN_LINUX_RUNTIME_ASSET_SIZE_BYTES || prefix === LFS_POINTER_PREFIX) {
      invalid.push(filePath);
    }
  }
  return { missing, invalid };
}

export async function ensureLinuxRuntimeAssets({
  label = 'Linux runtime assets',
  platformKey = linuxHostPlatformKey(),
} = {}) {
  // Claude/Codex 不打进 Linux 安装包，packaged runtime 会复用系统 CLI、迁移
  // 旧缓存，或从官方上游下载带 SHA-256 校验的 pin 版本。Ripgrep 仍由 forge
  // prePackage 单独 stage 进 resources/tools；这里仅校验 Git LFS 的 sqlite-vec。
  const sqliteVecPath = path.join(DESKTOP_ROOT, 'native', 'sqlite-vec', platformKey, 'vec0.so');
  const { missing, invalid } = collectLinuxRuntimeAssetProblems([sqliteVecPath]);
  if (missing.length === 0 && invalid.length === 0) return;
  if (missing.length > 0) {
    console.error(`ERROR: ${label} missing:`);
    for (const filePath of missing) {
      console.error(`  - ${filePath}`);
    }
  }
  if (invalid.length > 0) {
    console.error(`ERROR: ${label} invalid or still stored as Git LFS pointers:`);
    for (const filePath of invalid) {
      console.error(`  - ${filePath}`);
    }
  }
  console.error('sqlite-vec is still Git-LFS managed; run `git lfs pull` to materialize it before release.');
  process.exit(1);
}

export function logLinuxPackagingRequirements() {
  console.log('==> Linux first release packaging note:');
  console.log('    - Current packaging target is .deb (MakerDeb), not AppImage.');
  console.log('    - Linux builders need Debian packaging tools: fakeroot, dpkg, desktop-file-utils.');
  console.log('    - Native rebuild still needs the usual Electron toolchain: python3, make, gcc/g++.');
}

export function findInstallerArtifact(makeBaseDir, extension) {
  const stack = [makeBaseDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name.endsWith(`.${extension}`)) return full;
    }
  }
  return null;
}

// ── Release manifest (本次构建的元数据) ─────────────────────────────────────

export function writeReleaseManifest(destPath, ctx) {
  const journalPath = path.join(DESKTOP_ROOT, 'drizzle', 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const schemaVersionMax = entries.reduce(
    (max, e) => (typeof e.idx === 'number' && e.idx > max ? e.idx : max),
    -1,
  );
  const migrationFiles = fs
    .readdirSync(path.join(DESKTOP_ROOT, 'drizzle'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  let commitSha = '';
  try {
    commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: DESKTOP_ROOT }).trim();
  } catch { /* not in a git work tree */ }

  let electronVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf-8'));
    electronVersion = (pkg.devDependencies && pkg.devDependencies.electron) || '';
  } catch { /* ignore */ }

  const manifest = {
    version: ctx.version,
    commit_sha: commitSha,
    build_time: new Date().toISOString(),
    platform: ctx.platformKey.split('-')[0],
    arch: ctx.arch,
    schema_version_max: schemaVersionMax,
    migration_files: migrationFiles,
    node_version: process.version,
    electron_version: electronVersion,
  };
  fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`==> Release manifest written: ${destPath}`);
}

// ── Drizzle 校验 ───────────────────────────────────────────────────────────
//
// macOS:   appPath/Contents/Resources/drizzle/
// Windows: packagedDir/resources/drizzle/

export function verifyPackagedDrizzle(drizzleOut) {
  console.log(`==> Verifying packaged drizzle/ at ${drizzleOut} ...`);
  if (!fs.existsSync(drizzleOut)) {
    console.error(`ERROR: packaged drizzle/ missing at ${drizzleOut}`);
    process.exit(1);
  }
  const journalPath = path.join(drizzleOut, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    console.error(`ERROR: packaged meta/_journal.json missing at ${journalPath}`);
    process.exit(1);
  }
  const srcDrizzle = path.join(DESKTOP_ROOT, 'drizzle');
  const expectedSql = fs
    .readdirSync(srcDrizzle)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f));
  if (expectedSql.length === 0) {
    console.error(`ERROR: source drizzle/ has no NNNN_*.sql files`);
    process.exit(1);
  }
  for (const f of expectedSql) {
    const out = path.join(drizzleOut, f);
    if (!fs.existsSync(out)) {
      console.error(`ERROR: packaged drizzle/${f} missing at ${out}`);
      process.exit(1);
    }
  }
  console.log(`    verified ${expectedSql.length} sql file(s) + journal`);
}

// ── DB validation pre-flight ───────────────────────────────────────────────

export function runDbValidate() {
  console.log('==> Running db:validate pre-flight...');
  const result = spawnSync('pnpm', ['db:validate'], {
    stdio: 'inherit',
    cwd: DESKTOP_ROOT,
    shell: true,
  });
  if (result.status !== 0) {
    console.error('ERROR: db:validate failed; aborting.');
    process.exit(1);
  }
}

// ── macOS local signing ────────────────────────────────────────────────────

export function writeMacEntitlements(destPath, { appleEvents = false } = {}) {
  const appleEventsEntitlement = appleEvents
    ? `    <key>com.apple.security.automation.apple-events</key>
    <true/>
`
    : '';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
${appleEventsEntitlement}</dict>
</plist>`;
  fs.writeFileSync(destPath, content);
}

function readCodesignEntitlements(bundlePath) {
  const result = spawnSync(
    '/usr/bin/codesign',
    ['-d', '--entitlements', '-', '--xml', bundlePath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`codesign entitlement inspection failed for ${bundlePath}: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function hasAppleEventsEntitlement(entitlements) {
  return /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/.test(entitlements);
}

function readPlistString(infoPlistPath, key) {
  const result = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', `Print :${key}`, infoPlistPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`packaged Info.plist is missing ${key}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** Verify the packaged Contacts/JXA privacy contract after signing. */
export function verifyMacContactsPermissions(appPath) {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const appleEventsUsage = readPlistString(infoPlistPath, 'NSAppleEventsUsageDescription');
  const contactsUsage = readPlistString(infoPlistPath, 'NSContactsUsageDescription');
  for (const [key, value] of [
    ['NSAppleEventsUsageDescription', appleEventsUsage],
    ['NSContactsUsageDescription', contactsUsage],
  ]) {
    if (!/import/i.test(value) || !/(add|update|export)/i.test(value)) {
      throw new Error(`${key} must accurately describe Contacts import and explicit export/update`);
    }
  }

  if (!hasAppleEventsEntitlement(readCodesignEntitlements(appPath))) {
    throw new Error('main app is missing com.apple.security.automation.apple-events=true');
  }

  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  const helperApps = fs.readdirSync(frameworksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(frameworksDir, entry.name));
  for (const helperApp of helperApps) {
    if (hasAppleEventsEntitlement(readCodesignEntitlements(helperApp))) {
      throw new Error(`helper app must not receive Apple Events entitlement: ${helperApp}`);
    }
  }
  console.log('==> Verified macOS Contacts usage descriptions and main-only Apple Events entitlement');
}

export function adhocSignMacApp(appPath, helperEntitlementsPath, mainEntitlementsPath) {
  console.log('==> Ad-hoc signing macOS app for local packaged testing...');
  const signBase = '/usr/bin/codesign --force --options runtime --sign -';
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  const asarUnpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  if (fs.existsSync(asarUnpackedDir)) {
    exec(`find "${asarUnpackedDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  const resourceToolsDir = path.join(appPath, 'Contents', 'Resources', 'tools');
  if (fs.existsSync(resourceToolsDir)) {
    exec(`find "${resourceToolsDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
    exec(`find "${resourceToolsDir}" -depth -type d -name "*.app" -exec ${signBase} "{}" \\;`);
  }

  exec(`find "${frameworksDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  exec(`find "${frameworksDir}" -name "*.app" -exec ${signBase} --entitlements "${helperEntitlementsPath}" "{}" \\;`);
  exec(`find "${frameworksDir}" -maxdepth 1 -name "*.framework" -exec ${signBase} "{}" \\;`);
  exec(`${signBase} --entitlements "${mainEntitlementsPath}" "${appPath}"`);
  exec(`/usr/bin/codesign --verify --deep --strict "${appPath}"`);
  verifyMacContactsPermissions(appPath);
}

// ── macOS 正式签名 / 公证 / DMG(单点实现;publish-macos 与 package-desktop 共用)──
// 原实现在 ci/publish-macos.mjs 与 release-macos.mjs 各有一份;此处为参数化版本,
// Apple 身份由调用方传入(resolveAppleIdentity() + env APPLE_APP_PASSWORD)。

/**
 * Developer ID 由内向外逐层签名(Electron app 不能依赖 --deep)。
 * @param {{ signIdentity: string }} identity
 */
export function signMacAppWithIdentity(appPath, helperEntitlementsPath, mainEntitlementsPath, identity) {
  console.log('    Removing provenance attributes...');
  exec(`/usr/bin/xattr -dr com.apple.provenance "${appPath}" 2>/dev/null || true`);

  const signBase = `/usr/bin/codesign --force --timestamp --options runtime --sign "${identity.signIdentity}"`;
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  // 0. app.asar.unpacked/ 里的原生模块(better_sqlite3.node 等)是独立文件,
  //    不单签的话 Gatekeeper 拒绝加载,app 直接打不开。
  const asarUnpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  if (fs.existsSync(asarUnpackedDir)) {
    console.log('    Signing native modules in app.asar.unpacked/...');
    exec(`find "${asarUnpackedDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  // 0b. Contents/Resources/tools/ 下的 CLI 工具(extraResource 拷入,公证要求显式签)。
  const resourceToolsDir = path.join(appPath, 'Contents', 'Resources', 'tools');
  if (fs.existsSync(resourceToolsDir)) {
    console.log('    Signing bundled CLI tools in Contents/Resources/tools/...');
    exec(`find "${resourceToolsDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
    console.log('    Signing bundled resource app bundles...');
    exec(`find "${resourceToolsDir}" -depth -type d -name "*.app" -exec ${signBase} "{}" \\;`);
  }

  // 1. 全部 Mach-O(库、chrome_crashpad_handler、ShipIt 等)
  console.log('    Signing all Mach-O binaries...');
  exec(`find "${frameworksDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);

  // 2. Helper apps(V8 JIT entitlements)
  console.log('    Signing helper apps...');
  exec(`find "${frameworksDir}" -name "*.app" -exec ${signBase} --entitlements "${helperEntitlementsPath}" "{}" \\;`);

  // 3. Framework bundles
  console.log('    Signing frameworks...');
  exec(`find "${frameworksDir}" -maxdepth 1 -name "*.framework" -exec ${signBase} "{}" \\;`);

  // 4. 主 app bundle
  console.log('    Signing main app...');
  exec(`${signBase} --entitlements "${mainEntitlementsPath}" "${appPath}"`);

  console.log('    Verifying signature...');
  exec(`/usr/bin/codesign --verify --deep --strict "${appPath}"`);
  verifyMacContactsPermissions(appPath);
}

/**
 * Apple notarytool 公证 + staple。
 * @param {{ appleId: string, teamId: string, applePassword: string }} identity
 */
export function notarizeMacApp(appPath, identity) {
  const zipPath = appPath + '.zip';

  console.log('    Compressing for notarization...');
  exec(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${zipPath}"`);

  console.log('    Submitting to Apple notarization service (this may take a few minutes)...');
  // 密码作为 --password 值直接传给 notarytool——不再用 --password @env:VAR 间接:
  // 旧版 notarytool 不认 @env: 前缀,会把字面量 "@env:..." 当密码本身发出去而 401。
  // 走 spawnSync 参数数组:避免 shell 参与(无插值/无注入面),且日志回显时对密码
  // 打码(credentials 规则:输出不得含凭证明文)。
  // 注意暴露面:密码仍作为 xcrun 的明文 argv 传入,--wait 期间(最长 30min)同机同
  // 用户进程经 ps/proc 仍可读到——构建机为受控单租户环境,取此权衡;若需彻底消除
  // argv 暴露,后续可改用 notarytool 的 --keychain-profile(@keychain: 凭据)。
  const submitArgs = [
    'notarytool',
    'submit',
    zipPath,
    '--apple-id',
    identity.appleId,
    '--password',
    identity.applePassword,
    '--team-id',
    identity.teamId,
    '--wait',
  ];
  console.log(
    `    $ /usr/bin/xcrun notarytool submit "${zipPath}" ` +
      `--apple-id "${identity.appleId}" --password "****" --team-id "${identity.teamId}" --wait`,
  );
  const submitResult = spawnSync('/usr/bin/xcrun', submitArgs, {
    stdio: 'inherit',
    timeout: 1800000, // 30 min
  });
  if (submitResult.error) {
    throw new Error(`notarytool submit 无法执行:${submitResult.error.message}`);
  }
  if (submitResult.signal) {
    // 被信号终止(如 30min 超时 kill → SIGTERM):status 为 null,单看 exit 会显示
    // "exit null",这里显式报出 signal 便于定位。
    throw new Error(`notarytool submit 被信号 ${submitResult.signal} 终止(可能公证超时);公证未通过。`);
  }
  if (submitResult.status !== 0) {
    throw new Error(`notarytool submit 失败(exit ${submitResult.status});公证未通过。`);
  }

  fs.unlinkSync(zipPath);

  console.log('    Stapling notarization ticket...');
  exec(`/usr/bin/xcrun stapler staple "${appPath}"`);
}

// ── DMG 安装界面(dmgbuild)─────────────────────────────────────────────────
//
// DMG 用 dmgbuild(pip,纯 Python 无原生依赖)生成:Splash 品牌背景 + 图标定位的
// 安装窗口,替代裸 hdiutil 的无布局窗口。背景为 **PDF 矢量**——macOS 26 Finder
// 对位图背景只按 1x 绘制(Retina 必糊),但会按 backing scale 光栅化 PDF,
// 这是唯一的高清通道;完整实测结论与视觉约束见
// resources/dmg/render-background.swift 头注释。

/**
 * dmgbuild pin 版本;bump 前先在本机验证背景仍能渲染(macOS 26 Finder 很挑剔)。
 * ⚠️ 不得低于 1.6.6:旧版给背景写 bookmark 记录,macOS 26 Finder 不渲染
 * (electron-builder#9072 同源问题),1.6.6+ 才是 alias-only 实现。
 */
const DMGBUILD_VERSION = '1.6.7';

/** dmgbuild 1.6.6+ 要求 python >= 3.10;系统 /usr/bin/python3(CLT 3.9)不够 */
const PYTHON_MIN_MINOR = 10;

/** 从候选里找 >= 3.10 的 python3(PATH 优先,兼容 homebrew / CLT 新版) */
function findPython3() {
  const candidates = ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  for (const cand of candidates) {
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const m = `${r.stdout}${r.stderr}`.match(/Python 3\.(\d+)/);
    if (m && Number(m[1]) >= PYTHON_MIN_MINOR) return cand;
  }
  throw new Error(
    `No python3 >= 3.${PYTHON_MIN_MINOR} found (required by dmgbuild ${DMGBUILD_VERSION}); ` +
      'install one via https://python.org or homebrew',
  );
}

/**
 * 确保 dmgbuild 可用,返回其可执行文件路径。
 * venv 建在当前用户 ~/.cache 下并按版本号隔离(幂等复用);不用 /tmp——共享
 * 构建机上其他本地用户可预占可预测的 /tmp 路径塞入恶意 dmgbuild,而签名打包
 * 进程 env 里带着 APPLE_* 凭证。~/.cache 仅本用户可写,消除预占面。
 * 凭证不入仓、生成物不进工作区;首次创建需要网络(pip);失败直接抛错阻断
 * 构建,不静默回退成无背景 DMG。
 */
function ensureDmgbuild() {
  const venvDir = path.join(os.homedir(), '.cache', `cindy-dmgbuild-venv-${DMGBUILD_VERSION}`);
  const bin = path.join(venvDir, 'bin', 'dmgbuild');
  if (fs.existsSync(bin)) return bin;
  console.log(`    Installing dmgbuild ${DMGBUILD_VERSION} (one-time venv)...`);
  exec(`"${findPython3()}" -m venv "${venvDir}"`);
  exec(`"${path.join(venvDir, 'bin', 'pip')}" install --quiet dmgbuild==${DMGBUILD_VERSION}`);
  return bin;
}

/**
 * 生成带品牌安装界面的 UDZO DMG 并签名:Splash 风浅色背景(高清立绘 + CINDY
 * 字标 + 手写体 + 拖拽箭头,PDF 矢量高清)、app 居左 / Applications 软链居右、
 * 660×460 固定窗口。
 * 布局坐标与 resources/dmg/render-background.swift 内的品牌块/箭头位置联动,改动需两边同步。
 * @param {{ signIdentity: string }} identity
 */
export function createMacDMG(appPath, dmgPath, volumeName, identity) {
  const dmgbuildBin = ensureDmgbuild();
  const backgroundPath = path.join(DESKTOP_ROOT, 'resources', 'dmg', 'background.pdf');
  if (!fs.existsSync(backgroundPath)) {
    throw new Error(`DMG background missing: ${backgroundPath}`);
  }

  const appName = path.basename(appPath); // Cindy.app(cn/global)/ CindyDev.app(dev 线)
  // JSON.stringify 产出合法 Python 字符串字面量(转义引号/反斜杠语义一致)
  const py = (s) => JSON.stringify(s);
  const settings = [
    `files = [${py(appPath)}]`,
    `symlinks = {'Applications': '/Applications'}`,
    `background = ${py(backgroundPath)}`,
    // 与旧 hdiutil 产物格式保持一致(dmgbuild 默认 UDBZ)
    `format = 'UDZO'`,
    `window_rect = ((200, 140), (660, 460))`,
    `icon_size = 110`,
    `text_size = 13`,
    `icon_locations = {`,
    `    ${py(appName)}: (175, 335),`,
    `    'Applications': (485, 335),`,
    // 背景文件本体对默认设置的用户不可见;把坐标挪到远超可拉伸范围之外,
    // 照顾开了"显示隐藏文件"的用户(背景画布 900×610,窗口可被拉得比这更大)
    `    '.background.pdf': (1600, 1200),`,
    `}`,
  ].join('\n');
  const settingsPath = path.join(os.tmpdir(), `cindy-dmg-settings-${process.pid}.py`);
  fs.writeFileSync(settingsPath, settings);

  if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath);
  console.log('    Creating DMG (dmgbuild)...');
  try {
    exec(`"${dmgbuildBin}" -s "${settingsPath}" "${volumeName}" "${dmgPath}"`);
  } finally {
    fs.rmSync(settingsPath, { force: true });
  }

  console.log('    Signing DMG...');
  exec(`/usr/bin/codesign --force --timestamp --sign "${identity.signIdentity}" "${dmgPath}"`);
}

// ── Smoke test (启动 packaged app) ──────────────────────────────────────────

export function runSmokeTest(platform, arch, region = 'cn') {
  console.log('==> Running packaged smoke test...');
  const result = spawnSync(
    'node',
    [
      'scripts/smoke-packaged.mjs',
      `--platform=${platform}`,
      `--arch=${arch}`,
      // 产物基名按区域派生(cn/global 'Cindy' / dev 'CindyDev')。
      `--app-name=${packagedAppName(region)}`,
    ],
    { stdio: 'inherit', cwd: DESKTOP_ROOT, shell: false },
  );
  if (result.status !== 0) {
    console.error('ERROR: packaged smoke test failed; aborting.');
    process.exit(1);
  }
}

// ── Claude Code 二进制 ──────────────────────────────────────────────────────

export function getLocalClaudeCodeVersion(platformKey, binaryName = 'claude') {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, binaryName);
  if (!fs.existsSync(binPath)) return null;
  try { fs.chmodSync(binPath, 0o755); } catch {}
  try {
    const output = execSync(`"${binPath}" -v`, { encoding: 'utf8', timeout: 10000 });
    const match = output.match(/^([\d.]+)/);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(`    WARN: failed to exec ${binPath} --version: ${err.message}`);
    return null;
  }
}

/**
 * 比较本地 Claude Code 二进制与 CDN 上的版本和哈希，决定是否需要上传。
 * 返回 { uploadClaudeCode, gzPath, ccHash, ccSize, localBinHash } 或 null。
 */
export async function maybeBuildClaudeCodeGz({ platformKey, manifest, binaryName }) {
  const localCCVersion = getLocalClaudeCodeVersion(platformKey, binaryName);
  const cdnCCVersion = manifest.claudeCode?.version || '0.0.0';
  const cdnCCBinaryHash = manifest.claudeCode?.binarySha256 || '';

  console.log(`\n==> Claude Code compare (${platformKey})`);
  if (!localCCVersion) {
    console.log(`    SKIP: local bin missing or --version failed`);
    return null;
  }

  const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, binaryName);
  const binSize = fs.statSync(binPath).size;
  const localBinHash = sha256(binPath);

  console.log(`    bin path:         ${binPath}`);
  console.log(`    bin size:         ${(binSize / 1024 / 1024).toFixed(1)} MB (${binSize} bytes)`);
  console.log(`    local  version:   ${localCCVersion}`);
  console.log(`    local  sha256:    ${localBinHash}`);
  console.log(`    CDN    version:   ${cdnCCVersion}`);
  console.log(`    CDN    sha256:    ${cdnCCBinaryHash || '(none)'}`);

  const versionDiffers = localCCVersion !== cdnCCVersion;
  const hashDiffers = cdnCCBinaryHash ? localBinHash !== cdnCCBinaryHash : false;

  if (!versionDiffers && !hashDiffers) {
    console.log(`    → verdict: SKIP (version and binary hash match CDN)`);
    return null;
  }

  const reasons = [];
  if (versionDiffers) reasons.push(`version ${cdnCCVersion} → ${localCCVersion}`);
  if (hashDiffers) reasons.push('binary content changed');
  console.log(`    → verdict: UPLOAD (${reasons.join(', ')})`);

  const gzName = binaryName === 'claude.exe' ? 'claude.exe.gz' : `claude-${platformKey.split('-')[1]}.gz`;
  const gzPath = path.join(RELEASE_DIR, gzName);
  console.log(`    Compressing → ${gzName} ...`);
  await gzipFile(binPath, gzPath);
  const ccHash = sha256(gzPath);
  const ccSize = fs.statSync(gzPath).size;
  console.log(`    gz size:          ${(ccSize / 1024 / 1024).toFixed(1)} MB (${ccSize} bytes)`);
  console.log(`    gz sha256:        ${ccHash}`);

  return {
    localCCVersion,
    localBinHash,
    gzPath,
    gzName: binaryName === 'claude.exe' ? 'claude.exe.gz' : 'claude.gz',
    ccHash,
    ccSize,
  };
}

function getLocalCodexVersion(platformKey, binaryName = 'codex') {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', platformKey, binaryName);
  if (!fs.existsSync(binPath)) return null;
  try { fs.chmodSync(binPath, 0o755); } catch {}
  try {
    const output = execSync(`"${binPath}" --version`, { encoding: 'utf8', timeout: 10000 });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(`    WARN: failed to exec ${binPath} --version: ${err.message}`);
    return null;
  }
}

export async function maybeBuildCodexGz({ platformKey, manifest, binaryName }) {
  const localCodexVersion = getLocalCodexVersion(platformKey, binaryName);
  const cdnCodexVersion = manifest.codex?.version || '0.0.0';
  const cdnCodexBinaryHash = manifest.codex?.binarySha256 || '';

  console.log(`\n==> Codex compare (${platformKey})`);
  if (!localCodexVersion) {
    console.log('    SKIP: local bin missing or --version failed');
    return null;
  }

  const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', platformKey, binaryName);
  const binSize = fs.statSync(binPath).size;
  const localBinHash = sha256(binPath);

  console.log(`    bin path:         ${binPath}`);
  console.log(`    bin size:         ${(binSize / 1024 / 1024).toFixed(1)} MB (${binSize} bytes)`);
  console.log(`    local  version:   ${localCodexVersion}`);
  console.log(`    local  sha256:    ${localBinHash}`);
  console.log(`    CDN    version:   ${cdnCodexVersion}`);
  console.log(`    CDN    sha256:    ${cdnCodexBinaryHash || '(none)'}`);

  const versionDiffers = localCodexVersion !== cdnCodexVersion;
  const hashDiffers = cdnCodexBinaryHash ? localBinHash !== cdnCodexBinaryHash : false;

  if (!versionDiffers && !hashDiffers) {
    console.log('    -> verdict: SKIP (version and binary hash match CDN)');
    return null;
  }

  const reasons = [];
  if (versionDiffers) reasons.push(`version ${cdnCodexVersion} -> ${localCodexVersion}`);
  if (hashDiffers) reasons.push('binary content changed');
  console.log(`    -> verdict: UPLOAD (${reasons.join(', ')})`);

  // Keep the local temp artifact platform-qualified so parallel/staged release
  // runs do not clobber each other, but publish the canonical CDN object name
  // (`codex.gz`) to match the existing Claude manifest convention.
  const gzPath = path.join(RELEASE_DIR, binaryName === 'codex.exe' ? 'codex.exe.gz' : `codex-${platformKey.split('-')[1]}.gz`);
  console.log(`    Compressing -> ${path.basename(gzPath)} ...`);
  await gzipFile(binPath, gzPath);
  const codexHash = sha256(gzPath);
  const codexSize = fs.statSync(gzPath).size;
  console.log(`    gz size:          ${(codexSize / 1024 / 1024).toFixed(1)} MB (${codexSize} bytes)`);
  console.log(`    gz sha256:        ${codexHash}`);

  return {
    localCodexVersion,
    localBinHash,
    gzPath,
    gzName: binaryName === 'codex.exe' ? 'codex.exe.gz' : 'codex.gz',
    codexHash,
    codexSize,
  };
}

// ── 阿里云 OSS ─────────────────────────────────────────────────────────────
// createOSSClient / uploadToOSS / getAKSK 已移至 scripts/shared/oss.mjs(顶部 re-export);
// 下方 immutable 守卫通过 re-export 的 uploadToOSS / sha256 复用它们。

// ── 版本化二进制对象 immutable 守卫 ─────────────────────────────────────────
//
// 事故背景 (2026-07-03): claude-code/2.1.198/win32-x64/claude.exe.gz 在前后两次发版
// 中被重复 gzip + 覆盖上传到同一 OSS 路径。gzip 输出不可复现(同一 exe 两次压缩字节
// 不同),manifest 指向第二次的 sha256,而内网 CDN 边缘节点仍缓存第一次的字节 →
// 客户端下载后 sha256 校验必失败,内网 Windows 用户全部「环境初始化失败」。
//
// 原则:带版本号的 OSS 路径(claude-code/<ver>/... codex/<ver>/... ripgrep/<ver>/...)
// 一经上传即视为 immutable,发布二进制一律走本守卫,不要直接 uploadToOSS:
//   - 远端不存在           → 正常上传,并写 x-oss-meta-{gz,binary}-sha256,后续复核免下载
//   - 远端存在且二进制同源 → 不上传,复用远端对象的 sha256/size 写 manifest。用户实际
//                           下载的是远端字节,manifest 必须描述远端对象,而不是本地重压
//                           的"等价"文件;同源与否以解压后二进制 sha256 为准(gz 字节
//                           因 gzip 不可复现没有比较意义)
//   - 远端存在且二进制不同 → 冲突(同一版本号出现两种内容,例如上游重打了 binary 没
//                           bump 版本)。默认抛错拒绝;仅 force=true 时覆盖,且覆盖后
//                           必须人工刷新内外网 CDN 缓存(告警会打印具体 URL)。
//                           注意:同源场景即使 force 也走复用——覆盖等价字节没有任何
//                           收益,只会重新制造 manifest 与 CDN 边缘缓存的字节分裂。
//
// 2026-07 之前上传的远端老对象没有 sha meta,此时把 gz 下载回来解压计算——只发生
// 在同版本复发布的低频路径,用一次下载换确定性是值得的。

async function headVersionedGz(client, ossKey) {
  try {
    const res = await client.head(ossKey);
    const headers = res?.res?.headers ?? {};
    const meta = res?.meta ?? {};
    return {
      gzSha256: meta['gz-sha256'] ?? headers['x-oss-meta-gz-sha256'] ?? null,
      binarySha256: meta['binary-sha256'] ?? headers['x-oss-meta-binary-sha256'] ?? null,
      gzSize: Number(headers['content-length']) || 0,
    };
  } catch (err) {
    const status = err?.status ?? err?.res?.status;
    if (status === 404 || err?.code === 'NoSuchKey') return null;
    throw err;
  }
}

async function computeRemoteGzInfo(client, ossKey) {
  const tmpGz = path.join(os.tmpdir(), `xdt-immutable-check-${process.pid}-${Date.now()}.gz`);
  const tmpBin = `${tmpGz}.bin`;
  try {
    await client.get(ossKey, tmpGz);
    const gzSha256 = sha256(tmpGz);
    const gzSize = fs.statSync(tmpGz).size;
    await pipeline(fs.createReadStream(tmpGz), createGunzip(), fs.createWriteStream(tmpBin));
    const binarySha256 = sha256(tmpBin);
    return { gzSha256, gzSize, binarySha256 };
  } finally {
    try { fs.unlinkSync(tmpGz); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpBin); } catch { /* ignore */ }
  }
}

/**
 * 上传版本化 .gz 到 OSS,遵守 immutable 守卫(见上方大注释)。
 *
 * @returns {{ uploaded: boolean, gzSha256: string, gzSize: number, binarySha256: string }}
 *   写入 manifest 时必须使用返回值里的 gzSha256/gzSize/binarySha256(reuse 场景下是
 *   远端对象的值,与本地新压的 gz 不同),不要继续用本地计算的值。
 * @throws 远端存在不同内容且未 force 时抛错(调用方按各自流程中止/标记失败)。
 */
export async function uploadVersionedGzImmutable({
  client,
  ossKey,
  gzPath,
  gzSha256,
  gzSize,
  binarySha256,
  force = false,
}) {
  let remote = await headVersionedGz(client, ossKey);

  // meta 缺失/不完整(2026-07 之前的老对象)或 HEAD 未返回 content-length(gzSize=0)
  // → 下载复核,保证 reuse 时写进 manifest 的一定是远端对象的真实哈希与体积,绝不回退
  // 用本地值凑数、也绝不让 size:0 进 manifest(客户端 downloader 按 size 强校验,
  // size 错 = 该资产对全体用户下载必失败,与本次事故同级)。
  if (remote && (!remote.binarySha256 || !remote.gzSha256 || !remote.gzSize)) {
    console.log(`    immutable guard: remote object missing sha meta or size — downloading to verify: ${ossKey}`);
    remote = await computeRemoteGzInfo(client, ossKey);
  }

  if (remote && remote.binarySha256 === binarySha256) {
    console.log(`    immutable guard: ${ossKey} already holds the same binary — reusing remote sha256/size, no upload`);
    return { uploaded: false, gzSha256: remote.gzSha256, gzSize: remote.gzSize, binarySha256: remote.binarySha256 };
  }

  if (remote) {
    const rel = ossKey.startsWith(`${OSS_PREFIX}/`) ? ossKey.slice(OSS_PREFIX.length + 1) : ossKey;
    if (!force) {
      throw new Error(
        `immutable guard: ${ossKey} already exists with DIFFERENT binary content ` +
        `(remote binary sha256 ${remote.binarySha256} != local ${binarySha256}). ` +
        `版本化路径不允许覆盖上传——覆盖会与 CDN 边缘缓存产生字节分裂,导致客户端 sha256 校验失败 ` +
        `(2026-07-03 事故)。确认远端内容确实过期时,用对应 release-*.mjs 加 --force 覆盖,` +
        `覆盖后必须刷新内外网 CDN 该 URL 的缓存。`,
      );
    }
    console.warn(`    !! FORCE overwrite of existing versioned object: ${ossKey}`);
    console.warn('    !! 上传完成后必须手动刷新内外网 CDN 缓存,否则边缘节点会继续下发旧字节:');
    console.warn(`       - ${CDN_BASE}/${rel}`);
    console.warn('       - 以及发布方内网 CDN 域名下的同路径(如有)');
  }

  await uploadToOSS(client, ossKey, gzPath, {
    meta: { 'gz-sha256': gzSha256, 'binary-sha256': binarySha256 },
  });
  return { uploaded: true, gzSha256, gzSize, binarySha256 };
}
