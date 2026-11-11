#!/usr/bin/env node

// =============================================================================
// sign-desktop.mjs — 构建与签名分机的签名侧(macOS)
//
// 打包机(不持有签名密钥)跑 `package-desktop.mjs --stage build`,产出
// <baseName>-<arch>-unsigned.zip 与 signing.mode = pending 的 build-info.json。把整个产物目录
// 拷到签名机后:
//
//   node scripts/sign-desktop.mjs --build-info release/artifacts/<region>/<version>/darwin-<arch>/build-info.json
//
// 本脚本只做:按 build-info 核对未签名包的 SHA-256 与大小 → 解包 → Developer ID 签名 → 公证
// → DMG → 热更 ZIP → 改写同目录的 build-info.json(files 换成签名产物,其余构建事实不变)并删掉
// 未签名包。它不跑 forge、pnpm 或任何 Agent 运行时代码,签名机不需要 node_modules。
// 签名身份与单步打包相同:release-regions.json 的 <region>.macSigning 或 APPLE_* env,
// 密码只从 APPLE_APP_PASSWORD 读。打包机烘焙了 WebAuthn Team ID 时必须与签名身份一致,并要求
// CINDY_MAC_WEBAUTHN_PROVISIONING_PROFILE;没烘焙则签出的包不开 Touch ID。
// =============================================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DESKTOP_ROOT,
  loadDotenv,
  packagedAppName,
  resolveAppleIdentity,
  sha256,
  signAndPackMacApp,
} from './ci/lib.mjs';
import { artifactBaseName, signedBuildInfo } from './ci/package-lib.mjs';
import { applyMacSigningConfigToEnv } from './ci/release-regions.mjs';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  const { values } = parseArgs({ options: { 'build-info': { type: 'string' } } });
  if (!values['build-info']) fail('用法: sign-desktop.mjs --build-info <package-desktop.mjs --stage build 写出的 build-info.json>');
  if (process.platform !== 'darwin') fail('macOS 签名与公证只能在 macOS 上执行');

  const buildInfoPath = path.resolve(values['build-info']);
  const artifactDir = path.dirname(buildInfoPath);
  const pending = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  if (pending.platform !== 'darwin' || !pending.version) fail(`${buildInfoPath} 不是有版本的 macOS build-info`);

  const unsigned = pending.files?.find((f) => f.role === 'unsigned-app');
  if (pending.signing?.mode !== 'pending' || !unsigned) {
    fail(`${buildInfoPath} 不是 --stage build 的待签名产物(signing.mode=${pending.signing?.mode ?? '缺失'})`);
  }
  // 签名前先核对拷来的包就是打包机记下的那一份(传输损坏或被换包都在这里拦下)。
  const payloadPath = path.join(artifactDir, unsigned.name);
  if (!fs.existsSync(payloadPath)) fail(`未签名包不存在: ${payloadPath}`);
  const actual = { sha256: sha256(payloadPath), size: fs.statSync(payloadPath).size };
  if (actual.sha256 !== unsigned.sha256 || actual.size !== unsigned.size) {
    fail(`${unsigned.name} 与 build-info 记录不符(sha256 ${actual.sha256} / ${unsigned.sha256},size ${actual.size} / ${unsigned.size})`);
  }

  let headCommit = '';
  try {
    headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DESKTOP_ROOT, encoding: 'utf8' }).trim();
  } catch { /* 不在 git 工作区 */ }
  if (headCommit && pending.commitSha && headCommit !== pending.commitSha) {
    console.warn(`WARN: 签名机 checkout ${headCommit.slice(0, 12)} 与包的 commit ${pending.commitSha.slice(0, 12)} 不同;entitlements 与 DMG 背景取自签名机的 checkout。`);
  }

  applyMacSigningConfigToEnv(pending.region);
  const applePassword = process.env.APPLE_APP_PASSWORD;
  if (!applePassword) fail('签名机缺 APPLE_APP_PASSWORD(Developer ID 签名 + 公证)');
  const identity = { ...resolveAppleIdentity(), applePassword };
  // 动手前先校验状态与 Team ID,失败时不留半成品。
  signedBuildInfo(pending, { files: [], teamId: identity.teamId });

  const bakedTeamId = pending.signing.webAuthnAppleTeamId;
  const profileValue = process.env.CINDY_MAC_WEBAUTHN_PROVISIONING_PROFILE?.trim();
  let webAuthnProvisioningProfile;
  if (bakedTeamId) {
    if (!profileValue) fail(`包里烘焙了 WebAuthn Team ID ${bakedTeamId},签名机需要 CINDY_MAC_WEBAUTHN_PROVISIONING_PROFILE`);
    webAuthnProvisioningProfile = path.resolve(DESKTOP_ROOT, profileValue);
    if (!fs.existsSync(webAuthnProvisioningProfile) || !fs.statSync(webAuthnProvisioningProfile).isFile()) {
      fail(`CINDY_MAC_WEBAUTHN_PROVISIONING_PROFILE is not a file: ${webAuthnProvisioningProfile}`);
    }
  } else {
    console.warn('WARN: macOS Touch ID WebAuthn is disabled: the build machine did not bake APPLE_TEAM_ID into this package.');
  }

  const appName = packagedAppName(pending.region);
  const baseName = artifactBaseName({ version: pending.version, versionless: false });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-sign-'));
  const packagedDir = path.join(workDir, `${appName}-darwin-${pending.arch}`);
  const outputs = [`${baseName}-${pending.arch}.dmg`, `${baseName}-${pending.arch}-hotfix.zip`]
    .map((name) => path.join(artifactDir, name));
  try {
    console.log(`==> Unpacking ${unsigned.name}...`);
    execFileSync('/usr/bin/ditto', ['-x', '-k', payloadPath, packagedDir], { stdio: 'inherit' });
    const files = signAndPackMacApp({
      packagedDir,
      appName,
      arch: pending.arch,
      artifactDir,
      baseName,
      identity,
      webAuthnProvisioningProfile,
    });
    const signed = signedBuildInfo(pending, { files, teamId: identity.teamId });
    fs.writeFileSync(buildInfoPath, JSON.stringify(signed, null, 2) + '\n');
  } catch (err) {
    // 签名、公证或 DMG 失败:清掉本轮写出的产物,保留未签名包与 pending build-info,可直接重跑。
    for (const file of outputs) fs.rmSync(file, { force: true });
    throw err;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  fs.rmSync(payloadPath);

  console.log('');
  console.log('=== Sign complete ===');
  for (const f of JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')).files) {
    console.log(`  [${f.role}] ${f.name}  ${(f.size / 1024 / 1024).toFixed(1)} MB  sha256=${f.sha256.slice(0, 12)}…`);
  }
  console.log(`Build info: ${buildInfoPath}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
