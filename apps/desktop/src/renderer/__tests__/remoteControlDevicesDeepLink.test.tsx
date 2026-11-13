// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { deviceLinkSettings } = vi.hoisted(() => ({
  deviceLinkSettings: {
    enabled: true,
    linkStatus: 'online',
    connectionIssue: null,
    devices: [
      {
        deviceId: 'self',
        name: 'Studio Mac',
        platform: 'darwin',
        appVersion: '1.0.0',
        lastSeenAt: null,
        online: true,
        busy: false,
        remoteControlEnabled: true,
        controlEnabled: true,
        isSelf: true,
      },
    ],
    controlledBy: [],
    revokedControllers: [],
    disabledControlDeviceIds: [],
    listError: null,
    refreshing: false,
  },
}));
vi.mock('@/hooks/useDeviceLinkSettings', () => ({
  useDeviceLinkSettings: () => deviceLinkSettings,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ mode: 'cloud' }) }));
vi.mock('../components/settings/MyDevicesPanel', () => ({
  MyDevicesPanel: ({
    variant,
    focusDeviceId,
    focusRequestKey,
  }: {
    variant?: string;
    focusDeviceId?: string | null;
    focusRequestKey?: string | null;
  }) => (
    <div
      data-testid={`my-devices-panel-${variant ?? 'all'}`}
      data-focus-device={focusDeviceId ?? ''}
      data-focus-key={focusRequestKey ?? ''}
    />
  ),
}));
vi.mock('../components/settings/RemoteSection', () => ({
  RemoteSection: () => <div data-testid="remote-section" />,
}));

import { RemoteControlSection } from '@/components/settings/RemoteControlSection';
import { _resetRemoteConnectionV2ForTests } from '@/features/remote-connection-v2/useRemoteConnectionV2';

// 收起态的 header 无障碍名里还会带上摘要文案,所以用前缀匹配。
const devicesHeader = () =>
  screen.getByRole('button', { name: /^settings\.remoteControl\.sections\.myDevices/ });

function DeepLinkTrigger() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/settings?tab=remote-control&section=devices')}>
      go devices
    </button>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="search">{location.search}</span>;
}

const currentSearch = () => screen.getByTestId('search').textContent ?? '';

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      remoteSsh: {
        list: vi.fn(async () => ({ hosts: [] })),
        onStatusChanged: vi.fn(() => vi.fn()),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RemoteControlSection devices deep link', () => {
  it('renders the devices section expanded on the very first paint', () => {
    // 用 SSR 渲染拿「effect 跑之前」的那一帧:放在 effect 里展开会先画一帧收起,
    // 再把下方内容顶开一格。render() 会同步冲掉 effect,分辨不出这一帧。
    const firstPaint = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/settings?tab=remote-control&section=devices']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );

    // 只看「我的设备」那颗 header:SSH 子块默认收起,它的 aria-expanded=false 是对的。
    expect(firstPaint).toMatch(
      /aria-expanded="true"[\s\S]{0,300}?settings\.remoteControl\.sections\.myDevices/,
    );
    expect(firstPaint).not.toMatch(
      /aria-expanded="false"[\s\S]{0,300}?settings\.remoteControl\.sections\.myDevices/,
    );
  });

  it('keeps the deep link when it arrives while the page is already mounted', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control']}>
        <LocationProbe />
        <DeepLinkTrigger />
        <RemoteControlSection />
      </MemoryRouter>,
    );
    expect(devicesHeader().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'go devices' }));
    await waitFor(() => expect(devicesHeader().getAttribute('aria-expanded')).toBe('true'));

    // 清 URL 的 effect 不能拿这一帧还没提交的 devicesOpen=false 把刚进来的深链清掉,
    // 否则刷新/返回时这条链接就失效了。
    expect(currentSearch()).toContain('section=devices');
  });

  it('drops the section param once the user collapses the list', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control&section=devices']}>
        <LocationProbe />
        <RemoteControlSection />
      </MemoryRouter>,
    );

    fireEvent.click(devicesHeader());

    await waitFor(() => expect(currentSearch()).not.toContain('section=devices'));
    expect(currentSearch()).toContain('tab=remote-control');
    expect(devicesHeader().getAttribute('aria-expanded')).toBe('false');
  });

  it('hands the device focus param to both device panels once the list is expanded', () => {
    render(
      <MemoryRouter
        initialEntries={['/settings?tab=remote-control&section=devices&device=phone-1']}
      >
        <RemoteControlSection />
      </MemoryRouter>,
    );

    expect(devicesHeader().getAttribute('aria-expanded')).toBe('true');
    for (const variant of ['self', 'others']) {
      const panel = screen.getByTestId(`my-devices-panel-${variant}`);
      expect(panel.getAttribute('data-focus-device')).toBe('phone-1');
      expect(panel.getAttribute('data-focus-key')).toMatch(/^phone-1:/);
    }
  });

  it('ignores a device param that is not part of the devices deep link', () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control&device=phone-1']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );

    expect(devicesHeader().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('my-devices-panel-others').getAttribute('data-focus-device')).toBe('');
  });

  it('re-requests focus when the same device deep link is opened again', async () => {
    function SameLinkTrigger() {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() => navigate('/settings?tab=remote-control&section=devices&device=phone-1')}
        >
          go phone
        </button>
      );
    }
    render(
      <MemoryRouter
        initialEntries={['/settings?tab=remote-control&section=devices&device=phone-1']}
      >
        <SameLinkTrigger />
        <RemoteControlSection />
      </MemoryRouter>,
    );
    const panel = () => screen.getByTestId('my-devices-panel-others');
    const firstKey = panel().getAttribute('data-focus-key');

    fireEvent.click(screen.getByRole('button', { name: 'go phone' }));

    await waitFor(() => expect(panel().getAttribute('data-focus-key')).not.toBe(firstKey));
    expect(panel().getAttribute('data-focus-device')).toBe('phone-1');
  });

  it('drops the device focus param together with the section when the user collapses', async () => {
    render(
      <MemoryRouter
        initialEntries={['/settings?tab=remote-control&section=devices&device=phone-1']}
      >
        <LocationProbe />
        <RemoteControlSection />
      </MemoryRouter>,
    );

    fireEvent.click(devicesHeader());

    await waitFor(() => expect(currentSearch()).not.toContain('section=devices'));
    expect(currentSearch()).not.toContain('device=');
    expect(currentSearch()).toContain('tab=remote-control');
    expect(screen.getByTestId('my-devices-panel-others').getAttribute('data-focus-device')).toBe('');
  });
});

