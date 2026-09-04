/**
 * Main-process proxy for bounded, cancellable directory probes.
 *
 * Node's fs.stat cannot cancel a wedged UNC/SMB request. Each probe therefore
 * runs in one of a small number of Electron utility processes. A timed-out
 * probe kills only its worker, releasing the slot and the worker's libuv state.
 * Queued probes wait for a slot within the same end-to-end deadline instead of
 * being rejected immediately merely because other shares are slow.
 *
 * Capacity isolation (queue wait + execution share one deadline, so a starved
 * slot is a false timeout): settings-class jobs (validate/availability — IM
 * channel working-dir probes, fail-soft) jointly occupy at most maxWorkers-1
 * workers, keeping at least one execution slot for kind='probe' (the remote
 * session-creation safety gate, remote-workdir-guard). Two wedged settings
 * probes must not exhaust a healthy remote directory's whole budget and turn
 * it into REMOTE_WORKDIR_UNAVAILABLE. Queue drain prefers 'probe' so a freed
 * slot cannot be re-taken by an earlier-queued optional settings probe.
 * Workers awaiting exit confirmation (terminating) count toward the settings
 * occupancy regardless of their previous job kind — an unconfirmed exit
 * releases no capacity to optional probes.
 */

import type {
  WorkdirAvailabilityResult,
  WorkdirProbeRequest,
  WorkdirProbeResponse,
  WorkdirProbeResult,
  WorkdirProbeStatResult,
  WorkdirValidateResult,
} from './protocol';

type ProbeJobKind = WorkdirProbeRequest['kind'];

export interface WorkdirProbeChildLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(
    event: 'error',
    listener: (type: string, location: string, report: string) => void,
  ): void;
  kill(): boolean;
}

export interface WorkdirProbeLoggerLike {
  warn(...args: unknown[]): void;
}

export interface WorkdirProbeHostClientDeps {
  fork: () => WorkdirProbeChildLike;
  log: WorkdirProbeLoggerLike;
  maxWorkers?: number;
  maxQueued?: number;
}

export type WorkdirProbeClientErrorCode =
  | 'WORKDIR_PROBE_TIMEOUT'
  | 'WORKDIR_PROBE_UNAVAILABLE';

export class WorkdirProbeClientError extends Error {
  constructor(
    readonly code: WorkdirProbeClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkdirProbeClientError';
  }
}

interface ProbeEntry {
  id: number;
  kind: ProbeJobKind;
  dir: string;
  key: string;
  deadline: number;
  resolve: (result: WorkdirProbeResult) => void;
  reject: (error: Error) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
  probeTimer?: ReturnType<typeof setTimeout>;
}

interface ProbeWorker {
  child: WorkdirProbeChildLike;
  active?: ProbeEntry;
  terminating?: boolean;
}

const DEFAULT_MAX_WORKERS = 2;
const DEFAULT_MAX_QUEUED = 32;

/**
 * 设置类 job(IM 渠道工作目录探测): 失败可宽大降级(设置页「不可用」警告/
 * 选择器报错), 属可选探测。kind='probe' 是远程新建会话的安全闸
 * (remote-workdir-guard), 其误报直接阻断远程任务创建, 不归入此类。
 */
function isSettingsKind(kind: ProbeJobKind): boolean {
  return kind === 'validate' || kind === 'availability';
}

