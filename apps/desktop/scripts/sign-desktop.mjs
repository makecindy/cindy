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
import { randomUUID } from 'node:crypto';
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
import { artifactBaseName, assertSignableBuildInfo, signedBuildInfo } from './ci/package-lib.mjs';
import { applyMacSigningConfigToEnv } from './ci/release-regions.mjs';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

/**
 * 产物目录与解开的 app 都来自打包机。签名机会往里写 build-info、描述文件、签名与 DMG,
 * 一个指向外面的链接就能让这些写入落到签名机的其它文件上(例如 package.json 的 scripts)。
 * 产物目录本身与其中的文件不允许是链接;app 内部的链接(Electron framework 的 Versions/Current 等)
 * 只允许指向 app 内部。
 */
function assertNoLinksOut(dir, { allowInternal }) {
  const root = fs.realpathSync(dir);
  for (const rel of fs.readdirSync(root, { recursive: true })) {
    const full = path.join(root, rel);
    if (!fs.lstatSync(full).isSymbolicLink()) continue;
    // 按文件系统实际语义解析整条链接链(path.resolve 只折叠字面上的 ..,不跟随途中的链接);
    // 悬空或无法解析的链接一律拒绝。抛错而不是 process.exit:解包后调用时要让 finally 清掉临时目录。
    let target;
    try {
      target = fs.realpathSync(full);
    } catch {
      throw new Error(`${full} 是无法解析的链接(${fs.readlinkSync(full)}),拒绝签名`);
    }
    if (!allowInternal || !target.startsWith(root + path.sep)) throw new Error(`${full} 是指向 ${target} 的链接,拒绝签名`);
  }
}

function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  const { values } = parseArgs({ options: { 'build-info': { type: 'string' } } });
  if (!values['build-info']) fail('用法: sign-desktop.mjs --build-info <package-desktop.mjs --stage build 写出的 build-info.json>');
  if (process.platform !== 'darwin') fail('macOS 签名与公证只能在 macOS 上执行');

  const buildInfoPath = path.resolve(values['build-info']);
  const artifactDir = path.dirname(buildInfoPath);
  if (fs.lstatSync(artifactDir).isSymbolicLink()) fail(`${artifactDir} 是链接,请拷贝真实目录`);
  assertNoLinksOut(artifactDir, { allowInternal: false });
  const pending = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  // build-info 来自运行上游代码的打包机:路径与命令只用校验过格式的字段。
  let region, arch, version, unsignedName;
  try {
    ({ region, arch, version, unsignedName } = assertSignableBuildInfo(pending));
  } catch (err) {
    fail(`${buildInfoPath} 不是可签名的 --stage build 产物: ${err.message}`);
  }
  const unsigned = pending.files.find((f) => f.role === 'unsigned-app');
  // 核对拷来的包就是打包机记下的那一份。这只能发现传输损坏或拷错文件:哈希与包都来自打包机,
  // 被攻陷的打包机可以连同哈希一起改,签名机照签不误。包内容的可信度取决于打包机本身,
  // 所以发版打包仍用缺省的 --vendors pinned(打包机不执行上游代码)。
  const payloadPath = path.join(artifactDir, unsignedName);
  if (!fs.existsSync(payloadPath)) fail(`未签名包不存在: ${payloadPath}`);
  const actual = { sha256: sha256(payloadPath), size: fs.statSync(payloadPath).size };
  if (actual.sha256 !== unsigned.sha256 || actual.size !== unsigned.size) {
    fail(`${unsignedName} 与 build-info 记录不符(sha256 ${actual.sha256} / ${unsigned.sha256},size ${actual.size} / ${unsigned.size})`);
  }

  let headCommit = '';
  try {
    headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DESKTOP_ROOT, encoding: 'utf8' }).trim();
  } catch { /* 不在 git 工作区 */ }
  if (headCommit && pending.commitSha && headCommit !== pending.commitSha) {
    console.warn(`WARN: 签名机 checkout ${headCommit.slice(0, 12)} 与包的 commit ${pending.commitSha.slice(0, 12)} 不同;entitlements 与 DMG 背景取自签名机的 checkout。`);
  }

  applyMacSigningConfigToEnv(region);
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

  const appName = packagedAppName(region);
  const baseName = artifactBaseName({ version, versionless: false });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-sign-'));
  const packagedDir = path.join(workDir, `${appName}-darwin-${arch}`);
  // 产物目录名来自打包机(--build-info 的父目录),不能进 signAndPackMacApp 里拼 shell 的命令:
  // DMG 与热更 ZIP 先写到签名机自己建的暂存目录,再用 fs 拷进产物目录。
  const stageDir = path.join(workDir, 'out');
  const outputs = [`${baseName}-${arch}.dmg`, `${baseName}-${arch}-hotfix.zip`]
    .map((name) => path.join(artifactDir, name));
  try {
    console.log(`==> Unpacking ${unsignedName}...`);
    // ZIP 条目不能带绝对路径或 ..,否则解包就写到临时目录外面。
    const entries = execFileSync('/usr/bin/zipinfo', ['-1', payloadPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\n').filter(Boolean);
    const escaping = entries.find((e) => e.startsWith('/') || e.split('/').includes('..'));
    if (escaping) throw new Error(`${unsignedName} 含越界条目 ${escaping}`);
    execFileSync('/usr/bin/ditto', ['-x', '-k', payloadPath, packagedDir], { stdio: 'inherit' });
    assertNoLinksOut(packagedDir, { allowInternal: true });
    fs.mkdirSync(stageDir);
    const files = signAndPackMacApp({
      packagedDir,
      appName,
      arch,
      artifactDir: stageDir,
      baseName,
      identity,
      webAuthnProvisioningProfile,
    });
    for (const { name } of files) {
      const dest = path.join(artifactDir, name);
      fs.rmSync(dest, { force: true });
      fs.copyFileSync(path.join(stageDir, name), dest, fs.constants.COPYFILE_EXCL);
    }
    const signed = signedBuildInfo(pending, { files, teamId: identity.teamId });
    // 先写同目录临时文件再 rename:写一半失败时原 pending build-info 完好,可以直接重跑。
    // 随机文件名 + 独占创建(wx 不跟随已存在的链接);rename 替换的是目录项本身。
    const tmpPath = path.join(artifactDir, `.build-info.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(signed, null, 2) + '\n', { flag: 'wx' });
      fs.renameSync(tmpPath, buildInfoPath);
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
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