// 「Agent-Net (Beta)」打开后「我的设备」只留本机卡片,下面紧接拓扑图,其它设备不再列出(用户裁决 2026-11-07)。
// 设备深链照旧可用:指向本机时交给本机卡片定位,指向其它设备时打开拓扑里那台设备的卡片。
describe('RemoteControlSection with Agent-Net on', () => {
  const phone = {
    deviceId: 'phone-1',
    name: 'Pixel',
    platform: 'android',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: false,
    controlEnabled: true,
    isSelf: false,
  };

  beforeEach(() => {
    localStorage.setItem('remoteConnection.v2', 'on');
    _resetRemoteConnectionV2ForTests();
    deviceLinkSettings.devices.push(phone);
  });

  afterEach(() => {
    localStorage.removeItem('remoteConnection.v2');
    _resetRemoteConnectionV2ForTests();
    deviceLinkSettings.devices.splice(deviceLinkSettings.devices.indexOf(phone), 1);
  });

  it('keeps only this computer card above the topology, with no other-devices list', () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('switch', { name: 'settings.remoteControl.v2.switch.title' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByTestId('my-devices-panel-self')).toBeTruthy();
    expect(screen.queryByTestId('my-devices-panel-others')).toBeNull();
    expect(screen.queryByRole('button', { name: /^settings\.remoteControl\.sections\.myDevices/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Pixel/ })).toBeTruthy();
  });

  // 用户裁决(2026-11-07):没有「需要处理 / 最近」卡片,最近活动收在拓扑右上角的图标里。
  it('shows recent activity behind an icon instead of a separate card', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.v2.recent.title' }));
    const popover = await screen.findByRole('dialog');
    expect(popover.textContent).toContain('settings.remoteControl.v2.recent.empty');
  });

  it('hands a deep link to this computer to its card', () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control&section=devices&device=self']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );

    const panel = screen.getByTestId('my-devices-panel-self');
    expect(panel.getAttribute('data-focus-device')).toBe('self');
    expect(panel.getAttribute('data-focus-key')).toMatch(/^self:/);
  });

  it('opens the topology card of another device the deep link points at', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control&section=devices&device=phone-1']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );

    const card = await screen.findByRole('dialog');
    expect(card.textContent).toContain('Pixel');
  });
});