export class WorkdirProbeHostClient {
  private readonly maxWorkers: number;
  private readonly maxQueued: number;
  private readonly workers: ProbeWorker[] = [];
  private readonly queue: ProbeEntry[] = [];
  private readonly inFlightByPath = new Map<string, Promise<WorkdirProbeResult>>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly deps: WorkdirProbeHostClientDeps) {
    this.maxWorkers = deps.maxWorkers ?? DEFAULT_MAX_WORKERS;
    this.maxQueued = deps.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  probe(dir: string, key: string, timeoutMs: number): Promise<WorkdirProbeStatResult> {
    return this.request('probe', dir, key, timeoutMs).then(asStatResult);
  }

  /** validate: realpath → stat → 'wx' 写探针 → 清理(IM 渠道新选择目录严格校验)。 */
  validate(dir: string, key: string, timeoutMs: number): Promise<WorkdirValidateResult> {
    return this.request('validate', dir, key, timeoutMs).then(asValidateResult);
  }

  /** availability: stat → 'wx' 写探针 → 清理(IM 渠道已保存目录可用性探测)。 */
  availability(dir: string, key: string, timeoutMs: number): Promise<WorkdirAvailabilityResult> {
    return this.request('availability', dir, key, timeoutMs).then(asAvailabilityResult);
  }

  private request(
    kind: ProbeJobKind,
    dir: string,
    key: string,
    timeoutMs: number,
  ): Promise<WorkdirProbeResult> {
    if (this.disposed) {
      return Promise.reject(
        new WorkdirProbeClientError('WORKDIR_PROBE_UNAVAILABLE', 'probe host is disposed'),
      );
    }
    // single-flight 按「job 类型 + 路径」: 三种 job 的结果形态不同
    // (isDirectory/realPath/usable), 同路径跨类型复用会把成功结果交给错误的
    // 收窄函数, 变成 WORKDIR_PROBE_UNAVAILABLE 误拒 — 只合并同类型同路径。
    const flightKey = `${kind}\0${key}`;
    const existing = this.inFlightByPath.get(flightKey);
    if (existing) return existing;

    let entry!: ProbeEntry;
    const probe = new Promise<WorkdirProbeResult>((resolve, reject) => {
      entry = {
        id: this.nextId++,
        kind,
        dir,
        key,
        deadline: Date.now() + timeoutMs,
        resolve,
        reject,
      };
      this.schedule(entry);
    }).finally(() => {
      if (this.inFlightByPath.get(flightKey) === probe) {
        this.inFlightByPath.delete(flightKey);
      }
    });
    this.inFlightByPath.set(flightKey, probe);
    return probe;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new WorkdirProbeClientError(
      'WORKDIR_PROBE_UNAVAILABLE',
      'probe host is disposed',
    );
    for (const queued of this.queue.splice(0)) {
      if (queued.queueTimer) clearTimeout(queued.queueTimer);
      queued.reject(error);
    }
    for (const worker of this.workers.splice(0)) {
      if (worker.active?.probeTimer) clearTimeout(worker.active.probeTimer);
      worker.active?.reject(error);
      worker.active = undefined;
      try {
        worker.child.kill();
      } catch {
        // The utility process may already have exited.
      }
    }
  }

  private schedule(entry: ProbeEntry): void {
    if (this.hasFreeWorker() && this.withinSettingsCapacity(entry)) {
      const idle = this.workers.find((worker) => !worker.active && !worker.terminating);
      try {
        this.startProbe(idle ?? this.createWorker(), entry);
      } catch (error) {
        entry.reject(
          new WorkdirProbeClientError(
            'WORKDIR_PROBE_UNAVAILABLE',
            `failed to start probe host: ${String(error)}`,
          ),
        );
      }
      return;
    }
    // 队列上限只拦「确实需要排队」的请求 — 容量隔离下可能存在空闲的保留槽
    // (设置类占满 + probe 可立即启动), 可立即运行的 job 不得先被 queue-full
    // 拒绝。对实际排队项仍是硬限制(enqueue 前判定)。
    if (this.queue.length >= this.maxQueued) {
      entry.reject(
        new WorkdirProbeClientError('WORKDIR_PROBE_UNAVAILABLE', 'probe queue is full'),
      );
      return;
    }
    this.enqueue(entry);
  }

  private enqueue(entry: ProbeEntry): void {
    this.queue.push(entry);
    const remainingMs = this.remainingMs(entry);
    entry.queueTimer = setTimeout(() => {
      const index = this.queue.indexOf(entry);
      if (index < 0) return;
      this.queue.splice(index, 1);
      entry.reject(
        new WorkdirProbeClientError(
          'WORKDIR_PROBE_TIMEOUT',
          'timed out waiting for a probe slot',
        ),
      );
    }, remainingMs);
    entry.queueTimer.unref?.();
  }

  /** 空闲执行槽: 存在 idle worker, 或进程数仍在全局硬上限内可新建。 */
  private hasFreeWorker(): boolean {
    if (this.workers.some((worker) => !worker.active && !worker.terminating)) return true;
    return this.workers.length < this.maxWorkers;
  }

  /**
   * 设置类容量判定: validate/availability 的「容量占用」= 活跃设置 job 数 +
   * 全部 terminating worker 数(**不论**其此前的 job 类型)。
   *   - 活跃设置 job 直接占执行槽;
   *   - terminating worker 在 exit 确认前仍占 maxWorkers 名额, 它腾出的槽
   *     并未真正可回收 — 不计入的话, 设置 job 超时挂起的瞬间新设置 job 就会
   *     吃掉本应留给远程安全 probe 的保留槽(fail-closed: 未确认退出的进程
   *     不向可选探测释放任何容量, 可选设置不得扩大其故障半径)。
   * 合计占用 < maxWorkers-1 才放行, 恒为 kind='probe'(远程新建会话安全闸)
   * 保留至少 1 个执行槽 — 排队与执行共用同一 deadline, 两个设置探针挂死在
   * 失联网络盘上时, 安全 probe 仍能立即拿到保留槽, 而不是把预算耗在排队上。
   */
  private withinSettingsCapacity(entry: ProbeEntry): boolean {
    if (!isSettingsKind(entry.kind)) return true;
    return this.settingsOccupancy() < this.settingsWorkerCap();
  }

  /** 设置类容量占用: 活跃设置 job + 全部未确认退出的 terminating worker。 */
  private settingsOccupancy(): number {
    let count = 0;
    for (const worker of this.workers) {
      if (worker.terminating) count += 1;
      else if (worker.active && isSettingsKind(worker.active.kind)) count += 1;
    }
    return count;
  }

  /** maxWorkers=1 时无从保留(测试/极端配置), 退化为共享; 生产行为不变。 */
  private settingsWorkerCap(): number {
    return Math.max(1, this.maxWorkers - 1);
  }

  private createWorker(): ProbeWorker {
    const child = this.deps.fork();
    const worker: ProbeWorker = { child };
    this.workers.push(worker);
    child.on('message', (message) => {
      this.handleMessage(worker, message);
    });
    child.on('exit', () => {
      this.handleWorkerExit(worker);
    });
    child.on('error', (type, location) => {
      this.deps.log.warn('workdir probe host error', { type, location });
      this.beginWorkerTermination(
        worker,
        new WorkdirProbeClientError('WORKDIR_PROBE_UNAVAILABLE', 'probe host failed'),
      );
    });
    return worker;
  }

  private startProbe(worker: ProbeWorker, entry: ProbeEntry): void {
    if (entry.queueTimer) {
      clearTimeout(entry.queueTimer);
      entry.queueTimer = undefined;
    }
    const remainingMs = this.remainingMs(entry);
    if (remainingMs <= 0) {
      entry.reject(
        new WorkdirProbeClientError('WORKDIR_PROBE_TIMEOUT', 'directory probe deadline elapsed'),
      );
      this.drainQueue();
      return;
    }
    worker.active = entry;
    entry.probeTimer = setTimeout(() => {
      if (worker.active !== entry) return;
      this.beginWorkerTermination(
        worker,
        new WorkdirProbeClientError('WORKDIR_PROBE_TIMEOUT', 'directory probe timed out'),
      );
    }, remainingMs);
    entry.probeTimer.unref?.();

    const request: WorkdirProbeRequest = {
      kind: entry.kind,
      id: entry.id,
      dir: entry.dir,
    };
    try {
      worker.child.postMessage(request);
    } catch (error) {
      this.beginWorkerTermination(
        worker,
        new WorkdirProbeClientError(
          'WORKDIR_PROBE_UNAVAILABLE',
          `probe host postMessage failed: ${String(error)}`,
        ),
      );
    }
  }

  private handleMessage(worker: ProbeWorker, message: unknown): void {
    const entry = worker.active;
    if (!entry || !isProbeResponse(message) || message.id !== entry.id) return;
    if (entry.probeTimer) clearTimeout(entry.probeTimer);
    worker.active = undefined;
    entry.resolve(message.result);
    this.drainQueue();
  }

  private beginWorkerTermination(worker: ProbeWorker, error: WorkdirProbeClientError): void {
    if (worker.terminating) return;
    worker.terminating = true;
    const entry = worker.active;
    worker.active = undefined;
    if (entry?.probeTimer) clearTimeout(entry.probeTimer);
    entry?.reject(error);
    try {
      if (!worker.child.kill()) {
        this.deps.log.warn('workdir probe host kill was not acknowledged; waiting for exit');
      }
    } catch (killError) {
      this.deps.log.warn('failed to request workdir probe host termination; waiting for exit', {
        error: String(killError),
      });
    }
    // The worker remains in this.workers and therefore counts against
    // maxWorkers until Electron confirms exit. This is fail-closed: a process
    // that refuses to exit can reduce availability, but cannot multiply.
  }

  private handleWorkerExit(worker: ProbeWorker): void {
    if (!this.removeWorker(worker)) return;
    const entry = worker.active;
    worker.active = undefined;
    if (entry?.probeTimer) clearTimeout(entry.probeTimer);
    entry?.reject(
      new WorkdirProbeClientError('WORKDIR_PROBE_UNAVAILABLE', 'probe host exited'),
    );
    this.drainQueue();
  }

  private removeWorker(worker: ProbeWorker): boolean {
    const index = this.workers.indexOf(worker);
    if (index < 0) return false;
    this.workers.splice(index, 1);
    return true;
  }

  private remainingMs(entry: ProbeEntry): number {
    return Math.max(0, entry.deadline - Date.now());
  }

  private drainQueue(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const index = this.nextRunnableIndex();
      if (index < 0) return;
      const idle = this.workers.find((worker) => !worker.active && !worker.terminating);
      if (!idle && this.workers.length >= this.maxWorkers) {
        // nextRunnableIndex 已同步校验过空闲槽, 此分支不可达 — 保守起见保持
        // 条目排队而不是突破进程硬上限。
        return;
      }
      const entry = this.queue.splice(index, 1)[0];
      if (idle) {
        this.startProbe(idle, entry);
        continue;
      }
      try {
        this.startProbe(this.createWorker(), entry);
      } catch (error) {
        if (entry.queueTimer) clearTimeout(entry.queueTimer);
        entry.reject(
          new WorkdirProbeClientError(
            'WORKDIR_PROBE_UNAVAILABLE',
            `failed to restart probe host: ${String(error)}`,
          ),
        );
      }
    }
  }

  /**
   * 下一个可启动排队项的下标: kind='probe' 优先于设置类探针 — worker 释放后
   * 不得先启动排在前面的可选设置探针、再次占掉保留容量。返回 -1 = 当前无可
   * 启动项(无空闲槽, 或设置类容量已满需把槽留给 probe)。
   */
  private nextRunnableIndex(): number {
    const probeIndex = this.queue.findIndex((queued) => queued.kind === 'probe');
    if (probeIndex >= 0) {
      // probe 只看空闲槽; 有 probe 在队而槽不空时, 设置类同样无槽可占。
      return this.hasFreeWorker() ? probeIndex : -1;
    }
    const head = this.queue[0];
    if (!head) return -1;
    if (!this.hasFreeWorker() || !this.withinSettingsCapacity(head)) return -1;
    return 0;
  }
}

