import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerDeb } from '@electron-forge/maker-deb';
import { rebuild as electronRebuild } from '@electron/rebuild';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeArch, ForgeConfig, ForgePlatform } from '@electron-forge/shared-types';
import {
  BRAND_IDENTITY,
  allDeepLinkSchemes,
  brandAppId,
  brandBundleIdPrefix,
  brandExecutableName,
  resolveCindyRegion,
} from '@cindy/maker-shared/brand-identity';
import { stagePackagedThirdPartyNotices } from './forge-third-party-notices';

const _require = createRequire(__filename);

// ── 构建期身份(2026-07-17 Cindy 渠道分叉) ─────────────────────────────────────
// 区域默认 global;中国大陆包由发布脚本显式注入 CINDY_AUTH_REGION=cn。appId 随区域
// 派生(com.xd.cindycn / com.xd.cindy),必须与运行时 shared/brandRegion
// (经 vite.main.config 的 VITE_CINDY_AUTH_REGION define 烘焙)同源——AUMID
// 三位一体:NSIS appId = 运行时 setAppUserModelId = 快捷方式 AUMID。
const CINDY_REGION = resolveCindyRegion(
  process.env.CINDY_AUTH_REGION?.trim() || process.env.VITE_CINDY_AUTH_REGION,
);
// 把归一化后的区域回写给 vite 构建(plugin-vite 与 forge 同进程,loadEnv 读
// process.env):防止「只设 CINDY_AUTH_REGION 直跑 forge」时 NSIS appId 用
// global 而 main 烘焙的 CURRENT_APP_ID 落回 cn——AUMID 漂移 = toast 静默丢失。
process.env.VITE_CINDY_AUTH_REGION = CINDY_REGION;
const CINDY_APP_ID = brandAppId(CINDY_REGION);
const CINDY_UTI_PREFIX = brandBundleIdPrefix(CINDY_REGION);
/**
 * 可执行文件基名,按区域派生(cn/global 同值 'Cindy',dev 'CindyDev';
 * 2026-07-26 显示名统一决策,cn/global 文件层双装隔离随之放弃,见
 * brandIdentity.ts executableNameByRegion doc)。运行时 userData 目录由 main
 * 入口按同一区域切换(src/main/regionUserData.ts),两端从 brand-identity
 * 同源派生,cn/global 数据仍分库。
 */
const CINDY_EXE = brandExecutableName(CINDY_REGION);
/** 更新器二进制文件名(cindy-updater.exe)。 */
const UPDATER_EXE = `${BRAND_IDENTITY.updaterName}.exe`;

// discord.js is externalized from the main Vite bundle because its circular
// CommonJS graph crashes when Rollup reorders it. Its dependency tree contains
// version conflicts, so it is copied with parent-relative node_modules layout
// instead of being flattened into the generic runtime dep list below.
const DISCORD_RUNTIME_DEPS = [
  'discord.js',
];

// Workspace 用 pnpm `node-linker=hoisted`，所有依赖都只在根 node_modules/ 下，
// apps/desktop/node_modules/ 里连 symlink 都没建。electron-packager 只扫
// apps/desktop/node_modules/，会漏掉 better-sqlite3 这类原生模块。
// 这里把 better-sqlite3 及其运行时依赖物理拷贝进 packaged app 的 node_modules/,
// 之后针对 packaged buildPath 显式触发 @electron/rebuild —— forge 默认的 rebuild
// 是针对 apps/desktop/node_modules 扫描的，那里是空的，所以我们必须自己来一遍。
// rebuild 完成后 AutoUnpackNativesPlugin 才能在 asar 阶段识别 .node 并 unpack 到
// app.asar.unpacked/ 下。
// `@larksuiteoapi/node-sdk` itself is bundled inline by Vite, but its compiled
// lib does `require("protobufjs/minimal")` which rollup-commonjs can't inline,
// so it survives into the runtime bundle and must be resolvable from the
// packaged app's node_modules. Ship the full protobufjs runtime closure
// (9 `@protobufjs/*` helpers + `long`). protobufjs >=7.6 dropped
// `@protobufjs/inquire` (the eval-based dynamic require was removed in its
// 2026 security fixes) — don't re-add it, resolvePackageDir would throw.
const NATIVE_RUNTIME_DEPS = [
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
  'protobufjs',
  '@protobufjs/aspromise',
  '@protobufjs/base64',
  '@protobufjs/codegen',
  '@protobufjs/eventemitter',
  '@protobufjs/fetch',
  '@protobufjs/float',
  '@protobufjs/path',
  '@protobufjs/pool',
  '@protobufjs/utf8',
  'long',
  // @parcel/watcher: file-browser 用的 OS 原生 watcher。N-API 模块, 无需
  // electron-rebuild, 但平台特定子包 (@parcel/watcher-{platform}-{arch})
  // 必须跟主包一起进包, 否则运行时 require('@parcel/watcher') 找不到 .node。
  // 子包按当前打包平台决定, 在 bundleNativeDeps 里动态拼。
  // wrapper.js 还运行时 require: picomatch / is-glob / detect-libc。
  '@parcel/watcher',
  'detect-libc',
  'picomatch',
  'is-glob',
  'is-extglob', // is-glob 的运行时依赖
  // sharp (maker-core image-resizer 用): 主包 + libvips wrapper + 当前平台
  // 子包(在 bundleNativeDeps 里动态拼)。sharp 走 prebuilt 二进制路线,
  // 不需要 electron-rebuild — 它通过 N-API 兼容多 ABI, 直接 require 就能用。
  // sharp 0.34+ 的 runtime 闭包: @img/colour (替代老的 color 链) + semver
  // (上面 protobufjs 那块没用到, 这里 sharp/lib/libvips.js 显式 require) +
  // detect-libc (已经在 @parcel/watcher 那块声明过,这里不重复)。
  'sharp',
  '@img/colour',
  'semver',
  // ssh2 (remote-ssh): 主体纯 JS, vite externalizes 整包 + 可选 native dep
  // cpu-features (cpu-features 的 postinstall 默认被 pnpm 忽略, 缺 .node 时
  // ssh2 走纯 JS fallback)。packaged app 需要带 ssh2 主体 + 私钥/认证用的
  // 运行时闭包 (asn1 解 RSA, bcrypt-pbkdf 解加密私钥, 各自的 dep)。
  // cpu-features 故意不带 — 缺它 ssh2 自动 fallback, 带了反而要在每个目标
  // 平台/arch 上单独 build .node, 不值。
  'ssh2',
  'asn1',
  'safer-buffer',
  'bcrypt-pbkdf',
  'tweetnacl',
  // ssh-config (remote-ssh): 解析 ~/.ssh/config。纯 JS 但 vite 不 bundle,
  // 必须随包带运行时 require。
  'ssh-config',
  // ws (codex remote transport, P2): SshDaemonTransport 用 ws/lib/receiver
  // + ws/lib/sender 给 SSH-bridged codex daemon 通道做 WebSocket frame 编解码。
  // 跟 ssh2 / ssh-config 同模式: 纯 JS 主体 vite externalize 后必须随 packaged
  // app 带。bufferutil / utf-8-validate 是可选 native 加速依赖, 缺失自动 fallback
  // 纯 JS, 故不强带。
  'ws',
  // playwright-core (@cindy/browser-control-runtime 的运行时依赖): vendored 浏览器
  // runtime 通过 `require('playwright-core')` 加载它来驱动 act / snapshot / 截图 /
  // 交互等 Playwright 路径。vite externalize 后, packaged app 的 node_modules 只含
  // 本表的包 —— 不带它则打包版任何 Playwright 路径 `Cannot find module 'playwright-core'`
  // (dev 靠 workspace hoist 不暴露)。同 ssh2 纯 JS 模式; 其 dependencies 为空,
  // 无需带运行时闭包。注意: 该 runtime 用 CDP 接管用户已装 Chrome, 不需要
  // playwright 自带的浏览器二进制, 故只带 JS 模块即可。
  'playwright-core',
  // node-pty (RSB 终端 tab 的 PTY 后端): .node 原生模块, 跟 better-sqlite3 同款 ——
  // 必须 electron-rebuild (Node ABI ≠ Electron ABI), 必须随 packaged app 带,
  // AutoUnpackNativesPlugin 会把 .node 提取到 app.asar.unpacked/。main 进程通过
  // createRequire 在运行时 require, 不让 vite bundle (见 vite.main.config.ts external)。
  'node-pty',
  // node-addon-api: node-pty 的构建期依赖 (其 dependencies 里唯一一项)。hoisted 布局
  // 下 apps/desktop/node_modules 为空, 若不显式随包带上, electron-rebuild 在 packaged
  // buildPath 里对 node-pty 跑 node-gyp 时, binding.gyp 的 `require('node-addon-api')`
  // 会 Cannot find module 直接炸 (better-sqlite3 不踩是因为它用 bindings 而非 node-addon-api)。
  // header-only, rebuild 后即无用但体积极小, 随包带无妨。
  'node-addon-api',
  // undici (同 @cindy/browser-control-runtime 运行时依赖): vendored runtime 的
  // CDP 网络层 (_generated/leaf/src/infra/net/undici-runtime.ts) 通过
  // `createRequire(...).require('undici')` 懒加载它建 pinned dispatcher —— 任何
  // CDP 路径 (navigate/snapshot/act 等托管 Chrome 起来后) 都会用到。和
  // playwright-core 同因: vite externalize 懒 require、不在本表则 packaged app
  // `Cannot find module 'undici'`(dev 靠 hoist 不暴露)。undici dependencies 为空,
  // 无需带闭包。注: 这是 vendored runtime 里仅有的两个运行时外部 require 之一
  // (另一个是 playwright-core),已全覆盖。
  'undici',
];

