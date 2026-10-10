// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastInfo: vi.fn(),
  authDeviceId: 'this-mac' as string | null,
  devices: null as Array<{ deviceId: string; name: string; isSelf: boolean }> | null,
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key,
  }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthDeviceId: () => mocks.authDeviceId,
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => mocks.devices,
}));
vi.mock('@/lib/toast', () => ({ toast: { info: mocks.toastInfo } }));

import { SessionNavigationModeProvider } from '@/features/cc-agent/embeddedSessionNavigation';
import { SHARE_SOURCE_ATTR } from '@/lib/shareConversationImage';
import { MessageSourceLabels, QueueSourceDeviceTag } from '../MessageSourceLabels';

const phone = { deviceId: 'phone-1', name: 'Snapshot iPhone', platform: 'mobile' as const };

beforeEach(() => {
  mocks.authDeviceId = 'this-mac';
  mocks.devices = [
    { deviceId: 'this-mac', name: 'Studio Mac', isSelf: true },
    { deviceId: 'phone-1', name: 'Dash iPhone', isSelf: false },
  ];
});

afterEach(() => {
  cleanup();
  mocks.navigate.mockReset();
  mocks.toastInfo.mockReset();
});

describe('MessageSourceLabels device label', () => {
  it('names the sending phone with its live name and opens My devices focused on it', () => {
    render(<MessageSourceLabels sourceDevice={phone} />);
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('chat.userMessage.deviceSentMobileNamed:Dash iPhone');
    expect(button.getAttribute('title')).toBe(
      'chat.userMessage.deviceViewSettings\nchat.userMessage.sourceIds.device:phone-1',
    );
    fireEvent.click(button);
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/settings?tab=remote-control&section=devices&device=phone-1',
    );
  });

  it('uses computer wording for desktop controllers and the generic text without a name', () => {
    mocks.devices = null;
    render(<MessageSourceLabels sourceDevice={{ deviceId: 'pc-2', platform: 'desktop' }} />);
    expect(screen.getByRole('button').textContent).toBe('chat.userMessage.deviceSentDesktop');
  });

  it('is hidden on the sending device itself (viewer == sender)', () => {
    mocks.authDeviceId = 'phone-1';
    const { container } = render(<MessageSourceLabels sourceDevice={phone} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('is hidden when this desktop controlled a remote host and sent the message', () => {
    // 本机是控制端：被控电脑盖的是本机 device-link id，列表里 isSelf 那一行。
    mocks.authDeviceId = null;
    mocks.devices = [{ deviceId: 'controller-mac', name: 'My Mac', isSelf: true }];
    const { container } = render(
      <MessageSourceLabels sourceDevice={{ deviceId: 'controller-mac', platform: 'desktop' }} />,
    );
    expect(container.textContent).toBe('');
  });

  it('disambiguates two known devices with the same name by a short id', () => {
    mocks.devices = [
      { deviceId: 'this-mac', name: 'Studio Mac', isSelf: true },
      { deviceId: 'phone-1', name: 'iPhone', isSelf: false },
      { deviceId: 'phone-2', name: 'iPhone', isSelf: false },
    ];
    render(<MessageSourceLabels sourceDevice={phone} />);
    expect(screen.getByRole('button').textContent).toBe(
      'chat.userMessage.deviceSentMobileNamed:iPhone (phone-)',
    );
  });

  it('toasts instead of navigating when the device has been removed', () => {
    mocks.devices = [{ deviceId: 'this-mac', name: 'Studio Mac', isSelf: true }];
    render(<MessageSourceLabels sourceDevice={phone} />);
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('chat.userMessage.deviceSentMobileNamed:Snapshot iPhone');
    fireEvent.click(button);
    expect(mocks.toastInfo).toHaveBeenCalledWith('chat.userMessage.deviceRemoved');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('is display-only in the embedded sidebar view, keeping the id tooltip', () => {
    render(
      <SessionNavigationModeProvider mode="sidebar-embedded">
        <MessageSourceLabels sourceDevice={phone} />
      </SessionNavigationModeProvider>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    const label = screen.getByText('chat.userMessage.deviceSentMobileNamed:Dash iPhone');
    expect(label.closest('[title]')?.getAttribute('title')).toBe(
      'chat.userMessage.sourceIds.device:phone-1',
    );
  });
});

describe('MessageSourceLabels plugin and row', () => {
  it('labels plugin messages and opens the plugin detail', () => {
    render(<MessageSourceLabels sourcePlugin={{ pluginId: 'ghost.notes', name: 'Notes' }} />);
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('chat.userMessage.pluginSentNamed:Notes');
    expect(button.getAttribute('title')).toBe(
      'chat.userMessage.pluginViewDetail\nchat.userMessage.sourceIds.plugin:ghost.notes',
    );
    fireEvent.click(button);
    expect(mocks.navigate).toHaveBeenCalledWith('/plugins?ghost=ghost.notes');
  });

  it('uses the generic plugin text without a name', () => {
    render(<MessageSourceLabels sourcePlugin={{ pluginId: 'p' }} />);
    expect(screen.getByRole('button').textContent).toBe('chat.userMessage.pluginSent');
  });

  it('shows at most one sender label plus the device label, marked as a share-image source', () => {
    const { container } = render(
      <MessageSourceLabels
        automationOrigin={{ kind: 'session', senderSessionId: 's1', senderSessionTitle: 'Planner' }}
        sourcePlugin={{ pluginId: 'p', name: 'Notes' }}
        sourceDevice={phone}
      />,
    );
    // 插件优先(与 messageSourceSenderFromMeta 同序):插件在某任务里派发时同时带来源任务 origin。
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'chat.userMessage.pluginSentNamed:Notes',
      'chat.userMessage.deviceSentMobileNamed:Dash iPhone',
    ]);
    expect(container.firstElementChild?.hasAttribute(SHARE_SOURCE_ATTR)).toBe(true);
  });

  it('renders nothing for host-local input', () => {
    const { container } = render(<MessageSourceLabels />);
    expect(container.innerHTML).toBe('');
  });
});

describe('QueueSourceDeviceTag (pending queue rows)', () => {
  it('shows the sending device compactly with the full label and id on hover', () => {
    const { container } = render(<QueueSourceDeviceTag device={phone} />);
    const tag = container.querySelector('span[aria-label]');
    expect(tag?.getAttribute('aria-label')).toBe('chat.userMessage.deviceSentMobileNamed:Dash iPhone');
    expect(tag?.getAttribute('title')).toBe(
      'chat.userMessage.deviceSentMobileNamed:Dash iPhone\nchat.userMessage.sourceIds.device:phone-1',
    );
    expect(tag?.textContent).toBe('Dash iPhone');
  });

  it('is hidden on the sending device itself', () => {
    mocks.authDeviceId = 'phone-1';
    const { container } = render(<QueueSourceDeviceTag device={phone} />);
    expect(container.textContent).toBe('');
  });
});


describe('private group reply source', () => {
  it('shows the group name and id in the existing source row, excluded from share images', () => {
    const { container } = render(<MessageSourceLabels sourceGroup={{ groupId: 'g-1', name: 'Design' }} align="start" />);
    const label = screen.getByText('chat.userMessage.groupSentNamed:Design');
    expect(label.closest('[data-message-origin]')?.getAttribute('title')).toBe('chat.userMessage.sourceIds.group:g-1');
    expect(container.querySelector(`[${SHARE_SOURCE_ATTR}]`)).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});
