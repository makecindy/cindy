interface NodeWorkerReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  once?(event: 'end', listener: () => void): this;
}

interface NodeWorkerWritable {
  destroyed?: boolean;
  write(chunk: string): boolean;
}

/** 生产使用 utilityProcess 适配器；最小接口便于纯单测注入假进程。 */
export interface NodeWorkerProcess {
  stdin: NodeWorkerWritable;
  stdout: NodeWorkerReadable;
  stderr: NodeWorkerReadable;
  pid?: number;
  killed?: boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  /**
   * 诊断-only 的 main 侧观测；不得用于放行业务请求。晚订阅只安全回放已
   * 观测的 utility-process-spawned。
   */
  onStartupObservation?(listener: (observation: NodeWorkerStartupObservation) => void): void;
  /** Diagnostic-only adapter facts; absent on test/custom process implementations. */
  readStartupState?(): NodeWorkerStartupState;
  /** 订阅 worker 引导层就绪后经 parentPort 上行的控制帧(代启子进程用;可选)。 */
  onControl?(listener: (message: unknown) => void): void;
  /** 给 worker 引导层下行一条控制帧(代启结果/子进程输出等;可选)。 */
  sendControl?(message: unknown): boolean;
}

export type NodeWorkerStartupStage = 'utility-process-spawned' | 'parent-port-ready';

export interface NodeWorkerStartupObservation {
  stage: NodeWorkerStartupStage;
  pid?: number;
}

/** Main-only facts sampled at a failed startup deadline; never gate readiness. */
export interface NodeWorkerStartupState {
  messageCount: number;
  readySeen: boolean;
  adapterReady: boolean;
}

export type NodeWorkerObservedTimeoutClass = 'native-not-observed' | 'native-observed-ready-not-observed';

export type NodeRuntimeObservedMainWindowState =
  'absent' | 'hidden' | 'minimized' | 'visible-unfocused' | 'focused' | 'unknown';

export type NodeRuntimeObservedScreenState = 'active' | 'idle' | 'locked' | 'unknown';

export interface NodeRuntimeStartAttemptContext {
  observedMainWindowState: NodeRuntimeObservedMainWindowState;
  observedScreenState: NodeRuntimeObservedScreenState;
}

