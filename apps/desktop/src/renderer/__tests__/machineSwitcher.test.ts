import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  canonicalizeMachineEntries,
  machineSelectionEquals,
  MACHINE_ALL,
  MACHINE_LOCAL,
  normalizeSelectedMachineId,
  parseMachineSelection,
  selectVisibleSessions,
  serializeMachineSelection,
  toggleMachineSelection,
} from '@/features/device-link/selectedMachineStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  resolveSelectableIdsForNormalize,
  selectRemoteSessionBootstrapFailures,
  selectRemoteSessionBootstrapLoadingDevices,
  shouldShowMachineSwitcher,
  shouldShowSelectedMachineConnectingPlaceholder,
  shouldWaitForRemoteSessionBootstrap,
} from '@/features/device-link/useMachineSwitcher';
import { buildSwitcherDevices, selectableDeviceIds } from '@/features/device-link/switcherDevices';
import { compareDevicesByName } from '@/features/device-link/deviceSort';
import { applyDeviceRename } from '@/features/device-link/useDeviceLinkDeviceList';

/** 构造最小设备视图(只填 buildSwitcherDevices 关心的字段)。 */
function mkDevice(
  deviceId: string,
  over: Partial<DeviceLinkDeviceView> = {},
): DeviceLinkDeviceView {
  return {
    deviceId,
    name: deviceId.toUpperCase(),
    platform: null,
    appVersion: '0.0.0-test',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...over,
  };
}

/** 构造最小会话对象(只填本测试关心的字段)。 */
function mkSession(id: string, deviceLinkDeviceId?: string): Session {
  return { id, status: 'active', deviceLinkDeviceId } as unknown as Session;
}

describe('selectVisibleSessions', () => {
  const local = [mkSession('l1'), mkSession('l2')];
  const remote = [mkSession('r1', 'dev-a'), mkSession('r2', 'dev-a'), mkSession('r3', 'dev-b')];

  it('所有(默认)→ 本机 + 全部远程合并(顺序:本地在前)', () => {
    expect(selectVisibleSessions(local, remote, MACHINE_ALL).map((s) => s.id)).toEqual([
      'l1',
      'l2',
      'r1',
      'r2',
      'r3',
    ]);
  });

  it('只勾本机 → 只返回本地会话,排除所有远程会话', () => {
    expect(selectVisibleSessions(local, remote, [MACHINE_LOCAL]).map((s) => s.id)).toEqual([
      'l1',
      'l2',
    ]);
  });

  it('只勾一台远程机器 → 只返回该机器的会话', () => {
    expect(selectVisibleSessions(local, remote, ['dev-a']).map((s) => s.id)).toEqual(['r1', 'r2']);
    expect(selectVisibleSessions(local, remote, ['dev-b']).map((s) => s.id)).toEqual(['r3']);
  });

  it('多选:本机 + 某台远程 → 二者并集(本地在前)', () => {
    expect(selectVisibleSessions(local, remote, [MACHINE_LOCAL, 'dev-b']).map((s) => s.id)).toEqual(
      ['l1', 'l2', 'r3'],
    );
  });

  it('多选:两台远程 → 按勾选集过滤,排除本地', () => {
    expect(selectVisibleSessions(local, remote, ['dev-a', 'dev-b']).map((s) => s.id)).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
  });

  it('勾选的远程机器暂无会话 → 返回空数组', () => {
    expect(selectVisibleSessions(local, remote, ['dev-empty'])).toEqual([]);
  });
});

