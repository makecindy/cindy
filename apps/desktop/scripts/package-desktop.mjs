#!/usr/bin/env node

// =============================================================================
// package-desktop.mjs — 桌面端统一打包入口(只打包,不发布)
//
// 打包/发布拆分(2026-07):本脚本产出可分发的本地产物 + build-info.json,
// 全程不写 OSS/CDN;发布(上传、update manifest、canary/stable)由后续的
// publish 侧脚本读 build-info.json 接手。
//
// 用法:
//   node scripts/package-desktop.mjs [options]
//
//   --platform win32|darwin|linux   默认当前平台(不支持交叉打包)
//   --arch     x64|arm64            显式传 = 只打该单架构;缺省时 darwin
//                                   双架构连打(arm64 + x64,同一版本号,
//                                   与发布侧 canary/promote 的 mac 双架构
//                                   默认行为对齐),win/linux 取当前 arch
//   --region   cn|global|dev        默认 cn;决定应用身份、端点清单与发布目标
//   --version  x.y.z|major|minor|patch
//              缺省 = 版本无关打包:占位版本 0.0.0,包不参与热更新
//              (updateService 对 0.0.0 短路),开源社区拉仓即可打;
//              bump 关键字会只读拉一次 CDN manifest 取基线——这是打包阶段
//              仅存的 CDN 依赖,显式 x.y.z 则不再碰 CDN manifest。
//              (agent 侧车二进制走缓存优先的 ensureBinary:已就位且版本
//              匹配 pin 时跳过下载;首次打包仍需网络拉一次,之后可离线。)
//   --skip-smoke                    跳过 packaged smoke test(调试用)
//   --allow-unsigned                有版本打包放行无签名(win 缺 CINDY_WIN_SIGN_CMD /
//                                   mac 缺 APPLE_APP_PASSWORD 时降级 ad-hoc)
//   --no-sign                       主动跳过签名(即使签名配置在手;隐含 --allow-unsigned)。
//                                   外部签名命令依赖发布方自己的环境,不具备
//                                   该环境的机器打版本无关包时用它
//
// 产物: release/artifacts/<region>/<version|unversioned>/<platform-arch>/
//   cindy-<version|unversioned>-Setup.exe / -<arch>.dmg / .deb   安装包
//   cindy-<version>-hotfix.zip                           热更包(仅有版本时)
//   build-info.json                                      发布侧唯一输入
// =============================================================================

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import { desktopClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import {
  DESKTOP_ROOT,
  RELEASE_DIR,
  PACKAGED_APP_NAME,
  packagedAppName,
  loadDotenv,
  exec,
  sha256,
  writePackageVersion,
  runDbValidate,
  verifyPackagedDrizzle,
  runSmokeTest,
  fetchExistingManifestIfAvailable,
  findInstallerArtifact,
  ensureLinuxRuntimeAssets,
  logLinuxPackagingRequirements,
  writeMacEntitlements,
  adhocSignMacApp,
  resolveAppleIdentity,
  signMacAppWithIdentity,
  notarizeMacApp,
  createMacDMG,
} from './ci/lib.mjs';
import {
  parsePackageArgs,
  resolvePackageVersion,
  artifactRelDir,
  artifactBaseName,
  buildBuildInfo,
} from './ci/package-lib.mjs';
import { applyMacSigningConfigToEnv, applyReleaseCdnBaseUrlToEnv } from './ci/release-regions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 构建元数据收集(commit / drizzle journal / electron 版本)────────────────

function collectBuildMeta() {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8'),
  );
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
    commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: DESKTOP_ROOT }).trim();
  } catch { /* not in a git work tree */ }

  let electronVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'));
    electronVersion = pkg.devDependencies?.electron ?? '';
  } catch { /* ignore */ }

  return { schemaVersionMax, migrationFiles, commitSha, electronVersion };
}

// ── CDN 基线(仅 --version major/minor/patch 时调用,只读)─────────────────────

