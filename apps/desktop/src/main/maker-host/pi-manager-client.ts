/**
 * pi-manager host-side client — desktop 侧连远端 pi-manager daemon。
 *
 * 职责:
 *  1. resolvePiManagerBundlePath — 定位本地打包的 pi-manager.mjs(dev/packaged)
 *  2. ensurePiManagerInstalled — probe + 版本比对 + 上传 bundle + 确保 daemon 跑
 *  3. withPiManagerRpc — 开 ssh bridge execStream → RpcClient → hello → 调回调
 *
 * RPC 通道:每次操作开一条临时 ssh execStream,跑 `node pi-manager.mjs bridge
 * --socket <mgrSock>` 把 manager 的 unix socket 桥回本地 stdin/stdout,在上面
 * 跑 NDJSON RPC。频率低(每会话 start 一次 ensure / end 一次 kill),临时通道
 * 简单可靠,不需要长驻连接管理。
 *
 * 结构对齐 cc-manager-client.ts 的 bridgeStreamToDuplex 模式(平行实现,
 * 不 import cc-manager 代码)。
 */

import { Duplex } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { shellQuote, redactCredentialText } from './pi-remote-transport.js';

import {
  RpcClient,
  PI_MANAGER_BUNDLE_VERSION,
  METHODS,
  type PiEnsureParams,
  type PiEnsureResult,
  type PiListResult,
  PROTOCOL_VERSION,
} from '@cindy/maker-pi-manager';
import {
  installPiManagerBundle,
  probePiManager,
  ensurePiManagerDaemon,
  tailDaemonLog,
  BUNDLED_NODE_INSTALL_SH,
  BUNDLED_NODE_VERSION,
  type RemoteHost,
  type ExecStreamHandle,
  type PiManagerInstallEventCallback,
} from '@cindy/maker-remote-ssh';
import { setPendingPiUpgrade, clearPendingUpgrade } from '../remote-ssh/cc-manager-install.js';

interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/** 本地打包的 pi-manager.mjs 路径(dev 源码 dist 或 packaged resources)。 */
export function resolvePiManagerBundlePath(): string {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, '..', '..', 'packages', 'maker-pi-manager', 'dist', 'pi-manager.mjs'),
    // 轮 7 LOW-3:resourcesPath undefined(dev 模式)时 ?? '' 会拼出相对路径
    // 以 CWD 为基准查找, 永不命中还误导 —— 只在有值时加入。
    ...(process.resourcesPath
      ? [path.join(process.resourcesPath, 'pi-manager', 'pi-manager.mjs')]
      : []),
    path.join(`${appPath}.unpacked`, 'packages', 'maker-pi-manager', 'dist', 'pi-manager.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `pi-manager.mjs bundle not found in any of: ${candidates.join(' | ')} — ` +
      'packaging needs to ship packages/maker-pi-manager/dist/pi-manager.mjs as extraResource',
  );
}

/** per-host in-flight dedup(轮 12 MEDIUM-3):preflight 与 transport 创建并发
 *  时只跑一次 probe/install/kill, 防并发 cat > 双写同一 bundle。 */
const piManagerInstallInFlight = new Map<string, Promise<void>>();

/**
 * 确保远端 pi-manager bundle 装好且 daemon 在跑。幂等:
 *  - probe:node ready? bundle 装了吗?版本匹配吗?
 *  - 缺失或版本不符 → 上传 bundle(本地打包的 pi-manager.mjs)
 *  - 再 ensure daemon 进程(socket/pidfile 探活,未跑则 self-detach spawn)
 *
 * onEvent(轮 15 缺口 6):转发 installPiManagerBundle 的进度事件, 调用方可
 * 接入 silent install toast(renderer 状态机已支持 pi)。
 */
export function ensurePiManagerInstalled(
  host: RemoteHost,
  logger: Logger,
  onEvent?: PiManagerInstallEventCallback,
): Promise<void> {
  const key = host.id;
  const inFlight = piManagerInstallInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = ensurePiManagerInstalledInner(host, logger, onEvent)
    .finally(() => piManagerInstallInFlight.delete(key));
  piManagerInstallInFlight.set(key, promise);
  return promise;
}