/**
 * @parcel/watcher 的 prebuilt 二进制按 platform-arch (在 linux 上还分 glibc/musl)
 * 拆进独立子包, 主包运行时按 process.platform/arch 动态 require。打包时只带
 * 当前平台的子包就够了。
 *
 * 注意: 用 forge afterCopy hook 传进来的 TARGET platform/arch, 不要用
 * process.platform/arch (host) — 跨 arch build (例如 release:mac:arm64 跑在
 * Intel Mac 上) 会打错子包导致目标机器加载 .node 失败。
 */
function parcelWatcherPlatformPkg(platform: string, arch: string): string {
  if (platform === 'linux') {
    return `@parcel/watcher-${platform}-${arch}-glibc`;
  }
  return `@parcel/watcher-${platform}-${arch}`;
}

/**
 * sharp 的 prebuilt 二进制按 platform-arch 拆进 @img/sharp-{platform}-{arch}。
 *
 * 平台差异:
 *   - macOS / Linux: libvips 共享库住在独立的 @img/sharp-libvips-{platform}-{arch} 包,
 *     需要单独跟主包一起打。
 *   - Windows: 没有独立的 libvips 包 — libvips-42.dll / libvips-cpp-*.dll 直接和 .node
 *     一起塞在 @img/sharp-win32-{arch}/lib/ 里。所以只带主包就够了。
 *     (asar.unpack 规则需要单独覆盖这个 dir,见 packagerConfig.asar 注释。)
 *
 * 同 parcelWatcherPlatformPkg: 用 TARGET platform/arch 不用 host, 跨 arch
 * build (release:mac:arm64 on Intel Mac) 才不会打错二进制。
 */
function sharpPlatformPkgs(platform: string, arch: string): string[] {
  const pkgs = [`@img/sharp-${platform}-${arch}`];
  if (platform !== 'win32') {
    pkgs.push(`@img/sharp-libvips-${platform}-${arch}`);
  }
  return pkgs;
}

// Locate a package's directory on disk. Some packages ship a strict `exports`
// map that hides the obvious resolve targets:
//   - `long` blocks `./package.json` but exposes a main entry → walk up from
//     the bare specifier resolve.
//   - `@img/sharp-{platform}-{arch}` blocks BOTH `./package.json` AND the bare
//     specifier (no main), but exposes `./package` → resolve that, it points
//     at package.json directly.
// Final fallback: locate via the workspace root's hoisted node_modules path
// (we use pnpm node-linker=hoisted, so every dep lives under root node_modules).
function resolvePackageDir(dep: string, fromDirs?: string[]): string {
  // fromDirs: 从这些目录的视角解析(require.resolve 的 paths 选项)。用于消歧
  // 多版本依赖 —— 例如 node-addon-api 同时存在 1.7.2 (iconv-corefoundation, mac
  // dmg 工具链, 无 `.targets`) 和 7.1.1 (node-pty 需要)。hoisted 布局下 root
  // node_modules 只留一个版本, 若被 1.7.2 占了, 直接 resolve 会拿错版本, node-pty
  // 的 binding.gyp `require('node-addon-api').targets` 会因 undefined 而炸。传
  // node-pty 目录当 fromDirs 就能锁定它实际用的 7.1.1 (nested 或 hoisted 都覆盖)。
  if (fromDirs && fromDirs.length > 0) {
    try {
      return path.dirname(_require.resolve(`${dep}/package.json`, { paths: fromDirs }));
    } catch {
      // ignore, fall through to default resolution
    }
  }
  try {
    return path.dirname(_require.resolve(`${dep}/package.json`, resolveOptions(fromDirs)));
  } catch {
    // ignore, try next strategy
  }
  try {
    // sharp-style: `./package` exports map entry → resolves to package.json
    const pkgJson = _require.resolve(`${dep}/package`, resolveOptions(fromDirs));
    if (pkgJson.endsWith('package.json')) return path.dirname(pkgJson);
  } catch {
    // ignore, try next strategy
  }
  try {
    let dir = path.dirname(_require.resolve(dep, resolveOptions(fromDirs)));
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name === dep) return dir;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // ignore, try final filesystem fallback
  }
  // Final fallback: pnpm hoisted layout — every dep is at <repo>/node_modules/<dep>.
  // __dirname is apps/desktop, so repo root is two levels up.
  const hoisted = path.join(__dirname, '..', '..', 'node_modules', dep);
  if (fs.existsSync(path.join(hoisted, 'package.json'))) return hoisted;
  throw new Error(`[forge] cannot locate package dir for "${dep}"`);
}

function resolveOptions(fromDirs?: string[]): { paths: string[] } | undefined {
  return fromDirs && fromDirs.length > 0 ? { paths: fromDirs } : undefined;
}

function copyDiscordRuntimeDeps(destModules: string): void {
  const seen = new Set<string>();
  for (const dep of DISCORD_RUNTIME_DEPS) {
    copyDependencyTree(dep, destModules, undefined, seen);
  }
}

function copyDependencyTree(
  dep: string,
  destModules: string,
  fromDirs?: string[],
  seen = new Set<string>(),
): void {
  const src = resolvePackageDir(dep, fromDirs);
  const dst = path.join(destModules, dep);
  const seenKey = `${dst}\0${src}`;
  if (seen.has(seenKey)) return;
  seen.add(seenKey);

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, {
    recursive: true,
    dereference: true,
    filter: (srcPath) => path.basename(srcPath) !== 'node_modules',
  });
  console.log(`[forge:afterCopy] bundled runtime dep tree: ${dep} <- ${src}`);

  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const childDestModules = path.join(dst, 'node_modules');
  for (const childDep of Object.keys(pkg.dependencies ?? {}).sort()) {
    copyDependencyTree(childDep, childDestModules, [src], seen);
  }
}

/**
 * sqlite-vec の loadable 拡張バイナリ（vec0.dylib / vec0.dll）を buildPath にコピー。
 * target platform のファイルだけコピーして asar.unpack で展開させる。
 * asar 内のパス: native/sqlite-vec/{platform}-{arch}/vec0.{ext}
 * 展開後パス:    app.asar.unpacked/native/sqlite-vec/{platform}-{arch}/vec0.{ext}
 */
function copySqliteVecBinary(buildPath: string, targetPlatform: string, targetArch: string): void {
  const ext =
    targetPlatform === 'win32'
      ? 'vec0.dll'
      : targetPlatform === 'linux'
        ? 'vec0.so'
        : 'vec0.dylib';
  const platformDir = `${targetPlatform}-${targetArch}`;
  const src = path.join(__dirname, 'native', 'sqlite-vec', platformDir, ext);
  if (!fs.existsSync(src)) {
    console.warn(`[forge:afterCopy] sqlite-vec binary not found at ${src}, skipping`);
    return;
  }
  const dst = path.join(buildPath, 'native', 'sqlite-vec', platformDir);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(src, path.join(dst, ext));
  console.log(`[forge:afterCopy] sqlite-vec ${platformDir}/${ext} -> ${dst}`);
}

function bundleNativeDeps(buildPath: string, targetPlatform: string, targetArch: string): void {
  const destModules = path.join(buildPath, 'node_modules');
  fs.mkdirSync(destModules, { recursive: true });
  // 静态列表 + 当前 TARGET 平台的 @parcel/watcher 子包 + 当前 TARGET 平台的
  // sharp 子包对(动态拼)。target 由 forge afterCopy 传入, 跨 arch build 才能
  // 选对 .node / .dylib / .dll。
  const deps = [
    ...NATIVE_RUNTIME_DEPS,
    parcelWatcherPlatformPkg(targetPlatform, targetArch),
    ...sharpPlatformPkgs(targetPlatform, targetArch),
    // loudness 只在 Windows 用 (录音时静音)。它的 Win 后端是个捆绑的 .exe,
    // 必须运行时按 __dirname 找 — 所以走 NATIVE_RUNTIME_DEPS 这条路, 不让 vite
    // bundle。Mac/Linux 完全不带, 避免拖入 execa 这条无用依赖链。
    ...(targetPlatform === 'win32' ? ['loudness'] : []),
  ];
  // node-addon-api 必须解析成 node-pty 实际依赖的那一版 (7.x, 有 `.targets`),
  // 不能让它退化到 root 可能 hoist 的 1.7.2。以 node-pty 目录为解析起点。
  const nodePtyDir = resolvePackageDir('node-pty');
  for (const dep of deps) {
    const src = dep === 'node-addon-api'
      ? resolvePackageDir(dep, [nodePtyDir])
      : resolvePackageDir(dep);
    const dst = path.join(destModules, dep);
    // Scoped packages (`@protobufjs/aspromise`) need their `@scope` parent
    // dir created before cpSync — cpSync only mkdir's the leaf.
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true, dereference: true });
    console.log(`[forge:afterCopy] bundled native dep: ${dep} <- ${src}`);
  }
  copyDiscordRuntimeDeps(destModules);
}

