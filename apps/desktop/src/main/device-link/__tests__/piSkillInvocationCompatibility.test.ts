import { DeviceLinkError } from '@cindy/device-link';
import { describe, expect, it, vi } from 'vitest';

import { handleInvoke, type DeviceLinkIpcDeps } from '../ipc.js';

function depsForInvoke(invoke: DeviceLinkIpcDeps['invoke']): DeviceLinkIpcDeps {
  return {
    getState: () => ({ disabledControlDeviceIds: [] }) as never,
    invoke,
  } as unknown as DeviceLinkIpcDeps;
}

function queuedSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = '/demo inspect @file';
  const agentReferences = [{
    kind: 'project',
    start: 14,
    end: 19,
    href: 'cindy://project/example',
    name: 'file',
    workingDir: '/example',
  }];
  const pastedTextRanges = [{ start: 6, end: 13, display: 'inspect' }];
  const slashCommandRanges = [{ start: 0, end: 5 }];
  return {
    text,
    persistedContent: JSON.stringify({
      text,
      agentReferences,
      pastedTextRanges,
      slashCommandRanges,
      unrelated: { keep: true },
    }),
    agentReferences,
    chatMessage: {
      content: text,
      agentReferences,
      pastedTextRanges,
      slashCommandRanges,
      clientId: 'message-1',
      role: 'user',
    },
    createOpts: { agentKind: 'pi' },
    agentSkillInvocation: {
      name: 'demo',
      runtimeCommandName: 'skill:runtime-demo',
      scope: 'user',
      sourcePath: '/skills/demo',
    },
    clientId: 'message-1',
    ...overrides,
  };
}

describe('device-link Pi Skill invocation compatibility', () => {
  it('preserves the visible alias and receipt for a target that validates them', async () => {
    const item = queuedSkill();
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockResolvedValueOnce({
        ok: true,
        result: { supportsPiSkillInvocationReceipt: true },
      })
      .mockResolvedValueOnce({ ok: true, result: { accepted: true } });

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:enqueue', [
        'target-session',
        item,
      ]),
    ).resolves.toEqual({ accepted: true });

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'target-device',
      'maker:get-capabilities',
      ['pi'],
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'target-device',
      'maker:input:enqueue',
      ['target-session', item],
    );
  });

  it('rewrites only the wire copy for an older enqueue target and keeps the receipt', async () => {
    const item = queuedSkill();
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockResolvedValueOnce({ ok: true, result: { availableModels: [] } })
      .mockResolvedValueOnce({ ok: true, result: { accepted: true } });

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:enqueue', [
        'target-session',
        item,
      ]),
    ).resolves.toEqual({ accepted: true });

    const wireItem = invoke.mock.calls[1]?.[2][1] as Record<string, unknown>;
    expect(wireItem).not.toBe(item);
    expect(wireItem.text).toBe('/skill:runtime-demo inspect @file');
    expect(wireItem.agentSkillInvocation).toEqual((item as Record<string, unknown>)
      .agentSkillInvocation);
    expect(wireItem.agentReferences).toEqual([
      expect.objectContaining({ start: 28, end: 33 }),
    ]);
    expect(wireItem.chatMessage).toEqual(expect.objectContaining({
      content: '/skill:runtime-demo inspect @file',
      agentReferences: [expect.objectContaining({ start: 28, end: 33 })],
      pastedTextRanges: [expect.objectContaining({ start: 20, end: 27 })],
      slashCommandRanges: [{ start: 0, end: 19 }],
    }));
    const persisted = JSON.parse(wireItem.persistedContent as string) as Record<string, unknown>;
    expect(persisted).toEqual(expect.objectContaining({
      text: '/skill:runtime-demo inspect @file',
      agentReferences: [expect.objectContaining({ start: 28, end: 33 })],
      pastedTextRanges: [expect.objectContaining({ start: 20, end: 27 })],
      slashCommandRanges: [{ start: 0, end: 19 }],
      unrelated: { keep: true },
    }));
    expect(item).toEqual(queuedSkill());
  });

  it('applies the same legacy wire rewrite to steer', async () => {
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: { accepted: true } });

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:steer', [
        'target-session',
        queuedSkill(),
      ]),
    ).resolves.toEqual({ accepted: true });

    expect(invoke.mock.calls[1]?.[1]).toBe('maker:input:steer');
    expect((invoke.mock.calls[1]?.[2][1] as Record<string, unknown>).text)
      .toBe('/skill:runtime-demo inspect @file');
  });

  it('does not send the queued item when capability discovery times out', async () => {
    const item = queuedSkill();
    const invoke = vi
      .fn<DeviceLinkIpcDeps['invoke']>()
      .mockRejectedValue(new DeviceLinkError('INVOKE_TIMEOUT', 'slow'));

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:enqueue', [
        'target-session',
        item,
      ]),
    ).rejects.toThrow('[DEVICE_LINK_TIMEOUT]');

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(item).toEqual(queuedSkill());
  });

  it('does not send the queued item when the declared capability is malformed', async () => {
    const invoke = vi.fn<DeviceLinkIpcDeps['invoke']>().mockResolvedValue({
      ok: true,
      result: { supportsPiSkillInvocationReceipt: 'yes' },
    });

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:enqueue', [
        'target-session',
        queuedSkill(),
      ]),
    ).rejects.toThrow('[DEVICE_LINK_VERSION_MISMATCH]');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps a malformed receipt fail-closed for an older target', async () => {
    const item = queuedSkill({
      agentSkillInvocation: {
        name: 'demo',
        runtimeCommandName: 'skill:../other',
      },
    });
    const invoke = vi.fn<DeviceLinkIpcDeps['invoke']>().mockResolvedValue({ ok: true, result: {} });

    await expect(
      handleInvoke(depsForInvoke(invoke), 'target-device', 'maker:input:enqueue', [
        'target-session',
        item,
      ]),
    ).rejects.toThrow('[DEVICE_LINK_VERSION_MISMATCH]');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(item).toEqual(queuedSkill({
      agentSkillInvocation: {
        name: 'demo',
        runtimeCommandName: 'skill:../other',
      },
    }));
  });
});
