// Entry: Electron startup → bootstrap-electron.ts (dynamic import).
import fixPath from 'fix-path';
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { exit, stderr } from 'node:process';
import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';
import { resolveRegionUserDataDirName } from './regionUserData.js';
import { createLogger, initLogger } from './logger.js';
import { beginDesktopDevInstance, type DesktopDevMode } from './devStartupStatus.js';
import { ensureSystemBinPathForMachineId } from './deviceId.js';

// 正式目录保持历史兼容：global 构建继续使用 CindyGlobal，cn 版继续使用
// productName 默认的 Cindy；dev 也按构建区域选择对应 profile。必须在
// initLogger()(packaged 日志目录)、crashReporter、单实例锁与一切 userData
// 读取之前完成区域映射。
const regionUserDataDirName = resolveRegionUserDataDirName({
  isPackaged: app.isPackaged,
  region: CURRENT_CINDY_REGION,
  argv: process.argv,
  envUserDataDir: process.env.XDT_USER_DATA_DIR,
});
if (regionUserDataDirName) {
  app.setPath('userData', path.join(app.getPath('appData'), regionUserDataDirName));
}

// Node happy-eyeballs(autoSelectFamily)默认每个地址只给 250ms 完成 TCP 握手,
// VPN/高 RTT 链路上直连海外端点(platform.claude.com 换 token、订阅模式模型流量等)
// 的合法握手常超过 250ms,所有地址族全被掐掉后 undici 只报一个裸 'fetch failed'。
// 与 voice-input/refinerHttpDispatcher.ts 的 per-pool 配置同值(2500ms),这里设
// 进程级默认值,兜住 main 里所有不走自建 dispatcher 的 fetch / net.connect。
setDefaultAutoSelectFamilyAttemptTimeout(2500);

initLogger();
const log = createLogger('fix-path');
log.debug(`[fix-path] before PATH=${process.env.PATH ?? ''}`);
fixPath();
log.debug(`[fix-path] after PATH=${process.env.PATH ?? ''}`);

// Guarantee /usr/sbin:/sbin are on PATH before anything resolves the device id.
// A Finder/Dock-launched GUI process inherits a minimal PATH without them, so
// node-machine-id's bare `ioreg` isn't found and machineIdSync() throws — which,
// read at authManager's module top, crashed the whole app on launch (0.1.14).
// Must run before bootstrap-electron (and thus authManager) is imported below.
ensureSystemBinPathForMachineId();

// !! 必须在 dispatch() 之前同步执行 !!
// 把用户系统(HKCU / shell rc)注入到本进程 process.env 上的 Anthropic / Claude Code
// 体系 env 全部清掉,避免泄漏到我们 spawn 的 CC CLI 子进程。
// 字段列表 + 原理见 maker-core/agents/claude-code/env-builder.ts 里的
// SENSITIVE_ANTHROPIC_ENV_KEYS 注释。
//
// 这里同步 import 不走动态 import,确保 strip 在任何 module top-level 代码读
// process.env 之前执行。
import { stripSensitiveAnthropicEnv } from '@cindy/maker-core';

// device-link 远程控制:必须在任何 ipcMain.handle 调用之前 monkey-patch,
// 才能捕获到全量 channel → handler 映射(供被控端 dispatch 远程 invoke)。
// import 在 ESM 里被 hoist,patch 在 bootstrap-electron 动态 import(其内部注册
// 所有 handler)之前完成。
import { installInvokeCapture } from './device-link/invoke-registry.js';

const stripped = stripSensitiveAnthropicEnv();
if (stripped.length > 0) {
  stderr.write(`[cindy] stripped user-level Anthropic env: ${stripped.join(', ')}\n`);
}

installInvokeCapture();

// dev-only 启动覆写(与 scripts/restart-desktop-remote.mjs 的 --passive/--isolated
// 同义,人类直跑 pnpm dev:desktop* 时参数经 electron-forge 的 `--` 透传到这里,
// restart 脚本路径经 XDT_ISOLATED=1 环境变量声明隔离意图):
//   - XDT_USER_DATA_DIR / --isolated:userData 切独立目录 —— 多实例不抢 SQLite 锁
//     (device-link 联调)、或与正式版彻底分家(--isolated 默认 <userData>-dev2)。
//   - 隔离模式同时派生独立 deviceId(dev-<机器指纹>):服务端 refresh token 按
//     (user, device) 一对一存,沙箱沿用物理机指纹登录会覆盖正式版的续期凭证,
//     导致正式版下次续期被登出(同机互踢);显式设 XDT_DEVICE_ID_OVERRIDE 时尊重用户值。
//   - --passive / XDT_SCHEDULER_PASSIVE:定时任务自动触发让位给同机另一实例。
// 必须在 app 'ready' 前调用。仅 dev(非 packaged)生效,生产忽略,零线上影响。
import { machineIdSync } from 'node-machine-id';
import {
  resolveDevCliFlags,
  shouldEnforcePassiveMigrationCompatibility,
} from './devCliFlags.js';
import {
  KEYCHAIN_IDENTITY_MARKER_FILE,
  resolveDevKeychainDecision,
} from './devKeychainName.js';
import { createKeychainMarkerIo } from './devKeychainMarkerIo.js';

