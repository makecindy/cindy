/** Electron process wiring for the shared plugin Node broker. */
import { utilityProcess } from 'electron';
import os from 'node:os';
import { adaptPluginNodeProcess, pluginNodeEnvironment } from './nodeRuntimeProcessAdapter.js';
import path from 'node:path';
import { GHOST_NODE_CHILD_MODE_FLAG } from '../../shared/ghost.js';
import { GhostNodeRuntimeBroker as SharedGhostNodeRuntimeBroker } from './nodeRuntimeBroker.js';
import type { GhostNodeRuntimeBrokerDeps as SharedBrokerDeps, NodeWorkerProcess,
  NodeWorkerStartupObservation, NodeWorkerStartupState } from './nodeRuntimeBroker.js';
export type { NodeWorkerProcess, NodeWorkerStartupObservation, NodeWorkerStartupState,
  NodeWorkerStartupStage, NodeRuntimeObservedMainWindowState, NodeRuntimeObservedScreenState,
  NodeRuntimeStartAttemptContext } from './nodeRuntimeBroker.js';
export type GhostNodeRuntimeBrokerDeps = Omit<SharedBrokerDeps, 'spawnProcess' | 'spawnChildProcess'> &
  Partial<Pick<SharedBrokerDeps, 'spawnProcess' | 'spawnChildProcess'>>;
type UtilityFork = typeof utilityProcess.fork;

/** Only Desktop plugin processes inherit the CLI's existing HTTP proxy route. */
function desktopPluginEnvironment(ghostId: string): NodeJS.ProcessEnv {
  const env = pluginNodeEnvironment(ghostId);
  const endpoints: NodeJS.ProcessEnv = {};
  const exclusions: NodeJS.ProcessEnv = {};
  const loopback = ['localhost', '127.0.0.1', '::1'];
  for (const key of ['no_proxy', 'NO_PROXY']) {
    const value = process.env[key];
    if (!value) continue;
    // A malformed bypass list must never silently redirect private traffic.
    const entries = value.split(/[,\t ]+/).filter(Boolean);
    if (!entries.every(entry => /^[a-z0-9_.*:[\]-]+(?:\/\d{1,3})?$/i.test(entry))) return env;
    exclusions[key] = [...new Set([...entries, ...loopback])].join(',');
  }
  for (const name of ['http_proxy', 'https_proxy']) {
    const keys = [name, name.toUpperCase()];
    // Validate the raw authority too: URL parsing alone normalizes paths and whitespace.
    // Keep both spellings or neither so filtering cannot activate a fallback.
    if (keys.every(key => {
      const value = process.env[key];
      return !value || (/^https?:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d+)?\/?$/i.test(value)
        && URL.canParse(value));
    })) {
      for (const key of keys) if (process.env[key]) endpoints[key] = process.env[key];
    }
  }
  if (!Object.keys(endpoints).length) return env;
  // CLIs differ in which spelling they read. Preserve each configured route
  // and mirror a single configured list for clients using the other spelling.
  const fallback = exclusions.no_proxy ?? exclusions.NO_PROXY ?? loopback.join(',');
  return Object.assign(env, endpoints, {
    no_proxy: exclusions.no_proxy ?? fallback,
    NO_PROXY: exclusions.NO_PROXY ?? fallback,
  });
}

/**
 * 用 Electron 官方 utilityProcess 承载第三方 Node 代码。
 *
 * 正式包关闭 RunAsNode fuse，因此不能把 process.execPath 当 node 二进制 spawn。
 * utilityProcess 是 Electron 保留的 Node service process 通道，不要求放宽 fuse。
 */
export function createUtilityNodeWorkerProcess(
  entryPath: string,
  cwd: string,
  ghostId: string,
  fork: UtilityFork = utilityProcess.fork,
  /** 提供即为"原样 stdio 子进程"模式(childSpawn 代启):透传启动参数,不参与协议。 */
  childArgs?: string[],
  inheritEnv = false,
): NodeWorkerProcess {
  const isChild = childArgs !== undefined;
  const env = inheritEnv ? pluginNodeEnvironment(ghostId, process.env, true) : desktopPluginEnvironment(ghostId);
  const workerEntry = path.join(__dirname, 'nodeRuntimeWorkerProcess.desktop.js');
  const forkArgs = isChild
    ? [entryPath, GHOST_NODE_CHILD_MODE_FLAG, ...childArgs]
    : [entryPath];
  const child = fork(workerEntry, forkArgs, {
    cwd: os.tmpdir(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: `cindy-ghost-node:${ghostId}${isChild ? ':child' : ''}`,
    // 参考 VS Code 的本地扩展模型，为插件开放底层系统能力：
    // 保留宿主的 macOS TCC 责任归属，实际访问仍由系统权限决定。
    ...(process.platform === 'darwin' ? { disclaim: false } : {}),
  });
  return adaptPluginNodeProcess(child, isChild);
}

const defaultSpawnProcess = (entryPath: string, cwd: string, ghostId: string, inheritEnv = false): NodeWorkerProcess =>
  createUtilityNodeWorkerProcess(entryPath, cwd, ghostId, utilityProcess.fork, undefined, inheritEnv);

/** 代启子进程缺省实现:同一 utilityProcess 通道,原样 stdio 模式。 */
const defaultSpawnChildProcess = (
  entryPath: string,
  cwd: string,
  ghostId: string,
  args: string[],
  inheritEnv = false,
): NodeWorkerProcess =>
  createUtilityNodeWorkerProcess(entryPath, cwd, ghostId, utilityProcess.fork, args, inheritEnv);

export class GhostNodeRuntimeBroker extends SharedGhostNodeRuntimeBroker {
  constructor(deps: GhostNodeRuntimeBrokerDeps) {
    super({ ...deps, spawnProcess: deps.spawnProcess ?? defaultSpawnProcess,
      spawnChildProcess: deps.spawnChildProcess ?? defaultSpawnChildProcess });
  }
}
