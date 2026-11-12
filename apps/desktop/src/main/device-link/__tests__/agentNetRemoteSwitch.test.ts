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

import { APPLY_DELAY_MS, createAgentNetRemoteSwitch, type AgentNetPendingSwitch, type AgentNetRemoteChange } from '../agentNetRemoteSwitch.js';

const CONTROLLER = 'controller-device';
const SWITCH = 'switch-0001';

function setup(initial: { enabled?: boolean; onlyEncrypted?: boolean; pending?: AgentNetPendingSwitch; pid?: number } = {}) {
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
  const service = createAgentNetRemoteSwitch({
    readSettings: () => settings,
    writeChangedBy: async (value) => { settings.agentNetChangedBy = value; },
    writePending: async (value) => { settings.agentNetPendingSwitch = value; },
    readiness: () => block,
    apply,
    linkIsAgentNet: (deviceId) => agentNetLinks.has(deviceId),
    now: () => Date.now(),
    pid: initial.pid ?? 100,
    isProcessAlive: (pid) => alive.has(pid),
    log: { info: () => undefined, warn: () => undefined },
  });
  const turnOn = () => service.handle({ action: 'set', enabled: true, switchId: SWITCH }, CONTROLLER, 'Studio Mac');
  return { service, settings, agentNetLinks, alive, apply, blockWith: (value: 'NOT_SIGNED_IN') => { block = value; }, turnOn };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('remote Agent-Net switch on the switched computer', () => {
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
    await expect(turnOn()).resolves.toMatchObject({ switchId: SWITCH, enabled: true, confirmWithinMs: AGENT_NET_SWITCH_CONFIRM_MS });
    // 回答时还没切：切换会重启承载回答的连接。
    expect(settings.agentNetEnabled).toBe(false);
    expect(settings.agentNetChangedBy).toMatchObject({ deviceId: CONTROLLER, deviceName: 'Studio Mac', enabled: true });
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MS);
    expect(settings.agentNetEnabled).toBe(true);
    await vi.advanceTimersByTimeAsync(AGENT_NET_SWITCH_CONFIRM_MS);
    expect(settings).toMatchObject({ agentNetEnabled: false, agentNetPendingSwitch: null, agentNetChangedBy: null });
  });

  it('only counts a confirmation from the same computer over Agent-Net', async () => {
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
