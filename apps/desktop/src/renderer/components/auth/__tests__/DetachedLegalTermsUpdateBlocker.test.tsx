// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 分离侧栏 / 单页签窗口的协议更新遮挡。依据:老用户须确认新版协议才能继续使用,主窗口以外
 * 已打开的窗口也不能继续操作;这些窗口的专用 preload 只有只读桥,确认在主窗口完成。
 */

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const auth = vi.hoisted(() => ({
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  user: { membershipKind: 'personal' } as { membershipKind: 'personal' | 'org' } | null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

import { isAppInteractionLocked } from '@/lib/appInteractionLock';

import { DetachedLegalTermsUpdateBlocker } from '../DetachedLegalTermsUpdateBlocker';

let push: ((required: boolean) => void) | null = null;
const electronAPI = {
  getLegalTermsUpdateRequired: vi.fn(async () => true),
  onLegalTermsUpdateRequiredChange: vi.fn((cb: (required: boolean) => void) => {
    push = cb;
    return () => {
      push = null;
    };
  }),
};

beforeEach(() => {
  auth.mode = 'cloud';
  auth.user = { membershipKind: 'personal' };
  electronAPI.getLegalTermsUpdateRequired.mockResolvedValue(true);
  Object.assign(window, { electronAPI });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DetachedLegalTermsUpdateBlocker', () => {
  it('blocks the detached window and locks shortcuts until the main window records the agreement', async () => {
    render(<DetachedLegalTermsUpdateBlocker />);
    await screen.findByTestId('detached-legal-terms-blocker');
    expect(screen.getByText('legalTermsUpdate.detachedBody')).toBeTruthy();
    expect(isAppInteractionLocked()).toBe(true);

    act(() => push?.(false));
    expect(screen.queryByTestId('detached-legal-terms-blocker')).toBeNull();
    expect(isAppInteractionLocked()).toBe(false);
  });

  it('never blocks an organization (enterprise SSO) account', async () => {
    auth.user = { membershipKind: 'org' };
    render(<DetachedLegalTermsUpdateBlocker />);
    await act(async () => {});
    expect(screen.queryByTestId('detached-legal-terms-blocker')).toBeNull();
  });

  // 读取失败(例如窗口不被信任)时不挡,避免把用户锁在外面;之后的广播仍会生效。
  it('stays usable when the state cannot be read', async () => {
    electronAPI.getLegalTermsUpdateRequired.mockRejectedValue(new Error('PERMISSION_DENIED'));
    render(<DetachedLegalTermsUpdateBlocker />);
    await act(async () => {});
    expect(screen.queryByTestId('detached-legal-terms-blocker')).toBeNull();
  });
});
