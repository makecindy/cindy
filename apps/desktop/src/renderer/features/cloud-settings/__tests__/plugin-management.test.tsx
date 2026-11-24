// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudPluginManagement } from '../CloudPluginManagement';

type PageProps = {
  device: { deviceId: string; name: string };
  online: boolean;
  active: boolean;
  embedded?: boolean;
  deviceControl: {
    selected: { deviceId: string } | null;
    onSelect(device: { deviceId: string; name: string } | null): void;
    directory: { candidates: Array<{ deviceId: string }>; online: boolean };
    fixed?: boolean;
  };
  onSelectCatalogTab(tab: 'plugins' | 'skills'): void;
};
const pages = vi.hoisted(() => ({ plugins: [] as unknown[], skills: [] as unknown[], online: true }));
const instance = 'cloud-device-aaaaaaaaaaaaaaaaaaaaaaaa';
vi.mock('@/features/plugin/RemotePluginCatalogSource', () => ({
  RemotePluginCatalogSource: (props: PageProps) => {
    pages.plugins.push(props);
    return (
      <div data-testid="plugins">
        <button onClick={() => props.onSelectCatalogTab('skills')}>skills</button>
      </div>
    );
  },
}));
vi.mock('@/features/skillhub/RemoteSkillsPage', () => ({
  RemoteSkillsPage: (props: PageProps) => {
    pages.skills.push(props);
    return <div data-testid="skills" />;
  },
}));
vi.mock('@/features/plugin/PluginDevicePicker', () => ({
  usePluginDeviceDirectory: () => ({
    candidates: [
      { deviceId: 'mac', name: 'Mac', online: true },
      { deviceId: instance, name: 'Cloud A', online: pages.online },
    ],
    target: { deviceId: instance, name: 'Cloud A', online: pages.online },
    online: pages.online,
    relayOnline: true,
  }),
}));
afterEach(() => {
  cleanup();
  pages.plugins.length = 0;
  pages.skills.length = 0;
  pages.online = true;
});
const show = (active = true) =>
  render(
    <CloudPluginManagement deviceId={instance} name="Cloud A" active={active} />,
  );
const last = (list: unknown[]) => list.at(-1) as PageProps;

it('manages the instance with the remote plugin page, fixed to that instance', () => {
  show();
  const props = last(pages.plugins);
  expect(props.device).toEqual({ deviceId: instance, name: 'Cloud A' });
  expect(props).toMatchObject({ online: true, active: true, embedded: true });
  expect(props.deviceControl.selected).toEqual(props.device);
  // These settings belong to the instance: no computer can be chosen from here.
  expect(props.deviceControl.fixed).toBe(true);
  // The settings page names the instance above this category, as above every other.
  expect(props).toMatchObject({ hideManagingNotice: true });
});
it('follows DeviceLink presence, not the settings connection', () => {
  pages.online = false;
  show();
  expect(last(pages.plugins).online).toBe(false);
});
it('reads skills only once their tab is opened and keeps the plugin page mounted', async () => {
  show();
  expect(pages.skills).toHaveLength(0);
  fireEvent.click(screen.getByText('skills'));
  await screen.findByTestId('skills');
  expect(last(pages.skills)).toMatchObject({
    device: { deviceId: instance, name: 'Cloud A' },
    active: true,
    embedded: true,
    hideManagingNotice: true,
  });
  expect(last(pages.plugins).active).toBe(false);
  expect(screen.getByTestId('plugins')).toBeTruthy();
});
it('pauses the page while another settings category is shown', () => {
  show(false);
  expect(last(pages.plugins).active).toBe(false);
});
