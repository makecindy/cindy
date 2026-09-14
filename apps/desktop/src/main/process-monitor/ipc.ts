/**
 * process-monitor/ipc —— 「资源用量」面板的 IPC 面(main 侧)。
 *
 * 授权边界:
 *  - 所有 handler 首行 assertTrustedAppRendererEvent —— 进程信息与终止能力只
 *    对 Cindy 自有顶层 renderer 开放,WebView / Ghost 一律拒绝。
 *  - 出站推送同样设闸:采样快照带页面标题(用户内容),只发给仍然可信的
 *    订阅窗口(trustedAppRenderer 的出站口径)。
 *  - terminate 不信 renderer 传来的 pid 归属:执行前重新扫描,pid 必须命中
 *    「ppid == 本进程 且命令行带本产品 marker」的 agent 根进程,否则拒绝 ——
 *    绝不做任意进程杀手。
 *
 * 采样只在有订阅者(面板打开)时进行:subscribe 起 interval(unref,不拖
 * 退出),订阅清零即停,无需 onQuit 挂钩。
 */

import { BrowserWindow, app, ipcMain, webContents, type WebContents } from 'electron';

import {
  PROCESS_MONITOR_SAMPLE_CHANNEL,
  PROCESS_MONITOR_SUBSCRIBE_CHANNEL,
  PROCESS_MONITOR_TERMINATE_CHANNEL,
  PROCESS_MONITOR_UNSUBSCRIBE_CHANNEL,
  type ProcessMonitorSample,
  type TerminateAgentProcessResult,
} from '../../shared/processMonitor.js';
import { registerUserDataMarkers } from '../agent-process-priority.js';
import { killProcessTree } from '../claude-orphan-reaper.js';
import { createLogger } from '../logger';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer.js';
import {
  requireNonNegativeInt,
  requireObject,
  requireString,
  throwIpcError,
} from '../utils/ipcValidate.js';
import {
  classifyMonitoredAgentCommandLine,
  registerPiUserDataMarkers,
  scanOsProcesses,
  scanOsProcessesSync,
  type MonitoredAgentKind,
  type OsProcessSnapshot,
} from './agent-scan.js';
import {
  resolveAgentProcessRegistration,
  type AgentProcessRegistration,
} from './codex-process-registry.js';
import { terminateSafePosixProcessTree } from './safe-posix-process-tree.js';
import {
  createProcessMonitorSampler,
  type ProcessMonitorSampler,
} from './sampler.js';

/** 推送周期。2s 对「看资源用量」够实时,采样本身(getAppMetrics)开销可忽略。 */
export const SAMPLE_INTERVAL_MS = 2_000;

interface IpcLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** 依赖全部可注入(测试用);生产走缺省实现。 */
export interface ProcessMonitorIpcOptions {
  sampler?: ProcessMonitorSampler;
  /** terminate 校验用的**新鲜**扫描(不走 sampler 缓存)。 */
  scanOsProcessesSync?: () => OsProcessSnapshot;
  /** sampler 的异步 OS 扫描。 */
  scanOsProcesses?: () => Promise<OsProcessSnapshot>;
  /** 隐藏预热窗口等 sender 可保留订阅，但 Main 不允许它触发采样或接收快照。 */
  allowsSampling?: (sender: WebContents) => boolean;
  classify?: (cmdLineLower: string) => MonitoredAgentKind | null;
  resolveAgentProcessRegistration?: (pid: number) => AgentProcessRegistration | null;
  killProcessTree?: (pid: number, childrenByParent: Map<number, number[]>) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** 仅用于显式分流 Windows taskkill 与 POSIX 冻结终止；测试可注入。 */
  platform?: NodeJS.Platform;
  selfPid?: number;
  sampleIntervalMs?: number;
  log?: IpcLogger;
}

let registered = false;

