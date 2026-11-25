// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogTargetControls } from '@/features/plugin/PluginManagementLayout';
import type { CatalogDeviceControl } from '@/features/plugin/PluginDevicePicker';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Show the menu's content without opening it.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuItem: ({ children }: { children?: ReactNode }) => <div role="menuitem">{children}</div>,
    DropdownMenuSeparator: () => <hr />,
  };
});
afterEach(cleanup);

const instance = { deviceId: 'cloud-device-aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Cloud A' };
const control = (fixed?: boolean): CatalogDeviceControl => ({
  selected: instance,
  onSelect: () => {},
  directory: {
    candidates: [
      { ...instance, online: true },
      { deviceId: 'mac', name: 'Mac', online: true },
    ] as CatalogDeviceControl['directory']['candidates'],
    target: undefined,
    online: true,
    relayOnline: true,
  },
  fixed,
});
const project = <div role="menuitem">project scope</div>;

it('offers the computers and the project scope on the ordinary plugin page', () => {
  render(<CatalogTargetControls computer={control()} project={project} />);
  expect(screen.getByText('settings.ghosts.remote.thisComputer')).toBeTruthy();
  expect(screen.getByText('Mac')).toBeTruthy();
  expect(screen.getByText('project scope')).toBeTruthy();
});
// Cloud settings belong to one instance: its page offers no other computer.
it('offers only the project scope when the computer is fixed', () => {
  render(<CatalogTargetControls computer={control(true)} project={project} />);
  // The page already names the instance; the button only says which scope is shown.
  expect(screen.getByRole('button').textContent).toBe('settings.ghosts.scopePicker.globalScope');
  expect(screen.queryByText('settings.ghosts.remote.thisComputer')).toBeNull();
  expect(screen.queryByText('Mac')).toBeNull();
  expect(screen.queryByText('settings.ghosts.scopePicker.computers')).toBeNull();
  expect(screen.getByText('project scope')).toBeTruthy();
  expect(document.querySelector('hr')).toBeNull();
});
it('shows no target control when the computer is fixed and there is no scope to pick', () => {
  const { container } = render(<CatalogTargetControls computer={control(true)} />);
  expect(container.innerHTML).toBe('');
});