/** 按 job 收窄结果形态;形态不符(协议违例)按执行边界故障 fail-closed。 */
function asStatResult(result: WorkdirProbeResult): WorkdirProbeStatResult {
  if (result.ok === false) return result;
  return 'isDirectory' in result ? result : { ok: false, code: 'WORKDIR_PROBE_UNAVAILABLE' };
}

function asValidateResult(result: WorkdirProbeResult): WorkdirValidateResult {
  if (result.ok === false) return result;
  return 'realPath' in result ? result : { ok: false, code: 'WORKDIR_PROBE_UNAVAILABLE' };
}

function asAvailabilityResult(result: WorkdirProbeResult): WorkdirAvailabilityResult {
  if (result.ok === false) return result;
  return 'usable' in result ? result : { ok: false, code: 'WORKDIR_PROBE_UNAVAILABLE' };
}

function isProbeResponse(message: unknown): message is WorkdirProbeResponse {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Partial<WorkdirProbeResponse>;
  if (candidate.kind !== 'result' || typeof candidate.id !== 'number') return false;
  const result = candidate.result as Partial<WorkdirProbeResult> | undefined;
  if (!result || typeof result.ok !== 'boolean') return false;
  if (!result.ok) return typeof (result as { code?: unknown }).code === 'string';
  // ok 分支按 job 种类携带 isDirectory / realPath / usable 之一。
  return (
    typeof (result as { isDirectory?: unknown }).isDirectory === 'boolean' ||
    typeof (result as { realPath?: unknown }).realPath === 'string' ||
    typeof (result as { usable?: unknown }).usable === 'boolean'
  );
}