const devFlags = resolveDevCliFlags({
  argv: process.argv,
  isPackaged: app.isPackaged,
  envUserDataDir: process.env.XDT_USER_DATA_DIR,
  defaultUserDataDir: app.getPath('userData'),
  appDataDir: app.getPath('appData'),
  envIsolated: process.env.XDT_ISOLATED,
  envIsolationName: process.env.XDT_ISOLATED_NAME,
  envUserDataDirEpoch: process.env.XDT_USER_DATA_DIR_EPOCH,
  envDeviceIdOverride: process.env.XDT_DEVICE_ID_OVERRIDE,
  envSchedulerPassive: process.env.XDT_SCHEDULER_PASSIVE,
  envEndpointsCdn: process.env.XDT_ENDPOINTS_CDN,
});
if (devFlags.isolatedOnProductionProfile) {
  // isolated 身份会换独立 deviceId；正式 profile 上的 refresh token 属于正式版设备。
  // 两者叠在同一目录 = 必然 DEVICE_MISMATCH，再删盘会把正式版踢下线(2026-08-16)。
  // 报实际目标目录：可能是当前区域，也可能是另一地区的正式 profile。
  const targetDir = devFlags.userDataDirOverride ?? app.getPath('userData');
  stderr.write(
    `[cindy] FATAL: --isolated cannot use the official Cindy profile (${targetDir}). ` +
      'Use the default sandbox, --isolated=<name>, or a directory that is not an official userData.\n',
  );
  exit(1);
}
if (!app.isPackaged && devFlags.profileKind === 'production-shared') {
  // 正式 profile 上的 unpackaged writer 不得应用 pending migration。
  // 已合入 main、但安装包还没带上的序号会把安装版打挂（2026-08-16 schema 91）。
  process.env.XDT_OFFICIAL_SHARED_PROFILE = '1';
} else {
  delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
}
if (devFlags.schedulerPassive) {
  // 统一收敛到 env:scheduler-host 只认 XDT_SCHEDULER_PASSIVE,不重复解析 argv。
  process.env.XDT_SCHEDULER_PASSIVE = '1';
  stderr.write('[cindy] dev scheduler passive mode (--passive)\n');
}
if (shouldEnforcePassiveMigrationCompatibility({
  isPackaged: app.isPackaged,
  schedulerPassive: devFlags.schedulerPassive,
  profileKind: devFlags.profileKind,
})) {
  // 内部启动契约：共享 userData 的 passive dev 只能打开与当前 checkout migration
  // 完全一致的数据库，且不得自行迁移。localDb 在用户数据库首次打开时消费本标记。
  process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
} else {
  // 防止 shell 中同名 ambient env 污染 packaged / isolated 启动语义。
  delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
}
if (devFlags.endpointsCdn) {
  // 统一收敛到 env:clientEndpointsService 只认 XDT_ENDPOINTS_CDN,不重复解析 argv。
  process.env.XDT_ENDPOINTS_CDN = '1';
  stderr.write('[cindy] dev endpoints via CDN (--endpoints-cdn)\n');
}
if (devFlags.userDataDirOverride) {
  // 同步回 env,让读 env 的下游(日志、诊断)与实际生效目录一致。
  process.env.XDT_USER_DATA_DIR = devFlags.userDataDirOverride;
  app.setPath('userData', devFlags.userDataDirOverride);
  stderr.write(`[cindy] dev userData override → ${devFlags.userDataDirOverride}\n`);
  // 隔离 dev 独立钥匙串条目(#871 候选 B 收窄):userData 已在上一行显式 pin,
  // 改名只影响 safeStorage 服务名(`<app.name> Safe Storage`)与 dev-only 派生
  // 路径(crashDumps 等),不改数据目录。身份由 profile 标记文件粘住并原子认领;
  // 标记不可读/内容不可识别 = 身份不确定 → 拒绝启动(静默回退默认身份会用错
  // 钥匙覆盖既有密文)。决策全逻辑与边界见 devKeychainName.ts。
  const keychainMarkerPath = path.join(devFlags.userDataDirOverride, KEYCHAIN_IDENTITY_MARKER_FILE);
  const keychainDecision = resolveDevKeychainDecision({
    isPackaged: app.isPackaged,
    // CindyDev 身份只在「显式隔离 + 纪元派生目录」下认领;其余覆写形态(裸覆写 /
    // 指向非纪元目录的隔离启动)走观察模式——不认领,但目录已带标记时依标记运行,
    // 防同一目录被不同启动形态以两种身份轮流打开(review 反馈 P1 第十二/十四轮)。
    isolated: devFlags.isolated && devFlags.isolatedDirIsEpochDerived,
    hasDirOverride: true,
    // 真实文件系统 IO 抽在 devKeychainMarkerIo.ts(可导出工厂 + mkdtemp 集成
    // 测试;review 反馈 P1:手写 crash-consistency 协议不能只靠人工审查防回归)。
    io: createKeychainMarkerIo({
      markerPath: keychainMarkerPath,
      profileDir: devFlags.userDataDirOverride,
    }),
  });
  if (keychainDecision.kind === 'abort') {
    stderr.write(
      `[cindy] FATAL: 沙箱钥匙串身份不确定(${keychainDecision.reason});` +
        `为避免用错误主密钥覆盖沙箱既有密文,拒绝启动。\n` +
        `  标记文件: ${keychainMarkerPath}\n` +
        `  处置: 若确认该沙箱从未用过 CindyDev 身份,删除该标记文件后重启` +
        `(或将内容修复为 "Cindy",须以换行结尾);若沙箱曾以 CindyDev 运行,` +
        `修复其内容为 "CindyDev"(同样以换行结尾)。修复须在退出所有 Cindy dev` +
        `实例后进行,并用原子替换(先写临时文件再 mv 覆盖),不要原地截断重写。\n` +
        `  警告: 不要把旧版本 checkout 显式指向 -dev2 沙箱目录` +
        `(XDT_USER_DATA_DIR)——旧代码不认身份标记,会以默认身份写入并` +
        `损坏该沙箱的密文(已知残余风险,见 PR #912 描述)。\n`,
    );
    exit(1);
  }
  if (keychainDecision.kind === 'rename') {
    app.setName(keychainDecision.appName);
    stderr.write(`[cindy] dev keychain isolation → app.name=${keychainDecision.appName}\n`);
  }
}
if (devFlags.invalidIsolationName !== null) {
  // 名字不合法(字符集 / 长度)→ 已按默认沙箱处理(回落到不隔离会混进正式版
  // 数据,更危险),这里只大声警告,让用户发现自己起错了名字。
  stderr.write(
    `[cindy] WARN: invalid --isolated name "${devFlags.invalidIsolationName}"` +
      ' (allowed: A-Za-z0-9_-, max 32 chars); falling back to the DEFAULT sandbox\n',
  );
}
if (devFlags.needsIsolatedDeviceId) {
  // 必须在 authManager 模块加载(bootstrap 动态 import)之前落到 env——它在模块
  // 顶层读一次 XDT_DEVICE_ID_OVERRIDE ?? machineIdSync()。机器指纹极小概率取不到
  // (machineIdSync 抛),兜底用固定串:跨机器同账号双沙箱会撞,但比静默回落物理机
  // 指纹(必踢正式版)安全方向正确。
  // 长度硬预算 64:server 端 Slack 设备注册的 deviceId 白名单上限 64 字符
  // (apps/server/src/routes/slack.ts),超长会被静默降级成 legacy 伪设备。
  // 默认沙箱 'dev-' + 60 位指纹 = 64;命名沙箱 'dev-<名字>-' + 剩余预算的指纹
  // (名字 ≤32 → 指纹 ≥27 位 = 108 bit 熵,唯一性依然充裕)。
  const nameSegment = devFlags.isolationName ? `${devFlags.isolationName}-` : '';
  let isolatedDeviceId: string;
  try {
    const hashBudget = 60 - nameSegment.length; // 'dev-'(4) + nameSegment + hash = 64
    isolatedDeviceId = `dev-${nameSegment}${machineIdSync().slice(0, hashBudget)}`;
  } catch {
    isolatedDeviceId = `isolated-dev${devFlags.isolationName ? `-${devFlags.isolationName}` : ''}`;
  }
  process.env.XDT_DEVICE_ID_OVERRIDE = isolatedDeviceId;
  stderr.write(`[cindy] dev isolated deviceId → ${isolatedDeviceId}\n`);
}

