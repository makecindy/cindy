// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GhostHostUiSetting } from '@cindy/plugin-protocol';
import { PluginSettingsFields } from '../PluginSettingsSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Unit, real settings form + IPC boundary. New registered fields must save through
// the shared namespace, reject invalid edits and reset; existing settings tests
// exercise only built-in sections. Minimal input: one bounded number and a switch.
it('edits declared fields, preserves invalid input locally and restores defaults', async () => {
  const fields: GhostHostUiSetting[] = [
    { id: 'size', title: 'Size', type: 'number', default: 12, min: 10, max: 20 },
    { id: 'enabled', title: 'Enabled', type: 'boolean', default: true },
  ];
  let value = { size: 14, enabled: true };
  const invoke = vi.fn(async (_session, input) => {
    if (input.operation === 'update') value = { ...value, ...input.patch };
    if (input.operation === 'reset') value = { size: 12, enabled: true };
    return { section: 'plugins.local__demo', state: { value, defaults: { size: 12, enabled: true }, customizedKeys: ['size'] } };
  });
  vi.stubGlobal('electronAPI', { maker: { mcpApps: invoke } });
  render(<PluginSettingsFields instanceId="local__demo" title="Example" fields={fields} />);
  const size = await screen.findByRole('spinbutton', { name: 'Size' });
  await waitFor(() => expect((size as HTMLInputElement).value).toBe('14'));
  fireEvent.change(size, { target: { value: '30' } });
  expect(screen.getByRole('button', { name: 'pluginUi.save' }).hasAttribute('disabled')).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.change(size, { target: { value: '18' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
  fireEvent.click(screen.getByRole('button', { name: 'pluginUi.save' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith(null, { op: 'plugin-settings', instanceId: 'local__demo', operation: 'update', patch: { size: 18, enabled: false } }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'settings.defaults.restore' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));
  await waitFor(() => expect((size as HTMLInputElement).value).toBe('12'));
});
