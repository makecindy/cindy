// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteModelAccessDialog, RemoteModelAccessSection } from '../RemoteModelAccessSection';
import type { RemoteModelAccessView } from '../../../../shared/remoteModelAccess';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null }));
/* 测试价值：用户新增的勾选授权保存、个人上限、失败保留草稿及旧端禁写。现有管理页 fixture 不单独驱动此弹窗；
 * 最小输入：两个型号，仅开放一个，再清空个人选择。unit；真实组件与同账号管理 adapter，使用独立 jsdom。 */
const local = vi.fn();
const remote = vi.fn();
const value = (): RemoteModelAccessView => ({ version: 1, models: null, providerModels: null,
  availableModels: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] });
beforeEach(() => {
  local.mockReset().mockImplementation(async () => value());
  remote.mockReset().mockImplementation(async (cmd) => local(cmd.request.command));
  Object.assign(window, { electronAPI: {
    providerShare: { command: local, onOwnedChanged: () => () => {} },
    providerGroup: { command: remote },
  } });
});
afterEach(() => cleanup());
describe('remote model settings', () => {
  it('opens the global selection from settings and saves only the checked model', async () => {
    render(<RemoteModelAccessSection providerId="p" />);
    const choose = screen.getByRole('button', { name: 'providerShare.modelAccess.choose' });
    await waitFor(() => expect((choose as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(choose);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Large' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(local).toHaveBeenCalledWith({ action: 'set-model-access', providerId: 'p', memberId: undefined, models: ['small'] }));
  });
  it.each([undefined, 'studio'])('respects the remote ceiling and allows an explicit empty personal grant: %s', async (deviceId) => {
    local.mockImplementation(async () => ({ ...value(), providerModels: ['small'] }));
    render(<RemoteModelAccessDialog providerId="p" memberId="alice" memberName="Alice" deviceId={deviceId} onClose={() => {}} />);
    const large = await screen.findByRole('checkbox', { name: 'Large' }) as HTMLInputElement;
    expect(large.disabled).toBe(true);
    expect(large.checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Small' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(local).toHaveBeenCalledWith({ action: 'set-model-access', providerId: 'p', memberId: 'alice', models: [] }));
    if (deviceId) expect(remote).toHaveBeenCalledWith({ action: 'remote-manage', deviceId, request: { action: 'manage-share', command: expect.objectContaining({ action: 'set-model-access', memberId: 'alice', models: [] }) } });
    else expect(remote).not.toHaveBeenCalled();
  });
  it('keeps the selection available for retry when saving fails', async () => {
    local.mockImplementation(async (cmd) => { if (cmd.action === 'set-model-access') throw new Error('save failed'); return value(); });
    render(<RemoteModelAccessDialog providerId="p" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('providerShare.modelAccess.saveFailed');
    expect((screen.getByRole('checkbox', { name: 'Large' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Small' }) as HTMLInputElement).checked).toBe(true);
  });
  it('requires a supporting host instead of treating an old reply as unrestricted access', async () => {
    local.mockResolvedValue({});
    render(<RemoteModelAccessDialog providerId="p" deviceId="studio" onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('providerShare.modelAccess.needsUpdate');
    expect((screen.getByRole('button', { name: 'settings.providers.custom.save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(local).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'set-model-access' }));
  });
});
