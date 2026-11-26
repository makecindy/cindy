// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { OpenAiGroupAccount, OpenAiGroupAccountDetail } from '../../../../shared/openAiAccountGroup';
import { OpenAiAccountGroupSection, useOpenAiAccountGroup } from '../OpenAiAccountGroupSection';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string, args?: { name: string }) => args ? key + ' ' + args.name : key }),
}));

function Group({ providerId }: { providerId: string }) {
  const group = useOpenAiAccountGroup(providerId);
  return <ConfirmDialogProvider><OpenAiAccountGroupSection providerId={providerId} group={group} /></ConfirmDialogProvider>;
}

// Unit through the standalone API key settings entry: keep the test action
// without duplicating the provider's identity, and never retry a failed probe automatically.
it('shows why a standalone key test failed and only retries on another click', async () => {
  const account: OpenAiGroupAccount = { id: 'fixture-key', name: 'Fixture key', kind: 'apiKey', included: true,
    connected: true, checks: [{ agent: 'codex' }] };
  const command = vi.fn(async (input: { action: string }) => input.action === 'account-detail'
    ? { accounts: [account] } : { ok: false, code: 'INVALID_PROBE_RESPONSE' });
  Object.assign(window, { electronAPI: { providerGroup: { command } } });
  render(<Group providerId={account.id} />);
  const button = await screen.findByRole('button', { name: 'settings.providers.custom.test.button · Fixture key' });
  expect(screen.queryByText('Fixture key')).toBeNull();
  expect(screen.queryByText('openAiAccountGroup.title')).toBeNull();
  fireEvent.click(button);
  await screen.findByText('providerError.INVALID_PROBE_RESPONSE');
  expect(command.mock.calls.filter(([input]) => input.action === 'account-test')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'commonUi.retry' })).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(command.mock.calls.filter(([input]) => input.action === 'account-test')).toHaveLength(2));
});

// Unit, real settings component with IPC fixture. An incoming durable pause
// must replace an earlier displayed success and select the same engine to test.
it('updates a previously successful credential when its billing hold changes', async () => {
  let checks: NonNullable<OpenAiGroupAccount['checks']> = [{ agent: 'codex', result: { ok: true } }, { agent: 'pi', result: { ok: true } }];
  let notify!: () => void;
  const command = vi.fn(async (input: { action: string; agent?: string }) => {
    if (input.action === 'account-test') {
      checks = checks.map(check => check.agent === input.agent ? { agent: check.agent, result: { ok: true } } : check);
      return { ok: true };
    }
    return { accounts: [{ id: 'fixture-key', name: 'Fixture', kind: 'apiKey', included: true, connected: true, checks }] };
  });
  Object.assign(window, { electronAPI: { providerGroup: { command, onChanged: (fn: () => void) => { notify = fn; return () => {}; } } } });
  render(<Group providerId="fixture-key" />);
  await waitFor(() => expect(screen.getAllByText('openAiAccountGroup.testPassed')).toHaveLength(2));
  checks = [{ agent: 'codex', result: { ok: true } }, { agent: 'pi', blocked: true,
    result: { ok: false, code: 'QUOTA_EXCEEDED', billingCode: 'credit_balance_exhausted' } }];
  await act(async () => notify());
  expect(await screen.findByText('openAiAccountGroup.billingPaused')).toBeTruthy();
  expect(screen.getAllByText('openAiAccountGroup.testPassed')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.test.button · Pi · Fixture' }));
  expect(command).toHaveBeenCalledWith({ action: 'account-test', providerId: 'fixture-key', accountId: 'fixture-key', agent: 'pi' });
  await waitFor(() => expect(screen.getAllByText('openAiAccountGroup.testPassed')).toHaveLength(2));
  expect(screen.queryByText('openAiAccountGroup.billingPaused')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

// Unit through the real component and its IPC boundary. A failed read used to
// leave strategy absent with no way for the member's page to recover.
it('recovers a failed group read and saves against its target from the member page', async () => {
  const key: OpenAiGroupAccount = { id: 'fixture-key', name: 'Fixture key', kind: 'apiKey', included: true,
    connected: true, checks: [{ agent: 'codex' }] };
  const subscription: OpenAiGroupAccount = { id: 'openai', name: 'Fixture subscription', kind: 'subscription', included: true, connected: true };
  const detail: OpenAiGroupAccountDetail = { accounts: [key], group: { providerId: 'openai', members: [subscription, key],
    config: { strategy: 'expiring', autoSwitch: true, members: [{ key: 'local', kind: 'local', agentDeviceId: null,
      providerId: 'openai', weight: 1, limit: 4, paused: false }], localAccountIds: [key.id] } } };
  const command = vi.fn(async (input: { action: string }) => input.action === 'account-detail' ? detail : detail.group?.config);
  command.mockRejectedValueOnce(new Error('fixture read failed'));
  Object.assign(window, { electronAPI: { providerGroup: { command },
    subscriptionAccounts: { command: async () => ({ accounts: [] }) } } });
  render(<Group providerId={key.id} />);
  expect(screen.getByRole('status').textContent).toContain('providerGroup.section.loading');
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
  expect(await screen.findAllByTestId('openai-group-account')).toHaveLength(2);
  expect(screen.queryByRole('alert')).toBeNull();
  // 选法只在「智能路由」里改(2026-11-26)：这里只有现状说明，没有第二个选法控件。
  expect(screen.getByTestId('route-strategy-note')).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'modelGroups.settings.pick' })).toBeNull();
  // 每个账号的开关仍在这里，保存到目标组。
  fireEvent.click(screen.getByRole('switch', { name: 'providerGroup.member.assignAria Fixture key' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith({
    action: 'account-allocation', providerId: 'openai', expectedConfig: detail.group?.config, edit: { accountId: key.id, paused: true },
  }));
});