// 实例注册表对 dev 与 packaged 一律登记:dev/release 按 flavor 分锁域、共享同一
// userData 双开是受支持的工作流(bootstrap-electron 单例锁注释),owner-namespace
// 迁移的独占检查靠本注册表发现「还有谁共享这份 userData」——packaged 不登记的话,
// dev 实例会在 release 实例仍存活时误判独占并搬走 legacy 配置。
{
  const rootDir = app.isPackaged
    ? path.resolve(app.getAppPath())
    : path.resolve(app.getAppPath(), '..', '..');
  let commit: string | null = null;
  if (!app.isPackaged) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      // Source provenance remains useful without a commit in exported/unusual checkouts.
    }
  }
  const declaredMode = process.env.XDT_DESKTOP_DEV_MODE;
  const mode: DesktopDevMode = declaredMode === 'remote' || declaredMode === 'local'
    ? declaredMode
    : 'unknown';
  const cleanupDevInstance = beginDesktopDevInstance({
    userDataDir: app.getPath('userData'),
    rootDir,
    commit,
    mode,
    region: CURRENT_CINDY_REGION,
    passive: devFlags.schedulerPassive,
    isolated: devFlags.profileKind === 'isolated-sandbox',
    isolationIntent: devFlags.isolated,
    profileKind: devFlags.profileKind,
  });
  app.once('will-quit', cleanupDevInstance);
}

async function dispatch(): Promise<void> {
  const mod = await import('./bootstrap-electron.js');
  await mod.bootstrapElectron();
}

dispatch().catch((err) => {
  stderr.write(`[cindy] fatal: ${(err as Error).stack ?? err}\n`);
  exit(1);
});