describe('normalizeSelectedMachineId', () => {
  it('MACHINE_ALL / 含 MACHINE_LOCAL 的勾选集恒有效', () => {
    expect(normalizeSelectedMachineId(MACHINE_ALL, [])).toBe(MACHINE_ALL);
    expect(normalizeSelectedMachineId([MACHINE_LOCAL], [])).toEqual([MACHINE_LOCAL]);
  });

  it('勾选设备仍在线 → 保留(无裁剪时返回原引用,消费侧 useMemo 依赖引用稳定)', () => {
    const raw = ['dev-a'];
    expect(normalizeSelectedMachineId(raw, ['dev-a', 'dev-b'])).toBe(raw);
  });

  it('勾选集裁掉已掉线设备;裁空 → 回落「所有」', () => {
    expect(normalizeSelectedMachineId(['dev-a', 'dev-c'], ['dev-a', 'dev-b'])).toEqual(['dev-a']);
    expect(normalizeSelectedMachineId(['dev-c'], ['dev-a', 'dev-b'])).toBe(MACHINE_ALL);
    expect(normalizeSelectedMachineId(['dev-a'], [])).toBe(MACHINE_ALL);
    // 本机不受设备列表影响:裁掉设备后仍剩本机 → 保留。
    expect(normalizeSelectedMachineId([MACHINE_LOCAL, 'dev-c'], [])).toEqual([MACHINE_LOCAL]);
  });

  it('设备列表尚未加载(null)→ 原样保留,不裁剪(持久化恢复的选择不被启动瞬间误清)', () => {
    const raw = ['dev-a', MACHINE_LOCAL];
    expect(normalizeSelectedMachineId(raw, null)).toBe(raw);
    expect(normalizeSelectedMachineId(MACHINE_ALL, null)).toBe(MACHINE_ALL);
  });
});

describe('断网后远端选择的逃生路径', () => {
  it('设备目录尚未结算时保留 raw 选择；终态不可用时回落「所有」', () => {
    const raw = ['dev-a'];
    const loadingSelectable = resolveSelectableIdsForNormalize(null, false, []);
    const stoppedSelectable = resolveSelectableIdsForNormalize(null, true, []);

    expect(loadingSelectable).toBeNull();
    expect(normalizeSelectedMachineId(raw, loadingSelectable)).toBe(raw);
    expect(stoppedSelectable).toEqual([]);
    expect(normalizeSelectedMachineId(raw, stoppedSelectable)).toBe(MACHINE_ALL);
  });

  it('目录不可用但仍记着远端选择时保留切换入口，用户可显式切回本机', () => {
    expect(shouldShowMachineSwitcher(['dev-a'], [])).toBe(true);
    expect(shouldShowMachineSwitcher([MACHINE_LOCAL], [])).toBe(false);
    expect(shouldShowMachineSwitcher(MACHINE_ALL, [])).toBe(false);
    expect(
      shouldShowMachineSwitcher(MACHINE_ALL, [
        { deviceId: 'dev-a', name: 'Mac A', status: 'connecting' },
      ]),
    ).toBe(true);
  });
});

