// @vitest-environment jsdom
/**
 * Task menu → "Continue on another Claude account…": pick an account, then resume the same
 * session there or start a new session from the zero-token brief.
 *
 * 测试价值
 * - 生产入口与可观察结果：ClaudeHandoffMenuItem 是否出现；点击后的切换调用、新任务草稿内容与
 *   工作目录、导航与提示。
 * - 规则依据：docs/dev-rules/claude-multi-account.md §4.6（用户选择、不自动发送、简报不耗 token）。
 * - 现有覆盖缺口：新入口，无既有覆盖。
 * - 最小失败输入：远端 / 非 Claude Code 任务；没有其它账号；切换失败；选择第二个账号。
 * - tier：unit（jsdom，electronAPI / 对话框 / 草稿存储均为假实现）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ClaudeAccountSwitchResult,
  ClaudeAccountsListView,
  ClaudeHandoffPreview,
} from '../../../../shared/claudeAccounts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${Object.values(values).join(',')}` : key,
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));
const dialogs = vi.hoisted(() => ({
  confirmThree: vi.fn<(o: { content?: ReactNode }) => Promise<'confirm' | 'tertiary' | 'cancel'>>(),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => dialogs }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
const drafts = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: vi.fn((text: string) => ({ type: 'doc', text })),
  resetDraftWorkspaceTargets: vi.fn(),
  patchDraft: vi.fn(),
  switchVendor: vi.fn(),
}));
vi.mock('@/lib/composerDraftStore', () => ({ saveDraft: drafts.saveDraft, plainTextToTiptapDoc: drafts.plainTextToTiptapDoc }));
vi.mock('@/state/newMakerDraft', () => ({
  resetDraftWorkspaceTargets: drafts.resetDraftWorkspaceTargets,
  patchDraft: drafts.patchDraft,
  switchVendor: drafts.switchVendor,
}));
// The real menu item needs a Radix menu context; a plain button keeps the click observable.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>{children}</button>
  ),
}));

import { ClaudeHandoffMenuItem } from '../ClaudeHandoffMenuItem';

const LIST: ClaudeAccountsListView = {
  activeAccountId: 'master',
  accounts: [
    { id: 'master', kind: 'master', label: 'Master', active: true },
    { id: 'acct_work0001', kind: 'extra', label: 'Work', active: false },
    { id: 'acct_side0001', kind: 'extra', label: 'Side', active: false },
  ],
};
const PREVIEW: ClaudeHandoffPreview = {
  available: true,
  recommended: 'brief',
  resumeTokens: 325_502,
  briefTokens: 1_089,
  brief: '# Continuing an unfinished task\n\n## Goal\nShip it',
  goal: 'Ship it',
  userTurns: 20,
  filesTouched: 9,
  interruptedTool: 'Bash',
};

const api = {
  claudeAccountsList: vi.fn(async () => LIST),
  claudeAccountsHandoffPreview: vi.fn(async (): Promise<ClaudeHandoffPreview> => PREVIEW),
  claudeAccountsSwitch: vi.fn(async (): Promise<ClaudeAccountSwitchResult> => ({ ok: true })),
};

const LOCAL_CC = { id: 'sess-1', agentKind: 'cc' as const, workingDir: 'D:\\proj', remoteHostId: null, agentDeviceId: null };

beforeEach(() => {
  vi.clearAllMocks();
  api.claudeAccountsList.mockResolvedValue(LIST);
  api.claudeAccountsHandoffPreview.mockResolvedValue(PREVIEW);
  api.claudeAccountsSwitch.mockResolvedValue({ ok: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { maker: api };
});
afterEach(cleanup);

function openItem() {
  fireEvent.click(screen.getByRole('button', { name: 'claudeAccounts.handoff.menuItem' }));
}

describe('ClaudeHandoffMenuItem', () => {
  it.each([
    ['a Codex session', { ...LOCAL_CC, agentKind: 'codex' as const }],
    ['an SSH remote session', { ...LOCAL_CC, remoteHostId: 'devbox' }],
    ['a session whose agent runs on another computer', { ...LOCAL_CC, agentDeviceId: 'pc-2' }],
    ['a task viewed from another device', { ...LOCAL_CC, deviceLinkDeviceId: 'phone-1' }],
  ])('is hidden for %s', (_label, session) => {
    render(<ClaudeHandoffMenuItem session={session} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('resumes the same session on the chosen account without creating a draft', async () => {
    dialogs.confirmThree.mockResolvedValueOnce('confirm');
    render(<ClaudeHandoffMenuItem session={LOCAL_CC} />);
    openItem();
    await waitFor(() => expect(api.claudeAccountsSwitch).toHaveBeenCalledWith('acct_work0001'));
    expect(api.claudeAccountsHandoffPreview).toHaveBeenCalledWith('sess-1');
    expect(drafts.saveDraft).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('claudeAccounts.handoff.toast.resumed Work');
  });

  it('shows both costs and lets the user pick another account, then starts a brief session in the same folder', async () => {
    dialogs.confirmThree.mockImplementationOnce(async (options) => {
      // Render the dialog content as the real dialog would, and pick the second account.
      render(<>{options.content}</>);
      expect(screen.getByText('claudeAccounts.handoff.resumeDetail 325,502')).toBeTruthy();
      expect(screen.getByText('claudeAccounts.handoff.briefDetail 1,089')).toBeTruthy();
      expect(screen.getByText('claudeAccounts.handoff.recommended')).toBeTruthy();
      expect(screen.getByText('claudeAccounts.handoff.interrupted Bash')).toBeTruthy();
      fireEvent.click(screen.getByRole('radio', { name: 'Side' }));
      return 'tertiary';
    });
    render(<ClaudeHandoffMenuItem session={LOCAL_CC} />);
    openItem();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/cc-agent/new'));
    expect(api.claudeAccountsSwitch).toHaveBeenCalledWith('acct_side0001');
    expect(drafts.saveDraft).toHaveBeenCalledWith('__new_maker_draft__', {
      text: { type: 'doc', text: PREVIEW.available ? PREVIEW.brief : '' },
      attachments: [],
    });
    expect(drafts.switchVendor).toHaveBeenCalledWith('cc');
    expect(drafts.patchDraft).toHaveBeenCalledWith({ workingDir: 'D:\\proj' });
    expect(toast.success).toHaveBeenCalledWith('claudeAccounts.handoff.toast.briefReady Side');
  });

  it('does nothing when cancelled', async () => {
    dialogs.confirmThree.mockResolvedValueOnce('cancel');
    render(<ClaudeHandoffMenuItem session={LOCAL_CC} />);
    openItem();
    await waitFor(() => expect(dialogs.confirmThree).toHaveBeenCalledOnce());
    expect(api.claudeAccountsSwitch).not.toHaveBeenCalled();
    expect(drafts.saveDraft).not.toHaveBeenCalled();
  });

  it('keeps the draft untouched when the switch is refused', async () => {
    dialogs.confirmThree.mockResolvedValueOnce('tertiary');
    api.claudeAccountsSwitch.mockResolvedValueOnce({ ok: false, reason: 'not_logged_in' });
    render(<ClaudeHandoffMenuItem session={LOCAL_CC} />);
    openItem();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('claudeAccounts.settings.error.not_logged_in'));
    expect(drafts.saveDraft).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('explains instead of opening the dialog when there is nothing to hand off to', async () => {
    api.claudeAccountsList.mockResolvedValueOnce({ activeAccountId: 'master', accounts: [LIST.accounts[0]!] });
    render(<ClaudeHandoffMenuItem session={LOCAL_CC} />);
    openItem();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('claudeAccounts.handoff.noOtherAccounts'));
    expect(dialogs.confirmThree).not.toHaveBeenCalled();

    api.claudeAccountsHandoffPreview.mockResolvedValueOnce({ available: false, reason: 'not_found' });
    openItem();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('claudeAccounts.handoff.unavailable.not_found'));
    expect(dialogs.confirmThree).not.toHaveBeenCalled();
  });
});
