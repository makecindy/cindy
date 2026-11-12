/**
 * 测试价值
 * - 生产入口与可观察结果：createAgentNetRemoteSwitch(...).handle / recover / onLocalChange(dispatch 与本机开关
 *   调用的同一个对象);观察被切电脑最终的 Agent-Net 开关值、待确认记录与「由谁打开」记录，以及回给发起端的错误码。
 * - 规则依据：docs/product-rules/agent-net.md「远程切换其他电脑的连接方式」(2026-11-12 用户确认)——
 *   打开后期限内没经 Agent-Net 收到同一发起端确认就由被切电脑自己退回；本机的人改开关以人为准；
 *   应用中途退出后启动即退回；打不开时不切。
 * - 现有覆盖缺口：新增能力，无相邻测试；dispatch 准入(同账号 / 远程控制 / 撤销)沿用已有 dispatch 测试。
 * - 最小失败输入：set(enabled) 后不 confirm 并越过期限；confirm 来自另一台电脑或经 Device Link；
 *   待确认期间本机改开关；记录的 pid 已不在时 recover。
 * - tier：unit(内存端口 + 假时钟，不碰文件、网络与 Electron)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_NET_SWITCH_CONFIRM_MS } from '@cindy/device-link';

import { APPLY_DELAY_MS, createAgentNetRemoteSwitch, type AgentNetPendingSwitch, type AgentNetRemoteChange, type AgentNetRemoteSwitchPorts } from '../agentNetRemoteSwitch.js';

const CONTROLLER = 'controller-device';
const SWITCH = 'switch-0001';

function setup(initial: { enabled?: boolean; onlyEncrypted?: boolean; relayOnly?: boolean; pending?: AgentNetPendingSwitch; pid?: number } = {}) {
  const settings: {
    agentNetEnabled: boolean;
    agentNetOnlyEncrypted: boolean;
    agentNetChangedBy: AgentNetRemoteChange | null;
    agentNetPendingSwitch: AgentNetPendingSwitch | null;
  } = { agentNetEnabled: initial.enabled ?? false, agentNetOnlyEncrypted: initial.onlyEncrypted ?? false, agentNetChangedBy: null, agentNetPendingSwitch: initial.pending ?? null };
  const agentNetLinks = new Set<string>();
  const alive = new Set<number>();
  let block: 'NOT_SIGNED_IN' | null = null;
  const apply = vi.fn(async (enabled: boolean): Promise<string | null> => { settings.agentNetEnabled = enabled; return null; });
  const writePending = vi.fn(async (value: AgentNetPendingSwitch | null) => { settings.agentNetPendingSwitch = value; });
  const writeChangedBy = vi.fn(async (value: AgentNetRemoteChange | null) => { settings.agentNetChangedBy = value; });
  const ports: AgentNetRemoteSwitchPorts = {
    captureScope: () => () => {},
    readSettings: () => settings,
    writeChangedBy,
    writePending,
    readiness: () => block,
    disableBlock: () => initial.relayOnly ? 'V2_ONLY_RELAY' : null,
    apply,
    linkIsAgentNet: (deviceId) => agentNetLinks.has(deviceId),
    now: () => Date.now(),
    pid: initial.pid ?? 100,
    isProcessAlive: (pid) => alive.has(pid),
    log: { info: () => undefined, warn: () => undefined },
  };
  const service = createAgentNetRemoteSwitch(ports);
  const turnOn = () => service.handle({ action: 'set', enabled: true, switchId: SWITCH }, CONTROLLER, 'Studio Mac');
  return { service, anotherInstance: () => createAgentNetRemoteSwitch(ports), settings, agentNetLinks, alive, apply, writePending, writeChangedBy, blockWith: (value: 'NOT_SIGNED_IN') => { block = value; }, turnOn };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('remote Agent-Net switch on the switched computer', () => {
  // 独立审查 #10095：V2-only 网络不受 Beta 开关影响，远程关闭不能伪装成切回 V1。
  it('refuses a switch-back on an Agent-Net-only relay even when the user preference is not strict', async () => {
    const { service, settings, apply } = setup({ enabled: true, relayOnly: true });
    expect(service.status()).toMatchObject({ disableBlocked: 'V2_ONLY_RELAY' });
    await expect(service.handle({ action: 'set', enabled: false, switchId: SWITCH }, CONTROLLER, 'Studio Mac')).rejects.toThrow('[AGENT_NET_SWITCH_V2_ONLY_RELAY]');
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    expect(settings.agentNetEnabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  // 2026-11-12 用户裁决：本机选择仅使用 Agent-Net 后，必须先在本机解除，远程关闭不能降级连接。
  it('requires the target to release its encrypted-only choice before a remote disable', async () => {
    const { service, settings, apply } = setup({ enabled: true, onlyEncrypted: true });
    const disable = () => service.handle({ action: 'set', enabled: false, switchId: SWITCH }, CONTROLLER, 'Studio Mac');
    await expect(disable()).rejects.toThrow('[AGENT_NET_SWITCH_ENCRYPTION_REQUIRED]');
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    expect(apply).not.toHaveBeenCalled();
    expect(settings).toMatchObject({ agentNetEnabled: true, agentNetOnlyEncrypted: true, agentNetPendingSwitch: null, agentNetChangedBy: null });
    await service.onLocalChange();
    settings.agentNetOnlyEncrypted = false;
    await expect(disable()).resolves.toMatchObject({ enabled: false });
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    expect(settings.agentNetEnabled).toBe(false);
  });

  it('rechecks the target encryption choice before an accepted delayed disable applies', async () => {
    const { service, settings, apply } = setup({ enabled: true });
    await service.handle({ action: 'set', enabled: false, switchId: SWITCH }, CONTROLLER, 'Studio Mac');
    settings.agentNetOnlyEncrypted = true;
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    expect(apply).not.toHaveBeenCalled();
    expect(settings).toMatchObject({ agentNetEnabled: true, agentNetOnlyEncrypted: true, agentNetChangedBy: null });
  });

  it('answers before switching, then goes back by itself when no confirmation arrives', async () => {
    const { settings, turnOn } = setup();
    await expect(turnOn()).resolves.toMatchObject({ switchId: SWITCH, enabled: true, confirmWithinMs: AGENT_NET_SWITCH_CONFIRM_MS + APPLY_DELAY_MS });
    // 回答时还没切：切换会重启承载回答的连接。
    expect(settings.agentNetEnabled).toBe(false);
    expect(settings.agentNetChangedBy).toMatchObject({ deviceId: CONTROLLER, deviceName: 'Studio Mac', enabled: true });
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    expect(settings.agentNetEnabled).toBe(true);
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null, agentNetChangedBy: null });
  });

  it('only counts a confirmation from the same computer over Agent-Net before its deadline', async () => {
    const { service, settings, agentNetLinks, turnOn } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    const confirm = (from: string) => service.handle({ action: 'confirm', switchId: SWITCH }, from, 'x');
    await expect(confirm('someone-else')).rejects.toThrow('[AGENT_NET_SWITCH_STALE]');
    await expect(confirm(CONTROLLER)).rejects.toThrow('[AGENT_NET_SWITCH_NOT_ON_AGENT_NET]');
    agentNetLinks.add(CONTROLLER);
    await expect(confirm(CONTROLLER)).resolves.toMatchObject({ confirmed: true });
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS * 2);
    expect(settings).toMatchObject({ agentNetEnabled: true, agentNetPendingSwitch: null });
    // 「由谁打开」保留到本机再改。
    expect(settings.agentNetChangedBy).toMatchObject({ enabled: true });
    // 计时回调被队列/启动工作推迟时，过期记录也不能接受确认。
    const expired = setup({ enabled: true, pending: { switchId: SWITCH, controllerId: CONTROLLER, previous: false, deadlineAt: Date.now() - 1, pid: 100 } });
    expired.agentNetLinks.add(CONTROLLER);
    await expect(expired.service.handle({ action: 'confirm', switchId: SWITCH }, CONTROLLER, 'Studio Mac')).rejects.toThrow('[AGENT_NET_SWITCH_STALE]');
  });

  it('retains the recovery timer when saving the confirmation temporarily fails', async () => {
    const { service, settings, agentNetLinks, turnOn, writePending } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    agentNetLinks.add(CONTROLLER);
    writePending.mockRejectedValueOnce(new Error('temporary settings write failure'));
    await expect(service.handle({ action: 'confirm', switchId: SWITCH }, CONTROLLER, 'Studio Mac')).rejects.toThrow('temporary settings write failure');
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  it('lets the person at the computer win while a remote switch waits', async () => {
    const { service, settings, turnOn } = setup();
    await turnOn();
    await service.onLocalChange();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS + AGENT_NET_SWITCH_CONFIRM_MS);
    // 还没执行的打开被跳过，期限到了也不再改开关。
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null, agentNetChangedBy: null });
  });

  it('does not apply a delayed remote disable after the person at the computer keeps Agent-Net on', async () => {
    const { service, settings } = setup({ enabled: true });
    await service.handle({ action: 'set', enabled: false, switchId: SWITCH }, CONTROLLER, 'Studio Mac');
    await service.onLocalChange();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    expect(settings).toMatchObject({ agentNetEnabled: true, agentNetPendingSwitch: null, agentNetChangedBy: null });
  });

  // 独立重审 E：dev/release 共用 profile；另一实例的本机开关也必须取消尚未执行的远程关闭。
  it('honors a local change in another instance before the delayed remote disable starts', async () => {
    const { service, anotherInstance, settings, apply } = setup({ enabled: true });
    await service.handle({ action: 'set', enabled: false, switchId: SWITCH }, CONTROLLER, 'Studio Mac');
    const local = anotherInstance();
    await local.onLocalChange(); settings.agentNetEnabled = false;
    await vi.advanceTimersByTimeAsync(100);
    await local.onLocalChange(); settings.agentNetEnabled = true;
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS - 100);
    expect(settings).toMatchObject({ agentNetEnabled: true, agentNetChangedBy: null });
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses to turn on when the computer cannot, and allows another computer only to turn it off', async () => {
    const blocked = setup();
    blocked.blockWith('NOT_SIGNED_IN');
    await expect(blocked.turnOn()).rejects.toThrow('[AGENT_NET_SWITCH_NOT_READY]');
    expect(blocked.settings).toMatchObject({ agentNetPendingSwitch: null, agentNetChangedBy: null });

    const { service, settings, turnOn } = setup();
    await turnOn();
    await expect(service.handle({ action: 'set', enabled: true, switchId: 'switch-0002' }, 'other', 'x')).rejects.toThrow('[AGENT_NET_SWITCH_BUSY]');
    // 关闭总是可以，并取消还没执行的打开。
    await expect(service.handle({ action: 'set', enabled: false, switchId: 'switch-0003' }, 'other', 'x')).resolves.toMatchObject({ confirmWithinMs: null });
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS + AGENT_NET_SWITCH_CONFIRM_MS);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null, agentNetChangedBy: null });
  });

  it('keeps recovery protection while an accepted disable has not yet undone a pending enable', async () => {
    const original = setup();
    await original.turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    await original.service.handle({ action: 'set', enabled: false, switchId: 'switch-disable' }, CONTROLLER, 'Studio Mac');
    expect(original.settings.agentNetPendingSwitch).toMatchObject({ switchId: SWITCH, previous: false, restoring: true });
    original.agentNetLinks.add(CONTROLLER);
    await expect(original.service.handle({ action: 'confirm', switchId: SWITCH }, CONTROLLER, 'Studio Mac')).rejects.toThrow('[AGENT_NET_SWITCH_STALE]');
    const restarted = setup({ enabled: true, pending: original.settings.agentNetPendingSwitch!, pid: 101 });
    await restarted.service.recover();
    expect(restarted.settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  it('retains the deadline when disabling an unconfirmed enable fails', async () => {
    const { service, settings, turnOn, apply } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    apply.mockResolvedValueOnce('START_FAILED');
    await service.handle({ action: 'set', enabled: false, switchId: 'switch-disable' }, CONTROLLER, 'Studio Mac');
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    expect(settings).toMatchObject({ agentNetEnabled: true, agentNetPendingSwitch: { switchId: SWITCH, restoring: true } });
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  // 独立重审 REPRO C：归因落盘失败发生在关闭回调创建之前，不能丢掉原期限。
  it('retains automatic recovery when recording a pending disable fails', async () => {
    const { service, settings, turnOn, writeChangedBy } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    writeChangedBy.mockRejectedValueOnce(new Error('temporary attribution write failure'));
    await expect(service.handle({ action: 'set', enabled: false, switchId: 'switch-disable-write' }, CONTROLLER, 'Studio Mac')).rejects.toThrow('temporary attribution write failure');
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS + 15_000);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  it('preserves recovery and reports failure when cancelling the pending record for a local change fails', async () => {
    const { service, settings, turnOn, writePending } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    writePending.mockRejectedValueOnce(new Error('temporary cancellation write failure'));
    await expect(service.onLocalChange()).rejects.toThrow('temporary cancellation write failure');
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS + 15_000);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  // 本机保存/重连失败不是成功接管，不能提前清掉未确认远程打开的恢复记录。
  it('retains recovery when applying the local selection fails', async () => {
    const { service, settings, turnOn } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    await service.onLocalChange(async () => false);
    expect(settings.agentNetPendingSwitch).not.toBeNull();
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS + 15_000);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  // 本机请求在恢复执行中排队，恢复和取消均失败时仍须兜底；已有用例没有这次队列交错。
  it('rearms recovery when both an in-flight restore and its queued local cancellation fail', async () => {
    const { service, settings, turnOn, apply, writePending } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    let finish!: (error: string | null) => void;
    apply.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS);
    writePending.mockRejectedValueOnce(new Error('temporary cancellation write failure'));
    const local = service.onLocalChange().catch((error: unknown) => error);
    finish('START_FAILED');
    expect(await local).toMatchObject({ message: 'temporary cancellation write failure' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  it('keeps the pending record if restoring the original setting is interrupted, so the next process can recover', async () => {
    const original = setup();
    await original.turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    original.apply.mockRejectedValueOnce(new Error('interrupted before the original setting was restored'));
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS);
    expect(original.settings.agentNetPendingSwitch).toMatchObject({ switchId: SWITCH, previous: false });
    const restarted = setup({ enabled: true, pending: original.settings.agentNetPendingSwitch!, pid: 101 });
    await restarted.service.recover();
    expect(restarted.settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  // #10095 discussion_r4546598399：一次恢复失败不能留下只有重启才能重试的 pending。
  it('retries a failed automatic restore and rejects late confirmation while restoring', async () => {
    const { service, settings, turnOn, apply, agentNetLinks } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    apply.mockResolvedValueOnce('START_FAILED');
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS);
    expect(settings).toMatchObject({ agentNetEnabled: true, agentNetPendingSwitch: { restoring: true } });
    agentNetLinks.add(CONTROLLER);
    await expect(service.handle({ action: 'confirm', switchId: SWITCH }, CONTROLLER, 'Studio Mac')).rejects.toThrow('[AGENT_NET_SWITCH_STALE]');
    await vi.advanceTimersToNextTimerAsync();
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });

  it('stops automatic retries after a persistent restore failure without losing the recovery record', async () => {
    const { settings, turnOn, apply } = setup();
    await turnOn();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    apply.mockResolvedValue('START_FAILED');
    await vi.runAllTimersAsync();
    expect(settings).toMatchObject({ agentNetEnabled: true, agentNetPendingSwitch: { restoring: true } });
    expect(apply.mock.calls.filter(([enabled]) => !enabled).length).toBeGreaterThan(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('goes back on start-up when the process that waited for confirmation is gone', async () => {
    const pending = (pid: number): AgentNetPendingSwitch => ({ switchId: SWITCH, controllerId: CONTROLLER, previous: false, deadlineAt: Date.now() + 30_000, pid });
    const otherInstance = setup({ enabled: true, pending: pending(200) });
    otherInstance.alive.add(200);
    await otherInstance.service.recover();
    expect(otherInstance.settings).toMatchObject({ agentNetEnabled: true, agentNetPendingSwitch: { pid: 200 } });

    const crashed = setup({ enabled: true, pending: pending(200) });
    await crashed.service.recover();
    expect(crashed.settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null });
  });
});
