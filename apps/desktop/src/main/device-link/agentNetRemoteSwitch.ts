/**
 * 被切的电脑一侧：同账号另一台电脑远程打开 / 关闭这台电脑的 Agent-Net
 * (docs/product-rules/agent-net.md「远程切换其他电脑的连接方式」，2026-11-12 用户确认)。
 *
 * - 远程改的就是这台电脑自己的「Agent-Net (Beta)」开关，走与本机开关同一条保存与重连路径(apply)；
 *   「仅使用 Agent-Net」从不远程改，启用时也不接受远程关闭，须先由本机的人解除。
 * - 先回答再切换：切换会重启承载回答的连接，所以回答先发出，APPLY_DELAY_MS 后才切。
 * - 打开时由这台电脑自己兜底：必须在 AGENT_NET_SWITCH_CONFIRM_MS 内收到同一台发起电脑经 Agent-Net
 *   (端到端加密链路)发来的确认，否则自己退回原来的设置。发起端中途关机、断网都不会让这台电脑停在半路。
 *   关闭不需要确认(关闭即回到原路径)。
 * - 待确认的切换记在设置文件里(agentNetPendingSwitch)：应用在等待期间退出或崩溃，下次启动发现记录它的
 *   进程已不在，就直接退回；同一台电脑上另一个仍在运行的实例留给它自己处理。
 * - 这台电脑上的人自己动开关时，以人为准：丢掉待确认的远程切换和「由谁打开」的说明。
 * - 开关下面写「由“某设备”在几点远程打开 / 关闭」(agentNetChangedBy)，退回或本机再改后清除。
 *
 * 准入(同账号、对方开了远程控制、未撤销)由 dispatch 在调用前完成；这里只处理业务。
 */

import {
  AGENT_NET_SWITCH_CONFIRM_MS,
  AGENT_NET_SWITCH_VERSION,
  parseAgentNetSwitchRequest,
  type AgentNetSwitchAccepted,
  type AgentNetSwitchBlock,
  type AgentNetSwitchDisableBlock,
  type AgentNetSwitchConfirmed,
  type AgentNetSwitchErrorCode,
  type AgentNetSwitchStatus,
} from '@cindy/device-link';

export interface AgentNetRemoteChange {
  deviceId: string;
  deviceName: string;
  at: number;
  enabled: boolean;
}

export interface AgentNetPendingSwitch {
  switchId: string;
  controllerId: string;
  /** 切换前的开关值；没确认就回到它。 */
  previous: boolean;
  deadlineAt: number;
  /** 记录这次切换的进程；它不在了就没人能确认，启动时直接退回。 */
  pid: number;
  /** 已开始恢复原设置，不能再确认原来的打开；保留记录直到实际恢复。 */
  restoring?: boolean;
}

export interface AgentNetRemoteSwitchPorts {
  /** 捕获发起时的账号代次；排队、等待落盘或延迟切换后不能借用后来登录的账号执行。 */
  captureScope(): () => void;
  readSettings(): {
    agentNetEnabled?: boolean;
    agentNetOnlyEncrypted?: boolean;
    agentNetChangedBy?: AgentNetRemoteChange | null;
    agentNetPendingSwitch?: AgentNetPendingSwitch | null;
  };
  writeChangedBy(value: AgentNetRemoteChange | null): Promise<void>;
  writePending(value: AgentNetPendingSwitch | null): Promise<void>;
  /** 现在能不能打开 Agent-Net；关闭另受本机「仅使用 Agent-Net」选择约束。 */
  readiness(): AgentNetSwitchBlock | null;
  /** 目标当前网络是否根本没有 Device Link 路线；本机仅加密选择另在此对象内核对。 */
  disableBlock?(): AgentNetSwitchDisableBlock | null;
  /** 与本机开关同一条路径：保存开关并重连。切不了时返回错误码(它自己已恢复原值)。 */
  apply(enabled: boolean): Promise<string | null>;
  /** 这台电脑到 deviceId 的连接此刻是不是 Agent-Net(端到端加密)。 */
  linkIsAgentNet(deviceId: string): boolean;
  now(): number;
  pid: number;
  isProcessAlive(pid: number): boolean;
  log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}

/** 回答先离开这台电脑，再重启连接。 */
export const APPLY_DELAY_MS = 400;
/** 一次恢复的额外重试，避免短暂中转故障留下无人处理的 pending；不是持续轮询。 */
const RESTORE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];