// 针对 packaged buildPath 的 node_modules 强制重建 better-sqlite3 —— force:true 确保
// 即使根 node_modules 里的 .node 是 Node ABI（pnpm install 默认），也会被 Electron ABI
// 覆盖重编。编完的 .node 落在 build/Release/better_sqlite3.node,下游
// AutoUnpackNativesPlugin 会在 asar 打包时把它提取到 app.asar.unpacked/。
async function rebuildNativeDepsInPackage(
  buildPath: string,
  electronVersion: string,
  arch: string,
): Promise<void> {
  console.log(
    `[forge:afterCopy] rebuilding native modules (better-sqlite3, node-pty) for Electron ${electronVersion} (${arch})...`,
  );
  await electronRebuild({
    buildPath,
    electronVersion,
    arch,
    force: true,
    onlyModules: ['better-sqlite3', 'node-pty'],
  });
  const sqliteNative = path.join(
    buildPath,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  if (!fs.existsSync(sqliteNative)) {
    throw new Error(
      `[forge:afterCopy] rebuild reported success but ${sqliteNative} is missing`,
    );
  }
  // node-pty 的 .node 在 build/Release/pty.node;Windows 上同名,Linux/macOS 同名。
  // 跟 better-sqlite3 一样,缺了直接抛出,避免发出无法启动 PTY 的包。
  const ptyNative = path.join(
    buildPath,
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'pty.node',
  );
  if (!fs.existsSync(ptyNative)) {
    throw new Error(
      `[forge:afterCopy] rebuild reported success but ${ptyNative} is missing`,
    );
  }

  // node-pty 被整目录纳入 asar.unpack（为放出 spawn-helper / winpty 等运行时二进制），
  // 但 node-gyp 重编会在 build/Release/obj.target/ 留下 .o 编译中间产物（也是 Mach-O）。
  // 若随目录一起解包进 app.asar.unpacked，macOS 发版/公证签名脚本（release-macos.mjs /
  // publish-macos.mjs 的"凡 Mach-O 就签"）会去 codesign/notarize 这些不可签名的
  // relocatable object，弄崩整条签名。打 asar 前先删掉这些中间产物，只留运行时真正需要的
  // pty.node / spawn-helper / winpty 等（#443 review P1）。better-sqlite3 不受影响：它只有
  // .node 被 AutoUnpackNativesPlugin 解包，整目录仍在 asar 内，obj.target 不会被签。
  const ptyObjTarget = path.join(
    buildPath,
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'obj.target',
  );
  if (fs.existsSync(ptyObjTarget)) {
    fs.rmSync(ptyObjTarget, { recursive: true, force: true });
    console.log(`[forge:afterCopy] pruned node-gyp intermediates: ${ptyObjTarget}`);
  }

  console.log(`[forge:afterCopy] rebuild ok: ${sqliteNative}, ${ptyNative}`);
}

const isDev = process.env.NODE_ENV !== 'production' && !process.argv.includes('make') && !process.argv.includes('package');
const isWin = process.platform === 'win32';

/**
 * Build cindy-updater (Rust + Tauri) and copy the release binary into
 * resources/. Runs once per `forge package` / `make` invocation, so
 * `pnpm build` / `pnpm release:win` always ship the latest updater.
 *
 * Skipped on non-Windows hosts (the updater is currently Win-only).
 * Hard-fails if cargo is missing or the build errors — we'd rather break
 * the release than ship a stale updater.
 */
function buildCindyUpdater(): void {
  if (process.platform !== 'win32') return;
  console.log(`[forge:prePackage] Building ${UPDATER_EXE} (Rust + Tauri)...`);

  const updaterRoot = path.join(__dirname, 'cindy-updater', 'src-tauri');
  if (!fs.existsSync(updaterRoot)) {
    throw new Error(`[forge] cindy-updater source missing at ${updaterRoot}`);
  }

  // winget-installed Rust may not be on PATH in this shell session, fall
  // back to the well-known per-user install location.
  const cargoBin = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe')
    : 'cargo';
  const cargo = fs.existsSync(cargoBin) ? cargoBin : 'cargo';

  const t0 = Date.now();
  const r = spawnSync(
    cargo,
    ['build', '--release', '--manifest-path', path.join(updaterRoot, 'Cargo.toml')],
    { stdio: 'inherit' },
  );
  if (r.error) {
    throw new Error(`[forge] failed to invoke cargo (${cargo}): ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`[forge] cargo build --release failed with exit code ${r.status}`);
  }

  const builtExe = path.join(updaterRoot, 'target', 'release', UPDATER_EXE);
  const destExe = path.join(__dirname, 'resources', UPDATER_EXE);
  if (!fs.existsSync(builtExe)) {
    throw new Error(`[forge] cargo build succeeded but ${builtExe} is missing`);
  }

  // 替换 exe 内嵌 manifest, 声明 SupportedOS=Vista+ 让 Windows 跳过 PCA
  // (程序兼容性助手) 启发式——否则 exe 名带 "update" 会被 PCA 误判为
  // "安装失败的安装程序", 弹"可能未正确安装此程序"对话框。
  // 走 mt.exe 后处理而不是 build.rs 嵌资源, 是因为 tauri-build 自己已经
  // 在 ID 1 嵌了一个 manifest, 第二个 manifest 会触发 CVT1100。mt.exe
  // -outputresource:xxx;#1 直接覆盖 ID 1 那个, 不冲突。
  patchUpdaterManifest(builtExe);

  fs.copyFileSync(builtExe, destExe);
  const sizeMb = (fs.statSync(destExe).size / (1024 * 1024)).toFixed(2);
  console.log(`[forge:prePackage] ${UPDATER_EXE} → ${destExe} (${sizeMb} MB, ${Date.now() - t0}ms)`);
}

/**
 * 在 Windows SDK 安装目录里找 mt.exe (manifest tool)。优先用最新版 SDK 的
 * x64 版本; 找不到时给清晰的错(让构建机至少装一次 Win10 SDK)。
 */
function findMtExe(): string {
  const candidates = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    // 子目录形如 10.0.22621.0, 取版本号最大的
    const versions = fs.readdirSync(base)
      .filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d))
      .sort()
      .reverse();
    for (const v of versions) {
      const mt = path.join(base, v, 'x64', 'mt.exe');
      if (fs.existsSync(mt)) return mt;
    }
    // 老 SDK 直接放 bin\x64 下没版本号子目录
    const flat = path.join(base, 'x64', 'mt.exe');
    if (fs.existsSync(flat)) return flat;
  }
  throw new Error(
    '[forge] mt.exe not found. Install Windows 10/11 SDK and ensure ' +
    '"C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<ver>\\x64\\mt.exe" exists.',
  );
}

function patchUpdaterManifest(exePath: string): void {
  const manifestPath = path.join(__dirname, 'cindy-updater', 'src-tauri', 'cindy-updater.manifest');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[forge] manifest missing at ${manifestPath}`);
  }
  const mt = findMtExe();
  // -outputresource:<exe>;#1 — 替换 exe 里资源 ID 1 (RT_MANIFEST), 不新增。
  // tauri-build 已经塞过一个默认 manifest 在 ID 1, 这步把它换成我们的版本。
  const r = spawnSync(mt, [
    '-nologo',
    '-manifest', manifestPath,
    `-outputresource:${exePath};#1`,
  ], { stdio: 'inherit' });
  if (r.error) throw new Error(`[forge] mt.exe spawn failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`[forge] mt.exe exited ${r.status} when patching manifest`);
  console.log(`[forge:prePackage] manifest patched into ${UPDATER_EXE} (PCA bypass)`);
}

/**
 * 递归收集目录下所有 .exe 的绝对路径（目录不存在返回空数组）。用于给 node-pty
 * 这类内部布局随重编 / 版本变化的原生依赖做"按需签名"，不硬编码易漂的子路径。
 */
function collectExeFilesRecursively(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectExeFilesRecursively(full));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) out.push(full);
    }
  } catch {
    // 目录不存在（非 Windows 包 / node-pty 未解包）——返回空
  }
  return out;
}

/**
 * 用外部签名命令签单个 exe。命令模板来自 CINDY_WIN_SIGN_CMD 环境变量,其中的
 * `{file}` 占位符会被替换为目标 exe 的绝对路径(发布方在自己的构建环境注入,
 * 例如接 signtool 或自建签名服务;仓库本身不绑定任何签名实现)。
 * postPackage 的包内 exe 循环 与 NSIS maker 的 customSign
 * (installer + uninstaller) 共用这一处,签名逻辑单点、不 fork。
 * 失败即抛（调用方 postPackage / customSign 会让整个 make 失败,避免发出漏签包）。
 */
function signOneExeWithExternalCommand(exePath: string, commandTemplate: string): void {
  const command = commandTemplate.replaceAll('{file}', `"${exePath}"`);
  console.log(`[forge:sign] signing ${path.basename(exePath)}...`);
  const r = spawnSync(command, { stdio: 'inherit', shell: true });
  if (r.error) throw new Error(`[forge:sign] sign command spawn failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`[forge:sign] sign command exited ${r.status} for ${exePath}`);
}

/**
 * 把 packaged 目录内的所有 .exe 都用外部签名命令签一遍。
 * 触发时机：electron-forge 的 postPackage（package 完、makers 跑前），所以
 * NSIS Setup.exe 拿到的、以及 publish 阶段从 packagedDir 打的热更 ZIP 拿到的，
 * 都是已签名版本——彻底解决 hot-update 后 spawn updater EACCES 的问题
 * (Win 严格策略机器拒绝从 %TEMP% 启动未签名 exe)。
 *
 * NSIS 安装器自身(Setup.exe)与卸载器(Uninstall <App>.exe)不在这里签——它们由
 * makers 阶段生成,由 getAppBuilderConfig 的 win.sign(customSign)统一签,同样走
 * signOneExeWithExternalCommand。见 makers 定义处注释。
 *
 * 没有 CINDY_WIN_SIGN_CMD 时静默跳过，不影响本地 dev / 无签名环境的 packaging。
 */
function signPackagedExes(buildPath: string): void {
  if (process.platform !== 'win32') return;
  const signCmd = process.env.CINDY_WIN_SIGN_CMD;
  if (!signCmd) {
    console.log('[forge:postPackage] CINDY_WIN_SIGN_CMD not set — skipping exe signing');
    return;
  }

  // 路径写死：跟 forge 的 packagerConfig.extraResource + Electron 输出布局对齐。
  // 新增第三方 exe 时往这里加一行即可。
  //
  // postPackage 时 buildPath 是 packaged 后的最终目录(asar 已经打完),所以
  // 第三方 exe 通过 asar.unpack 释放的路径前缀是 resources/app.asar.unpacked/...
  // 跟 extraResource 注入的(resources/...)不一样,别搞混。
  // loudness 自带的 .exe 也在这里签:不签的话企业 EDR / Smart App Control 可能
  // 把它当未知未签名第三方进程拦下,影响"录音时静音"功能。
  const exes = [
    path.join(buildPath, `${CINDY_EXE}.exe`),
    path.join(buildPath, 'resources', UPDATER_EXE),
    path.join(
      buildPath,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'loudness',
      'impl',
      'windows',
      'adjust_get_current_system_volume_vista_plus.exe',
    ),
  ];

  // node-pty 在 Windows 上通过 spawn winpty-agent.exe / conpty/OpenConsole.exe 驱动
  // PTY。自本次把 node-pty 纳入 asar.unpack 后，这些非 .node 的 PE 可执行文件会被释放
  // 到 app.asar.unpacked，但和上面的 loudness.exe 一样需要签名——否则企业 EDR / Smart
  // App Control 会把未签名第三方进程拦下，导致终端启动失败。node-pty 内部布局
  // （build/Release vs prebuilds、conpty 子目录）随重编 / 版本变化，这里递归扫描按需
  // 签，避免硬编码易漂的子路径。
  exes.push(
    ...collectExeFilesRecursively(
      path.join(buildPath, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty'),
    ),
    // 递归整个 resources/tools（extraResource 注入的第三方 CLI）：覆盖
    // android-platform-tools/adb.exe + ripgrep/rg.exe + 未来新增的 tool exe。
    // 之前只递归了 android-platform-tools,漏了 ripgrep/rg.exe——rg 与 adb 同为
    // 未签名第三方 exe,会被运行时 spawn(项目内 grep/search),未签同样被严格策略 /
    // EDR 拦。扩到整个 tools/ 一次覆盖,新增工具免维护。
    ...collectExeFilesRecursively(path.join(buildPath, 'resources', 'tools')),
  );

  for (const exe of exes) {
    if (!fs.existsSync(exe)) {
      console.warn(`[forge:postPackage] skip (missing): ${exe}`);
      continue;
    }
    signOneExeWithExternalCommand(exe, signCmd);
  }
}

/**
 * macOS 打包显示名(与 win32metadata 同构):packaged 后把
 * .app 的 Info.plist 里 CFBundleDisplayName 改成 Cindy——Dock 名、Cmd+Tab、
 * Finder、系统通知读的都是它(显示优先级 CFBundleDisplayName > CFBundleName)。
 *
 * ⚠️ 绝不能改 CFBundleName:Electron 启动时用主 app 的 CFBundleName 拼
 * `Frameworks/<CFBundleName> Helper.app` 查找 Helper(electron_main_delegate_mac.mm,
 * 唯一 fallback 是 'Electron Helper.app'),而 Helper 目录名跟随 packager name
 * (区域派生:cn/global 'Cindy' / dev 'CindyDev')。把 CFBundleName 改成
 * 与 Helper 目录不一致的值会让包启动即 FATAL "Unable to find helper app"
 * (SIGTRAP;2026-07-21 dev region smoke 实踩)。
 * 代价:菜单栏粗体标题取自 CFBundleName 且运行时改不了,dev 构建上显示
 * CindyDev 而非 Cindy——cn/global(packager 已写 Cindy)不受影响,可接受。
 *
 * 为什么在 postPackage 改而不是 packagerConfig:electron-packager 在
 * updatePlistFiles 里先合并 extendInfo、后用 appName/executableName 覆写
 * CFBundleName / CFBundleDisplayName,extendInfo 改不动这两个键;而给
 * packagerConfig.name 设 'Cindy' 会连 .app 目录名一起改,踩标识符红线。
 *
 * 历史沿革:本步骤诞生于身份翻转前(当时 .app/CFBundleExecutable/bundle id/
 * userData 均为 xdt-maker 系,这里是唯一的显示名来源)。2026-07-17 身份翻转后
 * cn 构建的 packager 本身就会把 CFBundleName/CFBundleDisplayName 写成 Cindy,
 * 对 cn 是冗余兜底;2026-07-26 global exe 名与 cn 统一为 'Cindy' 后 global
 * 同样只是冗余兜底;dev 构建的 packager name 仍是 'CindyDev',本步骤把
 * Dock 名、Cmd+Tab、系统通知的**显示层**拉回 Cindy(BRAND_NAME 各区共用),
 * 对 dev 是显示名的唯一来源。正式签名/公证(外部发布流程)发生在
 * postPackage 之后,本改动会被签名一起封印,不存在破坏签名问题。
 */
function applyMacPackagedDisplayName(buildPath: string, platform: string): void {
  if (platform !== 'darwin') return;
  const apps = fs.readdirSync(buildPath).filter((n) => n.endsWith('.app'));
  for (const appDir of apps) {
    const plistPath = path.join(buildPath, appDir, 'Contents', 'Info.plist');
    if (!fs.existsSync(plistPath)) {
      throw new Error(`[forge:postPackage] Info.plist missing at ${plistPath}`);
    }
    // 只改 CFBundleDisplayName;CFBundleName 必须保持 packager name 原值,
    // 否则 Electron 找不到 Helper app(见函数头 ⚠️)。
    const key = 'CFBundleDisplayName';
    // packager 必写该键,Set 即可;Add 兜底防未来 packager 行为变化。
    const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} Cindy`, plistPath]);
    if (set.status !== 0) {
      const add = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string Cindy`, plistPath]);
      if (add.status !== 0) {
        throw new Error(`[forge:postPackage] PlistBuddy failed to set ${key} in ${plistPath}`);
      }
    }
    console.log(`[forge:postPackage] mac display name → Cindy (${appDir}/Contents/Info.plist)`);
  }
}

