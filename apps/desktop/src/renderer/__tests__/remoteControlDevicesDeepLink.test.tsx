// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const { authUser } = vi.hoisted(() => ({
  authUser: { current: null as null | { id: string; orgId: string; membershipKind: 'org' } },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'cloud' }),
  useOptionalAuthUser: () => authUser.current,
  useOptionalDataOwnerGeneration: () => 0,
}));
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
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';
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

// 「我的设备」就是设备管理:「Agent-Net (Beta)」打开后照样列出全部设备,拓扑图接在下面只管连接
// (用户裁决 2026-11-25,取代 2026-11-07「只留本机卡片、其它设备在拓扑里看」)。设备深链由列表定位。
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

  it('lists every device in My devices above the topology', () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('switch', { name: 'settings.remoteControl.v2.switch.title' }).getAttribute('aria-checked'),
    ).toBe('true');
    // The same collapsible list as with the switch off: this computer pinned, the others one click away.
    expect(devicesHeader().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('my-devices-panel-self')).toBeTruthy();
    expect(screen.getByTestId('my-devices-panel-others')).toBeTruthy();
    // The topology still draws every device.
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

  it('focuses another device the deep link points at in My devices, not in the topology', () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control&section=devices&device=phone-1']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );

    expect(devicesHeader().getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByTestId('my-devices-panel-others');
    expect(panel.getAttribute('data-focus-device')).toBe('phone-1');
    expect(panel.getAttribute('data-focus-key')).toMatch(/^phone-1:/);
    // Two targets for one link would fight over the scroll position.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// Cloud instances are device cards in "My devices"; the retired category's deep
// link and search entry open that list and focus the instance. Admission and the card's own
// controls are covered in features/cloud-settings/__tests__/device-directory.test.tsx.
describe('RemoteControlSection cloud instance deep link', () => {
  it('opens My devices and focuses the instance from the cloud instances link', () => {
    render(
      <MemoryRouter
        initialEntries={[
          '/settings?tab=remote-control&section=remoteControl.cloudInstances&device=cloud-1',
        ]}
      >
        <RemoteControlSection />
      </MemoryRouter>,
    );
    expect(devicesHeader().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('my-devices-panel-others').getAttribute('data-focus-device')).toBe(
      'cloud-1',
    );
  });

  it('restores the expanded list without focusing anything when coming back from instance settings', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control&devices=open']}>
        <LocationProbe />
        <RemoteControlSection />
      </MemoryRouter>,
    );
    expect(devicesHeader().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('my-devices-panel-others').getAttribute('data-focus-device')).toBe('');
    fireEvent.click(devicesHeader());
    await waitFor(() => expect(currentSearch()).not.toContain('devices=open'));
  });
});

// 测试价值
// - 生产入口与可观察结果:RemoteControlSection →「我的设备」里的「云主机」一行;用户看到哪些按钮,点了在浏览器里打开哪一页。
// - 规则依据:用户裁决 2026-11-25,云主机的添加和管理放进设备管理(侧栏菜单入口保留,与这里读同一份入口)。
// - 现有覆盖缺口:入口解析在 maker-shared deviceList.test.ts,但没有测试经界面验证按钮与打开的地址。
// - 最小失败输入:组织成员已有一台运行中的云主机、还能再开一台 → 两个按钮,「添加」带下单参数;个人账号没有这一行。
// - tier:unit(jsdom),与同页其它用例同一文件、同一套 mock。
describe('RemoteControlSection cloud computer row', () => {
  const consoleUrl = 'https://console.example.test/console/orgs/org-1/personal/cloud';
  const entry = (computer: unknown, canAdd = false) => ({
    enabled: true,
    membershipId: 'member-1',
    organizationId: 'org-1',
    url: consoleUrl,
    computer,
    canAdd,
  });
  let openExternal: ReturnType<typeof vi.fn>;

  function renderWithEntry(value: unknown) {
    openExternal = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        remoteSsh: { list: vi.fn(async () => ({ hosts: [] })), onStatusChanged: vi.fn(() => vi.fn()) },
        deviceLink: { cloudComputerEntry: vi.fn(async () => value) },
        openExternal,
      },
    });
    render(
      <MemoryRouter initialEntries={['/settings?tab=remote-control']}>
        <RemoteControlSection />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    authUser.current = { id: 'member-1', orgId: 'org-1', membershipKind: 'org' };
  });
  afterEach(() => {
    authUser.current = null;
  });

  it.each([
    ['no cloud computer yet', entry(null), ['addCloud']],
    ['one being prepared', entry({ status: 'creating' }), ['preparingCloud']],
    ['a running one, room for another', entry({ status: 'linked' }, true), ['manageCloud', 'addCloud']],
  ])('offers the actions for %s, pinned outside the collapsed list', async (_case, value, actions) => {
    renderWithEntry(value);

    for (const action of actions) {
      expect(
        await screen.findByRole('button', { name: `settings.remoteControl.cloudComputer.actions.${action}` }),
      ).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /^settings\.remoteControl\.cloudComputer\.actions\./ })).toHaveLength(
      actions.length,
    );
    expect(devicesHeader().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the order form for 添加云主机 and the cloud page for 管理云主机', async () => {
    renderWithEntry(entry({ status: 'linked' }, true));

    fireEvent.click(await screen.findByRole('button', { name: 'settings.remoteControl.cloudComputer.actions.addCloud' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.cloudComputer.actions.manageCloud' }));

    const [add, manage] = openExternal.mock.calls.map(([href]) => new URL(href as string));
    expect(add.origin + add.pathname).toBe(consoleUrl);
    expect(add.searchParams.get('add')).toBe('1');
    expect(add.searchParams.get('app')).toBe(BRAND_IDENTITY.primaryScheme);
    expect(manage.origin + manage.pathname).toBe(consoleUrl);
    expect(manage.searchParams.has('add')).toBe(false);
    expect(manage.searchParams.get('app')).toBe(BRAND_IDENTITY.primaryScheme);
  });

  it('shows no cloud computer row for an account without the entry', async () => {
    authUser.current = null;
    renderWithEntry(entry({ status: 'linked' }, true));
    // Let any entry read settle, so a row that would appear late still fails the check.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('my-devices-panel-self')).toBeTruthy();
    expect(screen.queryByText('settings.remoteControl.cloudComputer.title')).toBeNull();
    expect(screen.queryByRole('button', { name: /^settings\.remoteControl\.cloudComputer\.actions\./ })).toBeNull();
  });
});
