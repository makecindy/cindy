// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteModelAccessDialog, RemoteModelAccessSection } from '../RemoteModelAccessSection';
import type { RemoteModelAccessView } from '../../../../shared/remoteModelAccess';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { percent?: string }) => options?.percent ? `${key} ${options.percent}` : key, i18n: { language: 'en' } }) }));
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
  // Regression: the real dialog listed Codex and Pi/Claude bridge IDs twice. Existing
  // fixtures had no aliases. Unit: two wire IDs must render once, but both must be
  // sent on an explicit grant/revoke; distinct context profiles stay independent.
  const gptModels = [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' },
    { id: 'chatgpt/gpt-6.1-sol', name: 'GPT-6.1-Sol' },
    { id: 'gpt-6.1-sol[1m]', name: 'GPT-6.1-Sol 1M' },
  ];
  it('groups engine aliases and saves both actual IDs so Pi remains available', async () => {
    local.mockResolvedValue({ ...value(), models: [], availableModels: gptModels });
    render(<RemoteModelAccessDialog providerId="openai" onClose={() => {}} />);
    await screen.findByRole('checkbox', { name: 'GPT-6.1-Sol 1M' });
    expect(screen.getAllByRole('checkbox', { name: 'GPT-6.1-Sol' })).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'chatgpt/' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'GPT-6.1-Sol' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(local).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'set-model-access', models: ['gpt-6.1-sol', 'chatgpt/gpt-6.1-sol'],
    })));
  });
  it('removes every engine alias when excluding a model from an unrestricted grant', async () => {
    local.mockResolvedValue({ ...value(), availableModels: gptModels });
    render(<RemoteModelAccessDialog providerId="openai" onClose={() => {}} />);
    await screen.findByRole('checkbox', { name: 'GPT-6.1-Sol 1M' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'GPT-6.1-Sol' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(local).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'set-model-access', models: ['gpt-6.1-sol[1m]'],
    })));
  });
  it.each([false, true])('preserves an old partial grant without silently enabling Pi (missing alias: %s)', async missingAlias => {
    const selected = missingAlias ? 'chatgpt/gpt-6.1-sol' : 'gpt-6.1-sol';
    local.mockResolvedValue({ ...value(), models: [selected], availableModels: missingAlias ? [gptModels[0]] : gptModels });
    render(<RemoteModelAccessDialog providerId="openai" onClose={() => {}} />);
    const row = await screen.findByRole('checkbox', { name: 'GPT-6.1-Sol' });
    expect((row as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(local).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-model-access', models: [selected] })));
  });
  it.each([undefined, 'studio'])('respects a Pi-only provider ceiling when editing a member: %s', async deviceId => {
    local.mockResolvedValue({ ...value(), models: [], providerModels: ['chatgpt/gpt-6.1-sol'], availableModels: gptModels });
    render(<RemoteModelAccessDialog providerId="openai" deviceId={deviceId} memberId="alice" onClose={() => {}} />);
    await screen.findByRole('checkbox', { name: 'GPT-6.1-Sol 1M' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'GPT-6.1-Sol' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(local).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'set-model-access', memberId: 'alice', models: ['chatgpt/gpt-6.1-sol'],
    })));
    if (deviceId) expect(remote).toHaveBeenCalledWith(expect.objectContaining({ action: 'remote-manage', deviceId }));
  });
  // Unit: a member limit edit must preserve the existing model grant on save.
  it('saves member limits in the model access panel without broadening the model grant', async () => {
    local.mockResolvedValue({ ...value(), models: ['small'], budgetSupported: true, budgetAvailable: true });
    render(<RemoteModelAccessDialog providerId="p" memberId="alice" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'providerShare.memberBudget.addGroup' }));
    expect(screen.getByRole('checkbox', { name: 'providerShare.modelAccess.inherit' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(local).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-model-access', providerId: 'p', memberId: 'alice', models: ['small'],
      memberBudget: expect.objectContaining({ enabled: false, rules: [expect.objectContaining({ models: ['small'], maxPercent: 30 })] }) })));
  });
  // Unsaved model changes must recompute from the real snapshot, not keep another model's ratio.
  it('shows recorded ratios immediately when adding and changing an unsaved model limit', async () => {
    local.mockResolvedValue({ ...value(), budgetSupported: true, budgetAvailable: true,
      budgetStatus: { state: 'recorded', totalTokens: 100, modelUsage: [{ model: 'small', tokens: 20 }, { model: 'large', tokens: 80 }], rules: [] } });
    render(<RemoteModelAccessDialog providerId="p" memberId="alice" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'providerShare.memberBudget.addGroup' }));
    expect(screen.getByText('providerShare.memberBudget.used 20.00')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'providerShare.memberBudget.chooseModels' }), { target: { value: 'large' } });
    expect(screen.getByText('providerShare.memberBudget.used 80.00')).toBeTruthy();
    expect(screen.getByText('providerShare.memberBudget.draftExceeded')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'providerShare.memberBudget.enable' }) as HTMLInputElement).checked).toBe(false);
    expect(local).toHaveBeenCalledTimes(1);
  });
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

  // Percent/recommendation must travel atomically with grants and survive failed persistence.
  // The existing tests above exercise grants only. Minimal input: one group + changed recommendation; unit.
  it('retains a single-model percentage budget and recommendation after failed save, then retries the same values', async () => {
    const memberBudget = { rules: [{ id: 'premium', models: ['large'], maxPercent: 30 }], recommendedModel: 'small', basis: 'member-input-output-7d' as const, enabled: false };
    let fail = true;
    local.mockImplementation(async command => {
      if (command.action === 'set-model-access' && fail) throw new Error('offline');
      return { ...value(), budgetSupported: true, budgetAvailable: true, memberBudget };
    });
    const closed = vi.fn();
    render(<RemoteModelAccessDialog providerId="p" memberId="alice" onClose={closed} />);
    const percent = await screen.findByLabelText('providerShare.memberBudget.maxPercent');
    fireEvent.change(percent, { target: { value: '25' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'providerShare.memberBudget.recommended' }), { target: { value: 'large' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await screen.findByRole('alert');
    expect((percent as HTMLInputElement).value).toBe('25');
    expect(closed).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(local).toHaveBeenLastCalledWith({ action: 'set-model-access', providerId: 'p', memberId: 'alice', models: null,
      memberBudget: { ...memberBudget, recommendedModel: 'large', rules: [{ ...memberBudget.rules[0], maxPercent: 25 }] } });
  });
});