describe('toggleMachineSelection(菜单多选点选)', () => {
  const selectable = ['dev-a', 'dev-b'];

  it('「所有」下点选一项 → 收窄为只看该项(与旧单选直觉一致)', () => {
    expect(toggleMachineSelection(MACHINE_ALL, 'dev-a', selectable)).toEqual(['dev-a']);
    expect(toggleMachineSelection(MACHINE_ALL, MACHINE_LOCAL, selectable)).toEqual([MACHINE_LOCAL]);
  });

  it('未勾选 → 追加;已勾选 → 取消', () => {
    expect(toggleMachineSelection(['dev-a'], 'dev-b', selectable)).toEqual(['dev-a', 'dev-b']);
    expect(toggleMachineSelection(['dev-a', 'dev-b'], 'dev-b', selectable)).toEqual(['dev-a']);
  });

  it('取消最后一项 → 回落「所有」', () => {
    expect(toggleMachineSelection(['dev-a'], 'dev-a', selectable)).toBe(MACHINE_ALL);
  });

  it('勾满本机 + 全部可选设备 → 收敛回「所有」(未来新设备自动包含)', () => {
    expect(toggleMachineSelection([MACHINE_LOCAL, 'dev-a'], 'dev-b', selectable)).toBe(MACHINE_ALL);
  });

  it('勾选集规范序:本机在前,设备按 id 字典序', () => {
    expect(toggleMachineSelection(['dev-b'], MACHINE_LOCAL, selectable)).toEqual([
      MACHINE_LOCAL,
      'dev-b',
    ]);
    expect(canonicalizeMachineEntries(['dev-b', MACHINE_LOCAL, 'dev-a', 'dev-b'])).toEqual([
      MACHINE_LOCAL,
      'dev-a',
      'dev-b',
    ]);
  });

  it('隐藏半保留:勾选集中暂时不可选的设备不因无关点选被冲掉(codex P2)', () => {
    // dev-offline 不在可选集(离线/未加载),点选 dev-a 后仍留在勾选集里。
    expect(toggleMachineSelection([MACHINE_LOCAL, 'dev-offline'], 'dev-a', selectable)).toEqual([
      MACHINE_LOCAL,
      'dev-a',
      'dev-offline',
    ]);
    // 取消可见项同样不动隐藏半。
    expect(
      toggleMachineSelection([MACHINE_LOCAL, 'dev-a', 'dev-offline'], 'dev-a', selectable),
    ).toEqual([MACHINE_LOCAL, 'dev-offline']);
  });

  it('隐藏半的两个收敛例外:可见半清空 → 回落「所有」;可见半勾满 → 收敛「所有」', () => {
    // 可见半只剩 local,取消它 → 视觉上清空 → 回落「所有」(隐藏半一并放下,「所有」已覆盖)。
    expect(toggleMachineSelection([MACHINE_LOCAL, 'dev-offline'], MACHINE_LOCAL, selectable)).toBe(
      MACHINE_ALL,
    );
    // 可见半勾满本机 + 全部可选设备 → 收敛「所有」。
    expect(
      toggleMachineSelection([MACHINE_LOCAL, 'dev-a', 'dev-offline'], 'dev-b', selectable),
    ).toBe(MACHINE_ALL);
  });
});

describe('机器选择持久化(serialize / parse 往返)', () => {
  it('MACHINE_ALL 与勾选集均可往返', () => {
    expect(parseMachineSelection(serializeMachineSelection(MACHINE_ALL))).toBe(MACHINE_ALL);
    expect(parseMachineSelection(serializeMachineSelection([MACHINE_LOCAL, 'dev-a']))).toEqual([
      MACHINE_LOCAL,
      'dev-a',
    ]);
  });

  it('null / 损坏 JSON / 非法形状 → 回落「所有」', () => {
    expect(parseMachineSelection(null)).toBe(MACHINE_ALL);
    expect(parseMachineSelection('not-json{')).toBe(MACHINE_ALL);
    expect(parseMachineSelection('[]')).toBe(MACHINE_ALL);
    expect(parseMachineSelection('[1,2]')).toBe(MACHINE_ALL);
    expect(parseMachineSelection('["ok",""]')).toBe(MACHINE_ALL);
    expect(parseMachineSelection('{"a":1}')).toBe(MACHINE_ALL);
  });

  it('数组里的 all sentinel 条目被剔除(脏数据防御,greptile P2);剔空回落「所有」', () => {
    expect(parseMachineSelection('["all","dev-a"]')).toEqual(['dev-a']);
    expect(parseMachineSelection('["all"]')).toBe(MACHINE_ALL);
  });

  it('parse 会做规范化(去重 + 本机在前 + 设备字典序)', () => {
    expect(parseMachineSelection('["dev-b","local","dev-a","dev-b"]')).toEqual([
      MACHINE_LOCAL,
      'dev-a',
      'dev-b',
    ]);
  });

  it('machineSelectionEquals:同集合判等,与 MACHINE_ALL 互斥', () => {
    expect(machineSelectionEquals(MACHINE_ALL, MACHINE_ALL)).toBe(true);
    expect(machineSelectionEquals(['dev-a'], ['dev-a'])).toBe(true);
    expect(machineSelectionEquals(['dev-a'], ['dev-b'])).toBe(false);
    expect(machineSelectionEquals(MACHINE_ALL, ['dev-a'])).toBe(false);
  });
});

