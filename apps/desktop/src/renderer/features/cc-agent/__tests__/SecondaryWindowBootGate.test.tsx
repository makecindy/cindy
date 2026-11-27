// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBootDeviceId: vi.fn<() => string | null>(),
  getBootSessionId: vi.fn<() => string | null>(),
  getBootMessageClientId: vi.fn<() => string | null>(),
  getVisibleMergedRemoteSessions: vi.fn<() => Array<Record<string, unknown>>>(),
  getSessionFor: vi.fn(),
  navigate: vi.fn(),
  addSessionDetail: vi.fn(),
  resolveSessionRoute: vi.fn(),
}));

vi.mock('@/lib/sessionService', async (original) => ({
  ...await original<typeof import('@/lib/sessionService')>(),
  resolveReferences: async ([sessionId]: string[]) => [{ sessionId, state: 'missing' }],
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/lib/secondaryWindow', () => ({
  getBootDeviceId: mocks.getBootDeviceId,
  getBootSessionId: mocks.getBootSessionId,
  getBootMessageClientId: mocks.getBootMessageClientId,
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
  remoteProjectsStore: {
    getDeviceList: () => [{ deviceId: 'device-remote', deviceName: 'Remote Mac' }],
    getDeviceName: () => 'Host',
    captureSessionRead: () => Object.assign(() => true, { mergeActivity: (row: unknown) => row }),
    getDeviceSessions: mocks.getVisibleMergedRemoteSessions,
    getVisibleMergedRemoteSessions: mocks.getVisibleMergedRemoteSessions,
    pinSessionOrigin: vi.fn(),
    addSessionDetail: mocks.addSessionDetail,
  },
}));

vi.mock('@/lib/makerTransport', () => ({
  getSessionOnDevice: mocks.getSessionFor,
}));

vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: mocks.resolveSessionRoute,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { rememberCreatedTaskWorkspace } from '@/state/lastCreatedTaskWorkspace';
import { SecondaryWindowBootGate } from '../SecondaryWindowBootGate';

