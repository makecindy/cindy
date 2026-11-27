import { describe, expect, it } from 'vitest';
import { stampSharedTaskInput, assertSharedTaskQueueMutation } from '../sharedTaskInput.js';
import type { SharedTaskPeerCapture } from '../../device-link/sharedTaskDispatch.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

const author = { sharedTaskId: 'sharedTask', sessionId: 'task', memberId: 'guest-id', accountId: 'guest', displayName: 'Guest' };
const capture: SharedTaskPeerCapture = { author, isCurrent: () => true, authorize: () => true };
const item = { clientId: 'message', text: 'hello', persistedContent: 'hello',
  permissionMode: 'bypassPermissions', workingDir: 'untrusted', model: 'untrusted', effort: 'untrusted',
  createOpts: { agentKind: 'pi', workingDir: 'untrusted', permissionMode: 'bypassPermissions', model: 'untrusted', vendorOptions: { extraDirs: ['private'] } },
  vendorOptions: { extraDirs: ['private'] }, userName: 'Owner',
  chatMessage: { clientId: 'message', role: 'user', content: 'hello' },
} satisfies AgentInputQueuedMessage;

describe('sharedTask input uses the task Agent authority', () => {
  it.each(['ask', 'bypassPermissions'])('keeps the host permission mode %s, without a guest policy', (permissionMode) => {
    const task = { agentKind: 'pi' as const, workingDir: 'host-workdir', model: 'host-model', permissionMode };
    const result = stampSharedTaskInput(item, capture, task);
    expect(result.createOpts).toEqual(task);
    expect(result.permissionMode).toBe(permissionMode);
    expect(result.workingDir).toBe('host-workdir');
    expect(result.model).toBe('host-model');
    expect(result.effort).toBe('');
    expect(result).not.toHaveProperty('vendorOptions');
    expect(result).not.toHaveProperty('turnPermissionPolicy');
    expect(result.sharedTaskAuthor).toEqual(author);
    expect(result.userName).toBe('Guest');
  });
  it('strips guest-supplied device / plugin sources; the guest is attributed by sharedTaskAuthor only', () => {
    const task = { agentKind: 'pi' as const, workingDir: 'host-workdir', model: 'host-model', permissionMode: 'ask' };
    const result = stampSharedTaskInput({
      ...item,
      sourceDevice: { deviceId: 'forged', platform: 'mobile' },
      sourcePlugin: { pluginId: 'forged' },
      agentOmitsTriggerPrefix: true,
    }, capture, task);
    expect(result).not.toHaveProperty('sourceDevice');
    expect(result).not.toHaveProperty('sourcePlugin');
    expect(result).not.toHaveProperty('agentOmitsTriggerPrefix');
    expect(result.sharedTaskAuthor).toEqual(author);
  });
  it('strips a forged author from ordinary local input and rejects revoked preparation', () => {
    expect(stampSharedTaskInput({ ...item, sharedTaskAuthor: author }, undefined, undefined)).not.toHaveProperty('sharedTaskAuthor');
    expect(() => stampSharedTaskInput(item, { ...capture, isCurrent: () => false }, item.createOpts)).toThrow();
  });
  it('allows editing only the original membership own pending message, rechecking revocation', () => {
    const owned = { ...item, sharedTaskAuthor: author };
    expect(() => assertSharedTaskQueueMutation(capture, 'task', 'input.edit', owned)).not.toThrow();
    expect(() => assertSharedTaskQueueMutation(capture, 'task', 'input.withdraw', item)).toThrow();
    expect(() => assertSharedTaskQueueMutation(capture, 'task', 'input.edit', { ...owned, sharedTaskAuthor: { ...author, memberId: 'retired-member' } })).toThrow();
    expect(() => assertSharedTaskQueueMutation({ ...capture, isCurrent: () => false }, 'task', 'input.edit', owned)).toThrow();
    expect(() => assertSharedTaskQueueMutation(undefined, 'task', 'input.edit', owned)).not.toThrow();
  });

  // 生产入口：stampSharedTaskInput / assertSharedTaskQueueMutation 在共享任务跑在插件引擎(acp)上时的真实盖章与撤权守卫。
  // 规则依据：docs/dev-rules/protocol-compatibility/plugin-harnesses.md（共享任务保留宿主 acp 引擎、providerId、model、effort 与 agentDeviceId，剥离访客覆盖并维持撤权隔离）。
  // 覆盖缺口：此前 sharedTaskInput 仅断言内置 pi 引擎，未覆盖 agentKind='acp' + providerId + effort + agentDeviceId 盖章与撤权拒绝。
  // 最小失败输入与 tier：unit；访客伪造 claude-code / 覆盖 providerId 与 model 时宿主盖章必须保持 acp 真值，撤权后立即拒绝。
  it('preserves host-owned acp engine configuration on shared task input while stripping guest overrides', () => {
    const acpTask = {
      agentKind: 'acp' as const,
      workingDir: 'host-acp-workdir',
      model: 'gemini-2.5-pro',
      providerId: 'acp-plugin:agy:agy',
      effort: 'high',
      permissionMode: 'ask',
      agentDeviceId: 'device-remote-1',
    };
    const forgedGuestItem: AgentInputQueuedMessage = {
      ...item,
      createOpts: {
        agentKind: 'claude-code',
        workingDir: 'forged-dir',
        model: 'forged-model',
        providerId: 'forged-provider',
        permissionMode: 'bypassPermissions',
        vendorOptions: { extraDirs: ['private'] },
      },
      sourceDevice: { deviceId: 'forged', platform: 'mobile' },
      sourcePlugin: { pluginId: 'forged' },
    };

    const stamped = stampSharedTaskInput(forgedGuestItem, capture, acpTask);
    expect(stamped.createOpts).toEqual(acpTask);
    expect(stamped.workingDir).toBe('host-acp-workdir');
    expect(stamped.model).toBe('gemini-2.5-pro');
    expect(stamped.effort).toBe('high');
    expect(stamped.permissionMode).toBe('ask');
    expect(stamped.sharedTaskAuthor).toEqual(author);
    expect(stamped.userName).toBe('Guest');
    expect(stamped).not.toHaveProperty('vendorOptions');
    expect(stamped).not.toHaveProperty('sourceDevice');
    expect(stamped).not.toHaveProperty('sourcePlugin');

    expect(() =>
      stampSharedTaskInput(forgedGuestItem, { ...capture, isCurrent: () => false }, acpTask),
    ).toThrow(/PERMISSION_DENIED/);
    expect(() =>
      assertSharedTaskQueueMutation({ ...capture, isCurrent: () => false }, 'task', 'input.withdraw', stamped),
    ).toThrow(/PERMISSION_DENIED/);
  });
});