async function fetchCdnBaselineVersion(platformKey, region) {
  // 打包不发布,env 里通常没有 CDN 配置——按 region 从 release-regions.json
  // 只注入 cdnBaseUrl(env 显式值优先),满足这次只读拉取即可。
  applyReleaseCdnBaseUrlToEnv(region);
  // mac 双架构 manifest 同版本,任一即可;win/linux 用各自 key。
  const manifest = await fetchExistingManifestIfAvailable(platformKey, region);
  if (!manifest) {
    throw new Error(`CDN 上没有 ${platformKey} 的 manifest,无法计算 bump 基线;请显式传 --version x.y.z`);
  }
  return manifest.app?.version ?? '';
}

// ── 通用步骤 ────────────────────────────────────────────────────────────────

function cleanOutDir() {
  const outDir = path.join(DESKTOP_ROOT, 'out');
  if (!fs.existsSync(outDir)) return;
  console.log('==> Cleaning previous build output...');
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`ERROR: Cannot remove ${outDir} — is ${PACKAGED_APP_NAME} still running or antivirus scanning it?`);
    console.error(err.message);
    process.exit(1);
  }
}

function runForgeMake({ platform, arch, region, version, noSign }) {
  console.log('==> Building remote bundles...');
  execSync('node scripts/build-remote-bundles.mjs', { cwd: DESKTOP_ROOT, stdio: 'inherit' });

  console.log(`==> Running electron-forge make (${platform}-${arch}, region=${region})...`);
  const forgeEnv = {
    ...process.env,
    NODE_ENV: 'production',
    // 烘焙面只含 region + 端点清单自举基址,按 region 二选一。
    ...desktopClientBuildEnv({ allowEnvOverride: false, authRegion: region }),
    // forge.config.ts 的 NSIS appId / AUMID 优先读这个(与 VITE_ 同源,双保险)。
    CINDY_AUTH_REGION: region,
    // forge.config.ts 注入 packagerConfig.appVersion;版本无关时为占位 0.0.0。
    APP_VERSION: version,
  };
  // Git Bash(agent 常用 shell)会导出 NoDefaultCurrentDirectoryInExePath=1,
  // 使 cmd.exe 不再搜索当前目录——node-pty rebuild 时 winpty.gyp 的
  // `cmd /c "cd shared && GetCommitHash.bat"` 会直接 not recognized 挂掉。
  // 人类在 cmd/PowerShell 跑没有这个变量;这里对构建子进程摘掉它,
  // 把 agent shell 归一到人类 shell 的行为(仅作用于 forge make 子进程)。
  for (const key of Object.keys(forgeEnv)) {
    if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete forgeEnv[key];
  }
  // --no-sign:摘掉 CINDY_WIN_SIGN_CMD,让 forge postPackage 的内部 exe 签名一并
  // 跳过(forge.config.ts 只认这个 env;不摘的话外部签名命令失败会挂整个 make)。
  if (noSign) delete forgeEnv.CINDY_WIN_SIGN_CMD;
  execSync(`npx electron-forge make --platform ${platform} --arch ${arch}`, {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    env: forgeEnv,
  });
}

/** PowerShell 单引号字面量转义:内嵌 ' 双写,防路径含单引号时命令截断。 */
function psq(value) {
  return String(value).replaceAll("'", "''");
}

/** 物理 ARM64 mac 检测(即使当前进程跑在 Rosetta 下也返回 true;Intel 无该 oid)。 */
function isPhysicalArm64Mac() {
  try {
    return execSync('sysctl -in hw.optional.arm64', { encoding: 'utf8' }).trim() === '1';
  } catch {
    return false;
  }
}

/** 跳过 smoke 启动前,用 lipo 确认 packaged 主二进制确实是目标架构。 */
function verifyMacBinaryArch(appName, arch) {
  const exePath = path.join(
    DESKTOP_ROOT, 'out', `${appName}-darwin-${arch}`, `${appName}.app`, 'Contents', 'MacOS', appName,
  );
  const archInfo = execFileSync('lipo', ['-archs', exePath], { encoding: 'utf8' }).trim();
  const want = arch === 'arm64' ? 'arm64' : 'x86_64';
  if (!archInfo.includes(want)) {
    console.error(`ERROR: expected ${want} binary but lipo reports "${archInfo}" (${exePath})`);
    process.exit(1);
  }
}