describe('SecondaryWindowBootGate', () => {
  beforeEach(() => {
    mocks.getBootDeviceId.mockReset();
    mocks.getBootSessionId.mockReset();
    mocks.getBootMessageClientId.mockReturnValue(null);
    mocks.getVisibleMergedRemoteSessions.mockReset();
    mocks.getSessionFor.mockReset();
    mocks.navigate.mockReset();
    mocks.addSessionDetail.mockReset();
    mocks.resolveSessionRoute.mockReset();
    mocks.getBootSessionId.mockReturnValue('worker-remote');
    mocks.getBootDeviceId.mockReturnValue('device-remote');
    mocks.getVisibleMergedRemoteSessions.mockReturnValue([]);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    setDataOwnerGeneration(null);
  });

  // 测试价值:
  // - 生产入口与可观察结果: SecondaryWindowBootGate；验证 `?bootSession=/cc-agent/new` 的副窗直接落到
  //   `/cc-agent/new` 并还原通用新建的路由状态（上次创建工作区、本机继承或远程设备继承），不触发会话解析。
  // - Bug／规则依据: 左侧导航「新建」支持在新窗口打开，新建副窗需与同窗点击「新建」保持一致的默认工作区行为。
  // - 现有覆盖缺口: 此前仅覆盖任务与 /bots/* 副窗，未覆盖 /cc-agent/new 启动目标与 bootDevice 透传。
  // - 最小失败输入: bootSession='/cc-agent/new' 且 bootDevice 为 null / 'local' / 'device-remote'。
  // - tier: unit（jsdom）。
  it('opens /cc-agent/new directly and preserves generic workspace and device inheritance state', async () => {
    mocks.getBootSessionId.mockReturnValue('/cc-agent/new');
    mocks.getBootDeviceId.mockReturnValue(null);
    setDataOwnerGeneration('owner-boot', 1);
    rememberCreatedTaskWorkspace('owner-boot', {
      deviceId: null,
      deviceName: null,
      remoteHostId: null,
      workingDir: '/repo/demo',
    });

    render(<SecondaryWindowBootGate />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new', {
        replace: true,
        state: { workspacePrompt: 'generic', restoreLastCreatedWorkspace: true },
      }),
    );
    expect(mocks.resolveSessionRoute).not.toHaveBeenCalled();

    cleanup();
    mocks.navigate.mockReset();
    mocks.getBootDeviceId.mockReturnValue('local');
    render(<SecondaryWindowBootGate />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new', {
        replace: true,
        state: {
          workspacePrompt: 'generic',
          dialogueTargetRequest: expect.objectContaining({
            deviceId: null,
            deviceName: null,
            preserveWorkspaceIfSameDevice: true,
          }),
        },
      }),
    );

    cleanup();
    mocks.navigate.mockReset();
    mocks.getBootDeviceId.mockReturnValue('device-remote');
    render(<SecondaryWindowBootGate />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new', {
        replace: true,
        state: {
          workspacePrompt: 'generic',
          dialogueTargetRequest: expect.objectContaining({
            deviceId: 'device-remote',
            deviceName: 'Remote Mac',
            preserveWorkspaceIfSameDevice: true,
          }),
        },
      }),
    );
    expect(mocks.getSessionFor).not.toHaveBeenCalled();

    // Carried remote draft workspace hints reconstruct route state on clean `/cc-agent/new` and fall back to hint deviceName.
    cleanup();
    mocks.navigate.mockReset();
    mocks.getBootSessionId.mockReturnValue(
      '/cc-agent/new?workingDir=%2Fremote%2Frepo&deviceName=Studio+Box',
    );
    mocks.getBootDeviceId.mockReturnValue('device-unlisted');
    render(<SecondaryWindowBootGate />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new', {
        replace: true,
        state: {
          workspacePrompt: 'generic',
          dialogueTargetRequest: expect.objectContaining({
            deviceId: 'device-unlisted',
            deviceName: 'Studio Box',
            preserveWorkspaceIfSameDevice: true,
            workingDir: '/remote/repo',
          }),
        },
      }),
    );

    cleanup();
    mocks.navigate.mockReset();
    mocks.getBootSessionId.mockReturnValue('/cc-agent/new?explicitNoProject=1');
    mocks.getBootDeviceId.mockReturnValue('device-remote');
    render(<SecondaryWindowBootGate />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new', {
        replace: true,
        state: {
          workspacePrompt: 'generic',
          dialogueTargetRequest: expect.objectContaining({
            deviceId: 'device-remote',
            deviceName: 'Remote Mac',
            preserveWorkspaceIfSameDevice: true,
            explicitNoProject: true,
          }),
        },
      }),
    );
    expect(mocks.getSessionFor).not.toHaveBeenCalled();
  });

  // Unit regression: these sidebar targets have no local task row at window boot.
  it.each(['/bots/mate', '/bots/groups/group-1', '/bots/remote/mac/mate'])(
    'opens the dragged conversation %s directly in the secondary window',
    async target => {
      mocks.getBootSessionId.mockReturnValue(target);
      mocks.getBootDeviceId.mockReturnValue(null);
      render(<SecondaryWindowBootGate />);
      await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(target, { replace: true }));
      expect(mocks.resolveSessionRoute).not.toHaveBeenCalled();
    },
  );

  it('reads remote Worker metadata before registering its host when the mirror has not hydrated', async () => {
    const workerSession = { id: 'worker-remote', orcaRole: 'worker' };
    mocks.getSessionFor.mockResolvedValue(workerSession);
    mocks.resolveSessionRoute.mockResolvedValue('/cc-agent/lead-remote?worker=worker-remote');

    render(<SecondaryWindowBootGate />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/lead-remote?worker=worker-remote', {
        replace: true,
      }),
    );
    expect(mocks.addSessionDetail).toHaveBeenCalledWith('device-remote', workerSession);
    expect(mocks.getSessionFor).toHaveBeenCalledWith('worker-remote', 'device-remote');
    expect(mocks.resolveSessionRoute).toHaveBeenCalledWith('worker-remote', workerSession, { remote: true });
    expect(mocks.addSessionDetail.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.getSessionFor.mock.invocationCallOrder[0],
    );
    expect(mocks.getSessionFor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveSessionRoute.mock.invocationCallOrder[0],
    );
  });

  it('retains the message anchor through remote Worker routing and StrictMode effect replay', async () => {
    mocks.getBootMessageClientId.mockReturnValue('message/42');
    mocks.getSessionFor.mockResolvedValue({ id: 'worker-remote', orcaRole: 'worker' });
    mocks.resolveSessionRoute.mockResolvedValue('/cc-agent/lead-remote?worker=worker-remote');
    render(
      <StrictMode>
        <SecondaryWindowBootGate />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
        '/cc-agent/lead-remote?worker=worker-remote',
        {
          replace: true,
          state: {
            searchJump: {
              kind: 'conversation-search',
              sessionId: 'worker-remote',
              messageId: 'message/42',
              messageIdKind: 'clientId',
              messageClientId: 'message/42',
            },
          },
        },
      ),
    );
  });
});
