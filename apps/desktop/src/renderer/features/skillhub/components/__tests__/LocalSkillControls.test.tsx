// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), setEnabled: vi.fn(), uninstall: vi.fn(), retry: vi.fn(), refresh: vi.fn(),
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn(),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('../../hooks/useSkillhub', () => ({ refresh: mocks.refresh }));
vi.mock('@/lib/toast', () => ({ toast: {
  success: mocks.success, error: mocks.error, warning: mocks.warning, dismiss: mocks.dismiss,
} }));
import { LocalSkillControls } from '../LocalSkillControls';
import { resetUninstallCleanupNotices } from '../../lib/uninstallCleanupNotifications';

const skill = { id: 'global-example', name: 'example', kind: 'skill', absolutePath: '/fixture/.agents/skills/example',
  scope: 'global', cindyEnabled: true, canUninstall: true } as SkillhubSkill;

async function chooseUninstall() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'skillhub.management.moreLabel' }), { key: 'Enter' });
  const item = await screen.findByRole('menuitem', { name: 'skillhub.detail.uninstall' });
  await act(async () => { fireEvent.click(item); });
}

beforeEach(() => {
  resetUninstallCleanupNotices();
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.setEnabled.mockResolvedValue({ cindyEnabled: false });
  mocks.uninstall.mockResolvedValue({ success: true });
  mocks.retry.mockResolvedValue({ complete: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { skillhub: {
    setEnabled: mocks.setEnabled, uninstall: mocks.uninstall, retryUninstallCleanup: mocks.retry,
  } } });
});
afterEach(cleanup);

describe('Local Skill management', () => {
  it.each([true, false])('preserves Switch styling state with the real tooltip (enabled=%s)', async (enabled) => {
    render(<LocalSkillControls skill={{ ...skill, cindyEnabled: enabled }} />);
    const control = screen.getByRole('switch');
    expect(control.getAttribute('data-state')).toBe(enabled ? 'checked' : 'unchecked');
    fireEvent.focus(control);
    await screen.findByRole('tooltip');
    expect(control.getAttribute('data-state')).toBe(enabled ? 'checked' : 'unchecked');
    fireEvent.blur(control);
    expect(control.getAttribute('data-state')).toBe(enabled ? 'checked' : 'unchecked');
  });

  it('blocks repeated toggles while saving, rolls back on error, and does not open details', async () => {
    let reject!: (error: Error) => void;
    mocks.setEnabled.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const openDetails = vi.fn();
    render(<div onClick={openDetails}><LocalSkillControls skill={skill} /></div>);
    const control = screen.getByRole('switch') as HTMLButtonElement;
    fireEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(mocks.setEnabled).toHaveBeenCalledTimes(1);
    expect(openDetails).not.toHaveBeenCalled();
    await act(async () => { reject(new Error('disk full')); });
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.disabled).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith('skillhub.management.toggleFailed');
  });

  it('refreshes cards after a successful enable', async () => {
    render(<LocalSkillControls skill={{ ...skill, cindyEnabled: false }} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('skillhub.management.enabledToast'));
    expect(mocks.setEnabled).toHaveBeenCalledWith({ absolutePath: skill.absolutePath, skillId: skill.id, enabled: true });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('treats Main confirmation cancellation as a no-op', async () => {
    mocks.uninstall.mockResolvedValueOnce({ success: false, errorCode: 'CANCELLED', message: '' });
    const onUninstalled = vi.fn();
    render(<LocalSkillControls skill={skill} onUninstalled={onUninstalled} />);
    await chooseUninstall();
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledOnce());
    expect(onUninstalled).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('delegates confirmation to Main with the selected skill identity', async () => {
    const onUninstalled = vi.fn();
    render(<LocalSkillControls skill={{ ...skill, scope: 'project', projectRoot: '/project', uninstallLinkOnly: true }} onUninstalled={onUninstalled} />);
    await chooseUninstall();
    await waitFor(() => expect(onUninstalled).toHaveBeenCalledOnce());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.uninstall).toHaveBeenCalledWith(skill.absolutePath, skill.id);
  });

  it('keeps package-owned uninstall unavailable', async () => {
    render(<LocalSkillControls skill={{ ...skill, canUninstall: false }} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'skillhub.management.moreLabel' }), { key: 'Enter' });
    const item = await screen.findByRole('menuitem');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(screen.getByText('skillhub.management.managedElsewhere')).toBeTruthy();
  });

  it('offers a cleanup retry with the Main receipt after partial cleanup', async () => {
    mocks.uninstall.mockResolvedValueOnce({ success: true, cleanupToken: 'receipt' });
    render(<LocalSkillControls skill={skill} />);
    await chooseUninstall();
    await waitFor(() => expect(mocks.warning).toHaveBeenCalledOnce());
    await act(async () => { mocks.warning.mock.calls[0][1].action.onClick(); });
    expect(mocks.retry).toHaveBeenCalledWith('receipt');
    expect(mocks.uninstall).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith('skillhub.management.cleanupComplete');
  });

  it('directs plugin-owned Skills to plugin management without allowing uninstall', async () => {
    render(<LocalSkillControls skill={{ ...skill, canUninstall: false, managedByPlugin: true }} />);
    const control = screen.getByRole('switch') as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'skillhub.management.moreLabel' }), { key: 'Enter' });
    const item = await screen.findByRole('menuitem');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(screen.getByText('skillhub.management.managedByPlugin')).toBeTruthy();
  });
});