/** @internal test helper: reset per-host dedup map between test cases. */
export function resetPiManagerInstallInFlight(): void {
  piManagerInstallInFlight.clear();
}

/**
 * 轮 22(对齐 cc-mgr runCcMgrUpgrade):用户点 UpgradeBanner「立即升级」→ 强制
 * 升级 pi-manager —— kill 旧 daemon(中断 alive pi 会话, 用户已确认)+ 强制
 * 重传 bundle + 重启 daemon。
 *
 * 与 ensurePiManagerInstalled 的 defer 不同:这里显式 kill + 置 versionMatch
 * 为不匹配(通过清 piManagerInstallInFlight + 传 forceReinstall 语义)。
 * 实现:kill daemon → 走完整 ensurePiManagerInstalled(此时 probe 发现无 daemon
 * 或版本不匹配 → 自动重装新 bundle)→ ensurePiManagerDaemon spawn 新 daemon。
 */
export async function runPiManagerUpgrade(host: RemoteHost, logger: Logger): Promise<void> {
  logger.info('pi-manager force upgrade: killing daemon', { hostId: host.id });
  await killRemotePiManagerDaemon(host);
  // 清 in-flight 去重(防并发 ensure 复用旧的 promise 短路跳过重装)。
  piManagerInstallInFlight.delete(host.id);
  await ensurePiManagerInstalled(host, logger);
  // 轮 22-F2 HIGH:升级成功后清 pending + 广播 available:null —— 否则 banner
  // 仍挂着, 用户可能重复点升级再触发 kill+reinstall。
  clearPendingUpgrade(host.id, 'pi');
}