function targetPlatformKey(targetPlatform: string, targetArch: string): string {
  return `${targetPlatform}-${targetArch}`;
}

function readForgeTargetArg(name: 'platform' | 'arch'): string | null {
  const flag = `--${name}`;
  const argv = process.argv;
  const idx = argv.indexOf(flag);
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  return null;
}

function requestedTargetPlatform(): string {
  return process.env.ELECTRON_FORGE_PLATFORM || readForgeTargetArg('platform') || process.platform;
}

function requestedTargetArch(): string {
  return process.env.ELECTRON_FORGE_ARCH || readForgeTargetArg('arch') || process.arch;
}

function ripgrepBinaryName(targetPlatform: string): string {
  return targetPlatform === 'win32' ? 'rg.exe' : 'rg';
}

function stageRipgrep(targetPlatform: string, targetArch: string): void {
  const key = targetPlatformKey(targetPlatform, targetArch);
  const file = ripgrepBinaryName(targetPlatform);
  const src = path.join(__dirname, '..', 'ripgrep-bin', key, file);
  const destDir = path.join(__dirname, 'resources', 'tools', 'ripgrep');
  const dest = path.join(destDir, file);

  // ripgrep 不再进 git/LFS 且 apps/ripgrep-bin/ 现在被 gitignore、会跨 pin 升级残留在本地——
  // 因此无条件经 ensure 脚本保证目标平台是 tools/ripgrep/latest.json 的 pin 版本：标记命中则快速跳过，
  // 缺失/不匹配/仍是旧二进制或 LFS pointer 则刷新。只判 fs.existsSync 会把陈旧 rg 直接打进包。
  const ensureScript = path.join(__dirname, '..', '..', 'scripts', 'ensure-agent-binaries.mjs');
  console.log(`[forge:prePackage] ensuring pinned ripgrep ${key} via ${ensureScript}...`);
  const r = spawnSync(process.execPath, [ensureScript, '--kinds=ripgrep', `--platform=${key}`], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`[forge] failed to ensure pinned ripgrep ${key}; run "pnpm update:ripgrep" before packaging`);
  }
  if (!fs.existsSync(src)) {
    throw new Error(`[forge] ripgrep still missing at ${src} after ensure`);
  }

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  if (targetPlatform !== 'win32') {
    fs.chmodSync(dest, 0o755);
  }

  const sizeMb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(2);
  console.log(`[forge:prePackage] ripgrep ${key} -> ${dest} (${sizeMb} MB)`);
}

