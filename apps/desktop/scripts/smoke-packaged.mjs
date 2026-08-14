#!/usr/bin/env node

/**
 * smoke-packaged.mjs — 打包产物的端到端 smoke 测试（release 后置验收）。
 *
 * 启动 packaged Electron exe，加上 `--smoke-test` flag：main 进程在 `app.on('ready')`
 * 里走 short-circuit 分支，跑 `ensureReady(fakeUserId)`、查 `schema_version` + 三张核心表
 * 的行数，把结果 JSON 输出到 stdout 后 `app.quit()`。
 *
 * 用法：
 *   node scripts/smoke-packaged.mjs --platform=win32 --arch=x64
 *   node scripts/smoke-packaged.mjs --platform=darwin --arch=arm64
 *   node scripts/smoke-packaged.mjs --platform=darwin --arch=x64 --out-dir=custom/path
 *
 * 验收标准：
 *   - 子进程 60s 内正常退出（exit code = 0）
 *   - stdout 的 JSON 能解析且 `ok: true`
 *   - `schema_version >= 0`
 *   - `tables.sessions / tables.messages / tables.migration_meta` 三个 count 都 ≥ 0
 *
 * 任一失败 → 打印诊断并 exit(1)；成功 → 打印 `✅ smoke test passed`。
 *
 * 退出前清理临时 userData 目录（不留垃圾）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, '..');

/**
 * electron-forge 打包产物基名默认值(out 目录 / exe / .app / linux 二进制同名)。
 * ⚠️ 值必须与 packages/maker-shared/src/brandIdentity.ts 的
 * BRAND_IDENTITY.executableName 及 ci/lib.mjs 的 PACKAGED_APP_NAME 一致
 * (本脚本刻意零外部依赖,不 import lib.mjs;一致性由
 * scripts/__tests__/brand-identity-sync.test.mjs 断言兜底)。
 * 区域化:产物基名按区域派生(cn/global 'Cindy' / dev 'CindyDev'),由调用方
 * (ci/lib.mjs runSmokeTest)经 --app-name= 传入覆盖,本默认值服务 global / 手跑。
 */
const PACKAGED_APP_NAME = 'Cindy';

// ── Arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  /** @type {Record<string, string>} */
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  const platform = out.platform || process.platform;
  const arch = out.arch || process.arch;
  const outDir = out['out-dir'] || null;
  const appName = out['app-name'] || PACKAGED_APP_NAME;
  const pluginStorage = args.includes('--plugin-storage');
  return { platform, arch, outDir, appName, pluginStorage };
}

const { platform, arch, outDir, appName, pluginStorage } = parseArgs();

if (!['win32', 'darwin', 'linux'].includes(platform)) {
  console.error(`[smoke] ERROR: unsupported --platform=${platform}`);
  process.exit(1);
}
if (!['x64', 'arm64'].includes(arch)) {
  console.error(`[smoke] ERROR: unsupported --arch=${arch}`);
  process.exit(1);
}

console.log(`[smoke] platform=${platform} arch=${arch}`);

// ── Locate packaged executable ───────────────────────────────────────────

/**
 * electron-forge 把 packaged 应用放在 `out/<PACKAGED_APP_NAME>-<platform>-<arch>/`。
 * 入口 exe 位置：
 *   - Windows: <packaged>/<PACKAGED_APP_NAME>.exe
 *   - macOS:   <packaged>/<PACKAGED_APP_NAME>.app/Contents/MacOS/<PACKAGED_APP_NAME>
 *   - Linux:   <packaged>/<PACKAGED_APP_NAME>
 */
function resolveExePath() {
  const baseDir = outDir
    ? path.resolve(outDir)
    : path.join(DESKTOP_ROOT, 'out', `${appName}-${platform}-${arch}`);
  if (!fs.existsSync(baseDir)) {
    console.error(`[smoke] ERROR: packaged dir not found: ${baseDir}`);
    console.error(`[smoke]        run 'pnpm --filter ./apps/desktop package' first, or pass --out-dir=<path>`);
    process.exit(1);
  }
  if (platform === 'win32') {
    const exe = path.join(baseDir, `${appName}.exe`);
    if (!fs.existsSync(exe)) {
      console.error(`[smoke] ERROR: ${appName}.exe not found under ${baseDir}`);
      process.exit(1);
    }
    return exe;
  }
  if (platform === 'darwin') {
    const exe = path.join(baseDir, `${appName}.app`, 'Contents', 'MacOS', appName);
    if (!fs.existsSync(exe)) {
      console.error(`[smoke] ERROR: ${appName} binary not found at ${exe}`);
      process.exit(1);
    }
    return exe;
  }
  // linux
  const exe = path.join(baseDir, appName);
  if (!fs.existsSync(exe)) {
    console.error(`[smoke] ERROR: ${appName} binary not found at ${exe}`);
    process.exit(1);
  }
  return exe;
}

const exePath = resolveExePath();
console.log(`[smoke] exe: ${exePath}`);

