/**
 * Lead 所在电脑：协同远端 Worker 的宿主装配。
 *
 *  - 可选运行设备：同账号、在线、对方开启远程控制、本机允许控制的桌面电脑；逐台探测能力，
 *    旧版本标为需要更新(只读，控制端也经 `maker:orca:execution-devices` 读同一份)；
 *  - 创建：在运行设备上 open 任务，本机写一条不跑 Agent 的代理任务行，登记到运行时轮询；
 *  - 运行：把 OrcaTeamService 的会话依赖按「是否远端 Worker」分流——派活、停止、存活查询
 *    走运行设备，其余(计槽、回报、状态机)沿用现有实现；
 *  - 结束：归档或结束团队时通知运行设备 release，失败的留待重连后补发。
 */
import { createId } from '@paralleldrive/cuid2';
import {
  DeviceLinkError,
  ORCA_REMOTE_WORKER_CAPS_CHANNEL,
  ORCA_REMOTE_WORKER_OPEN_CHANNEL,
  type InvokeResultPayload,
  type OrcaExecutionDeviceView,
  type OrcaRemoteWorkerOpenResult as DeviceOpenResult,
} from '@cindy/device-link';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import type { AgentKind } from '@cindy/maker-core';

import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import {
  archiveSingleWorkerSession,
  getRemoteWorkerByProxySession,
  listActiveRemoteWorkers,
  listUnreleasedEndedRemoteWorkers,
  markWorkerRemoteReleased,
  markWorkerRemoteStopConfirmed,
  getWorkerRemoteReleaseState,
  saveWorkerRemoteReport,
  saveRemoteWorkerOpen,
  removeRemoteWorkerOpen,
  listOrphanRemoteWorkerOpens,
  addRemoteWorker,
  removeWorker,
} from '../localDb/orcaTeamStore.js';
import { createHostSendFailure } from '../maker-host/send-outcome.js';
import type {
  OrcaRemoteWorkerOpenResult,
  OrcaWorkerCreationDeps,
  OrcaWorkerCreationErrorCode,
} from './orcaWorkerCreationService.js';
import {
  createOrcaRemoteWorkerRuntime,
  type OrcaRemoteWorkerRuntime,
  type RemoteWorkerTurnEnd,
} from './orcaRemoteWorkerRuntime.js';
import type { OrcaTeamService, OrcaTeamServiceDeps } from './orcaTeamService.js';
import { runAcceptedRollback } from './acceptedCallbackRunner.js';

const CAPS_PROBE_TIMEOUT_MS = 5_000;
const RELEASE_RETRY_MS = 5 * 60_000;
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const REMOTE_DIR_ERRORS = new Set([
  'REMOTE_WORKDIR_NOT_FOUND',
  'REMOTE_WORKDIR_NOT_DIRECTORY',
  'REMOTE_WORKDIR_INVALID',
  'REMOTE_WORKDIR_UNAVAILABLE',
]);