export class AgentNetSwitchError extends Error {
  constructor(readonly code: AgentNetSwitchErrorCode, detail: string) {
    super(`[${code}] ${detail}`);
  }
}

export function createAgentNetRemoteSwitch(ports: AgentNetRemoteSwitchPorts) {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** 切换串行执行：退回不能和还没执行的切换交错。 */
  let applying: Promise<void> = Promise.resolve();
  /** 本机操作取消两个方向上尚未执行的远程切换。 */
  let localChangeEpoch = 0;
  /** 新请求可以替换尚未执行的回调，不靠提前删除恢复记录来取消。 */
  let delayedChangeEpoch = 0;
  const log = ports.log;

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };
  const clearDeadline = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
  };
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = applying.then(task, task);
    applying = next.then(() => undefined, (error: unknown) => { log.warn('remote agent-net switch step failed', { error: String(error) }); });
    return next;
  };
  const serially = (task: () => Promise<void>): Promise<void> => enqueue(task).catch(() => undefined);

  function disableBlock(): AgentNetSwitchDisableBlock | null {
    const settings = ports.readSettings();
    return ports.disableBlock?.() ?? (settings.agentNetEnabled === true && settings.agentNetOnlyEncrypted === true ? 'ENCRYPTION_REQUIRED' : null);
  }

  function status(controllerId?: string): AgentNetSwitchStatus {
    const settings = ports.readSettings();
    return {
      version: AGENT_NET_SWITCH_VERSION,
      enabled: settings.agentNetEnabled === true,
      onlyEncrypted: settings.agentNetEnabled === true && settings.agentNetOnlyEncrypted === true,
      disableBlocked: disableBlock(),
      blocked: ports.readiness(),
      pending: !!settings.agentNetPendingSwitch,
      ...(controllerId ? { encrypted: ports.linkIsAgentNet(controllerId) } : {}),
    };
  }

  /** 没等到确认：回到原来的设置。已确认、已被本机改过或已被新的切换取代时什么都不做。 */
  function revert(switchId: string, reason: 'deadline' | 'interrupted', attempt = 0): Promise<void> {
    return serially(async () => {
      const pending = ports.readSettings().agentNetPendingSwitch;
      if (!pending || pending.switchId !== switchId) return;
      const epoch = localChangeEpoch;
      clearDeadline();
      log.warn('remote agent-net switch was not confirmed; going back', { reason, previous: pending.previous });
      let error: string | null;
      try {
        // 恢复已开始后，迟到的确认不能取消恢复（包括下一次重试）。
        if (!pending.restoring) await ports.writePending({ ...pending, restoring: true });
        error = await ports.apply(pending.previous);
        if (!error) {
          if (ports.readSettings().agentNetPendingSwitch?.switchId !== switchId) return;
          // 恢复完成后再清记录；中途退出，下次启动仍能继续恢复。
          await ports.writeChangedBy(null);
          await ports.writePending(null);
          return;
        }
      } catch {
        error = 'RECOVERY_INTERRUPTED';
      }
      log.warn('going back after an unconfirmed remote agent-net switch failed', { error, attempt });
      if (epoch !== localChangeEpoch || ports.readSettings().agentNetPendingSwitch?.switchId !== switchId) return;
      const delay = RESTORE_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) deadlineTimer = later(() => void revert(switchId, reason, attempt + 1), delay);
    });
  }

  function armDeadline(pending: AgentNetPendingSwitch): void {
    clearDeadline();
    deadlineTimer = later(() => void revert(pending.switchId, 'deadline'), Math.max(0, pending.deadlineAt - ports.now()));
  }

  async function set(enabled: boolean, switchId: string, controllerId: string, controllerName: string, assertScope: () => void): Promise<AgentNetSwitchAccepted> {
    const epoch = localChangeEpoch;
    const offBlock = !enabled ? disableBlock() : null;
    if (offBlock) {
      // 在任何取消、归因或计时器改动之前拒绝，不能用远程总开关绕过本机的加密选择。
      throw new AgentNetSwitchError(offBlock === 'V2_ONLY_RELAY' ? 'AGENT_NET_SWITCH_V2_ONLY_RELAY' : 'AGENT_NET_SWITCH_ENCRYPTION_REQUIRED', 'the target requires Agent-Net');
    }
    let pending = ports.readSettings().agentNetPendingSwitch;
    if (pending) {
      // 同一请求重发(回答在路上丢了)：照原样再答一次，不重复切换。
      if (!pending.restoring && pending.switchId === switchId && pending.controllerId === controllerId && enabled) {
        return { version: AGENT_NET_SWITCH_VERSION, switchId, enabled, confirmWithinMs: Math.max(0, pending.deadlineAt - ports.now()) };
      }
      if (enabled) throw new AgentNetSwitchError('AGENT_NET_SWITCH_BUSY', 'another remote switch is waiting for confirmation');
      // 取消打开，但恢复记录必须留到关闭真正完成，避免退出窗口和关闭失败丢掉兜底。
      pending = { ...pending, restoring: true };
      await ports.writePending(pending);
      // 后续归因落盘或关闭回调创建仍可能失败；原期限必须继续兜底。
      armDeadline(pending);
      assertScope();
    }
    const delayedEpoch = ++delayedChangeEpoch;
    const settings = ports.readSettings();
    if (enabled === (settings.agentNetEnabled === true)) {
      // 取消的是还没执行的打开：开关没变过，「由谁打开」也一并撤掉。
      if (pending) {
        await ports.writePending(null);
        assertScope();
        clearDeadline();
      }
      if (pending && settings.agentNetChangedBy) { await ports.writeChangedBy(null); assertScope(); }
      return { version: AGENT_NET_SWITCH_VERSION, switchId, enabled, confirmWithinMs: null };
    }
    if (enabled) {
      const block = ports.readiness();
      if (block) throw new AgentNetSwitchError('AGENT_NET_SWITCH_NOT_READY', block);
    }
    const now = ports.now();
    let confirmBy: number | null = null;
    if (enabled) {
      const next: AgentNetPendingSwitch = {
        switchId,
        controllerId,
        previous: settings.agentNetEnabled === true,
        deadlineAt: now + APPLY_DELAY_MS + AGENT_NET_SWITCH_CONFIRM_MS,
        pid: ports.pid,
      };
      confirmBy = next.deadlineAt;
      await ports.writePending(next);
      armDeadline(next);
      assertScope();
    }
    await ports.writeChangedBy({ deviceId: controllerId, deviceName: controllerName, at: now, enabled });
    assertScope();
    log.info('remote agent-net switch accepted', { enabled });
    later(() => void serially(async () => {
      assertScope();
      // 回答发出后、真正切换前，这台电脑上的人可能已经自己改了开关：以人为准。
      if (epoch !== localChangeEpoch) return;
      if (delayedEpoch !== delayedChangeEpoch) return;
      if (enabled && ports.readSettings().agentNetPendingSwitch?.switchId !== switchId) return;
      const current = ports.readSettings();
      // 共用同一 profile 的另一实例也能接收本机操作；它清掉归因后，旧回调同样失效。
      const change = current.agentNetChangedBy;
      if (!change || change.deviceId !== controllerId || change.at !== now || change.enabled !== enabled) return;
      if (!enabled && disableBlock()) {
        // 回答离开后的延迟窗口中，本机(含另一实例)也可能刚刚选了仅使用 Agent-Net。
        await ports.writeChangedBy(null);
        assertScope();
        if (pending && current.agentNetPendingSwitch?.switchId === pending.switchId) { await ports.writePending(null); assertScope(); }
        clearDeadline();
        log.info('remote agent-net disable stopped by the target encryption choice');
        return;
      }
      const error = await ports.apply(enabled);
      assertScope();
      if (!error) {
        if (!enabled && pending && ports.readSettings().agentNetPendingSwitch?.switchId === pending.switchId) {
          await ports.writePending(null);
          assertScope();
          clearDeadline();
        }
        return;
      }
      log.warn('remote agent-net switch could not be applied', { error, enabled });
      // 打开失败时 apply 已恢复原值，发起端会核实实际状态后报告结果。
      if (enabled) {
        await ports.writePending(null);
        assertScope();
        clearDeadline();
      } else if (pending && ports.readSettings().agentNetPendingSwitch?.switchId === pending.switchId) {
        // 没关成仍由原期限兜底；恢复中的旧打开不能因迟到的确认重新生效。
        armDeadline(pending);
      }
      await ports.writeChangedBy(null);
      assertScope();
    }), APPLY_DELAY_MS);
    // 与重发回答相同，返回实际剩余期限；发起端才不会在目标的 400ms 延迟窗口之前判定恢复失败。
    return { version: AGENT_NET_SWITCH_VERSION, switchId, enabled, confirmWithinMs: confirmBy === null ? null : Math.max(0, confirmBy - ports.now()) };
  }

  async function confirm(switchId: string, controllerId: string, assertScope: () => void): Promise<AgentNetSwitchConfirmed> {
    const pending = ports.readSettings().agentNetPendingSwitch;
    if (!pending || pending.restoring || ports.now() >= pending.deadlineAt || pending.switchId !== switchId || pending.controllerId !== controllerId) {
      throw new AgentNetSwitchError('AGENT_NET_SWITCH_STALE', 'no matching remote switch is waiting');
    }
    // 只有经 Agent-Net 真的连回来才算数；对方还在重连时会稍后重试。
    if (!ports.linkIsAgentNet(controllerId)) {
      throw new AgentNetSwitchError('AGENT_NET_SWITCH_NOT_ON_AGENT_NET', 'confirmation must arrive over Agent-Net');
    }
    await ports.writePending(null);
    assertScope();
    clearDeadline();
    log.info('remote agent-net switch confirmed');
    return { version: AGENT_NET_SWITCH_VERSION, switchId, confirmed: true };
  }

  return {
    status,
    /** dispatch 已完成同账号与远程控制准入；controllerId 是中转盖章的来源。 */
    async handle(raw: unknown, controllerId: string, controllerName: string): Promise<AgentNetSwitchStatus | AgentNetSwitchAccepted | AgentNetSwitchConfirmed> {
      const request = parseAgentNetSwitchRequest(raw);
      if (!request) throw new AgentNetSwitchError('AGENT_NET_SWITCH_INVALID', 'invalid request');
      if (request.action === 'status') return status(controllerId);
      const assertScope = ports.captureScope();
      if (request.action === 'set') {
        const epoch = localChangeEpoch;
        return enqueue(() => {
          assertScope();
          if (epoch !== localChangeEpoch) throw new AgentNetSwitchError('AGENT_NET_SWITCH_STALE', 'a local change took precedence');
          return set(request.enabled, request.switchId, controllerId, controllerName, assertScope);
        });
      }
      return enqueue(() => { assertScope(); return confirm(request.switchId, controllerId, assertScope); });
    },
    /**
     * 启动时调用：记录切换的进程已经不在，就没人能确认了，直接退回；仍在运行的另一个实例留给它；
     * 本进程自己的记录(不该出现)按原期限继续等。
     */
    async recover(): Promise<void> {
      const pending = ports.readSettings().agentNetPendingSwitch;
      if (!pending) return;
      if (pending.pid === ports.pid) {
        armDeadline(pending);
        return;
      }
      if (ports.isProcessAlive(pending.pid)) return;
      await revert(pending.switchId, 'interrupted');
    },
    /** 本机修改也在同一队列中执行；成功接手之后才清待确认记录，失败仍由设备恢复。 */
    async onLocalChange(change: () => Promise<boolean> = async () => true): Promise<void> {
      const assertScope = ports.captureScope();
      localChangeEpoch++;
      await enqueue(async () => {
        assertScope();
        const settings = ports.readSettings();
        // 先取消其它实例尚未执行的回调；保存/重连成功后才丢掉恢复记录。
        if (settings.agentNetChangedBy) { await ports.writeChangedBy(null); assertScope(); }
        const applied = await change(); assertScope();
        if (!applied) {
          const pending = ports.readSettings().agentNetPendingSwitch;
          if (pending) armDeadline(pending);
          return;
        }
        if (settings.agentNetPendingSwitch && ports.readSettings().agentNetPendingSwitch?.switchId === settings.agentNetPendingSwitch.switchId) {
          await ports.writePending(null); assertScope();
        }
        clearDeadline();
      }).catch((error: unknown) => {
        // 正在恢复的操作可能已因本机代次变化停掉重试；取消没落盘时重新接回设备兜底。
        const pending = ports.readSettings().agentNetPendingSwitch;
        if (pending) armDeadline(pending);
        throw error;
      });
    },
  };
}

export type AgentNetRemoteSwitch = ReturnType<typeof createAgentNetRemoteSwitch>;