// ARM64 macOS host 上无法通过 Rosetta 可靠运行 x64 Electron（Chromium 131+ SIGILL）。
// 跳过前验证：产物存在（resolveExePath）+ 可执行 + 确实是 x86_64 Mach-O。
// 用 sysctl hw.optional.arm64 检测物理 CPU（即使当前进程跑在 Rosetta 下也返回 1）。
if (platform === 'darwin' && arch === 'x64') {
  let isPhysicalArm64 = false;
  try {
    isPhysicalArm64 = execSync('sysctl -in hw.optional.arm64', { encoding: 'utf-8' }).trim() === '1';
  } catch { /* sysctl 失败（如 Intel Mac unknown oid）→ 不是 ARM64，继续正常 smoke */ }

  if (isPhysicalArm64) {
    try {
      fs.accessSync(exePath, fs.constants.X_OK);
      const archInfo = execFileSync('lipo', ['-archs', exePath], { encoding: 'utf-8' }).trim();
      if (!archInfo.includes('x86_64')) {
        console.error(`[smoke] FAIL: expected x86_64 binary but got: ${archInfo}`);
        process.exit(1);
      }
      console.log(`[smoke] SKIP: x64 Electron launch on arm64 host (binary verified: ${archInfo})`);
      console.log('✅ smoke test skipped (packaged x86_64 binary verified)');
      process.exit(0);
    } catch (err) {
      console.error(`[smoke] FAIL: binary verification failed: ${err.message}`);
      process.exit(1);
    }
  }
}

// ── Temp userData dir ────────────────────────────────────────────────────

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-smoke-'));
console.log(`[smoke] userData: ${tmpUserData}`);

function cleanupUserData() {
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[smoke] WARN: cleanup ${tmpUserData} failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Spawn & capture ──────────────────────────────────────────────────────

const SMOKE_USER = '__smoke_test__';
const TIMEOUT_MS = 60_000;

const child = spawn(
  exePath,
  [
    '--smoke-test',
    `--smoke-user=${SMOKE_USER}`,
    ...(pluginStorage ? ['--smoke-plugin-storage'] : []),
    `--user-data-dir=${tmpUserData}`,
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 禁用自动更新 / Windows Squirrel startup 钩子（smoke 跑的是已安装的 exe，
      // 但为了稳妥这里也显式清掉会影响启动的环境变量）
      ELECTRON_DISABLE_SANDBOX: '1',
    },
  },
);

let stdoutBuf = '';
let stderrBuf = '';

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString();
});

const timeoutHandle = setTimeout(() => {
  console.error(`[smoke] ERROR: timeout after ${TIMEOUT_MS}ms, killing process`);
  try { child.kill('SIGKILL'); } catch { /* noop */ }
}, TIMEOUT_MS);

child.on('exit', (code, signal) => {
  clearTimeout(timeoutHandle);
  const exitLabel = signal ? `signal=${signal}` : `code=${code}`;
  console.log(`[smoke] child exited: ${exitLabel}`);

  if (stderrBuf.trim()) {
    console.log('[smoke] --- stderr ---');
    console.log(stderrBuf.trim());
    console.log('[smoke] ---');
  }
  if (stdoutBuf.trim()) {
    console.log('[smoke] --- stdout ---');
    console.log(stdoutBuf.trim());
    console.log('[smoke] ---');
  }

  // 解析最后一行 JSON（stdout 可能夹杂 Electron / Chromium 的预热日志）
  const jsonLine = extractJsonLine(stdoutBuf) || extractJsonLine(stderrBuf);
  if (!jsonLine) {
    console.error('[smoke] FAIL: no JSON result line found in stdout/stderr');
    cleanupUserData();
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonLine);
  } catch (err) {
    console.error(`[smoke] FAIL: JSON parse error: ${err instanceof Error ? err.message : err}`);
    console.error(`[smoke]       line: ${jsonLine}`);
    cleanupUserData();
    process.exit(1);
  }

  // 验收
  if (parsed.ok !== true) {
    console.error(`[smoke] FAIL: main reported ok=false, error=${parsed.error || '(none)'}`);
    cleanupUserData();
    process.exit(1);
  }
  if (typeof parsed.schema_version !== 'number' || parsed.schema_version < 0) {
    console.error(`[smoke] FAIL: schema_version invalid: ${parsed.schema_version}`);
    cleanupUserData();
    process.exit(1);
  }
  const t = parsed.tables || {};
  for (const key of ['sessions', 'messages', 'migration_meta']) {
    const v = t[key];
    if (typeof v !== 'number' || v < 0) {
      console.error(`[smoke] FAIL: tables.${key} invalid: ${v}`);
      cleanupUserData();
      process.exit(1);
    }
  }
  if (pluginStorage) {
    const storage = parsed.plugin_storage || {};
    if (storage.ownerGhostFound !== true) {
      console.error('[smoke] FAIL: owner Plugin was not found after signed-out startup recovery');
      cleanupUserData();
      process.exit(1);
    }
    if (storage.ledgerInstalledAfterEmptySnapshot !== true) {
      console.error('[smoke] FAIL: passive empty snapshot changed installed ledger state');
      cleanupUserData();
      process.exit(1);
    }
    if (storage.optOutAfterEmptySnapshot !== false) {
      console.error('[smoke] FAIL: passive empty snapshot wrote a default-install opt-out');
      cleanupUserData();
      process.exit(1);
    }
  }
  if (code !== 0) {
    console.error(`[smoke] FAIL: child exit code ${code} (expected 0)`);
    cleanupUserData();
    process.exit(1);
  }

  console.log(
    `✅ smoke test passed: schema_version=${parsed.schema_version}, ` +
      `sessions=${t.sessions}, messages=${t.messages}, migration_meta=${t.migration_meta}` +
      (pluginStorage ? ', plugin_storage=passed' : ''),
  );
  cleanupUserData();
  process.exit(0);
});

child.on('error', (err) => {
  clearTimeout(timeoutHandle);
  console.error(`[smoke] FAIL: spawn error: ${err.message}`);
  cleanupUserData();
  process.exit(1);
});

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * 从混合输出中挑出最后一行以 `{` 开头 `}` 结尾的 JSON 行。
 * @param {string} buf
 * @returns {string | null}
 */
function extractJsonLine(buf) {
  const lines = buf.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith('{') && line.endsWith('}')) {
      return line;
    }
  }
  return null;
}