describe('buildSwitcherDevices', () => {
  it('已连接(已同步)/ 连接中(在线可控未同步)/ 被拒(已撤销)三态分类', () => {
    const result = buildSwitcherDevices({
      fullList: [mkDevice('dev-connected'), mkDevice('dev-connecting'), mkDevice('dev-rejected')],
      syncedDevices: [
        { deviceId: 'dev-connected', deviceName: 'Connected', sessionCount: 1, connected: true },
      ],
      revoked: new Set(['dev-rejected']),
    });
    const byId = Object.fromEntries(result.map((d) => [d.deviceId, d.status]));
    expect(byId).toEqual({
      'dev-connected': 'connected',
      'dev-connecting': 'connecting',
      'dev-rejected': 'rejected',
    });
  });

  it('排除本机、离线、未开启被控的设备', () => {
    const result = buildSwitcherDevices({
      fullList: [
        mkDevice('self', { isSelf: true }),
        mkDevice('offline', { online: false }),
        mkDevice('no-remote', { remoteControlEnabled: false }),
        mkDevice('control-off', { controlEnabled: false }),
        mkDevice('ok'),
      ],
      syncedDevices: [],
      revoked: new Set(),
    });
    expect(result.map((d) => d.deviceId)).toEqual(['ok']);
    expect(result[0].status).toBe('connecting');
  });

  it('排除手机等移动端(ios/android),即便异常上报 remoteControlEnabled=true', () => {
    const result = buildSwitcherDevices({
      fullList: [
        mkDevice('iphone', { platform: 'ios' }),
        mkDevice('android-phone', { platform: 'android', remoteControlEnabled: true }),
        mkDevice('mac', { platform: 'darwin' }),
      ],
      syncedDevices: [],
      revoked: new Set(),
    });
    expect(result.map((d) => d.deviceId)).toEqual(['mac']);
  });

  it('被拒优先于在线可控判定状态', () => {
    const result = buildSwitcherDevices({
      fullList: [mkDevice('dev-x')],
      syncedDevices: [],
      // dev-x 仍在线可控,但被拒优先 → rejected 而非 connecting。
      revoked: new Set(['dev-x']),
    });
    expect(result).toEqual([{ deviceId: 'dev-x', name: 'DEV-X', status: 'rejected' }]);
  });

  it('按名字稳定排序,与连接状态无关(状态只决定显示、不决定位置)', () => {
    const result = buildSwitcherDevices({
      fullList: [
        mkDevice('dev-z', { name: 'Zeta' }), // connected
        mkDevice('dev-a', { name: 'Alpha' }), // rejected
        mkDevice('dev-m', { name: 'Mike' }), // connecting
      ],
      syncedDevices: [{ deviceId: 'dev-z', deviceName: 'Zeta', sessionCount: 0, connected: true }],
      revoked: new Set(['dev-a']),
    });
    // 名字序 Alpha < Mike < Zeta;若按状态(connected→connecting→rejected)会是 Zeta,Mike,Alpha。
    expect(result.map((d) => [d.name, d.status])).toEqual([
      ['Alpha', 'rejected'],
      ['Mike', 'connecting'],
      ['Zeta', 'connected'],
    ]);
  });

  it('被拒设备即使不在全量列表也列出(名字回退到 deviceId)', () => {
    const result = buildSwitcherDevices({
      fullList: [],
      syncedDevices: [],
      revoked: new Set(['gone-dev']),
    });
    expect(result).toEqual([{ deviceId: 'gone-dev', name: 'gone-dev', status: 'rejected' }]);
  });

  it('fullList 为 null(尚未加载)→ 仅由已同步 / 被拒撑起', () => {
    const result = buildSwitcherDevices({
      fullList: null,
      syncedDevices: [{ deviceId: 'dev-a', deviceName: 'Mac A', sessionCount: 2, connected: true }],
      revoked: new Set(),
    });
    expect(result).toEqual([{ deviceId: 'dev-a', name: 'Mac A', status: 'connected' }]);
  });

  it('仅有断线缓存的设备仍显示,但状态为 connecting', () => {
    const result = buildSwitcherDevices({
      fullList: [],
      syncedDevices: [
        { deviceId: 'dev-a', deviceName: 'Mac A', sessionCount: 2, connected: false },
      ],
      revoked: new Set(),
    });
    expect(result).toEqual([{ deviceId: 'dev-a', name: 'Mac A', status: 'connecting' }]);
  });

  it('已连接设备名以同步分片为准(覆盖 fullList 滞后的旧名;REST 改名不广播 presence)', () => {
    const result = buildSwitcherDevices({
      fullList: [mkDevice('dev-a', { name: '旧名' })],
      syncedDevices: [{ deviceId: 'dev-a', deviceName: '新名', sessionCount: 1, connected: true }],
      revoked: new Set(),
    });
    expect(result).toEqual([{ deviceId: 'dev-a', name: '新名', status: 'connected' }]);
  });

  it('同步分片名为空 → 回退 fullList 既有名(不被空名覆盖)', () => {
    const result = buildSwitcherDevices({
      fullList: [mkDevice('dev-a', { name: 'Mac A' })],
      syncedDevices: [{ deviceId: 'dev-a', deviceName: '', sessionCount: 0, connected: true }],
      revoked: new Set(),
    });
    expect(result).toEqual([{ deviceId: 'dev-a', name: 'Mac A', status: 'connected' }]);
  });
});