async function ensurePiManagerInstalledInner(
  host: RemoteHost,
  logger: Logger,
  onEvent?: PiManagerInstallEventCallback,
): Promise<void> {
  let probe = await probePiManager(host);
  // 临时诊断(排查 remoteVersion:null / LAZY_CREATE_FAILED):probe 原始结果。
  logger.info('pi-manager probe debug', {
    hostId: host.id,
    nodeReady: probe.nodeReady,
    installed: probe.piManagerInstalled,
    version: probe.piManagerVersion,
    protocol: probe.piManagerProtocolVersion,
    binaryPath: probe.piManagerBinaryPath,
    sockPath: probe.piManagerSockPath,
  });
  if (!probe.nodeReady) {
    // 轮 22(pi 独立化):bundled node 缺失不再引导用户去装 CC/CX —— 首次创建
    // Pi 任务时**自动**安装 bundled node(与 CC 的 silent-install 同体验:
    // 第一次发消息自动装好一切)。BUNDLED_NODE_INSTALL_SH 与 CC/CX 安装链
    // 同源(同一 ~/.xdt-server/<ver>/node/, 幂等不重复下载)。失败才抛错。
    logger.info('pi-manager: bundled node missing on remote — auto-installing', {
      hostId: host.id,
      nodeVersion: BUNDLED_NODE_VERSION,
    });
    onEvent?.({ kind: 'install-log', line: `installing Node.js ${BUNDLED_NODE_VERSION} (bundled runtime for pi-manager)` });
    const nodeResult = await host.exec(
      `bash -c ${shellQuote(BUNDLED_NODE_INSTALL_SH)}`,
      {
        timeoutMs: 300_000,
        label: 'pi-manager-node-install',
      },
    );
    if (nodeResult.exitCode !== 0) {
      throw new Error(
        `remote Node.js install failed (exit ${nodeResult.exitCode}): ${nodeResult.stderr.trim().slice(0, 200) || nodeResult.stdout.trim().slice(0, 200)}`,
      );
    }
    // 重 probe(node 已就绪, piManager 可能仍未装 → 走下方安装)。
    probe = await probePiManager(host);
    if (!probe.nodeReady) {
      throw new Error('remote Node.js install completed but bundled node still not runnable');
    }
    onEvent?.({ kind: 'install-log', line: 'Node.js runtime ready on remote' });
  }
  let versionMatch = probe.piManagerInstalled
    // 版本比对容忍 v 前缀(与 pi 二进制 probe 的 V_LAST 策略对齐 —— 自审轮 4 M-3)。
    && ((probe.piManagerVersion ?? '').replace(/^v/, '') === PI_MANAGER_BUNDLE_VERSION.replace(/^v/, ''));
  // 协议不兼容(退役审轮 10 CRITICAL):daemon 是旧协议, 新 desktop 的 hello 必失败
  // —— 必须强制 kill 旧 daemon(对齐 cc-mgr 的「协议不兼容 pkill」模式), 否则
  // 会话创建永远失败且无自动恢复。即使 bundle 版本匹配(旧 daemon 内存态跑旧
  // bundle 但磁盘已被覆盖), 协议检查也要兜底。
  const protocolCompatible = probe.piManagerInstalled
    && probe.piManagerProtocolVersion === PROTOCOL_VERSION;
  if (probe.piManagerInstalled && !protocolCompatible) {
    logger.warn('pi-manager protocol mismatch — forcing daemon restart + reinstall', {
      hostId: host.id,
      remoteProtocol: probe.piManagerProtocolVersion,
      localProtocol: PROTOCOL_VERSION,
    });
    await killRemotePiManagerDaemon(host);
    // 轮 7 HIGH:协议不兼容必须连带强制重装 bundle —— 否则版本匹配(versionMatch
    // true)但协议不匹配时, 杀 daemon 后 ensurePiManagerDaemon 会重新 spawn 磁盘
    // 上同一份(协议异常的)bundle, 下次连接又检测到不兼容, 死循环。
    // 置 versionMatch=false 强制走 install(不递归 —— 本地 bundle 协议本身
    // 与 PROTOCOL_VERSION 不同步时, 递归会无限重装; 置 false 只重装一次,
    // 下次调用仍不兼容则由日志暴露构建 bug)。
    versionMatch = false;
  } else if (probe.piManagerInstalled && !versionMatch) {
    // 轮 22(对齐 cc-manager-install 的「daemon alive → 不打扰」语义):bundle
    // 版本差但协议兼容时, 不 kill 旧 daemon —— 升级要重启 daemon, 会中断
    // 正在跑的 alive session。分两种情况:
    //   (a) daemon 活着(pidfile + ps 确认是 pi-manager 进程)→ 跳过升级,
    //       磁盘 bundle 保持旧版; 下次 daemon 死后(空闲回收/手动重启/崩溃)
    //       再走 install 静默升级。alive session 不被打扰。
    //   (b) daemon 没在跑(磁盘只有旧 bundle, 无活进程)→ fall through 走
    //       install pipeline 静默升级磁盘 bundle; 后续 ensurePiManagerDaemon
    //       spawn 自然加载新 bundle, 没有 alive session 要保护。
    // 注: 与 cc-mgr 的 UpgradeBanner 不同, pi MVP 无 banner —— 跳过升级是
    // 静默的(留 info 日志), 用户下次主动重连/重建时会感知到新版本生效。
    const daemonAlive = await checkPiManagerDaemonAlive(host, probe.installDir);
    if (daemonAlive) {
      // 轮 22(对齐 cc-manager-install 的「daemon alive → 不打扰」):版本差但
      // daemon 活着, 跳过升级(磁盘 bundle 保持旧版, alive session 不被打扰)。
      // 注意:**不 return** —— 继续走下方 ensurePiManagerDaemon, 它的 fast
      // path 有完整在线校验(socket 可连 + pidfile + protocol hello, 轮 40-w4-t3)。
      // 若 alive-check 是伪正例(daemon 退出窗口/pid reuse/socket 未就绪),
      // ensurePiManagerDaemon 会判定 DEAD → 重新 spawn 恢复, 而不是让调用方
      // 直接连一个不可用的 daemon 失败(轮 22-Z1 HIGH)。
      logger.info('pi-manager bundle version mismatch + daemon alive — deferring bundle upgrade (alive sessions protected)', {
        hostId: host.id,
        remoteVersion: probe.piManagerVersion,
        localVersion: PI_MANAGER_BUNDLE_VERSION,
      });
      // 轮 22(对齐 cc-mgr):记 pending + 触发 UpgradeBanner, 让用户主动选时机
      // 升级(点「立即升级」→ runPiManagerUpgrade kill + 重装)。不 kill alive
      // daemon, alive session 不被打扰。
      setPendingPiUpgrade(host.id, probe.piManagerVersion ?? 'unknown', PI_MANAGER_BUNDLE_VERSION);
      versionMatch = true; // 跳过 install, 但仍走 ensurePiManagerDaemon 在线校验
    } else {
      logger.info('pi-manager bundle version mismatch + no live daemon — silently upgrading disk bundle', {
        hostId: host.id,
        remoteVersion: probe.piManagerVersion,
        localVersion: PI_MANAGER_BUNDLE_VERSION,
      });
      // fall through → 置 versionMatch=false 强制走 install(daemon 死后静默
      // 升级磁盘 bundle; 下次 ensurePiManagerDaemon spawn 自然加载新 bundle)。
      versionMatch = false;
    }
  }
  if (!versionMatch) {
    logger.info('pi-manager bundle missing or stale — installing', {
      hostId: host.id,
      remoteVersion: probe.piManagerVersion,
      localVersion: PI_MANAGER_BUNDLE_VERSION,
    });
    const bundlePath = resolvePiManagerBundlePath();
    const result = await installPiManagerBundle(host, {
      piManagerBundlePath: bundlePath,
      ...(onEvent ? { onEvent } : {}),
    });
    if (!result.ready) {
      throw new Error(`pi-manager install failed: ${result.error ?? 'unknown'}`);
    }
    // 轮 24-I2 HIGH:安装成功后用 result.probe(含最新安装状态)替换旧 probe ——
    // 否则旧 probe.piManagerInstalled=false 会让 ensurePiManagerDaemon 内部
    // 检查直接报「bundle not installed」, 首次安装的自愈链断掉。
    probe = result.probe;
    // 轮 42 P2(codex-connector):静默重装成功 = 磁盘 bundle 已是最新 —— 清掉
    // 之前 defer 分支(daemon 活 + 版本差)记的 hostId:pi pending, 否则 renderer
    // 继续显示 Pi 升级 banner, 用户误点 runPiManagerUpgrade 会 kill 刚起的新
    // daemon 做一次无意义的重装。
    clearPendingUpgrade(host.id, 'pi');
  } else {
    // 快速路径诊断日志(轮 7 CRITICAL #2 —— 测试断言引用它, 且「为何跳过
    // install」值得留痕)。
    logger.debug('pi-manager already installed and up to date', {
      hostId: host.id,
      remoteVersion: probe.piManagerVersion,
    });
  }
  // 轮 40-w4-t3 HIGH:fast path 用 RPC protocol/hello 校验运行中 daemon 的
  // 协议版本(而非只验磁盘 bundle 的 --version)——「磁盘新、进程旧」的升级
  // 残留/回滚状态会被判定 DEAD 并重 spawn, 否则旧 daemon 保留且 RPC 失败
  // 无自愈。
  // 轮 22-G5 MEDIUM:复用本函数最后一次 probe(避免 ensurePiManagerDaemon
  // 内部再 probe 一次 —— 单次会话启动从 2-3 次降到 1 次远端检查)。
  // 轮 24-I2:probe 已在上方安装成功后更新为 result.probe, 此处传的是最新态。
  await ensurePiManagerDaemon(host, { protocolVersion: PROTOCOL_VERSION, probe });
}

