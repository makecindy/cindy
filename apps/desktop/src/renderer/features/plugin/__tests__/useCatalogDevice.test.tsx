// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { CatalogDeviceScope, useCatalogDevice } from '../useCatalogDevice';
import { PluginDevicePicker } from '../PluginDevicePicker';

const directory = vi.hoisted(() => ({ online: true }));
vi.mock('../PluginDevicePicker', () => ({
  usePluginDeviceDirectory: () => directory,
  PluginDevicePicker: ({
    onSelect,
  }: {
    onSelect(device: { deviceId: string; name: string }): void;
  }) => (
    <button onClick={() => onSelect({ deviceId: 'target', name: 'A' })}>Select computer</button>
  ),
}));
afterEach(cleanup);

let ownerId = 'owner';
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: ownerId, isAuthenticated: true }),
}));
function Page({ tab }: { tab: string }) {
  const { device, selectDevice } = useCatalogDevice();
  return (
    <>
      <output>
        {tab}: {device?.name ?? 'local'}
      </output>
      <button onClick={() => selectDevice({ deviceId: 'target', name: 'A' })}>Select A</button>
    </>
  );
}
describe('shared Plugin and Skill host scope', () => {
  it('keeps presence and the selected computer current while the installed picker is absent in detail', () => {
    ownerId = 'owner';
    setDataOwnerGeneration('owner');
    directory.online = true;
    const scoped = (detail = false) => (
      <CatalogDeviceScope>
        {(device, online, _generation, control) => (
          <>
            <output>
              {device?.name ?? 'local'}: {online ? 'online' : 'offline'}
            </output>
            {!detail && control ? <PluginDevicePicker {...control} /> : null}
          </>
        )}
      </CatalogDeviceScope>
    );
    const ui = render(scoped());
    fireEvent.click(screen.getByText('Select computer'));
    expect(screen.getByText('A: online')).toBeTruthy();
    directory.online = false;
    ui.rerender(scoped(true));
    expect(screen.getByText('A: offline')).toBeTruthy();
    expect(screen.queryByText('Select computer')).toBeNull();
    ui.rerender(scoped());
    expect(screen.getByText('A: offline')).toBeTruthy();
    expect(screen.getByText('Select computer')).toBeTruthy();
  });
  it('retains the computer across separate page mounts and clears it across the account generation boundary', () => {
    setDataOwnerGeneration('owner');
    const first = render(<Page tab="Plugins" />);
    fireEvent.click(screen.getByText('Select A'));
    expect(screen.getByText('Plugins: A')).toBeTruthy();
    first.unmount();
    const skills = render(<Page tab="Skills" />);
    expect(screen.getByText('Skills: A')).toBeTruthy();
    setDataOwnerGeneration('owner');
    skills.rerender(<Page tab="Skills" />);
    expect(screen.getByText('Skills: local')).toBeTruthy();
    fireEvent.click(screen.getByText('Select A'));
    ownerId = 'other';
    setDataOwnerGeneration('other');
    skills.rerender(<Page tab="Skills" />);
    expect(screen.getByText('Skills: local')).toBeTruthy();
  });
});
