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
): NodeWorkerProcess {
  const isChild = childArgs !== undefined;
  const env = pluginNodeEnvironment(ghostId);
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

const defaultSpawnProcess = createUtilityNodeWorkerProcess;

/** 代启子进程缺省实现:同一 utilityProcess 通道,原样 stdio 模式。 */
const defaultSpawnChildProcess = (
  entryPath: string,
  cwd: string,
  ghostId: string,
  args: string[],
): NodeWorkerProcess =>
  createUtilityNodeWorkerProcess(entryPath, cwd, ghostId, utilityProcess.fork, args);

export class GhostNodeRuntimeBroker extends SharedGhostNodeRuntimeBroker {
  constructor(deps: GhostNodeRuntimeBrokerDeps) {
    super({ ...deps, spawnProcess: deps.spawnProcess ?? defaultSpawnProcess,
      spawnChildProcess: deps.spawnChildProcess ?? defaultSpawnChildProcess });
  }
}
