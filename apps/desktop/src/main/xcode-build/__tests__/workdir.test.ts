import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionRowSnapshotStrict = vi.hoisted(() => vi.fn());
vi.mock('../../localDb/ipc/sessions.js', () => ({ getSessionRowSnapshotStrict }));

import { assertXcodeBuildSessionWorkdir } from '../workdir.js';

/**
 * 测试价值
 * - 生产入口与可观察结果：Xcode IPC 的本地会话归属校验，决定工具栏能否发现并启动工程。
 * - Bug／规则依据：本地工程使用远程模型执行位置时，旧校验错误拒绝 Xcode 功能。
 * - 现有覆盖缺口：Xcode 构建测试覆盖了发现与执行，但未覆盖会话归属校验。
 * - 最小失败输入：local workingDir + agentDeviceId，及 remoteHostId。
 * - tier：unit。
 */
describe('Xcode session workdir guard', () => {
  beforeEach(() => getSessionRowSnapshotStrict.mockReset());

  it('allows a local workspace when only the agent runs remotely', async () => {
    getSessionRowSnapshotStrict.mockResolvedValue({
      workingDir: '/repo',
      remoteHostId: null,
      agentDeviceId: 'model-device',
    });

    await expect(assertXcodeBuildSessionWorkdir('session-1', '/repo')).resolves.toBeUndefined();
  });

  it('rejects an SSH workspace', async () => {
    getSessionRowSnapshotStrict.mockResolvedValue({
      workingDir: '/repo',
      remoteHostId: 'ssh-host',
      agentDeviceId: null,
    });

    await expect(assertXcodeBuildSessionWorkdir('session-1', '/repo')).rejects.toThrow(
      'UNSUPPORTED_CAPABILITY',
    );
  });
});