describe('compareDevicesByName（切换栏与设置共用,稳定身份排序）', () => {
  it('按名字 localeCompare → deviceId 兜底,不含状态/在线/时间', () => {
    const arr = [
      { name: 'Zeta', deviceId: 'z' },
      { name: 'alpha', deviceId: 'a2' },
      { name: 'alpha', deviceId: 'a1' },
      { name: 'Mike', deviceId: 'm' },
    ];
    expect(
      arr
        .slice()
        .sort(compareDevicesByName)
        .map((d) => d.deviceId),
    ).toEqual([
      'a1', // alpha + deviceId 兜底(a1 < a2)
      'a2',
      'm',
      'z',
    ]);
  });
});

describe('selectableDeviceIds', () => {
  it('已连接 + 连接中可选中,被拒不可选', () => {
    expect(
      selectableDeviceIds([
        { deviceId: 'a', name: 'A', status: 'connected' },
        { deviceId: 'b', name: 'B', status: 'connecting' },
        { deviceId: 'c', name: 'C', status: 'rejected' },
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('normalizeSelectedMachineId 配合可选中集(连接中可保留,被拒回落)', () => {
  it('勾选的连接中设备保留;被拒 / 消失的设备被裁掉,裁空回落「所有」', () => {
    const selectable = ['connected-1', 'connecting-1']; // 不含被拒 / 已消失
    const raw = ['connecting-1'];
    expect(normalizeSelectedMachineId(raw, selectable)).toBe(raw);
    expect(normalizeSelectedMachineId(['rejected-1'], selectable)).toBe(MACHINE_ALL);
    expect(normalizeSelectedMachineId(['gone-1'], selectable)).toBe(MACHINE_ALL);
    expect(normalizeSelectedMachineId(['connecting-1', 'rejected-1'], selectable)).toEqual([
      'connecting-1',
    ]);
  });
});

describe('shouldWaitForRemoteSessionBootstrap', () => {
  const connecting = [{ deviceId: 'dev-a', name: 'Mac A', status: 'connecting' as const }];
  const noBootstrapFailures = new Set<string>();

  it('所有机器:设备清单或在线远端首快照未落地 → 保持加载态', () => {
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: MACHINE_ALL,
        deviceListSettled: false,
        devices: [],
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(true);
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: MACHINE_ALL,
        deviceListSettled: true,
        devices: connecting,
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(true);
  });

  it('权威空快照已落地也算 bootstrap 完成，不把 0 会话误判成仍加载', () => {
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: MACHINE_ALL,
        deviceListSettled: true,
        devices: connecting,
        syncedDevices: [
          { deviceId: 'dev-a', deviceName: 'Mac A', sessionCount: 0, connected: false },
        ],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
  });

  it('明确选择已有权威 shard 的设备时，不等待独立的设备清单重试', () => {
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: ['dev-a'],
        deviceListSettled: false,
        devices: connecting,
        syncedDevices: [
          { deviceId: 'dev-a', deviceName: 'Mac A', sessionCount: 0, connected: false },
        ],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
  });

  it('设备清单请求失败但已结算 → 不把未知设备列表当成永久加载', () => {
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: MACHINE_ALL,
        deviceListSettled: true,
        devices: [],
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
  });

  it('仅本机不等待远端；混合选择只等待作用域内尚未同步的远端设备', () => {
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: [MACHINE_LOCAL],
        deviceListSettled: false,
        devices: [],
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: [MACHINE_LOCAL, 'dev-b'],
        deviceListSettled: true,
        devices: connecting,
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: [MACHINE_LOCAL, 'dev-a'],
        deviceListSettled: true,
        devices: connecting,
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(true);
  });

  it('被拒或已有断线缓存的设备不算等待中的首次 bootstrap', () => {
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: MACHINE_ALL,
        deviceListSettled: true,
        devices: [{ deviceId: 'dev-a', name: 'Mac A', status: 'rejected' }],
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: MACHINE_ALL,
        deviceListSettled: true,
        devices: connecting,
        syncedDevices: [
          { deviceId: 'dev-a', deviceName: 'Mac A', sessionCount: 2, connected: false },
        ],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
  });

  it('bootstrap 终态失败的连接中设备不再无限 loading；其它未结算设备仍继续等待', () => {
    const devices = [
      { deviceId: 'dev-a', name: 'Mac A', status: 'connecting' as const },
      { deviceId: 'dev-b', name: 'Mac B', status: 'connecting' as const },
    ];
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: ['dev-a'],
        deviceListSettled: true,
        devices,
        syncedDevices: [],
        bootstrapFailedDeviceIds: new Set(['dev-a']),
      }),
    ).toBe(false);
    expect(
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId: MACHINE_ALL,
        deviceListSettled: true,
        devices,
        syncedDevices: [],
        bootstrapFailedDeviceIds: new Set(['dev-a']),
      }),
    ).toBe(true);
  });
});

describe('selectRemoteSessionBootstrapFailures', () => {
  const devices = [
    { deviceId: 'dev-a', name: 'Mac A', status: 'connecting' as const },
    { deviceId: 'dev-b', name: 'Mac B', status: 'connected' as const },
    { deviceId: 'dev-c', name: 'Mac C', status: 'rejected' as const },
  ];
  const failures = new Set(['dev-a', 'dev-b', 'dev-c']);

  it('所有机器返回全部可见失败设备，但不把已拒绝设备混成读取失败', () => {
    expect(
      selectRemoteSessionBootstrapFailures({
        selectedMachineId: MACHINE_ALL,
        devices,
        bootstrapFailedDeviceIds: failures,
      }).map((device) => device.deviceId),
    ).toEqual(['dev-a', 'dev-b']);
  });

  it('显式多选只返回勾选范围内的失败设备；仅本机忽略远端失败', () => {
    expect(
      selectRemoteSessionBootstrapFailures({
        selectedMachineId: ['dev-b'],
        devices,
        bootstrapFailedDeviceIds: failures,
      }).map((device) => device.deviceId),
    ).toEqual(['dev-b']);
    expect(
      selectRemoteSessionBootstrapFailures({
        selectedMachineId: [MACHINE_LOCAL],
        devices,
        bootstrapFailedDeviceIds: failures,
      }),
    ).toEqual([]);
    expect(
      selectRemoteSessionBootstrapFailures({
        selectedMachineId: [MACHINE_LOCAL, 'dev-a'],
        devices,
        bootstrapFailedDeviceIds: failures,
      }).map((device) => device.deviceId),
    ).toEqual(['dev-a']);
  });
});

describe('selectRemoteSessionBootstrapLoadingDevices', () => {
  const devices = [
    { deviceId: 'dev-a', name: 'Mac A', status: 'connecting' as const },
    { deviceId: 'dev-b', name: 'Mac B', status: 'connected' as const },
  ];
  const loading = new Set(['dev-a', 'dev-b']);

  it('已有 shard 的设备重读时仍属于 loading，并按当前机器范围过滤', () => {
    expect(
      selectRemoteSessionBootstrapLoadingDevices({
        selectedMachineId: MACHINE_ALL,
        devices,
        bootstrapLoadingDeviceIds: loading,
      }).map((device) => device.deviceId),
    ).toEqual(['dev-a', 'dev-b']);
    expect(
      selectRemoteSessionBootstrapLoadingDevices({
        selectedMachineId: ['dev-b'],
        devices,
        bootstrapLoadingDeviceIds: loading,
      }).map((device) => device.deviceId),
    ).toEqual(['dev-b']);
    expect(
      selectRemoteSessionBootstrapLoadingDevices({
        selectedMachineId: [MACHINE_LOCAL],
        devices,
        bootstrapLoadingDeviceIds: loading,
      }),
    ).toEqual([]);
  });
});

describe('shouldShowSelectedMachineConnectingPlaceholder', () => {
  const noBootstrapFailures = new Set<string>();

  it('在线可控但尚未同步会话 → 显示连接中占位', () => {
    expect(
      shouldShowSelectedMachineConnectingPlaceholder({
        rawSelection: ['dev-a'],
        devices: [{ deviceId: 'dev-a', name: 'Mac A', status: 'connecting' }],
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(true);
  });

  it('断线但已有缓存会话 → 不显示连接中占位,让侧边栏展示缓存 session', () => {
    expect(
      shouldShowSelectedMachineConnectingPlaceholder({
        rawSelection: ['dev-a'],
        devices: [{ deviceId: 'dev-a', name: 'Mac A', status: 'connecting' }],
        syncedDevices: [
          { deviceId: 'dev-a', deviceName: 'Mac A', sessionCount: 2, connected: false },
        ],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
  });

  it('断线缓存为空 → 仍显示连接中占位', () => {
    expect(
      shouldShowSelectedMachineConnectingPlaceholder({
        rawSelection: ['dev-a'],
        devices: [{ deviceId: 'dev-a', name: 'Mac A', status: 'connecting' }],
        syncedDevices: [
          { deviceId: 'dev-a', deviceName: 'Mac A', sessionCount: 0, connected: false },
        ],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(true);
  });

  it('选中设备的 bootstrap 已终态失败 → 停止连接中占位，交给独立错误态', () => {
    expect(
      shouldShowSelectedMachineConnectingPlaceholder({
        rawSelection: ['dev-a'],
        devices: [{ deviceId: 'dev-a', name: 'Mac A', status: 'connecting' }],
        syncedDevices: [],
        bootstrapFailedDeviceIds: new Set(['dev-a']),
      }),
    ).toBe(false);
  });

  it('多选:全是连接中且无缓存 → 占位;混入本机或已连接设备 → 不占位', () => {
    const devices = [
      { deviceId: 'dev-a', name: 'Mac A', status: 'connecting' as const },
      { deviceId: 'dev-b', name: 'PC B', status: 'connected' as const },
    ];
    expect(
      shouldShowSelectedMachineConnectingPlaceholder({
        rawSelection: ['dev-a'],
        devices,
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(true);
    expect(
      shouldShowSelectedMachineConnectingPlaceholder({
        rawSelection: ['dev-a', 'dev-b'],
        devices,
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
    expect(
      shouldShowSelectedMachineConnectingPlaceholder({
        rawSelection: ['local', 'dev-a'],
        devices,
        syncedDevices: [],
        bootstrapFailedDeviceIds: noBootstrapFailures,
      }),
    ).toBe(false);
  });
});

describe('remoteProjectsStore.getDeviceList', () => {
  afterEach(() => {
    remoteProjectsStore.clear();
  });

  it('反映已连接设备(按 deviceName 稳定排序)+ 正确会话数', () => {
    remoteProjectsStore.setDeviceSessions('dev-b', 'PC B', [mkSession('s3')]);
    remoteProjectsStore.setDeviceSessions('dev-a', 'Mac A', [mkSession('s1'), mkSession('s2')]);

    expect(remoteProjectsStore.getDeviceList()).toEqual([
      { deviceId: 'dev-a', deviceName: 'Mac A', sessionCount: 2, connected: true },
      { deviceId: 'dev-b', deviceName: 'PC B', sessionCount: 1, connected: true },
    ]);
  });

  it('会话内容变化但设备数/名/数量不变 → 引用稳定(不触发切换栏重渲染)', () => {
    remoteProjectsStore.setDeviceSessions('dev-a', 'Mac A', [mkSession('s1'), mkSession('s2')]);
    const ref1 = remoteProjectsStore.getDeviceList();
    // 同设备、同名、同数量,但会话 id 不同 → recompute 运行,但设备摘要无变化。
    remoteProjectsStore.setDeviceSessions('dev-a', 'Mac A', [mkSession('s1x'), mkSession('s2x')]);
    expect(remoteProjectsStore.getDeviceList()).toBe(ref1);
  });

  it('设备增删 → 换新引用并反映变化;clear → 空列表', () => {
    remoteProjectsStore.setDeviceSessions('dev-a', 'Mac A', [mkSession('s1')]);
    const ref1 = remoteProjectsStore.getDeviceList();
    remoteProjectsStore.setDeviceSessions('dev-b', 'PC B', [mkSession('s2')]);
    const ref2 = remoteProjectsStore.getDeviceList();
    expect(ref2).not.toBe(ref1);
    expect(ref2.map((d) => d.deviceId)).toEqual(['dev-a', 'dev-b']);

    remoteProjectsStore.removeDevice('dev-b');
    expect(remoteProjectsStore.getDeviceList().map((d) => d.deviceId)).toEqual(['dev-a']);

    remoteProjectsStore.clear();
    expect(remoteProjectsStore.getDeviceList()).toEqual([]);
  });
});

describe('applyDeviceRename(切换栏全量设备就地改名)', () => {
  const list: DeviceLinkDeviceView[] = [
    mkDevice('dev-a', { name: 'Old A' }),
    mkDevice('dev-b', { name: 'Old B' }),
  ];

  it('改中目标设备 → 新数组,目标名更新,其它设备原对象保持', () => {
    const next = applyDeviceRename(list, 'dev-a', 'New A');
    expect(next).not.toBe(list); // 换新引用 → 触发订阅者重渲染
    expect(next?.map((d) => d.name)).toEqual(['New A', 'Old B']);
    expect(next?.[1]).toBe(list[1]); // 未改的设备复用原对象引用
  });

  it('名字会 trim;首尾空白不算变化时仍按 trim 后比较', () => {
    expect(applyDeviceRename(list, 'dev-a', '  New A  ')?.[0].name).toBe('New A');
    // trim 后与原名相同 → 视为无变化,返回原引用(no-op)。
    expect(applyDeviceRename(list, 'dev-a', '  Old A  ')).toBe(list);
  });

  it('no-op 返回原引用:名字未变 / 设备不存在 / 空名 / null 列表', () => {
    expect(applyDeviceRename(list, 'dev-a', 'Old A')).toBe(list);
    expect(applyDeviceRename(list, 'missing', 'X')).toBe(list);
    expect(applyDeviceRename(list, 'dev-a', '   ')).toBe(list);
    expect(applyDeviceRename(null, 'dev-a', 'New A')).toBeNull();
  });

  it('回归:改名后,连接中(无同步分片)设备的切换栏 chip 名即时刷新', () => {
    // dev-c 在线可控但未同步 → 'connecting',其 chip 名只能来自 fullList。改名后 fullList 经
    // applyDeviceRename 就地更新(= useDeviceLinkSettings.rename 里 renameDeviceLinkDevice 的效果),
    // buildSwitcherDevices 应立刻吐出新名(此前会停在旧名直到无关 refresh — Codex P2 修复点)。
    const fullList = [mkDevice('dev-c', { name: 'Old C' })];
    const renamed = applyDeviceRename(fullList, 'dev-c', 'New C') as DeviceLinkDeviceView[];
    const devices = buildSwitcherDevices({
      fullList: renamed,
      syncedDevices: [],
      revoked: new Set(),
    });
    expect(devices).toEqual([{ deviceId: 'dev-c', name: 'New C', status: 'connecting' }]);
  });
});
