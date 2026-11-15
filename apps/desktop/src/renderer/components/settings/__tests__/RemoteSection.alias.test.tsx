// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteSection } from '../RemoteSection';
import { parseSelfHostedRelayCommand } from '../../../../shared/selfHostedRelay';

const { t } = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('../RemoteHostDetail', () => ({ RemoteHostDetail: () => null }));
vi.mock('../SshKeySetupDialog', () => ({ SshKeySetupDialog: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const legacyHost: RemoteHostSnapshot = {
  config: {
    id: '测试服务器',
    hostname: 'example.com',
    port: 22,
    user: 'ubuntu',
    authMethod: 'agent',
    identityFileConfigured: false,
    source: 'manual',
    managedByCindy: true,
  },
  status: 'disconnected',
  statusChangedAt: 0,
  autoConnect: false,
  agentProxy: null,
  agentProxyTunnel: null,
};

async function openForm(hosts: RemoteHostSnapshot[] = []) {
  const add = vi.fn(async () => ({}));
  vi.stubGlobal('electronAPI', {
    remoteSsh: {
      list: async () => ({ hosts }),
      onStatusChanged: () => () => {},
      add,
    },
  });
  // The host bridge lives on window; jsdom shares the global property.
  render(<RemoteSection />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.button.add' }));
  fireEvent.change(screen.getByLabelText('settings.remote.add.hostname'), {
    target: { value: 'example.com' },
  });
  fireEvent.change(screen.getByLabelText('settings.remote.add.user'), {
    target: { value: 'ubuntu' },
  });
  return add;
}

it('keeps the alias rules associated with the input after typing', async () => {
  await openForm();
  const alias = screen.getByLabelText('settings.remote.add.alias');
  fireEvent.change(alias, { target: { value: 'my-server' } });
  const hint = screen.getByText('settings.remote.add.aliasHint');
  expect(alias.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
});

it('blocks unsupported aliases before saving and recovers after correction', async () => {
  const add = await openForm();
  const alias = screen.getByLabelText('settings.remote.add.alias');
  const submit = screen.getByRole('button', { name: 'settings.remote.add.submit' });
  for (const value of [
    '测试服务器',
    'bad host',
    'bad*host',
    'bad?host',
    '[host]',
    '!host',
    'é',
    'a'.repeat(129),
  ]) {
    fireEvent.change(alias, { target: { value } });
    expect(alias.getAttribute('aria-invalid')).toBe('true');
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
  }
  expect(add).not.toHaveBeenCalled();
  fireEvent.change(alias, { target: { value: 'my-server' } });
  expect(alias.hasAttribute('aria-invalid')).toBe(false);
  expect(submit.hasAttribute('disabled')).toBe(false);
});

it('accepts every supported symbol and length boundary while keeping Chinese display names', async () => {
  const add = await openForm();
  const alias = screen.getByLabelText('settings.remote.add.alias');
  const submit = screen.getByRole('button', { name: 'settings.remote.add.submit' });
  for (const value of ['a', 'A0._@:-', 'a'.repeat(128)]) {
    fireEvent.change(alias, { target: { value } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    expect(parseSelfHostedRelayCommand({ type: 'check-server', sshHostId: value })).not.toBeNull();
  }
  fireEvent.change(alias, { target: { value: 'my-server' } });
  fireEvent.change(screen.getByLabelText('settings.remote.add.displayName'), {
    target: { value: '测试服务器' },
  });
  fireEvent.click(submit);
  await act(async () => {});
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'my-server', displayName: '测试服务器' }),
  );
});

it('keeps an existing Chinese alias editable through its display name', async () => {
  await openForm([legacyHost]);
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.add.cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.button.edit' }));
  const alias = screen.getByLabelText('settings.remote.add.alias');
  expect(alias.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('settings.remote.add.displayName'), {
    target: { value: '新显示名' },
  });
  expect(
    screen.getByRole('button', { name: 'settings.remote.edit.submit' }).hasAttribute('disabled'),
  ).toBe(false);
  expect(alias.hasAttribute('aria-invalid')).toBe(false);
});
