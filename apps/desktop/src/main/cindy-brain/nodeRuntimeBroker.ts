/** Desktop preserves its released adapter and injects the same host policies. */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';
import { GHOST_NODE_CHILD_MODE_FLAG, type GhostManifest, type InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { bindDeviceAuthorizationTarget, bindPluginAuthorizationTarget } from '../plugin-oauth/targetPolicy.js';
import { GhostNodeRuntimeBroker as SharedBroker, type GhostNodeRuntimeBrokerDeps as SharedDeps } from '@cindy/plugin-runtime/nodeRuntimeBroker';
import type { NodeWorkerProcess, NodeWorkerStartupState, NodeWorkerStartupObservation } from '@cindy/plugin-runtime/processTypes';
export type { NodeWorkerProcess, NodeWorkerStartupStage, NodeWorkerStartupObservation, NodeWorkerStartupState, NodeRuntimeObservedMainWindowState, NodeRuntimeObservedScreenState, NodeRuntimeStartAttemptContext } from '@cindy/plugin-runtime/processTypes';
export interface GhostNodeRuntimeBrokerDeps extends Omit<SharedDeps, 'getGhost' | 'spawnProcess' | 'spawnChildProcess' | 'instanceId' | 'bindDeviceAuthorizationTarget' | 'bindPluginAuthorizationTarget'> {
  getGhost(id: string): InstalledGhost | null;
  spawnProcess?: SharedDeps['spawnProcess'];
  spawnChildProcess?: SharedDeps['spawnChildProcess'];
}
export class GhostNodeRuntimeBroker extends SharedBroker {
  constructor(deps: GhostNodeRuntimeBrokerDeps) {
    super({ ...deps, instanceId: installedGhostStoragePart,
      spawnProcess: deps.spawnProcess ?? createUtilityNodeWorkerProcess,
      spawnChildProcess: deps.spawnChildProcess ?? ((entry, cwd, id, args) => createUtilityNodeWorkerProcess(entry, cwd, id, utilityProcess.fork, args)),
      bindDeviceAuthorizationTarget: (manifest, url) => {
        const check = bindDeviceAuthorizationTarget(manifest as GhostManifest, url);
        return current => check(current as GhostManifest);
      },
      bindPluginAuthorizationTarget: (manifest, request) => {
        const check = bindPluginAuthorizationTarget(manifest as GhostManifest, request);
        return current => check(current as GhostManifest);
      },
    });
  }
}

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
  // 不继承 API key / token 等宿主环境变量。Node 本身仍有用户级本机权限，
  // 这里只是在“无意泄露宿主秘密”和“系统运行必需变量”之间取最小集合。
  const inheritedKeys = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    // 用户身份路径变量（是路径不是秘密）：gh / git 等 CLI 依赖它们定位用户级
    // 配置。gh 会按 GH_CONFIG_DIR → XDG_CONFIG_HOME → 平台默认目录查找；
    // Windows 上默认目录依赖 APPDATA / 用户目录，缺少这些变量会让 keyring 里明明
    // 有登录的 gh 仍误报“未登录”。HOME 是 Unix 侧同义变量，一并透传。
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    // gh 允许用 GH_CONFIG_DIR 指定自定义配置目录；同属路径类变量，不含秘密。
    'GH_CONFIG_DIR',
    // XDG_CONFIG_HOME 也可指定 gh 配置目录，且在 Windows 上同样可能优先于 APPDATA。
    'XDG_CONFIG_HOME',
  ] as const;
  const env: NodeJS.ProcessEnv = {
    CINDY_GHOST_ID: ghostId,
    // 不暴露安装目录路径——插件通过 __dirname 定位自身资源即可。
    // 显式传路径会降低篡改 ghost.json/trust 的门槛(相对路径写入已
    // 靠 cwd=tmpdir 阻断,但绝对路径仍可达;减少攻击面)。
  };
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const workerEntry = path.join(__dirname, 'nodeRuntimeWorkerProcess.js');
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
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill();
    throw new Error('Node utilityProcess 没有可用的 stdout/stderr');
  }

  const events = new EventEmitter();
  const controlListeners = new Set<(message: unknown) => void>();
  const startupObservationListeners = new Set<
    (observation: NodeWorkerStartupObservation) => void
  >();
  let nativeSpawnObservation: NodeWorkerStartupObservation | null = null;
  let destroyed = false;
  let killed = false;
  let ready = false;
  let messageCount = 0;
  let readySeen = false;
  const readNativePid = (): number | undefined => {
    try {
      const value = child.pid;
      return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const publishNativeSpawnObservation = (pid = readNativePid()): void => {
    try {
      if (nativeSpawnObservation) return;
      const observation: NodeWorkerStartupObservation = {
        stage: 'utility-process-spawned',
        ...(pid !== undefined ? { pid } : {}),
      };
      nativeSpawnObservation = observation;
      for (const listener of startupObservationListeners) {
        try {
          listener(observation);
        } catch {
          // 诊断 observer 不能中断原有 ready/spawn 传播。
        }
      }
    } catch {
      // 整条 native-spawn diagnostic 发布链 fail-open。
    }
  };
  const onMessage = (message: unknown) => {
    messageCount += 1;
    if (
      !ready &&
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).type === 'ready'
    ) {
      ready = true;
      readySeen = true;
      events.emit('spawn');
      // 子进程原样模式:就绪后一律不再收消息——它没有任何上行控制资格。
      if (isChild) child.removeListener('message', onMessage);
      return;
    }
    // 普通模式就绪后,parentPort 只承载引导层的子进程控制帧;帧形状由
    // broker 侧 parseGhostNodeChildToHostMessage 严格把关,不合形静默丢。
    if (ready && !isChild) {
      controlListeners.forEach((listener) => listener(message));
    }
  };
  try {
    child.on('spawn', () => publishNativeSpawnObservation());
  } catch {
    // native spawn observer 安装失败不得影响 adapter 构造。
  }
  try {
    const initialPid = readNativePid();
    if (initialPid !== undefined) publishNativeSpawnObservation(initialPid);
  } catch {
    // PID 只用于诊断；getter 异常不得影响 adapter 构造。
  }
  child.on('message', onMessage);
  child.on('exit', (code) => {
    destroyed = true;
    killed = true;
    events.emit('exit', code, null);
  });
  child.on('error', (type, location) => {
    events.emit('error', new Error(`Node utilityProcess ${type} at ${location}`));
  });

  const adapter = {
    stdin: {
      get destroyed() {
        return destroyed;
      },
      write(chunk: string): boolean {
        if (destroyed) return false;
        // 原样子进程走 base64 字节口(chunk 可能切坏多字节字符);
        // 普通 worker 保持 utf8 文本口(逐行 JSON,旧行为零变化)。
        child.postMessage(isChild ? { type: 'stdin-b64', chunk } : { type: 'stdin', chunk });
        return true;
      },
    },
    stdout,
    stderr,
    readStartupState(): NodeWorkerStartupState {
      return { messageCount, readySeen, adapterReady: ready };
    },
    onStartupObservation(listener: (observation: NodeWorkerStartupObservation) => void): void {
      if (nativeSpawnObservation) {
        try {
          listener(nativeSpawnObservation);
        } catch {
          // native spawn 可能早于 broker 订阅；安全回放仍须 fail-open。
        }
      }
      startupObservationListeners.add(listener);
    },
    onControl(listener: (message: unknown) => void): void {
      controlListeners.add(listener);
    },
    sendControl(message: unknown): boolean {
      if (destroyed) return false;
      child.postMessage(message);
      return true;
    },
    get pid() {
      return child.pid;
    },
    get killed() {
      return killed;
    },
    on(event: 'exit' | 'error', listener: (...args: unknown[]) => void) {
      events.on(event, listener);
      return adapter;
    },
    once(event: 'spawn' | 'exit' | 'error', listener: (...args: unknown[]) => void) {
      events.once(event, listener);
      return adapter;
    },
    kill(signal?: NodeJS.Signals): boolean {
      destroyed = true;
      killed = true;
      if (signal === 'SIGKILL' && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL');
          return true;
        } catch {
          // 已退出或平台不支持时落回 utilityProcess 自带的终止。
        }
      }
      return child.kill();
    },
  };
  return adapter as NodeWorkerProcess;
}