/**
 * 打开一条到远端 pi-manager daemon 的 RPC 通道并执行回调。
 * 通道 = ssh execStream 跑 `node pi-manager.mjs bridge --socket <mgrSock>`
 * (bridge 把 daemon 的 manager socket 桥回本地),上面跑 RpcClient。
 * 回调返回后 dispose 关闭通道。
 */
export async function withPiManagerRpc<R>(
  host: RemoteHost,
  logger: Logger,
  fn: (client: RpcClient) => Promise<R>,
): Promise<R> {
  const probe = await probePiManager(host);
  if (!probe.piManagerInstalled) {
    // 内部错误信息不进用户可见面(退役审轮 2 H-2):调用方(cleanup/kill)会
    // catch 并降级, 这里给可操作的诊断信息。
    throw new Error('pi-manager daemon is not available on this host');
  }
  // bridge 命令:node <mgrBin> bridge --socket <mgrSock>。
  // 所有路径统一 shellQuote(自审轮 7 M-5 —— nodeBinaryPath 之前用双引号,
  // 与其它路径引号不对称)。
  const bridgeScript = [
    `${shellQuote(probe.nodeBinaryPath)} ${shellQuote(probe.piManagerBinaryPath)} bridge --socket ${shellQuote(probe.piManagerSockPath)}`,
  ].join(' ');
  const cmd = `bash -c ${shellQuote(bridgeScript)}`;
  // 轮 40-w4-t6 HIGH:建立阶段 15s 超时(exec callback 卡住时不再无限挂起)。
  const handle = await host.execStream(cmd, { timeoutMs: 15_000 });
  const duplex = bridgeStreamToDuplex(handle);
  // 轮 40-w4-t10 MEDIUM:传 logger —— RpcClient 的 corrupt NDJSON / stream error
  // 日志依赖它, 缺失时远端 bridge 输出损坏/ECONNRESET 的根因线索丢失。
  // (Logger 接口含 warn/debug, 与 RpcClient 的 Pick<Console,'warn'|'debug'> 兼容。)
  const client = new RpcClient(duplex, { clientId: 'desktop', logger });
  try {
    await client.hello();
    return await fn(client);
  } catch (err) {
    // 轮 24-I4 MEDIUM:hello/调用失败时附加 daemon log tail —— 运行期 daemon
    // 崩溃/报错的现场(bridge 只给 stderr, 拿不到 daemon 侧最后 10 行)。
    // best-effort:tail 失败不阻断原错误。
    const base = err instanceof Error ? err : new Error(String(err));
    let tailLine: string | undefined;
    try {
      tailLine = await tailDaemonLog(host, probe);
    } catch {
      /* tail 失败保留原错误 */
    }
    if (tailLine) {
      const enriched = new Error(`${base.message}\ndaemon log tail: ${tailLine}`);
      enriched.stack = base.stack;
      throw enriched;
    }
    throw base;
  } finally {
    // 轮 40-w4-t16 MEDIUM(日志盲区):teardown 失败静默吞掉会让 bridge 残留
    // 无迹可循 —— best-effort 语义保留, 但失败原因必须留日志。
    try {
      client.dispose();
    } catch (err) {
      logger.warn('pi-manager rpc dispose failed', {
        hostId: host.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // dispose 失败时兜底 kill ssh channel(防 exec channel 残留 —— 自审轮 6 L-4)。
    try {
      handle.kill();
    } catch (err) {
      logger.warn('pi-manager rpc channel kill failed', {
        hostId: host.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * pi/ensure 包装:确保远端 pi 会话存在。
 * 返回 { sockPath, isReattach }(sockPath 供 bridge 连接)。
 */
export async function piManagerEnsure(
  host: RemoteHost,
  logger: Logger,
  params: PiEnsureParams,
): Promise<PiEnsureResult> {
  return withPiManagerRpc(host, logger, (client) =>
    client.request<PiEnsureResult>(METHODS.PI_ENSURE, params, { timeoutMs: 30_000 }),
  );
}

/**
 * 检查远端 pi-manager daemon 是否真的活着(轮 22, 对齐 cc-mgr daemonAliveCheck)。
 * 只靠 pidfile + kill -0 不够:stale pidfile 的 PID 可能被别的进程复用。
 * 必须 ps -p $PID -o command= 确认 cmdline 含 pi-manager.mjs 才是我们的 daemon。
 * 返回 true = daemon 活着(升级会中断 alive session, 应跳过); false = 死/无。
 */
export async function checkPiManagerDaemonAlive(host: RemoteHost, installDir: string): Promise<boolean> {
  const pidFile = `${installDir}/pi-manager/pi-manager.pid`;
  // 本 install 的 socket 路径(与 pidfile 同根):身份校验必须匹配 `--socket`。
  const sockPath = `${installDir}/pi-manager/pi-manager.sock`;
  try {
    const r = await host.exec(
      `bash -c 'PID="$(cat "${pidFile}" 2>/dev/null || true)"; ` +
        `CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"; ` +
        // 轮 42 P2(codex-connector):stale pidfile 的 PID 可能被复用成**别的**
        // install root 的 pi-manager daemon —— 只 grep 进程名会把别人的活
        // daemon 当成本 install 的, 从而 defer bundle 升级(兼容性修复永远
        // 到不了该 host)。必须同时匹配本 install 的 `--socket <sock>` 才
        // 算 ALIVE; 不匹配按 DEAD 处理(走升级 + spawn, 幂等自愈)。
        `if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && ` +
        `printf "%s" "$CMD" | grep -F "pi-manager.mjs" >/dev/null && ` +
        `printf "%s" "$CMD" | grep -F -- "--socket ${sockPath}" >/dev/null; ` +
        `then echo ALIVE; else echo DEAD; fi'`,
      { timeoutMs: 5_000, label: 'pi-manager-daemon-alive-check' },
    );
    // 精确匹配 'ALIVE'(trim 后 ===)—— includes('ALIVE') 会误匹配
    // 'STILL_ALIVE'(kill 脚本的输出来自同一套远端命令体系)。
    return r.stdout.trim().split(/\r?\n/).pop() === 'ALIVE';
  } catch {
    // 检查失败按「不确认活着」处理(走升级路径;升级本身幂等)。
    return false;
  }
}

/** pi/kill 包装:杀远端 pi 会话。 */
export async function piManagerKill(
  host: RemoteHost,
  logger: Logger,
  sessionId: string,
): Promise<void> {
  await withPiManagerRpc(host, logger, (client) =>
    client.request<void>(METHODS.PI_KILL, { sessionId }, { timeoutMs: 30_000 }),
  );
}

/** pi/list 包装:列远端 pi 会话。 */
export async function piManagerList(
  host: RemoteHost,
  logger: Logger,
): Promise<PiListResult> {
  return withPiManagerRpc(host, logger, (client) =>
    client.request<PiListResult>(METHODS.PI_LIST, {}, { timeoutMs: 15_000 }),
  );
}

/**
 * 强制 kill 远端 pi-manager daemon 进程(协议不兼容/强制升级用)。
 * 按 pidfile 精确定位 + 身份验证(kill -0 + ps 确认是 pi-manager.mjs)——
 * 防 pidfile 陈旧 + PID 重用误杀(与 uninstall 同款, 退役审轮 10 CRITICAL)。
 * daemon 的 SIGTERM handler 会 shutdownAll + 清理 env-file/socket。
 */
export async function killRemotePiManagerDaemon(host: RemoteHost): Promise<void> {
  const probe = await probePiManager(host);
  const pidFile = `${probe.installDir}/pi-manager/pi-manager.pid`;
  const killScript = [
    `PID_FILE=${shellQuote(pidFile)}`,
    `MGR_SOCK=${shellQuote(probe.piManagerSockPath)}`,
    `if [ -f "$PID_FILE" ]; then`,
    `  PID=$(cat "$PID_FILE" 2>/dev/null || true)`,
    `  case "$PID" in`,
    `    *[!0-9]*|'') ;;`,
    `    *) if kill -0 "$PID" 2>/dev/null && (ps -p "$PID" -o command= 2>/dev/null | grep -q pi-manager.mjs || grep -aq pi-manager.mjs /proc/$PID/cmdline 2>/dev/null); then`,
    `         # 轮 40-w4-t5 CRITICAL:身份校验必须绑定 socket path —— stale pidfile
    #  + PID 复用时 basename grep 会误杀另一 install root 的 daemon。cmdline
    #  必须同时含 pi-manager.mjs 与 --socket 且后随本 host 的 sock path。
    #  轮 40-w4-t6 LOW:用 grep -F 固定字符串匹配(路径含 . [ ] + 等正则字符时
    #  grep -E 会语法错/误判)。`,
    `         if ! (ps -p "$PID" -o command= 2>/dev/null | grep -Fq -- "pi-manager.mjs" && ps -p "$PID" -o command= 2>/dev/null | grep -Fq -- "--socket $MGR_SOCK") && ! (grep -aFq -- "pi-manager.mjs" /proc/$PID/cmdline 2>/dev/null && grep -aFq -- "--socket $MGR_SOCK" /proc/$PID/cmdline 2>/dev/null); then`,
    `           echo NO_DAEMON; exit 0`,
    `         fi`,
    `         kill "$PID" >/dev/null 2>&1 || true`,
    `         # 等 daemon 退出(最多 10s) — 防 kill 后立刻 spawn 与旧 daemon shutdown 竞态。`,
    `         for i in $(seq 1 50); do`,
    `           kill -0 "$PID" 2>/dev/null || { echo KILLED; exit 0; }`,
    `           sleep 0.2`,
    `         done`,
    `         # SIGTERM 无效(SIGKILL 兜底, 轮 7 MEDIUM-1):shutdown handler 卡死/`,
    `         # 忽略信号时 SIGTERM 不生效, 旧 daemon 残留会继续占 socket 使新 daemon`,
    `         # 无法 spawn(ensurePiManagerDaemon 探活认为 ALIVE)。kill -9 是协议`,
    `         # 不兼容场景的最终兜底 —— 清理由下次启动的 cleanupStaleState 兜底。`,
    `         kill -9 "$PID" >/dev/null 2>&1 || true`,
    `         for i in $(seq 1 15); do`,
    `           kill -0 "$PID" 2>/dev/null || { echo KILLED; exit 0; }`,
    `           sleep 0.2`,
    `         done`,
    `         echo STILL_ALIVE; exit 1`,
    `       fi ;;`,
    `  esac`,
    `fi`,
    `echo NO_DAEMON`,
  ].join('\n');
  const result = await host.exec(`bash -c ${shellQuote(killScript)}`, {
    timeoutMs: 20_000,
    label: 'pi-manager-daemon-force-kill',
  });
  const out = result.stdout.trim();
  if (result.exitCode !== 0 && !out.includes('NO_DAEMON')) {
    // 轮 13 MEDIUM-3:STILL_ALIVE(D 状态杀不死)必须抛错 —— 静默继续会让调用方
    // 以为 daemon 已死, 实际旧 daemon 仍占 socket, ensurePiManagerDaemon 探活
    // ALIVE 跳过 spawn, 新 bundle 永远不生效。
    // 轮 20-V4 MEDIUM:远端 shell 原始输出(绝对路径/命令/环境细节)不得直拼进
    // 用户可见错误 —— 脱敏后再带, 完整输出由调用方日志通道记录。
    throw new Error(
      `pi-manager daemon force-kill failed (still alive): ${redactCredentialText(out.slice(0, 200) || result.stderr.trim().slice(0, 200))}`,
    );
  }
}

/* ============================== private ============================== */

/**
 * 把 ExecStreamHandle(event-based)包成 Node Duplex(RpcClient 接的 shape)。
 * 平行实现自 cc-manager-client.ts 的 bridgeStreamToDuplex —— NDJSON 协议走
 * onStdoutBytes(bytes)保二进制安全。
 */
function bridgeStreamToDuplex(handle: ExecStreamHandle): Duplex {
  const duplex = new Duplex({
    read(): void {
      /* push-driven, 无主动 pull 逻辑 */
    },
    write(chunk: Buffer, _enc, cb): void {
      try {
        handle.write(chunk);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    final(cb): void {
      try {
        handle.end();
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    destroy(err, cb): void {
      try {
        handle.kill();
      } catch {
        /* channel 已死 */
      }
      cb(err);
    },
  });

  // 轮 7 MEDIUM-2:收集 bridge stderr —— bridge 启动失败(socket 不存在 ENOENT /
  // 权限 / node 损坏)时错误信息全在 stderr, 通道关闭后如果丢失, RpcClient 只
  // 收到「stream closed」, 无法判断是 daemon 崩还是 socket 没了。
  let stderrTail = '';
  handle.onStderr((chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  handle.onStdoutBytes((buf) => {
    // 轮 7 LOW-1:destroy 后不再 push(避免 Node 20+ 的 warning / 无效写入)。
    if (!duplex.destroyed) duplex.push(buf);
  });
  handle.onClose((info) => {
    // 非零退出 + stderr 有内容 → 把失败原因带进 destroy 错误(诊断可见)。
    // 轮 18-U4 HIGH:bridge stderr 可能含绝对路径/socket/命令片段/凭证 ——
    // 原样拼进用户可见错误会外泄内部细节。先脱敏再截断, 完整 stderr 由
    // RpcClient 的 stderr 日志通道另记(同样脱敏)。
    if (info && info.code !== 0 && stderrTail.trim().length > 0) {
      duplex.destroy(new Error(`pi-manager bridge exited (code=${info.code}): ${redactCredentialText(stderrTail.trim()).slice(0, 500)}`));
    } else {
      duplex.destroy();
    }
  });
  handle.onError((err) => {
    duplex.destroy(err);
  });

  return duplex;
}
