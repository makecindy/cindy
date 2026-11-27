// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudMcpAuthorization } from '../CloudMcpAuthorization';
import { createTrialCloudSettingsClient } from '../trialClient';
import { toast } from '@/lib/toast';
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (k: string) => k }),
}));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const props = { active: true, online: true, name: 'Cloud', trial: true };
async function setup() {
  Object.assign(window, {
    electronAPI: new Proxy(
      {},
      {
        get() {
          throw Error('LOCAL_API_FORBIDDEN');
        },
      },
    ),
  });
  const client = createTrialCloudSettingsClient(),
    manage = vi.spyOn(client, 'manage');
  const view = render(<CloudMcpAuthorization {...props} client={client} />);
  fireEvent.click(
    (await screen.findAllByRole('button', { name: 'cloudSettings.mcpCredentials' }))[0],
  );
  return {
    client,
    manage,
    view,
    token: screen.getByLabelText('settings.mcp.fields.token') as HTMLInputElement,
  };
}
describe('native cloud MCP credentials', () => {
  it('shows the native row and saved status, never reads existing secrets into the controller', async () => {
    const f = await setup();
    expect(f.token.value).toBe('');
    expect(screen.getByText('settings.mcp.fields.tokenSaved')).toBeTruthy();
    expect(screen.getByText('https://example.com/mcp')).toBeTruthy();
    expect(screen.getByText('X-API-Key')).toBeTruthy();
    expect(f.manage.mock.calls.filter(([c]) => c.operation !== 'list')).toHaveLength(0);
    // The page header reloads the category; the section offers a retry only after a failure.
    expect(screen.queryByRole('button', { name: 'cloudSettings.reload' })).toBeNull();
  });
  it('does not interpret blank token or closing the form as credential removal', async () => {
    const f = await setup();
    expect(
      screen.getAllByRole('button', { name: 'settings.mcp.save' })[0].matches(':disabled'),
    ).toBe(true);
    fireEvent.change(f.token, { target: { value: 'synthetic-secret' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'cloudSettings.mcpCredentials' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'cloudSettings.mcpCredentials' })[0]);
    expect((screen.getByLabelText('settings.mcp.fields.token') as HTMLInputElement).value).toBe('');
    expect(f.manage.mock.calls.some(([c]) => c.operation === 'run')).toBe(false);
  });
  it('submits only the new token once, clears it and reads back the cloud state', async () => {
    const f = await setup();
    fireEvent.change(f.token, { target: { value: 'synthetic-secret' } });
    const save = screen.getAllByRole('button', { name: 'settings.mcp.save' })[0];
    fireEvent.click(save);
    fireEvent.click(save);
    // How it ended is a toast, as the client's MCP page says a save.
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('settings.mcp.toast.updated'));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(f.manage.mock.calls.filter(([c]) => c.operation === 'run')).toHaveLength(1);
    expect(f.manage.mock.calls.find(([c]) => c.operation === 'run')?.[0]).toMatchObject({
      values: { bearerToken: 'synthetic-secret' },
    });
    expect(f.token.value).toBe('');
    await waitFor(() =>
      expect(f.manage.mock.calls.filter(([c]) => c.operation === 'list').length).toBe(2),
    );
  });
  it('clears new input when leaving the category or losing the connection', async () => {
    const f = await setup();
    fireEvent.change(f.token, { target: { value: 'synthetic-secret' } });
    f.view.rerender(<CloudMcpAuthorization {...props} client={f.client} active={false} />);
    expect(screen.queryByLabelText('settings.mcp.fields.token')).toBeNull();
    f.view.rerender(<CloudMcpAuthorization {...props} client={f.client} online={false} />);
    expect(
      screen
        .getAllByRole('button', { name: 'cloudSettings.mcpCredentials' })
        .every((b) => b.matches(':disabled')),
    ).toBe(true);
  });
  it('uses status after a lost write response without resubmitting the credential', async () => {
    const f = await setup();
    f.manage.mockRestore();
    const base = f.client.manage!.bind(f.client);
    const spy = vi.spyOn(f.client, 'manage').mockImplementation(async (command) => {
      const result = await base(command);
      if (command.operation === 'run') throw Error('LOST');
      return result;
    });
    fireEvent.change(f.token, { target: { value: 'synthetic-secret' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.mcp.save' })[0]);
    // Read back on its own from the operation 2 s later (no 「检查授权状态」 button).
    await waitFor(
      () => expect(spy.mock.calls.some(([c]) => c.operation === 'status')).toBe(true),
      { timeout: 4_000 },
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('settings.mcp.toast.updated'));
    expect(spy.mock.calls.filter(([c]) => c.operation === 'run')).toHaveLength(1);
    expect(f.token.value).toBe('');
  }, 10_000);
});

// Add, edit and delete use the local dialog and delete confirmation.
describe('native cloud MCP servers', () => {
  const open = async () => {
    Object.assign(window, {
      electronAPI: new Proxy(
        {},
        {
          get() {
            throw Error('LOCAL_API_FORBIDDEN');
          },
        },
      ),
    });
    const client = createTrialCloudSettingsClient(),
      manage = vi.spyOn(client, 'manage');
    render(<CloudMcpAuthorization {...props} client={client} />);
    await screen.findByText('Documentation');
    const runs = () => manage.mock.calls.filter(([c]) => c.operation === 'run').map(([c]) => c);
    return { manage, runs };
  };
  const field = (name: string) =>
    screen.getByLabelText(`settings.mcp.fields.${name}`) as HTMLInputElement;
  it('adds a server through the local dialog without collecting credentials in it', async () => {
    const f = await open();
    fireEvent.click(screen.getByText('settings.mcp.addCustom.title'));
    expect(screen.queryByLabelText('settings.mcp.fields.token')).toBeNull();
    expect(screen.getByText(/cloudSettings\.mcpCredentialsAfterSave/)).toBeTruthy();
    fireEvent.change(field('name'), { target: { value: 'Search' } });
    fireEvent.change(field('url'), { target: { value: 'https://example.com/search' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.save' }));
    await screen.findByText('Search');
    expect(f.runs()).toHaveLength(1);
    expect(f.runs()[0]).toMatchObject({
      values: { name: 'Search', url: 'https://example.com/search', transport: 'http' },
    });
    expect(toast.success).toHaveBeenCalledWith('settings.mcp.toast.created');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('edits the name and transport, and keeps credentials away from a changed endpoint', async () => {
    const f = await open();
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.mcp.editAria' })[1]);
    expect(field('url').value).toBe('https://example.com/sse');
    fireEvent.change(field('name'), { target: { value: 'Team Tools 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.save' }));
    await screen.findByText('Team Tools 2');
    expect(f.runs()[0]).toMatchObject({
      values: { name: 'Team Tools 2', url: 'https://example.com/sse', transport: 'sse' },
    });
    // The first server has a token and a header: the dialog says why its URL cannot move yet.
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.mcp.editAria' })[0]);
    expect(screen.getByText(/cloudSettings\.mcpClearCredentialsBeforeUrl/)).toBeTruthy();
    fireEvent.change(field('url'), { target: { value: 'https://example.org/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.mcp.toast.saveFailed'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('https://example.com/mcp')).toBeTruthy();
  });
  it('deletes only after the local confirmation', async () => {
    const f = await open();
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.mcp.deleteAria' })[1]);
    await waitFor(() => expect(screen.queryByText('Team Tools')).toBeNull());
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'settings.mcp.deleteConfirm.title' }),
    );
    expect(f.runs()).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('settings.mcp.toast.deleted');
  });
  it('offers no add entry on an instance that cannot create servers here', async () => {
    const client = createTrialCloudSettingsClient(),
      base = client.manage!.bind(client);
    vi.spyOn(client, 'manage').mockImplementation(async (command) => {
      const result = await base(command);
      return result.kind === 'page'
        ? { ...result, items: result.items.filter((item) => item.id !== 'mcp:create') }
        : result;
    });
    render(<CloudMcpAuthorization {...props} client={client} />);
    await screen.findByText('Documentation');
    expect(screen.queryByText('settings.mcp.addCustom.title')).toBeNull();
  });
});