export function registerProcessMonitorIpc(opts: ProcessMonitorIpcOptions = {}): void {
  if (registered) return;
  registered = true;

  const log = opts.log ?? createLogger('process-monitor');
  const selfPid = opts.selfPid ?? process.pid;
  const classify = opts.classify ?? classifyMonitoredAgentCommandLine;
  const resolveAgentRegistration =
    opts.resolveAgentProcessRegistration ?? resolveAgentProcessRegistration;
  const sampleScan = opts.scanOsProcesses ?? scanOsProcesses;
  const ownershipScanSync = opts.scanOsProcessesSync ?? scanOsProcessesSync;
  const killTree = opts.killProcessTree ?? killProcessTree;
  const signalProcess =
    opts.signalProcess ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });
  const platform = opts.platform ?? process.platform;
  const sampleIntervalMs = opts.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
  let windowsScanSourceLogged = false;
  const sampleScanWithSource = (): Promise<OsProcessSnapshot> => {
    if (platform === 'win32' && !windowsScanSourceLogged) {
      windowsScanSourceLogged = true;
      log.info('Windows OS process scan requested by resource usage sampling', {
        childProcessSource: 'process-monitor.windows-os-scan',
      });
    }
    return sampleScan();
  };

  if (!opts.sampler) {
    // 运行时 userData 可被重定向(XDG_CONFIG_HOME / --user-data-dir),静态品牌
    // marker 会整体失配 —— 补一组实际路径派生的 marker,失败降级为静态 marker。
    try {
      const userData = app.getPath('userData');
      registerUserDataMarkers(userData);
      registerPiUserDataMarkers(userData);
    } catch (err) {
      log.warn('userData marker registration failed; static brand markers only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sampler =
    opts.sampler ??
    createProcessMonitorSampler({
      getMetrics: () => app.getAppMetrics(),
      scanOsProcesses: sampleScanWithSource,
      describeRendererProcess: describeRendererProcessByPid,
      classify,
      resolveAgentProcessRegistration: resolveAgentRegistration,
      selfPid,
      log,
      // Windows 冷启 PowerShell 可达秒级；用户打开后的首帧只等 app.getAppMetrics，
      // Worker 扫描完成后由下一次 2s tick 补齐 agent 树。
      deferOsScan: platform === 'win32',
    });

  const subscribers = new Set<WebContents>();
  const destroyListeners = new WeakMap<WebContents, () => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let sampling = false;

  function samplingAllowed(wc: WebContents): boolean {
    return !opts.allowsSampling || opts.allowsSampling(wc);
  }

  function hasActiveSubscriber(): boolean {
    let active = false;
    for (const wc of [...subscribers]) {
      if (wc.isDestroyed()) {
        dropSubscriber(wc);
        continue;
      }
      if (samplingAllowed(wc)) active = true;
    }
    return active;
  }

  function publishSample(sample: ProcessMonitorSample): void {
    for (const wc of [...subscribers]) {
      if (wc.isDestroyed()) {
        dropSubscriber(wc);
        continue;
      }
      // 窗口可能在采样 in-flight 期间被隐藏；Main gate 重新检查，禁止把结果发回。
      if (!samplingAllowed(wc)) continue;
      // 出站闸:快照含页面标题(用户内容),窗口导航离开 Cindy 页面后不再推。
      if (!isTrustedAppRendererWindow(BrowserWindow.fromWebContents(wc))) {
        dropSubscriber(wc);
        continue;
      }
      try {
        wc.send(PROCESS_MONITOR_SAMPLE_CHANNEL, sample);
      } catch {
        // 窗口可能在枚举与 send 之间被销毁。
      }
    }
  }

  function dropSubscriber(wc: WebContents): void {
    subscribers.delete(wc);
    const destroyListener = destroyListeners.get(wc);
    if (destroyListener) {
      wc.removeListener('destroyed', destroyListener);
      destroyListeners.delete(wc);
    }
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function tick(): Promise<void> {
    if (sampling || !hasActiveSubscriber()) return; // 采样慢于周期时跳过,不排队叠加
    sampling = true;
    try {
      const sample = await sampler.sample();
      publishSample(sample);
    } catch (err) {
      log.warn('process monitor sample failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // 不把顶层失败伪装成有效的「0 个进程」快照。已展示的最后一份数据继续保留；
      // 冷打开则保持 Loading，定时器会在下一 tick 自动重试。
    } finally {
      sampling = false;
    }
  }

  ipcMain.handle(PROCESS_MONITOR_SUBSCRIBE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    const wc = event.sender;
    if (!samplingAllowed(wc)) {
      log.info('process monitor subscription deferred while resource window is prewarmed', {
        source: 'resource-usage-window-prewarm',
      });
    }
    if (!subscribers.has(wc)) {
      const destroyListener = () => dropSubscriber(wc);
      subscribers.add(wc);
      destroyListeners.set(wc, destroyListener);
      wc.once('destroyed', destroyListener);
    }
    if (!timer) {
      timer = setInterval(() => {
        void tick();
      }, sampleIntervalMs);
      timer.unref?.();
    }
    void tick(); // 面板打开立即出首帧,不等第一个周期
  });

  ipcMain.handle(PROCESS_MONITOR_UNSUBSCRIBE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    dropSubscriber(event.sender);
  });

  ipcMain.handle(PROCESS_MONITOR_TERMINATE_CHANNEL, (event, rawRequest: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = requireObject(rawRequest, 'request');
    const pid = requireNonNegativeInt(request.pid, 'pid');
    const processInstanceId = requireString(request.processInstanceId, 'processInstanceId');
    if (pid === selfPid || pid === 0) {
      throwIpcError('INVALID_PARAMS', 'pid is not a terminable process');
    }
    // 归属校验用新鲜扫描:renderer 手里的快照可能已过期(进程退出、pid 复用)。
    let snapshot: OsProcessSnapshot;
    try {
      snapshot = ownershipScanSync();
    } catch (err) {
      log.warn('process monitor ownership scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throwIpcError('INTERNAL', 'failed to inspect process ownership');
    }
    const row = snapshot.rows.find((r) => r.pid === pid);
    const kind = row && row.ppid === selfPid ? classify(row.cmdLineLower) : null;
    const registration = row ? resolveAgentRegistration(row.pid) : null;
    if (
      !row ||
      row.ppid !== selfPid ||
      !row.startIdentity ||
      !kind ||
      registration?.kind !== kind ||
      registration.role !== 'task-host' ||
      registration.instanceId !== processInstanceId
    ) {
      throwIpcError('NOT_FOUND', 'process is not an agent process owned by this app');
    }
    // registry 只收紧动作范围，不扩大授权；新鲜扫描 + PPID + marker 仍是首要边界。
    // 随机 instanceId 绑定一次真实 spawn，消除 POSIX lstart 秒级碰撞导致的陈旧授权。
    // 从同步扫描开始到终止完成之间不能 await/让出事件循环。Windows taskkill /T 由
    // OS 展开当前树；POSIX 先暂停根，再逐层暂停后代。父进程暂停期间无法 reap 已退出
    // 子进程，因此已枚举的 PID 不会被复用为无关进程。
    if (platform === 'win32') {
      if (!killTree(pid, new Map())) {
        throwIpcError('INTERNAL', 'failed to terminate the agent process tree');
      }
    } else {
      let terminationResult: ReturnType<typeof terminateSafePosixProcessTree>;
      try {
        terminationResult = terminateSafePosixProcessTree({
          rootPid: pid,
          rootStartIdentity: row.startIdentity,
          rootStateBeforeStop: row.state,
          scan: ownershipScanSync,
          signal: signalProcess,
          isExpectedRoot: (candidate) =>
            candidate.ppid === selfPid &&
            candidate.startIdentity === row.startIdentity &&
            classify(candidate.cmdLineLower) === kind,
        });
      } catch (err) {
        log.warn('process monitor POSIX tree termination failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throwIpcError('INTERNAL', 'failed to terminate the agent process tree');
      }
      if (terminationResult === 'root-not-found') {
        throwIpcError('NOT_FOUND', 'process is no longer an agent process owned by this app');
      }
    }
    log.info('agent process tree terminated from resource usage panel', { pid, kind });
    const result: TerminateAgentProcessResult = { pid, kind };
    return result;
  });
}

/**
 * pid → renderer 展示标签:遍历现存 webContents 匹配 OS pid,取页面标题,
 * 兜底 URL host。永不缓存 WebContents(与 TabRegistry 同一原则)。
 * 同进程多页面(Chromium same-site 合并)取第一个命中的标题。
 */
function describeRendererProcessByPid(pid: number): string | null {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed() || wc.getOSProcessId() !== pid) continue;
      const title = wc.getTitle();
      if (title) return title;
      const url = wc.getURL();
      if (url) {
        try {
          return new URL(url).host || null;
        } catch {
          return null;
        }
      }
      return null;
    } catch {
      // webContents 可能在枚举中途销毁;跳过继续。
    }
  }
  return null;
}

/** 仅测试用:允许同一进程内重复注册。 */
export function _resetProcessMonitorIpcForTests(): void {
  registered = false;
  ipcMain.removeHandler(PROCESS_MONITOR_SUBSCRIBE_CHANNEL);
  ipcMain.removeHandler(PROCESS_MONITOR_UNSUBSCRIBE_CHANNEL);
  ipcMain.removeHandler(PROCESS_MONITOR_TERMINATE_CHANNEL);
}
