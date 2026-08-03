import { describe, expect, it, vi } from 'vitest';

import {
  checkContactsAiSessionBeforeSend,
  contactsAiSessionBlockMessageKey,
} from '../contacts/contactsAiSessionGuard';

const ready = {
  enabled: true,
  pluginEnabled: true,
  codexMcpReady: true,
};

describe('contacts AI session send guard', () => {
  it('统一映射发送与新建目标的阻断提示', () => {
    expect(contactsAiSessionBlockMessageKey('unavailable')).toBe(
      'settings.contacts.toast.aiUnavailable',
    );
    expect(contactsAiSessionBlockMessageKey('codex-deferred')).toBe(
      'settings.contacts.toast.codexRefreshDeferred',
    );
  });

  it('普通新任务不读取通讯录状态', async () => {
    const readReadiness = vi.fn(async () => ready);

    await expect(
      checkContactsAiSessionBeforeSend({
        entryIntent: null,
        vendor: 'codex',
        workingDir: '/project',
        isLocalTarget: true,
        readReadiness,
      }),
    ).resolves.toBeNull();
    expect(readReadiness).not.toHaveBeenCalled();
  });

  it('按发送时最终项目重读 override，项目启用可覆盖全局关闭，项目关闭也能覆盖全局开启', async () => {
    const readReadiness = vi
      .fn()
      .mockResolvedValueOnce({ ...ready, codexMcpReady: false })
      .mockResolvedValueOnce({ ...ready, pluginEnabled: false });

    // Claude 不受 Codex applied 快照影响；最终项目有效启用即可发送。
    await expect(
      checkContactsAiSessionBeforeSend({
        entryIntent: 'contacts-ai-management',
        vendor: 'cc',
        workingDir: '/project-enabled',
        isLocalTarget: true,
        readReadiness,
      }),
    ).resolves.toBeNull();
    // 反向 override 必须 fail closed。
    await expect(
      checkContactsAiSessionBeforeSend({
        entryIntent: 'contacts-ai-management',
        vendor: 'cc',
        workingDir: '/project-disabled',
        isLocalTarget: true,
        readReadiness,
      }),
    ).resolves.toBe('unavailable');
    expect(readReadiness).toHaveBeenNthCalledWith(1, '/project-enabled');
    expect(readReadiness).toHaveBeenNthCalledWith(2, '/project-disabled');
  });

  it('只在实际 vendor 为 Codex 时服从 applied readiness，并在每次发送时重读', async () => {
    const readReadiness = vi
      .fn()
      .mockResolvedValueOnce({ ...ready, codexMcpReady: false })
      .mockResolvedValueOnce(ready);
    const input = {
      entryIntent: 'contacts-ai-management' as const,
      vendor: 'codex' as const,
      workingDir: '/project',
      isLocalTarget: true,
      readReadiness,
    };

    await expect(checkContactsAiSessionBeforeSend(input)).resolves.toBe('codex-deferred');
    await expect(checkContactsAiSessionBeforeSend(input)).resolves.toBeNull();
    expect(readReadiness).toHaveBeenCalledTimes(2);
  });

  it('切到远端目标后不拿本机通讯录状态放行', async () => {
    const readReadiness = vi.fn(async () => ready);

    await expect(
      checkContactsAiSessionBeforeSend({
        entryIntent: 'contacts-ai-management',
        vendor: 'cc',
        workingDir: '/remote/project',
        isLocalTarget: false,
        readReadiness,
      }),
    ).resolves.toBe('unavailable');
    expect(readReadiness).not.toHaveBeenCalled();
  });
});