function fileEntry(role, filePath) {
  return {
    role,
    name: path.basename(filePath),
    sha256: sha256(filePath),
    size: fs.statSync(filePath).size,
  };
}

// ── 平台收尾:签名 + 产物归集,返回 files/signing 供 build-info ────────────────

function findSetupExe(makeBaseDir) {
  // 只认文件名含 setup 的 .exe(NSIS 产物目录里可能还有其它 exe)。
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.endsWith('.exe') && entry.name.toLowerCase().includes('setup')) {
        return full;
      }
    }
    return null;
  }
  return walk(makeBaseDir);
}

async function finishWindows({ artifactDir, baseName, appName, versionless, allowUnsigned, noSign }) {
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${appName}-win32-x64`);
  const setupExe = findSetupExe(makeBaseDir);
  if (!setupExe) {
    console.error(`ERROR: No Setup.exe found under ${makeBaseDir}`);
    process.exit(1);
  }

  // 签名已全部在 forge make 阶段完成,这里不再后置补签:
  //   - 包内 exe(Cindy/cindy-updater/loudness/node-pty/adb/rg)由
  //     forge.config.ts 的 postPackage signPackagedExes 签;
  //   - 安装器 Setup.exe + 卸载器 Uninstall <App>.exe 由 NSIS maker 的
  //     win.sign(customSign)签(Issue #998)。
  // 两处都经 forge.config.ts 的 CINDY_WIN_SIGN_CMD 可插拔外部签名命令(发布方
  // 在构建环境注入,仓库不绑定任何签名实现)。
  // 门禁在拷贝进 release/artifacts 之前跑:失败时产物目录不留「看起来能用」
  // 的未签名 Setup.exe。校验对象是 make 产出的源文件。
  const winSignCmd = noSign ? undefined : process.env.CINDY_WIN_SIGN_CMD;
  let installerSigned = false;
  if (noSign) {
    console.log('==> --no-sign: installer / uninstaller / internal exes are UNSIGNED');
  } else if (winSignCmd) {
    // make 阶段用同一签名命令已签全部 exe + installer + uninstaller;签名命令
    // 失败会让 make 直接挂掉(forge fail closed)。这里再验一道「产物确实带
    // Authenticode 签名块」,防外部命令被误配成 no-op(退出 0 但没签)时
    // build-info 记下假阳性签名状态。只验签名存在,不验证书链——构建机不一定
    // 信任发布证书,按 Valid 判定会误伤。
    // 坏状态清单:NotSigned(没签)与 HashMismatch(签名后文件被改/签名损坏)
    // 一票否决;UnknownError / NotTrusted 属「构建机不信任证书链」的正常状态,
    // 放行——这正是不按 Valid 判定的原因。
    const badSigStatuses = ['NotSigned', 'HashMismatch'];
    // execFileSync 数组传参:不经 cmd.exe,路径里的 % ^ & 等元字符不会被外层
    // shell 展开;psq 只需管 PowerShell 单引号字面量这一层。
    const sigStatus = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-AuthenticodeSignature '${psq(setupExe)}').Status`],
      { encoding: 'utf8' },
    ).trim();
    if (badSigStatuses.includes(sigStatus)) {
      console.error(`ERROR: CINDY_WIN_SIGN_CMD 已设置且 make 成功,但 Setup.exe 签名状态为 ${sigStatus}。`);
      console.error('       外部签名命令疑似 no-op 或签名后文件被改动,请检查 CINDY_WIN_SIGN_CMD 配置与构建流程。');
      process.exit(1);
    }
    // 再全量扫一遍 packaged 目录:internalExesSigned 不能只凭签名命令在手就记
    // true——forge 的固定清单/递归范围若漏了某个包内 exe(热更 ZIP 正是从这个
    // 目录打的),这里兜底抓出来 fail closed,漏签 exe 在严格策略机器上会被拦。
    const badExes = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-ChildItem -Path '${psq(packagedDir)}' -Recurse -Filter *.exe | Get-AuthenticodeSignature | Where-Object { $_.Status -eq 'NotSigned' -or $_.Status -eq 'HashMismatch' } | ForEach-Object { $_.Status.ToString() + ' ' + $_.Path }`,
      ],
      { encoding: 'utf8' },
    ).trim();
    if (badExes) {
      console.error('ERROR: packaged 目录内以下 exe 签名不可用(未签 / 签名后被改动;forge 签名清单可能有遗漏):');
      console.error(badExes);
      process.exit(1);
    }
    installerSigned = true;
  } else if (!versionless && !allowUnsigned) {
    console.error('ERROR: 有版本的 Windows 打包要求 CINDY_WIN_SIGN_CMD(安装包 / 卸载器 / 内部 exe 均在 forge make 阶段签名)。');
    console.error('       缺签名的包在严格策略 Windows 机器上热更/启动/卸载会被拦。');
    console.error('       确要产出未签名包时加 --allow-unsigned。');
    process.exit(1);
  } else {
    console.log('==> CINDY_WIN_SIGN_CMD not set — installer / uninstaller / internal exes are UNSIGNED');
  }

  const installerPath = path.join(artifactDir, `${baseName}-Setup.exe`);
  fs.copyFileSync(setupExe, installerPath);

  const files = [fileEntry('installer', installerPath)];

  // 热更 ZIP 只对有版本的包有意义(版本无关包不参与热更新)。
  if (!versionless) {
    const hotfixZipPath = path.join(artifactDir, `${baseName}-hotfix.zip`);
    console.log('==> Creating hotfix ZIP from packaged app...');
    if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${psq(packagedDir)}\\*' -DestinationPath '${psq(hotfixZipPath)}'`,
      ],
      { stdio: 'inherit' },
    );
    files.push(fileEntry('hotfix', hotfixZipPath));
  }

  return { files, signing: { installerSigned, internalExesSigned: Boolean(winSignCmd) } };
}

