// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getSnapshot: mocks.getSnapshot,
    sendMessage: vi.fn(),
  },
}));

vi.mock('@/lib/sessionService', () => ({
  get: mocks.getSession,
}));

vi.mock('@/state/ccMgrUpgradeStore', () => ({
  subscribeCcMgrUpgradeStore: vi.fn(),
  getCcMgrUpgradeSnapshot: vi.fn(() => null),
  forceUpgradeCcMgr: vi.fn(),
  dismissCcMgrUpgrade: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}));

import { snapshotRetryCandidate } from '../UpgradeBanner';

describe('UpgradeBanner retry snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSnapshot.mockReturnValue({
      isStreaming: true,
      agentStatus: { isRunning: true },
      messages: [{ role: 'user', content: 'continue this task' }],
    });
  });

  it('keeps an explicit empty effort for a no-tier SSH session', async () => {
    mocks.getSession.mockResolvedValue({
      workingDir: '/workspace',
      model: 'claude-sonnet-4-5',
      effort: '',
      permissionMode: 'default',
    });

    await expect(snapshotRetryCandidate('ssh-no-effort')).resolves.toMatchObject({
      sessionId: 'ssh-no-effort',
      text: 'continue this task',
      effort: '',
    });
  });

  it.each([null, undefined])('rejects a session row with missing effort (%j)', async (effort) => {
    mocks.getSession.mockResolvedValue({
      workingDir: '/workspace',
      model: 'claude-sonnet-4-5',
      effort,
      permissionMode: 'default',
    });

    await expect(snapshotRetryCandidate('missing-effort')).resolves.toBeNull();
  });
});