function extraResourcesForTarget(targetPlatform: string): string[] {
  const base = [
    'resources/icon.png',
    'resources/tools',
    'drizzle',
    'resources/cc-manager',
    'resources/anthropic-compat-proxy',
    'resources/remote-file-service',
    // .cindy 发布者/审核 Ed25519 公钥信任表(私钥永不进客户端)。
    'resources/ghost-trust.json',
    // 第三方开源声明,由 scripts/generate-third-party-notices.mjs 生成
    // (pnpm licenses:generate),随安装包分发以满足各开源协议的署名义务。
    'resources/THIRD-PARTY-NOTICES.txt',
    // 非开源 / source-available / 商业条款组件单列,避免与开源包数量混淆。
    'resources/THIRD-PARTY-RESTRICTED.txt',
  ];

  if (targetPlatform === 'win32') {
    base.unshift(`resources/${UPDATER_EXE}`);
  }

  // macOS 「帮助 → 安装到命令行」symlink 的目标脚本(<App>/Contents/Resources/cli/cindy)。
  // 仅 darwin 有此功能,其它平台不打进包。exec 位由 git 跟踪,extraResource 拷贝时保留。
  if (targetPlatform === 'darwin') {
    base.push('resources/cli');
  }

  return base;
}

function assertRealAndroidPlatformTool(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[forge] bundled Android platform-tools file missing at ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size < 4096) {
    const prefix = fs.readFileSync(filePath, 'utf8').slice(0, 128);
    if (prefix.includes('git-lfs.github.com/spec/v1')) {
      throw new Error(`[forge] bundled Android platform-tools file is a Git LFS pointer; run "git lfs pull": ${filePath}`);
    }
    throw new Error(`[forge] bundled Android platform-tools file is unexpectedly small (${stat.size} bytes): ${filePath}`);
  }
}

function validateAndroidPlatformToolsSource(srcDir: string, targetPlatform: string): void {
  if (targetPlatform === 'win32') {
    for (const file of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      assertRealAndroidPlatformTool(path.join(srcDir, file));
    }
    return;
  }

  assertRealAndroidPlatformTool(path.join(srcDir, 'adb'));
}

/**
 * Windows 打包前把 Android platform-tools 的三个二进制按 pin 版本就位。
 *
 * 它们(6.5MB)不入仓:公开仓每次 clone 与每次 CI checkout(ci.yml 的 lfs: true)都会
 * 把 LFS 对象下一遍,免费带宽额度耗尽后 clone 与 CI 会一起硬失败。脚本幂等 ——
 * 已就位且 sha256 匹配时直接跳过、不碰网络;无外网的打包机见脚本内的离线出路。
 */