async function finishDarwin({ artifactDir, baseName, appName, arch, versionless, allowUnsigned, noSign }) {
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${appName}-darwin-${arch}`);
  const appPath = path.join(packagedDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    console.error(`ERROR: ${appPath} not found`);
    process.exit(1);
  }

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const helperEntitlementsPath = path.join(RELEASE_DIR, 'build-helper.entitlements');
  const mainEntitlementsPath = path.join(RELEASE_DIR, 'build-main.entitlements');
  writeMacEntitlements(helperEntitlementsPath);
  writeMacEntitlements(mainEntitlementsPath, { appleEvents: true });

  const applePassword = noSign ? undefined : process.env.APPLE_APP_PASSWORD;
  const wantsRealSigning = !versionless && !noSign;
  let signingMode = 'adhoc';

  if (wantsRealSigning && !applePassword && !allowUnsigned) {
    console.error('ERROR: 有版本的 macOS 打包要求 APPLE_APP_PASSWORD(Developer ID 签名 + 公证)。');
    console.error('       确要降级 ad-hoc 签名时加 --allow-unsigned(产物无法过 Gatekeeper 分发)。');
    process.exit(1);
  }

  const files = [];
  if (wantsRealSigning && applePassword) {
    const identity = { ...resolveAppleIdentity(), applePassword };
    console.log('==> Signing (Developer ID)...');
    signMacAppWithIdentity(appPath, helperEntitlementsPath, mainEntitlementsPath, identity);
    console.log('==> Notarizing...');
    notarizeMacApp(appPath, identity);
    signingMode = 'developer-id+notarized';

    const dmgPath = path.join(artifactDir, `${baseName}-${arch}.dmg`);
    console.log('==> Creating DMG...');
    // DMG 卷名 = 安装窗口标题,走 '<appName> Installer'(cn/global
    // 'Cindy Installer' / dev 'CindyDev Installer');版本号不进卷名,
    // 安装包文件名里已有。
    createMacDMG(appPath, dmgPath, `${appName} Installer`, identity);
    files.push(fileEntry('installer', dmgPath));

    const hotfixZipPath = path.join(artifactDir, `${baseName}-${arch}-hotfix.zip`);
    console.log('==> Creating hotfix ZIP...');
    if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
    exec(`/usr/bin/ditto -c -k "${packagedDir}" "${hotfixZipPath}"`);
    files.push(fileEntry('hotfix', hotfixZipPath));
  } else {
    // 版本无关(或显式放行)→ ad-hoc 签名,产出 .app 的 zip 供本机/内部试用。
    adhocSignMacApp(appPath, helperEntitlementsPath, mainEntitlementsPath);
    const appZipPath = path.join(artifactDir, `${baseName}-${arch}.zip`);
    console.log('==> Creating app ZIP (ad-hoc signed)...');
    if (fs.existsSync(appZipPath)) fs.unlinkSync(appZipPath);
    exec(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${appZipPath}"`);
    files.push(fileEntry('installer', appZipPath));
  }

  return { files, signing: { mode: signingMode } };
}