export interface OrcaRemoteWorkersDeps {
  getOwnerToken?(): unknown;
  remoteInvoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
  listDevices(): Promise<{ devices: DeviceLinkDeviceView[] }>;
  /** 事件回调需要的团队服务；创建顺序上晚于本模块，按需取。 */
  getTeamService(): OrcaTeamService | null;
  broadcastOrcaWorkerChanged(leadSessionId: string): void;
  readLeadTitle(leadSessionId: string): Promise<string>;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** 把隧道结果统一成「成功返回值 / 抛出带 `[CODE]` 的错误」，保留 inFlight 标记。 */
export async function invokeDeviceValue(
  remoteInvoke: OrcaRemoteWorkersDeps['remoteInvoke'],
  deviceId: string,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  let result: InvokeResultPayload;
  try {
    result = await remoteInvoke(deviceId, channel, args);
  } catch (err) {
    if (err instanceof DeviceLinkError) {
      throw Object.assign(new Error(`[${err.code}] ${err.message}`), {
        inFlight: err.inFlight === true,
      });
    }
    throw err;
  }
  if (result.ok) return result.result;
  const code =
    result.error.code === 'IPC_ERROR'
      ? (/^\[([A-Z_]+)\]/.exec(result.error.message)?.[1] ?? 'IPC_ERROR')
      : result.error.code;
  throw new Error(`[${code}] ${result.error.message}`);
}

function codeOf(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  return /^\[([A-Z_]+)\]/.exec(message)?.[1] ?? null;
}

export function isExecutionDeviceCandidate(device: DeviceLinkDeviceView): boolean {
  return (
    device.online &&
    device.remoteControlEnabled &&
    device.controlEnabled &&
    !device.isSelf &&
    !isMobilePlatform(device.platform)
  );
}

export function createOrcaRemoteWorkers(deps: OrcaRemoteWorkersDeps) {
  const deviceNames = new Map<string, string>();
  const opening = new Set<string>();
  const releases = new Map<string, Promise<void>>();
  const creationOwners = new Map<string, unknown>();
  const openLocks = new Map<string, Promise<unknown>>();
  let releaseRetryTimer: ReturnType<typeof setInterval> | null = null;
  let startInFlight: { owner: unknown; promise: Promise<void> } | null = null;
  const ownerToken = () => (deps.getOwnerToken ? deps.getOwnerToken() : deps);
  let activeOwner: unknown = ownerToken();
  const ownerCurrent = () => activeOwner === ownerToken();
  const assertOwner = (owner: unknown) => {
    if (owner !== ownerToken() || owner !== activeOwner)
      throw new Error('remote worker owner changed');
  };
  const invoke = async (deviceId: string, channel: string, args: unknown[]) => {
    const owner = ownerToken();
    if (!ownerCurrent()) throw new Error('remote worker owner changed');
    const value = await invokeDeviceValue(deps.remoteInvoke, deviceId, channel, args);
    if (owner !== ownerToken()) throw new Error('remote worker owner changed');
    return value;
  };
  const nameOf = (deviceId: string) => deviceNames.get(deviceId) || '另一台电脑';

  async function withOpenLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = openLocks.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    openLocks.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (openLocks.get(sessionId) === operation) openLocks.delete(sessionId);
    }
  }

  const runtime: OrcaRemoteWorkerRuntime = createOrcaRemoteWorkerRuntime({
    invoke,
    deviceName: nameOf,
    saveReport: saveWorkerRemoteReport,
    isOwnerCurrent: ownerCurrent,
    onTurnStarted: async (proxySessionId) => {
      await deps.getTeamService()?.handleWorkerTurnStarted(proxySessionId);
    },
    captureTurnEnded: (proxySessionId) => {
      const service = deps.getTeamService();
      const capture = service?.captureWorkerTerminalTurn(proxySessionId);
      const owner = ownerToken();
      return async (turn: RemoteWorkerTurnEnd) => {
        if (!service || !capture || owner !== ownerToken()) return false;
        await service.handleWorkerTerminalTurn({
          sessionId: proxySessionId,
          status: turn.status,
          finalText: turn.finalText,
          capture,
          ...(turn.diagnostic ? { diagnostic: turn.diagnostic } : {}),
        });
        return (
          owner === ownerToken() &&
          service.captureWorkerTerminalTurn(proxySessionId).autoBridgeIdentity !==
            capture.autoBridgeIdentity
        );
      };
    },
    onWorkerStateChanged: deps.broadcastOrcaWorkerChanged,
    now: Date.now,
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: deps.log,
  });

  async function refreshDeviceNames(): Promise<DeviceLinkDeviceView[]> {
    const { devices } = await deps.listDevices();
    for (const device of devices) if (device.name) deviceNames.set(device.deviceId, device.name);
    return devices;
  }

  async function probeSupported(deviceId: string): Promise<boolean | null> {
    try {
      await Promise.race([
        invoke(deviceId, ORCA_REMOTE_WORKER_CAPS_CHANNEL, []),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('[INVOKE_TIMEOUT] caps probe timed out')),
            CAPS_PROBE_TIMEOUT_MS,
          ).unref?.(),
        ),
      ]);
      return true;
    } catch (err) {
      return codeOf(err) === 'CHANNEL_NOT_ALLOWED' ? false : null;
    }
  }

  function releaseAndMark(row: {
    workerId: string;
    deviceId: string;
    remoteSessionId: string;
    remoteStopConfirmedAt?: number | null;
  }): Promise<void> {
    const existing = releases.get(row.workerId);
    if (existing) return existing;
    const owner = ownerToken();
    const operation = (async () => {
      if (!ownerCurrent()) return;
      // 归档与重连补发共用单飞入口；在入口内读最新阶段，不能沿用排队前的行快照。
      const phase = await getWorkerRemoteReleaseState(row.workerId);
      if (!phase || phase.remoteReleasedAt || owner !== ownerToken()) return;
      if (!phase.remoteStopConfirmedAt) {
        if (!(await runtime.abortRemote(row)) || owner !== ownerToken()) return;
        await markWorkerRemoteStopConfirmed(row.workerId);
      }
      if (owner !== ownerToken()) return;
      if (await runtime.release(row)) {
        if (owner === ownerToken()) {
          await markWorkerRemoteReleased(row.workerId);
          if (phase.removeAfterRelease && owner === ownerToken()) await removeWorker(row.workerId);
        }
      }
    })();
    releases.set(row.workerId, operation);
    return operation.finally(() => {
      if (releases.get(row.workerId) === operation) releases.delete(row.workerId);
    });
  }

  async function retryPendingReleases(): Promise<void> {
    const owner = ownerToken();
    const rows = await listUnreleasedEndedRemoteWorkers().catch(() => []);
    if (owner !== ownerToken()) return;
    await Promise.all(
      rows.map((row) =>
        releaseAndMark(row).catch((err) =>
          deps.log.warn('orca remote worker: release retry failed', {
            workerId: row.workerId,
            err: String(err),
          }),
        ),
      ),
    );
    const orphans = await listOrphanRemoteWorkerOpens().catch(() => []);
    if (owner !== ownerToken()) return;
    for (const row of orphans) {
      if (opening.has(row.remoteSessionId) || owner !== ownerToken()) continue;
      try {
        await withOpenLock(row.remoteSessionId, async () => {
          assertOwner(owner);
          if (opening.has(row.remoteSessionId)) return;
          // 查询结果可能早于 record，锁内重新核对，且与关联操作共用同一把锁。
          const [candidate] = await listOrphanRemoteWorkerOpens(row.remoteSessionId);
          assertOwner(owner);
          if (!candidate) return;
          const session = await invoke(row.deviceId, 'local-db:sessions:get', [
            row.remoteSessionId,
          ]);
          if (session) {
            // 未关联的 open 从未由 Lead 派活，仅解除标记，保留用户可能已启动的普通工作。
            if (await runtime.release(row)) {
              if (owner === ownerToken()) await removeRemoteWorkerOpen(row.remoteSessionId);
            }
          } else if (Date.now() - row.createdAt > 24 * 60 * 60_000) {
            // 未发出请求的预写身份也会残留；在线核对一天仍不存在后才删除。
            if (owner === ownerToken()) await removeRemoteWorkerOpen(row.remoteSessionId);
          }
        });
      } catch {
        /* 设备恢复后再核对，不把超时当作未创建。 */
      }
    }
  }

  async function restore(owner: unknown): Promise<void> {
    if (activeOwner !== owner) {
      releases.clear();
      opening.clear();
    }
    activeOwner = owner;
    runtime.reset();
    if (releaseRetryTimer) clearInterval(releaseRetryTimer);
    releaseRetryTimer = null;
    const rows = await listActiveRemoteWorkers();
    if (owner !== ownerToken() || owner !== activeOwner) return;
    for (const row of rows) {
      if (row.pendingReport)
        deps.getTeamService()?.restoreWorkerPendingReport(row.proxySessionId, row);
      runtime.track(row);
    }
    void refreshDeviceNames().catch(() => undefined);
    void retryPendingReleases();
    // 结束通知在运行设备离线时发不出去；低频补发，送达即记账，不重复。
    releaseRetryTimer = setInterval(() => void retryPendingReleases(), RELEASE_RETRY_MS);
    releaseRetryTimer.unref?.();
  }

  return {
    runtime,

    /**
     * 按当前账号恢复待回报与结束通知；同一数据库 owner 重入不清除现有派活。
     */
    start,
    isRemoteWorker,

    stop(): void {
      activeOwner = Symbol('stopped');
      runtime.stop();
      if (releaseRetryTimer) clearInterval(releaseRetryTimer);
      releaseRetryTimer = null;
    },

    deviceName: nameOf,

    async listExecutionDevices(): Promise<OrcaExecutionDeviceView[]> {
      const devices = (await refreshDeviceNames()).filter(isExecutionDeviceCandidate);
      const supported = await Promise.all(devices.map((device) => probeSupported(device.deviceId)));
      return devices
        .flatMap((device, index) =>
          supported[index] === null
            ? []
            : [
                {
                  deviceId: device.deviceId,
                  name: device.name,
                  platform: device.platform,
                  supported: supported[index] === true,
                },
              ],
        )
        .sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name));
    },
    async openRemoteWorker(
      input: Parameters<NonNullable<OrcaWorkerCreationDeps['openRemoteWorker']>>[0],
    ): Promise<OrcaRemoteWorkerOpenResult> {
      const owner = ownerToken();
      assertOwner(owner);
      const devices = await refreshDeviceNames().catch(() => null);
      assertOwner(owner);
      const device = devices?.find((item) => item.deviceId === input.deviceId);
      if (devices && (!device || !isExecutionDeviceCandidate(device))) {
        return {
          ok: false,
          errorCode: 'REMOTE_AGENT_DEVICE_UNREACHABLE',
          message: `${device?.name ?? '指定的电脑'} 当前不可用：需要在线，且已开启「允许远程控制」。`,
        };
      }
      const name = nameOf(input.deviceId);
      const supported = await probeSupported(input.deviceId);
      assertOwner(owner);
      if (supported === false) {
        return {
          ok: false,
          errorCode: 'UNSUPPORTED_CAPABILITY',
          message: `${name} 的 Cindy 版本过旧，需要更新后才能运行协同 Worker。`,
        };
      }
      if (supported === null) {
        return {
          ok: false,
          errorCode: 'REMOTE_AGENT_DEVICE_UNREACHABLE',
          message: `${name} 当前不可达，Worker 没有创建。`,
        };
      }
      const remoteSessionId = createId();
      let opened: DeviceOpenResult | undefined;
      let uncertainOpen = false;
      await saveRemoteWorkerOpen(input.deviceId, remoteSessionId);
      assertOwner(owner);
      opening.add(remoteSessionId);
      try {
        const openArgs = [
          {
            sessionId: remoteSessionId,
            agentKind: input.agent,
            ...(input.model ? { model: input.model } : {}),
            ...(input.providerId ? { providerId: input.providerId } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.fast !== undefined ? { fastMode: input.fast } : {}),
            permissionMode: input.permissionMode,
            ...(input.workingDir ? { workingDir: input.workingDir } : {}),
            title: input.title,
            lead: {
              leadSessionId: input.leadSessionId,
              leadTitle: await deps.readLeadTitle(input.leadSessionId).catch(() => ''),
              workerLabel: input.label,
            },
          },
        ];
        assertOwner(owner);
        try {
          opened = (await invoke(
            input.deviceId,
            ORCA_REMOTE_WORKER_OPEN_CHANNEL,
            openArgs,
          )) as DeviceOpenResult;
        } catch (err) {
          if (codeOf(err) !== 'INVOKE_TIMEOUT' && (err as { inFlight?: boolean }).inFlight !== true)
            throw err;
          uncertainOpen = true;
          // open 以 sessionId 幂等：丢失回执时复用同一身份，不创建第二个远端任务。
          opened = (await invoke(
            input.deviceId,
            ORCA_REMOTE_WORKER_OPEN_CHANNEL,
            openArgs,
          )) as DeviceOpenResult;
        }
      } catch (err) {
        const code = codeOf(err);
        if (
          !uncertainOpen &&
          owner === ownerToken() &&
          (code === 'CHANNEL_NOT_ALLOWED' || code === 'ALREADY_EXISTS') &&
          (err as { inFlight?: boolean }).inFlight !== true
        ) {
          // 仅未进入 open 的通道拒绝或已存在的其他任务可直接清理。
          // 普通启动错误可能发生在 INSERT 之后，保留收据供恢复核对并解除标记。
          await removeRemoteWorkerOpen(remoteSessionId);
        }
        if (code === 'CHANNEL_NOT_ALLOWED' && input.workingDir) {
          return {
            ok: false,
            errorCode: 'INVALID_PARAMS',
            message: `${name} 上找不到这个目录或不允许使用：${input.workingDir}。Worker 没有创建。`,
          };
        }
        if (
          code === 'INVALID_PARAMS' ||
          code === 'WORKDIR_NOT_FOUND' ||
          code === 'NOT_A_DIRECTORY' ||
          (code !== null && REMOTE_DIR_ERRORS.has(code))
        ) {
          return {
            ok: false,
            errorCode:
              code !== null && REMOTE_DIR_ERRORS.has(code)
                ? (code as Extract<OrcaWorkerCreationErrorCode, `REMOTE_WORKDIR_${string}`>)
                : 'INVALID_PARAMS',
            message: `${name} 拒绝了创建请求：${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (code === 'CHANNEL_NOT_ALLOWED') {
          return {
            ok: false,
            errorCode: 'UNSUPPORTED_CAPABILITY',
            message: `${name} 的 Cindy 版本过旧，需要更新后才能运行协同 Worker。`,
          };
        }
        deps.log.warn('orca remote worker: open failed', { deviceId: input.deviceId, code });
        return {
          ok: false,
          errorCode:
            !uncertainOpen &&
            (code === 'INVOKE_TIMEOUT' || code === 'DEVICE_OFFLINE' || code === 'LINK_NOT_OPEN')
              ? 'REMOTE_AGENT_DEVICE_UNREACHABLE'
              : 'INTERNAL',
          message: uncertainOpen
            ? `无法确认 ${name} 上的创建结果，尚未派活。连接恢复后会核对并解除未关联任务的协同标记。`
            : `在 ${name} 上创建 Worker 失败：${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        if (!opened) opening.delete(remoteSessionId);
      }
      const proxySessionId = createId();
      const agent: AgentKind = opened.agentKind ?? input.agent;
      // open 与关联之间尚未创建本机代理，退出后只需按持久 open 身份解除远端标记。
      assertOwner(owner);
      const proxySession = {
        title: input.title,
        agentKind: agent === 'claude-code' ? 'cc' : agent,
        model: opened.model || input.model || '',
        effort: opened.effort !== undefined
          ? opened.effort
          : input.effort && EFFORTS.has(input.effort) ? input.effort : null,
        permissionMode: input.permissionMode,
        fastMode: opened.fastMode ?? (input.fast === true),
      };
      creationOwners.set(proxySessionId, owner);
      return {
        ok: true,
        proxySessionId,
        proxySession,
        remoteSessionId: opened.sessionId || remoteSessionId,
        agent,
        model: opened.model,
        workingDir: opened.workingDir,
      };
    },

    async recordRemoteWorker(
      input: Parameters<NonNullable<OrcaWorkerCreationDeps['recordRemoteWorker']>>[0],
    ) {
      const owner = creationOwners.has(input.proxySessionId)
        ? creationOwners.get(input.proxySessionId)
        : deps.getOwnerToken
          ? Symbol('unknown creation')
          : ownerToken();
      await withOpenLock(input.remoteSessionId, async () => {
        assertOwner(owner);
        await addRemoteWorker(input);
        assertOwner(owner);
        opening.delete(input.remoteSessionId);
        const { workingDir, proxySession: _proxySession, label: _label, role: _role, ...ref } = input;
        runtime.track({ ...ref, lastBridgedMessageId: null }, { workingDir });
        deps.broadcastOrcaWorkerChanged(input.leadSessionId);
        creationOwners.delete(input.proxySessionId);
      });
    },

    async discardRemoteWorker(input: {
      proxySessionId: string;
      deviceId: string;
      remoteSessionId: string;
    }) {
      const owner = creationOwners.has(input.proxySessionId)
        ? creationOwners.get(input.proxySessionId)
        : deps.getOwnerToken
          ? Symbol('unknown creation')
          : ownerToken();
      if (owner !== ownerToken() || !ownerCurrent()) return;
      await withOpenLock(input.remoteSessionId, async () => {
        assertOwner(owner);
        opening.delete(input.remoteSessionId);
        const row = await getRemoteWorkerByProxySession(input.proxySessionId);
        assertOwner(owner);
        if (row && row.deviceId === input.deviceId && row.remoteSessionId === input.remoteSessionId) {
          await removeWorker(row.workerId);
          assertOwner(owner);
          runtime.untrack(input.proxySessionId);
          await releaseAndMark(row);
          creationOwners.delete(input.proxySessionId);
          return;
        }
        // 关联事务失败时没有新代理；ID 冲突也不能归档或取消已有任务的路由。
        if (await runtime.release(input)) {
          assertOwner(owner);
          await removeRemoteWorkerOpen(input.remoteSessionId);
        }
        assertOwner(owner);
        creationOwners.delete(input.proxySessionId);
      });
    },

    archive,
    wrapTeamDeps,
    async rollbackCreatedWorker(proxySessionId: string): Promise<boolean> {
      const owner = ownerToken();
      assertOwner(owner);
      const row = await getRemoteWorkerByProxySession(proxySessionId);
      assertOwner(owner);
      if (!row) return false;
      // removeWorker 的事务保留未释放路由；重连补发成功后才删除回滚行。
      await removeWorker(row.workerId);
      assertOwner(owner);
      runtime.untrack(proxySessionId);
      await releaseAndMark(row);
      return true;
    },

    /** 团队结束后：停掉仍在跑的远端 Worker，并补发全部未送达的结束通知。 */
    async releaseEnded(proxySessionIds: readonly string[]): Promise<void> {
      assertOwner(ownerToken());
      for (const id of proxySessionIds) runtime.untrack(id);
      await retryPendingReleases();
    },
  };

  async function start(): Promise<void> {
    const owner = ownerToken();
    if (startInFlight && startInFlight.owner === owner) return startInFlight.promise;
    if (releaseRetryTimer && owner === activeOwner) return;
    const promise = restore(owner);
    startInFlight = { owner, promise };
    try {
      await promise;
    } finally {
      if (startInFlight?.promise === promise) startInFlight = null;
    }
  }

  /** 恢复尚未完成或查询失败时不得把未知代理回退到本机。 */
  async function isRemoteWorker(sessionId: string): Promise<boolean> {
    const owner = ownerToken();
    if (!runtime.isRemote(sessionId) || !ownerCurrent()) await start();
    assertOwner(owner);
    if (runtime.isRemote(sessionId)) return true;
    const row = await getRemoteWorkerByProxySession(sessionId);
    assertOwner(owner);
    return row !== null;
  }

  /** 归档或结束团队：通知运行设备结束协同(任务保留)，本机归档代理行。 */
  async function archive(
    proxySessionId: string,
    beforeMutation?: () => Promise<void>,
  ): Promise<void> {
    const owner = ownerToken();
    assertOwner(owner);
    const row = await getRemoteWorkerByProxySession(proxySessionId);
    assertOwner(owner);
    await archiveSingleWorkerSession(proxySessionId, async () => {
      await beforeMutation?.();
      assertOwner(owner);
    });
    assertOwner(owner);
    runtime.untrack(proxySessionId);
    if (row) await releaseAndMark(row);
  }

  /**
   * 包装 OrcaTeamService 的会话依赖：远端 Worker 的代理任务在本机永远不跑 Agent，
   * 涉及会话的操作改走运行设备；其余依赖原样透传。
   */
  function wrapTeamDeps(base: OrcaTeamServiceDeps): OrcaTeamServiceDeps {
    const remote = (sessionId: string) => runtime.isRemote(sessionId);
    const wrapped: OrcaTeamServiceDeps = {
      ...base,
      // 远端 Worker 在本机永远没有活会话；只有运行设备正在跑时才视为在线，
      // 否则按「已恢复」派发(恢复本身是空操作)，wake_kind 与实际一致。
      getLiveSession: (sessionId) =>
        remote(sessionId)
          ? runtime.isTurnRunning(sessionId)
            ? { isTurnRunning: () => true }
            : null
          : base.getLiveSession(sessionId),
      resumeWorkerSession: async (worker, link) => {
        if (await isRemoteWorker(worker.sessionId)) return;
        await base.resumeWorkerSession(worker, link);
      },
      closeWorkerSession: async (sessionId, beforeClose) => {
        if (!(await isRemoteWorker(sessionId))) return base.closeWorkerSession(sessionId, beforeClose);
        await beforeClose?.();
        await runtime.abort(sessionId);
      },
      closeWorkerSessionIfIdle: async (sessionId, sendLockHeld) =>
        (await isRemoteWorker(sessionId))
          ? !runtime.isTurnRunning(sessionId)
          : base.closeWorkerSessionIfIdle(sessionId, sendLockHeld),
      hasPendingWorkerInput: async (sessionId) =>
        (await isRemoteWorker(sessionId))
          ? runtime.hasPendingReport(sessionId)
          : base.hasPendingWorkerInput(sessionId),
      archiveWorkerSession: async (sessionId, beforeMutation) => {
        if (!(await isRemoteWorker(sessionId))) return base.archiveWorkerSession(sessionId, beforeMutation);
        await archive(sessionId, beforeMutation);
      },
      dispatchWorkerMessage: async (params) => {
        if (!(await isRemoteWorker(params.targetSessionId))) return base.dispatchWorkerMessage(params);
        // 与本机派发复用同一会话锁，保持 enqueue 与 accepted/commit 身份的顺序一致。
        return base.withSessionSendLock(params.targetSessionId, async () => {
          const clientId = createId();
          const meta = { source: params.dispatchMeta.source, context: params.dispatchMeta.context };
          let acceptedDidRun = false;
          let rollbackDidRun = false;
          const rollbackAccepted = async () => {
            if (!acceptedDidRun || rollbackDidRun) return;
            rollbackDidRun = true;
            await runAcceptedRollback(params.onAcceptedRollback, params.targetSessionId, clientId, deps.log);
          };
          try {
            const result = await runtime.dispatch({
              proxySessionId: params.targetSessionId,
              rawContent: params.message,
              clientId,
              beforeEnqueue: async () => {
                if (!params.onAccepted) return;
                acceptedDidRun = true;
                await params.onAccepted();
              },
            });
            if (!result.ok) {
              await rollbackAccepted();
              return {
                ok: false,
                dispatchOutcome: {
                  ...createHostSendFailure(
                    result.code === 'DEVICE_UNREACHABLE'
                      ? 'HOST_NOT_READY'
                      : result.code === 'SESSION_NOT_FOUND'
                        ? 'SESSION_NOT_FOUND'
                        : 'SEND_FAILED',
                    result.message,
                  ),
                  ...meta,
                },
              };
            }
            await params.onAcceptedCommit?.();
            runtime.confirmDispatchAccepted(params.targetSessionId, clientId);
            return {
              ok: true,
              mode: result.mode,
              clientId,
              dispatchOutcome:
                result.mode === 'queued'
                  ? {
                      kind: 'session-dispatch',
                      source: meta.source,
                      dispatched: true,
                      wakeKind: 'queued',
                    }
                  : { kind: 'session-dispatch', source: meta.source, dispatched: true },
              targetTitle: null,
              targetLastUserSendAt: null,
            };
          } catch (err) {
            await runtime.rejectDispatchAcceptance(params.targetSessionId, clientId).catch((rollbackError) =>
              deps.log.warn('orca remote worker: acceptance rollback persistence failed', {
                workerId: params.workerId,
                err: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              }),
            );
            await rollbackAccepted();
            throw err;
          }
        });
      },
      reserveWorkerMessage: async (params) => {
        if (!(await isRemoteWorker(params.targetSessionId))) return base.reserveWorkerMessage(params);
        // 打断改派：先停远端当前一轮，再把新指令作为下一条派过去。
        await params.beforeReserve?.();
        // TeamService 的 onReserved 已发起停止；等待同一次请求，不能再发第二次 abort。
        if (params.onReserved) await params.onReserved();
        else await runtime.abort(params.targetSessionId);
        return wrapped.dispatchWorkerMessage({
          targetSessionId: params.targetSessionId,
          message: params.message,
          workerId: params.workerId,
          dispatchMeta: params.dispatchMeta,
          onAccepted: params.onAccepted,
          onAcceptedRollback: params.onAcceptedRollback,
          onAcceptedCommit: params.onAcceptedCommit,
        });
      },
      requestWorkerInterrupt: async (sessionId) => {
        if (!(await isRemoteWorker(sessionId))) return base.requestWorkerInterrupt(sessionId);
        const requested = await runtime.abort(sessionId);
        return { stopOutcome: requested ? 'requested' : 'unconfirmed', queuePaused: false };
      },
      getWorkerQueuePaused: (sessionId) =>
        remote(sessionId) ? false : base.getWorkerQueuePaused(sessionId),
      getSessionQueueSnapshot: async (sessionId) =>
        (await isRemoteWorker(sessionId))
          ? {
              pendingQueue: [],
              steeringClientIds: [],
              consumingClientIds: [],
              inspectionMessages: [],
              isWorking: runtime.isTurnRunning(sessionId),
              willQueue: runtime.isTurnRunning(sessionId),
              queuePaused: false,
            }
          : base.getSessionQueueSnapshot(sessionId),
      ensureWorkerQueueRestored: async (sessionId) =>
        (await isRemoteWorker(sessionId)) ? false : base.ensureWorkerQueueRestored(sessionId),
      removeQueuedMessage: (sessionId, clientId, expected) =>
        remote(sessionId) ? false : base.removeQueuedMessage(sessionId, clientId, expected),
      replaceQueuedMessage: (sessionId, clientId, next, expected) =>
        remote(sessionId) ? false : base.replaceQueuedMessage(sessionId, clientId, next, expected),
      steerStoredQueuedMessage: async (sessionId, clientId) =>
        (await isRemoteWorker(sessionId))
          ? { kind: 'queued', reason: 'STEER_UNSUPPORTED' }
          : base.steerStoredQueuedMessage(sessionId, clientId),
      moveQueuedMessage: (sessionId, clientId, position) =>
        remote(sessionId) ? null : base.moveQueuedMessage(sessionId, clientId, position),
      mergeQueuedMessages: (sessionId, clientIds, buildReplacement) =>
        remote(sessionId)
          ? false
          : base.mergeQueuedMessages(sessionId, clientIds, buildReplacement),
    };
    return wrapped;
  }
}

export type OrcaRemoteWorkers = ReturnType<typeof createOrcaRemoteWorkers>;