function ensureAndroidPlatformToolsBinaries(key: string): void {
  const script = path.join(__dirname, 'scripts', 'ensure-android-platform-tools.mjs');
  const r = spawnSync(process.execPath, [script, `--platform-key=${key}`], { stdio: 'inherit' });
  if (r.error) {
    throw new Error(`[forge] failed to invoke ${script}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `[forge] Android platform-tools ${key} 未能就位(exit ${r.status})——见上方脚本输出的离线出路。`,
    );
  }
}

function stageAndroidPlatformTools(targetPlatform: string, targetArch: string): void {
  const key = targetPlatformKey(targetPlatform, targetArch);
  const srcDir = path.join(__dirname, '..', 'android-platform-tools-bin', key);
  const destDir = path.join(__dirname, 'resources', 'tools', 'android-platform-tools', key);

  // win32 的二进制不入仓,先按 pin 版本下载/校验。注意不能靠 srcDir 是否存在来判断
  // 二进制在不在 —— 同目录的 NOTICE.txt 与 source.properties 是有意入仓的文本
  // (许可清单与版本 pin 都读它们),所以目录一直存在。
  if (targetPlatform === 'win32') {
    ensureAndroidPlatformToolsBinaries(key);
  }

  if (!fs.existsSync(srcDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
    if (targetPlatform !== 'win32') {
      console.log(`[forge:prePackage] Android platform-tools ${key} missing; runtime preparation will download it when needed`);
      return;
    }
    throw new Error(`[forge] bundled Android platform-tools missing at ${srcDir}`);
  }

  validateAndroidPlatformToolsSource(srcDir, targetPlatform);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  if (process.platform !== 'win32') {
    const adbPath = path.join(destDir, 'adb');
    if (fs.existsSync(adbPath)) fs.chmodSync(adbPath, 0o755);
  }

  console.log(`[forge:prePackage] Android platform-tools ${key} -> ${destDir}`);
}

function isMacForgePlatform(platform: ForgePlatform): boolean {
  return platform === 'darwin' || platform === 'mas';
}

const MACOS_VOICE_HELPER_DEPLOYMENT_TARGET = 'macos10.15';
const MACOS_AGENT_ISLAND_HELPER_DEPLOYMENT_TARGET = 'macos14.0';
const MACOS_COMPUTER_PERMISSION_GUIDE_HELPER_DEPLOYMENT_TARGET = 'macos13.0';

function swiftTargetTriple(cpuArch: 'arm64' | 'x86_64', deploymentTarget: string): string {
  return `${cpuArch}-apple-${deploymentTarget}`;
}

function swiftTargetTriplesForForgeArch(arch: ForgeArch, deploymentTarget: string): string[] {
  switch (arch) {
    case 'x64':
      return [swiftTargetTriple('x86_64', deploymentTarget)];
    case 'arm64':
      return [swiftTargetTriple('arm64', deploymentTarget)];
    case 'universal':
      return [
        swiftTargetTriple('x86_64', deploymentTarget),
        swiftTargetTriple('arm64', deploymentTarget),
      ];
    default:
      throw new Error(`[forge] unsupported macOS Swift helper arch: ${arch}`);
  }
}

function swiftArchLabel(arch: ForgeArch, deploymentTarget: string): string {
  return swiftTargetTriplesForForgeArch(arch, deploymentTarget)
    .map((target) => target.split('-')[0])
    .join('+');
}

function runSwiftcForTarget(src: string, dest: string, target: string, extraArgs: string[], label: string): void {
  const r = spawnSync('swiftc', ['-target', target, src, ...extraArgs, '-o', dest], { stdio: 'inherit' });
  if (r.error) throw new Error(`[forge] swiftc spawn failed for ${label}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`[forge] swiftc failed for ${label} (${target}) with exit code ${r.status}`);
}

function buildSwiftHelperForForgeArch(
  src: string,
  dest: string,
  arch: ForgeArch,
  deploymentTarget: string,
  extraArgs: string[],
  label: string,
): void {
  const targets = swiftTargetTriplesForForgeArch(arch, deploymentTarget);
  if (targets.length === 1) {
    runSwiftcForTarget(src, dest, targets[0], extraArgs, label);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-swift-helper-'));
  const outputs = targets.map((target) => path.join(tempDir, `${path.basename(dest)}-${target.split('-')[0]}`));
  try {
    targets.forEach((target, index) => runSwiftcForTarget(src, outputs[index], target, extraArgs, label));
    const r = spawnSync('lipo', ['-create', ...outputs, '-output', dest], { stdio: 'inherit' });
    if (r.error) throw new Error(`[forge] lipo spawn failed for ${label}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`[forge] lipo failed for ${label} with exit code ${r.status}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildMacVoiceInputTextInsertionHelper(platform: ForgePlatform, arch: ForgeArch): void {
  if (process.platform !== 'darwin' || !isMacForgePlatform(platform)) return;
  const src = path.join(__dirname, 'native', 'voice-input', 'macos-text-insertion-helper.swift');
  const destDir = path.join(__dirname, 'resources', 'tools', 'voice-input');
  const dest = path.join(destDir, 'xdt-macos-text-insertion-helper');
  if (!fs.existsSync(src)) {
    throw new Error(`[forge] macOS voice input text insertion helper source missing at ${src}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  buildSwiftHelperForForgeArch(
    src,
    dest,
    arch,
    MACOS_VOICE_HELPER_DEPLOYMENT_TARGET,
    [],
    'voice input text insertion helper',
  );
  fs.chmodSync(dest, 0o755);
  const sizeMb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(2);
  console.log(`[forge:prePackage] macOS voice input text insertion helper (${swiftArchLabel(arch, MACOS_VOICE_HELPER_DEPLOYMENT_TARGET)}) -> ${dest} (${sizeMb} MB)`);
}

function buildMacVoiceInputModifierShortcutListener(platform: ForgePlatform, arch: ForgeArch): void {
  if (process.platform !== 'darwin' || !isMacForgePlatform(platform)) return;
  const src = path.join(__dirname, 'native', 'voice-input', 'macos-modifier-shortcut-listener.swift');
  const destDir = path.join(__dirname, 'resources', 'tools', 'voice-input');
  const dest = path.join(destDir, 'xdt-macos-modifier-shortcut-listener');
  if (!fs.existsSync(src)) {
    throw new Error(`[forge] macOS voice input modifier shortcut listener source missing at ${src}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  buildSwiftHelperForForgeArch(
    src,
    dest,
    arch,
    MACOS_VOICE_HELPER_DEPLOYMENT_TARGET,
    [],
    'voice input modifier shortcut listener',
  );
  fs.chmodSync(dest, 0o755);
  const sizeMb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(2);
  console.log(`[forge:prePackage] macOS voice input modifier shortcut listener (${swiftArchLabel(arch, MACOS_VOICE_HELPER_DEPLOYMENT_TARGET)}) -> ${dest} (${sizeMb} MB)`);
}

function buildMacAgentIslandHelper(platform: ForgePlatform, arch: ForgeArch): void {
  if (process.platform !== 'darwin' || !isMacForgePlatform(platform)) return;
  const src = path.join(__dirname, 'native', 'agent-island', 'macos-agent-island-helper.swift');
  const gifSrc = path.join(__dirname, 'native', 'agent-island', 'running-agent.gif');
  const soundsSrc = path.join(__dirname, 'native', 'agent-island', 'sounds');
  const mascotsSrc = path.join(__dirname, 'native', 'agent-island', 'mascots');
  const destDir = path.join(__dirname, 'resources', 'tools', 'agent-island');
  const dest = path.join(destDir, 'xdt-macos-agent-island-helper');
  const gifDest = path.join(destDir, 'running-agent.gif');
  const soundsDest = path.join(destDir, 'sounds');
  const mascotsDest = path.join(destDir, 'mascots');
  if (!fs.existsSync(src)) {
    throw new Error(`[forge] macOS agent island helper source missing at ${src}`);
  }
  if (!fs.existsSync(gifSrc)) {
    throw new Error(`[forge] macOS agent island running GIF missing at ${gifSrc}`);
  }
  if (!fs.existsSync(soundsSrc)) {
    throw new Error(`[forge] macOS agent island sounds missing at ${soundsSrc}`);
  }
  if (!fs.existsSync(mascotsSrc)) {
    throw new Error(`[forge] macOS agent island mascots missing at ${mascotsSrc}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  buildSwiftHelperForForgeArch(
    src,
    dest,
    arch,
    MACOS_AGENT_ISLAND_HELPER_DEPLOYMENT_TARGET,
    ['-O'],
    'agent island helper',
  );
  fs.copyFileSync(gifSrc, gifDest);
  fs.rmSync(soundsDest, { recursive: true, force: true });
  fs.cpSync(soundsSrc, soundsDest, { recursive: true });
  fs.rmSync(mascotsDest, { recursive: true, force: true });
  fs.cpSync(mascotsSrc, mascotsDest, { recursive: true });
  fs.chmodSync(dest, 0o755);
  const sizeMb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(2);
  console.log(`[forge:prePackage] macOS agent island helper (${swiftArchLabel(arch, MACOS_AGENT_ISLAND_HELPER_DEPLOYMENT_TARGET)}) -> ${dest} (${sizeMb} MB)`);
}

function buildMacComputerPermissionGuideHelper(platform: ForgePlatform, arch: ForgeArch): void {
  if (process.platform !== 'darwin' || !isMacForgePlatform(platform)) return;
  const src = path.join(
    __dirname,
    'native',
    'computer-permission-guide',
    'macos-computer-permission-guide-helper.swift',
  );
  const destDir = path.join(__dirname, 'resources', 'tools', 'computer-permission-guide');
  const dest = path.join(destDir, 'xdt-macos-computer-permission-guide-helper');
  if (!fs.existsSync(src)) {
    throw new Error(`[forge] macOS computer permission guide helper source missing at ${src}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  buildSwiftHelperForForgeArch(
    src,
    dest,
    arch,
    MACOS_COMPUTER_PERMISSION_GUIDE_HELPER_DEPLOYMENT_TARGET,
    ['-O'],
    'computer permission guide helper',
  );
  fs.chmodSync(dest, 0o755);
  const sizeMb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(2);
  console.log(`[forge:prePackage] macOS computer permission guide helper (${swiftArchLabel(arch, MACOS_COMPUTER_PERMISSION_GUIDE_HELPER_DEPLOYMENT_TARGET)}) -> ${dest} (${sizeMb} MB)`);
}

// MakerNSIS is Windows-only (native dependency), conditionally require to
// avoid import errors on macOS / Linux.
const makers: ForgeConfig['makers'] = [
  new MakerZIP({}, ['darwin']),
  new MakerDeb({
    options: {
      categories: ['Development'],
      icon: path.join(__dirname, 'resources', 'icon.png'),
      // 双 scheme:cindy 主 + xdt-maker 兼容(老分享链接不死)。
      mimeType: allDeepLinkSchemes().map((s) => `x-scheme-handler/${s}`),
      maintainer: 'Lizi <feedback@cindy.app>',
      // deb 包名规范要求小写;跟随区域 exe 名(cn/global cindy / dev cindydev)。
      name: CINDY_EXE.toLowerCase(),
      bin: CINDY_EXE,
      productName: CINDY_EXE,
    },
  }, ['linux']),
];
if (isWin) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MakerNSIS = require('@felixrieseberg/electron-forge-maker-nsis').default;
  makers.unshift(
    new MakerNSIS({
      getAppBuilderConfig: async () => ({
        // NSIS installer(Setup.exe)与 uninstaller(Uninstall <App>.exe)的签名。
        // 这是签卸载器的唯一入口(Issue #998):uninstaller 由 NSIS 编译期两遍生成后
        // 嵌入 installer,postPackage 阶段还不存在、也没有独立成品文件可事后补签,
        // 只能让 electron-builder 在生成时对 installer + uninstaller 都回调 win.sign。
        // 复用包内 exe 同一条外部签名通道(signOneExeWithExternalCommand),逻辑单点;
        // 无 CINDY_WIN_SIGN_CMD(dev / 无签名环境)时跳过,与 postPackage 一致。
        win: {
          // 只用 sha256:不设时 electron-builder 默认 ['sha1','sha256'],会对 installer +
          // uninstaller 各回调 customSign 两趟(sha1 一趟 + sha256 一趟)= 每个文件两次
          // 签名往返,sha1 那趟纯浪费(Windows 早已弃信 sha1 Authenticode)。收敛到单
          // sha256:一趟往返、少一半瞬时失败面。customSign 忽略 hash 参数,签名实现用
          // 自身证书签,与此列表无关——只影响回调次数。
          signingHashAlgorithms: ['sha256'],
          sign: async (cfg: { path: string }) => {
            const signCmd = process.env.CINDY_WIN_SIGN_CMD;
            if (!signCmd) {
              console.log(`[forge:nsis:sign] CINDY_WIN_SIGN_CMD not set — skipping ${path.basename(cfg.path)}`);
              return;
            }
            signOneExeWithExternalCommand(cfg.path, signCmd);
          },
        },
        // appId 决定 NSIS 写到 Start Menu 快捷方式上的 System.AppUserModel.ID 属性。
        // Electron 主进程必须用 app.setAppUserModelId() 设同一个值，Windows 通知中枢
        // 才会接收 toast；否则原生 Notification 被静默丢弃。
        // 值按构建区域派生(shared/brandRegion 运行时同源),见文件头身份块。
        appId: CINDY_APP_ID,
        // 安装目录名跟随区域 exe 名(默认装到 …\Programs\<productName>):
        // cn/global 'Cindy'(2026-07-26 显示名统一,双装同目录互抢已被 owner
        // 接受)/ dev 'CindyDev'(仍与正式包隔离)。显式设值防 app-builder
        // 回落 package.json productName 造成 dev 与正式包同目录。
        productName: CINDY_EXE,
        // Setup.exe 与 Uninstall <App>.exe 的 FileDescription 版本资源。
        // app-builder-lib 只从 metadata(= apps/desktop/package.json)取
        // description,没有顶层 config 字段;extraMetadata 是唯一的覆盖通道
        // (packager.ts 在读完 package.json 后 deepAssign 进 metadata)。
        // 不设时回落 package.json 的 npm 包描述,UAC 提权弹窗、文件属性、
        // 快捷方式悬停提示上就会显示那段面向开发者的文本。
        //
        // ⚠️ 取 displayName 而非 CINDY_EXE:展示名两区(含 dev)共用 'Cindy',
        // 而 exe 名 dev 派生为 'CindyDev'。用后者会让 dev 包的安装器显示
        // CindyDev、装完的主 exe 却显示 Cindy(win32metadata 同样取
        // displayName)——安装前后自相矛盾,正是本次要消除的那类不一致。
        // 文件名层的区分由 productName / shortcutName 承担,与展示层解耦。
        //
        // prepackaged 模式下 doPack 直接 return,extraMetadata 不会重写
        // 已由 electron-forge 打好的 app.asar 内 package.json。
        extraMetadata: { description: BRAND_IDENTITY.displayName },
        nsis: {
          oneClick: false,
          allowToChangeInstallationDirectory: true,
          installerIcon: 'resources/icon.ico',
          uninstallerIcon: 'resources/icon.ico',
          createDesktopShortcut: 'always',
          createStartMenuShortcut: true,
          // 快捷方式显示名,跟随区域 exe 名(cn/global 'Cindy'——同名 .lnk
          // 双装互抢已被 owner 接受 / dev 'CindyDev')。installer.nsh 只清理/
          // 重建自家 .lnk——同机可能并存老 XDMaker 安装,它的 xdt-maker.lnk /
          // XDMaker.lnk 属于老 app,绝不能删(共存红线,见 installer.nsh
          // customInit 注释)。
          shortcutName: CINDY_EXE,
          runAfterFinish: true,
          include: 'resources/installer.nsh',
        },
      }),
    }),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    // sharp 的底层 libvips 共享库 (libvips-cpp.dylib / libvips-42.dll /
    // libvips-cpp.so) 在不同平台上的位置不同:
    //   - macOS / Linux: 住在独立的 @img/sharp-libvips-{platform}-{arch}/ 包,
    //     该目录里没有 .node, AutoUnpackNativesPlugin (按 **/*.node 匹配) 不会
    //     unpack 它, libvips 库会被 asar 困住。
    //   - Windows: libvips-42.dll / libvips-cpp-*.dll 直接和 sharp.node 一起塞
    //     在 @img/sharp-win32-{arch}/lib/ 里。AutoUnpackNativesPlugin 只 unpack
    //     .node 文件本身, 兄弟 .dll 不跟着出来, dlopen 找不到依赖 DLL 报错
    //     "The specified module could not be found"。
    // 用 brace 同时覆盖两种 layout, AutoUnpackNativesPlugin 的 .node 规则会以
    // ',' 拼接到这条后面。
    //
    // loudness 在 Windows 上自带一个 adjust_get_current_system_volume_vista_plus.exe,
    // node-pty 在 macOS/Linux 上会 posix_spawn 一个无扩展名的 spawn-helper、在
    // Windows 上也带 winpty-agent.exe / DLL 等非 .node 二进制；这些都必须 unpack
    // 到 asar 外才能被 spawn / 动态加载。AutoUnpackNativesPlugin 只 unpack .node,
    // 所以这里显式覆盖 loudness / node-pty 整个目录。
    asar: { unpack: '**/{@img/{sharp-libvips-*,sharp-win32-*},loudness,native/sqlite-vec,node-pty}/**' },
    // 打包名(out 目录 / mac .app 包名 / Helper 目录名 / 主 plist CFBundleName)
    // 按区域派生:cn/global 'Cindy'(2026-07-26 显示名统一,.app 撞名双装
    // 互覆已被 owner 接受)/ dev 'CindyDev'(显式设值防 packager 回落
    // package.json productName 让 dev 与正式包撞名)。mac 的 Dock/Cmd+Tab/
    // 通知**显示名**由 postPackage 的 applyMacPackagedDisplayName 经
    // CFBundleDisplayName 统一拉回 Cindy(对 dev 是唯一显示名来源;
    // CFBundleName 不可动,Electron 靠它找 Helper,见该函数注释)。
    name: CINDY_EXE,
    executableName: CINDY_EXE,
    // mac bundle id(与 Windows AUMID 同值,按区域派生;cn/global 是两个可并存
    // 的系统身份,与 mobile 的 com.xd.cindycn / com.xd.cindy 同一套)。
    appBundleId: CINDY_APP_ID,
    // exe 资源元数据(任务管理器进程名、文件右键属性的显示层)。只影响展示,
    // 与 exe 文件名 / AUMID / userData 等标识符解耦;显示层两区共用 Cindy
    // (与 mac 显示名口径一致)。FileDescription 走 BRAND_IDENTITY.displayName,
    // 与 NSIS maker 的 extraMetadata.description 同一表达式——安装器/卸载器
    // 与主 exe 的「说明」字段必须同值,否则 dev 包会安装前后显示两个名字。
    win32metadata: {
      CompanyName: 'XD',
      ProductName: 'Cindy',
      FileDescription: BRAND_IDENTITY.displayName,
    },
    icon: 'resources/icon',
    // 自定义 URL scheme: xdt-maker://session/<id> | xdt-maker://project/<encoded-workingDir>
    // macOS: electron-packager 把这里的项写进 Info.plist 的 CFBundleURLTypes,
    //        系统 LaunchServices 据此把 xdt-maker:// 链接路由到本 app。
    // Windows: 不读这个字段(走 app.setAsDefaultProtocolClient 写注册表), 见
    //          main/deepLink.ts registerDeepLinkProtocol()。
    protocols: [
      // 双 scheme 注册:cindy:// 主 + xdt-maker:// 永久兼容(存量分享链接不死)。
      { name: 'Cindy Deep Link', schemes: [...allDeepLinkSchemes()] },
    ],
    // macOS 文件夹右键 "打开方式 → Cindy" 入口:
    //   声明 app 能接受 public.folder, Finder 自动把 Cindy 出现在 "打开方式" 列表。
    //   LSHandlerRank=Alternate: 不抢 Finder 默认 handler, 仅作为可选项之一。
    //   CFBundleTypeRole=Editor: 用户对该类型有 "打开+操作" 能力 (而非 Viewer 只看)。
    //   触发后 macOS 通过 app.on('open-file') 事件把目录路径推给 main 进程,
    //   main 端把它当作 --open-folder 同语义处理 (见 bootstrap-electron 中 open-file
    //   handler 注释,Windows 走 argv,macOS 走该事件,殊途同归)。
    //
    //   Windows / Linux 完全忽略此字段。
    extendInfo: {
      NSMicrophoneUsageDescription: 'This app needs access to the microphone for voice input.',
      // agent 会话中访问受 TCC 保护的目录(桌面/文稿/下载)时，macOS 需要这些声明才能向
      // 用户展示授权弹窗；缺失时系统直接静默拒绝，不弹窗。
      NSDesktopFolderUsageDescription:
        "Cindy's AI agent needs access to read and write files on your Desktop.",
      NSDocumentsFolderUsageDescription:
        "Cindy's AI agent needs access to read and write files in your Documents folder.",
      NSDownloadsFolderUsageDescription:
        "Cindy's AI agent needs access to read and write files in your Downloads folder.",
      // 智能通讯录导入: 经 osascript 向"通讯录"发 Apple Events(只读拉取)。
      // 缺这条声明 macOS 会不弹授权窗直接拒绝(-1743), 用户只看到静默失败。
      NSAppleEventsUsageDescription:
        'Cindy uses Apple Events to read Contacts you import and to add or update Contacts you explicitly export.',
      NSContactsUsageDescription:
        'Cindy accesses Contacts only when you import them or explicitly export additions or updates.',
      NSLocalNetworkUsageDescription:
        'Cindy uses your local network to sync end-to-end encrypted Smart Contacts directly between your online desktop devices.',
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Folder',
          CFBundleTypeRole: 'Editor',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.folder'],
        },
        // Cindy 卡带 (.cindy):Finder 双击 → open-file 事件 → 装入 + 停靠
        // (卡带系统;Windows 半边走注册表自注册,见 brain/fileAssociation.ts)。
        // LSItemContentTypes 指向下方 UTExportedTypeDeclarations 声明的自有 UTI
        // (UTI 里带扩展名 + MIME 映射);CFBundleTypeExtensions 保留作旧系统
        // 兜底(LSItemContentTypes 存在时会被忽略)。Owner 表示本 app 是该类型
        // 的归属方。⚠️ 仅打包生效,mac 真机轮验证。
        {
          CFBundleTypeName: 'Cindy Cartridge',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Owner',
          LSItemContentTypes: [`${CINDY_UTI_PREFIX}.cindy`],
          CFBundleTypeExtensions: ['cindy'],
        },
      ],
      // 自有文件格式的 UTI + MIME 声明:LaunchServices 扫到 app 后即在系统层
      // 登记「.cindy → application/x-xd-cindy」「.cshare → application/x-xd-cshare」
      // (MIME 未经 IANA 注册,按惯例走 x- 前缀)。.cshare(会话分享)只声明
      // 类型、不进 CFBundleDocumentTypes —— 双击导入链路尚未实现,先不认领
      // 打开行为;导入入口仍是拖入窗口 / 设置页按钮。
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: `${CINDY_UTI_PREFIX}.cindy`,
          UTTypeDescription: 'Cindy Cartridge',
          UTTypeConformsTo: ['public.data'],
          UTTypeTagSpecification: {
            'public.filename-extension': ['cindy'],
            'public.mime-type': ['application/x-xd-cindy'],
          },
        },
        {
          UTTypeIdentifier: `${CINDY_UTI_PREFIX}.cshare`,
          UTTypeDescription: 'Cindy Session Share',
          UTTypeConformsTo: ['public.data'],
          UTTypeTagSpecification: {
            'public.filename-extension': ['cshare'],
            'public.mime-type': ['application/x-xd-cshare'],
          },
        },
      ],
    },
    // Electron captures microphone input from renderer/helper processes, so the
    // helper bundles also need the usage description for macOS TCC to register
    // the packaged app correctly in Privacy & Security > Microphone.
    extendHelperInfo: {
      NSMicrophoneUsageDescription: 'This app needs access to the microphone for voice input.',
      NSDesktopFolderUsageDescription:
        "Cindy's AI agent needs access to read and write files on your Desktop.",
      NSDocumentsFolderUsageDescription:
        "Cindy's AI agent needs access to read and write files in your Documents folder.",
      NSDownloadsFolderUsageDescription:
        "Cindy's AI agent needs access to read and write files in your Downloads folder.",
    },
    // chat-data-localization F1：drizzle SQL migration 文件需要随包发出，
    // main 通过 process.resourcesPath/drizzle 读取。dev 模式 main 走源码路径，
    // packaged 模式由 process.resourcesPath 拼出。
    // cc-manager/ + anthropic-compat-proxy/ 这两个目录由 scripts/build-remote-bundles.mjs
    // 在 prepackage / prebuild hook 阶段填充 (bundle + stage)。它们 gitignore,
    // 不入仓 — 详见 build-remote-bundles.mjs 与 .gitignore 注释。两个目录里各放一个
    // self-contained ESM bundle (cc-mgr.mjs / proxy.mjs), 通过 SSH stdin pipe 部署
    // 到远端机器, desktop main 通过 process.resourcesPath 解析路径。
    extraResource: extraResourcesForTarget(requestedTargetPlatform()),
    // 注意：不要在这里手动设 `ignore`。@electron-forge/plugin-vite 会自动把
    // `ignore` 设成「除了 .vite/ 之外全部排除」——因为 Vite 打包产物都在
    // .vite/build 下。手动覆盖会让大量源码 / node_modules 误打进 release。
    // Version 由 release 脚本通过 APP_VERSION 环境变量注入,
    // 避免 Win/Mac release 都回写 package.json 引发 git 冲突。
    // 未设置时由 electron-packager 回落到 package.json 里的占位版本(仅 dev 用)。
    ...(process.env.APP_VERSION ? { appVersion: process.env.APP_VERSION } : {}),
    afterCopy: [
      (buildPath, electronVersion, platform, arch, callback) => {
        (async () => {
          try {
            bundleNativeDeps(buildPath, platform, arch);
            await rebuildNativeDepsInPackage(buildPath, electronVersion, arch);
            copySqliteVecBinary(buildPath, platform, arch);
            callback();
          } catch (err) {
            callback(err as Error);
          }
        })();
      },
    ],
  },
  rebuildConfig: {},
  hooks: {
    // Builds cindy-updater.exe before electron-packager copies resources/ into
    // the package — guarantees the shipped updater matches HEAD.
    prePackage: async (_forgeConfig, platform, arch) => {
      const targetPlatform = requestedTargetPlatform();
      const targetArch = requestedTargetArch();
      if (targetPlatform === 'win32') {
        buildCindyUpdater();
      }
      stageRipgrep(targetPlatform, targetArch);
      stageAndroidPlatformTools(targetPlatform, targetArch);
      buildMacVoiceInputTextInsertionHelper(platform, arch);
      buildMacVoiceInputModifierShortcutListener(platform, arch);
      buildMacAgentIslandHelper(platform, arch);
      buildMacComputerPermissionGuideHelper(platform, arch);
    },
    // packaged dir 产出后、makers 跑之前签内部 .exe。这样 NSIS 包出来的
    // Setup.exe 内嵌的、和 publish 阶段从同一 packagedDir 打的热更 ZIP 内嵌的，
    // 都是已签名版本。详见 signPackagedExes() 注释。
    postPackage: async (_forgeConfig, opts) => {
      for (const buildPath of opts.outputPaths) {
        const noticeName = stagePackagedThirdPartyNotices(buildPath, opts.platform);
        console.log(`[forge:postPackage] staged ${noticeName} + restricted component disclosure`);
        signPackagedExes(buildPath);
        applyMacPackagedDisplayName(buildPath, opts.platform);
      }
    },
  },
  makers,
  plugins: [
    // chat-data-localization F1：自动 unpack 任何 *.node 原生模块（better-sqlite3）
    // 使其在 packaged 应用中可以被 require()——asar 会阻止原生模块的 dlopen 调用。
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/localDb/worker/dbWorker.ts',
          config: 'vite.db-worker.config.ts',
          // 借用 preload target 的 CJS 单文件输出；这里运行时是 Node worker_threads，
          // 不是 Electron preload。
          target: 'preload',
        },
        {
          entry: 'src/main/im/wechat/silkWorker.ts',
          config: 'vite.silk-worker.config.ts',
          // SILK/WASM 解码隔离在线程中，避免阻塞 Electron main。
          target: 'preload',
        },
        {
          entry: 'src/main/contacts-sync/contactsSyncCodecWorker.ts',
          config: 'vite.contacts-sync-codec-worker.config.ts',
          // 大通讯录 JSON/gzip/crypto 隔离在线程中，避免阻塞 Electron main。
          target: 'preload',
        },
        {
          entry: 'src/main/mcp-integrations/forgeIconConversionProcess.ts',
          config: 'vite.forge-icon-conversion-process.config.ts',
          // Sharp/libvips 转换在一次性 utility process 中执行；超时可 kill，
          // 不把不可取消的 native 任务留在 Electron main。
          target: 'preload',
        },
        {
          entry: 'src/main/watcher-host/watcherHostProcess.ts',
          config: 'vite.watcher-host.config.ts',
          // 同 dbWorker:借 preload target 出 CJS 单文件；运行时是 Electron
          // utilityProcess（@parcel/watcher 的 native 崩溃隔离，见 watcher-host/）。
          target: 'preload',
        },
        {
          entry: 'src/main/workdir-probe-host/workdirProbeHostProcess.ts',
          config: 'vite.preload.config.ts',
          // UNC/SMB stat 不可取消；独立 utility process 超时后可直接终止，
          // 避免把挂死 I/O 留在 Electron main 的 libuv 线程池。
          target: 'preload',
        },
        {
          entry: 'src/main/cindy-brain/nodeRuntimeWorkerProcess.ts',
          config: 'vite.preload.config.ts',
          // 正式包关闭 RunAsNode fuse；随包插件改由 Electron utilityProcess
          // 承载。独立 CJS entry 与 main bundle 同目录，dev / packaged 同路径。
          target: 'preload',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // RSB 内置浏览器 webview 的 guest 注入层(页面评论 overlay)。由
          // main 的 webview hardener 在 will-attach-webview 时按
          // `path.join(__dirname, 'browserCommentPreload.js')` 强制注入,
          // renderer 端 `<webview preload>` 写什么都不认。
          entry: 'src/preload/browserCommentPreload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // 意识电子脑管子桥(离屏沙箱逻辑页专用;面板 webview 无 preload,
          // hardener 亦强制 delete。见 brain/runtime/electronSandboxAdapter)。
          entry: 'src/preload/ghostPreload.ts',
          config: 'vite.ghost-preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // FusesPlugin conflicts with VitePlugin on `start` command — only load for package/make
    ...(isDev ? [] : [
      new FusesPlugin({
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      }),
    ]),
  ],
};

export default config;