async function finishLinux({ artifactDir, baseName }) {
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  const debPath = findInstallerArtifact(makeBaseDir, 'deb');
  if (!debPath) {
    console.error(`ERROR: No .deb found under ${makeBaseDir}`);
    process.exit(1);
  }
  const installerPath = path.join(artifactDir, `${baseName}-amd64.deb`);
  fs.copyFileSync(debPath, installerPath);
  // Linux 首发无热更链路(见 ci/lib.mjs createLinuxFirstReleaseManifest),只出安装包。
  return { files: [fileEntry('installer', installerPath)], signing: { mode: 'none' } };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // 打包本身不发布；只读通用构建 env，不要求 OSS 发布四件套。
  loadDotenv(undefined, { refreshReleaseConfig: false });
  let args;
  try {
    args = parsePackageArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  const { platform, archs, region, versionSpec, skipSmoke, allowUnsigned, noSign } = args;
  // ensureBinary 的 CDN fallback 按此 region 选择清单基址；必须早于二进制准备。
  process.env.CINDY_AUTH_REGION = region;
  // mac 签名身份按区域从 release-regions.json 注入(文件缺失时静默跳过,
  // 届时签名要求身份齐备,由 resolveAppleIdentity fail closed)。只在 darwin
  // 且未显式跳签时加载:appPasswordEnv 声明即承诺(指向空 env 会抛错),
  // 不该拦住 win/linux 或 --no-sign 的打包。
  if (platform === 'darwin' && !noSign) applyMacSigningConfigToEnv(region);

  if (platform !== process.platform) {
    console.error(`ERROR: 不支持交叉打包(当前 ${process.platform},目标 ${platform});请在目标平台机器上执行。`);
    process.exit(1);
  }

  // 版本号只解析一次,mac 双架构共用(canary 发布要求两 arch 同版本)。
  const { version, versionless } = await resolvePackageVersion(versionSpec, () =>
    fetchCdnBaselineVersion(platform === 'darwin' ? 'darwin-arm64' : `${platform}-${archs[0]}`, region),
  );

  console.log('='.repeat(60));
  console.log(`==> Package Cindy desktop`);
  console.log(`    platform: ${archs.map((a) => `${platform}-${a}`).join(' + ')}`);
  console.log(`    region:   ${region}`);
  console.log(`    version:  ${versionless ? `(版本无关,占位 ${version},不参与热更新)` : version}`);
  console.log('='.repeat(60));

  // Linux 只校验 sqlite-vec 等原生运行资产。Claude/Codex 各平台都不进安装包
  // (forge extraResource 不含它们),由 packaged runtime 首启时复用系统 CLI 或
  // 安装到 userData/agent-runtime,打包阶段无需预下载。ripgrep 是唯一进包的
  // agent 二进制,这里按 pin 预 ensure(缓存命中即跳过),在昂贵的 forge make
  // 之前尽早失败;forge prePackage 的 stageRipgrep 仍会兜底校验。
  if (platform === 'linux') {
    await ensureLinuxRuntimeAssets();
    logLinuxPackagingRequirements();
  } else {
    for (const platformKey of archs.map((a) => `${platform}-${a}`)) {
      await ensureBinary('ripgrep', platformKey);
    }
  }

  runDbValidate();

  // 版本号临时写入 package.json(asar 内 app.getVersion() 的来源),退出自动恢复。
  writePackageVersion(version);

  // 产物基名按区域派生(cn/global 'Cindy' / dev 'CindyDev',out 目录 / exe /
  // .app 同名;forge.config 的 packagerConfig.name 同源)。
  const appName = packagedAppName(region);
  const baseName = artifactBaseName({ version, versionless });
  const finishers = { win32: finishWindows, darwin: finishDarwin, linux: finishLinux };
  const meta = collectBuildMeta();
  const results = [];

  // 逐 arch 完整走「make → 校验 → smoke → 归集 → build-info」;mac 缺省会连打
  // arm64 + x64(cleanOutDir 每轮清 out/,上一轮产物已归集进 release/artifacts)。
  for (const arch of archs) {
    const platformKey = `${platform}-${arch}`;

    // 本轮目标产物目录构建前先清:构建失败时不能给同一路径留上一轮的旧
    // build-info.json / 安装包(看起来像可发布结果,易被人工分发或发布侧误取)。
    const artifactDir = path.join(
      RELEASE_DIR,
      ...artifactRelDir({ region, version, versionless, platformKey }).split('/'),
    );
    fs.rmSync(artifactDir, { recursive: true, force: true });

    cleanOutDir();
    runForgeMake({ platform, arch, region, version, noSign });

    // drizzle 资源校验(平台差异只在 packaged 内路径)。
    const drizzleOut =
      platform === 'darwin'
        ? path.join(DESKTOP_ROOT, 'out', `${appName}-darwin-${arch}`, `${appName}.app`, 'Contents', 'Resources', 'drizzle')
        : path.join(DESKTOP_ROOT, 'out', `${appName}-${platformKey}`, 'resources', 'drizzle');
    verifyPackagedDrizzle(drizzleOut);

    if (skipSmoke) {
      console.log('==> Skipping packaged smoke test (--skip-smoke)');
    } else if (platform === 'darwin' && arch === 'arm64' && !isPhysicalArm64Mac()) {
      // Intel mac 缺省双架构连打时,arm64 产物在 x64 硬件上起不来(smoke 脚本只
      // 处理了「arm64 宿主打 x64 包」的镜像场景)。lipo 验完二进制架构即跳过启动。
      verifyMacBinaryArch(appName, arch);
      console.log('==> Skipping smoke: arm64 artifact not runnable on Intel host (binary arch verified)');
    } else {
      runSmokeTest(platform, arch, region);
    }

    // 产物目录(本轮开始前已清空)
    fs.mkdirSync(artifactDir, { recursive: true });

    // 归集途中(如 DMG/hotfix ZIP 制作)失败时清掉本轮产物目录:安装器已拷入
    // 而 build-info.json 未写的半成品目录看起来像可发布结果,不能留。
    let files, signing, buildInfoPath;
    try {
      ({ files, signing } = await finishers[platform]({
        artifactDir,
        baseName,
        appName,
        arch,
        version,
        versionless,
        allowUnsigned,
        noSign,
      }));

      const buildInfo = buildBuildInfo({
        version,
        versionless,
        region,
        platform,
        arch,
        commitSha: meta.commitSha,
        electronVersion: meta.electronVersion,
        schemaVersionMax: meta.schemaVersionMax,
        migrationFiles: meta.migrationFiles,
        files,
        signing,
      });
      buildInfoPath = path.join(artifactDir, 'build-info.json');
      fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n');
    } catch (err) {
      fs.rmSync(artifactDir, { recursive: true, force: true });
      throw err;
    }

    results.push({ platformKey, artifactDir, files, buildInfoPath });
  }

  console.log('');
  console.log('=== Package complete ===');
  for (const r of results) {
    console.log(`Artifacts:  ${r.artifactDir}`);
    for (const f of r.files) {
      console.log(`  [${f.role}] ${f.name}  ${(f.size / 1024 / 1024).toFixed(1)} MB  sha256=${f.sha256.slice(0, 12)}…`);
    }
    console.log(`Build info: ${r.buildInfoPath}`);
  }
  if (versionless) {
    console.log('注意: 版本无关包(0.0.0)不参与热更新,仅供本地/社区使用,不能作为发布产物。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
