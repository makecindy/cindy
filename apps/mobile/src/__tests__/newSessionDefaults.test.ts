/**
 * 测试价值
 * - 生产入口与可观察结果：`resolveNewSessionDefaultDevice` / `resolveNewSessionDefaultWorkspace`
 *   决定新建任务页打开在哪个电脑、哪个项目或对话；用户看到的是选择器和一行回退提示。
 * - Bug／规则依据：Android「新建任务默认」的两份档案（应用内 / 桌面小组件）、入口明确目标
 *   优先、默认不可用回退、项目默认绑定电脑。旧逻辑只有「记住上次」，没有这层默认。
 * - 现有覆盖缺口：`newSession.test.ts` 覆盖的是 `pickNewSessionDefaultDevice` 等旧记忆链，
 *   不覆盖新档案、`follow-app` 委托与项目绑定电脑的回退分支。
 * - 最小失败输入：配置的默认电脑不在 `deviceOptions`；项目默认属于另一台电脑；
 *   组件档案 `follow-app` 而应用内档案 `follow-last`。
 * - tier：unit（纯函数，无 React / 存储）。
 * - 实测耗时：本机单文件约 4.3s（含收集；测试执行约 16ms）。
 */
import { describe, expect, it } from 'vitest';

import type { NewSessionDeviceOption } from '@/session/newSession';
import {
  createDefaultNewSessionDefaults,
  newSessionDefaultProjectName,
  newSessionDefaultProfileForOrigin,
  normalizeNewSessionDefaults,
  resolveNewSessionDefaultDevice,
  resolveNewSessionDefaultWorkspace,
  withNewSessionDefaultDevice,
  withNewSessionDefaultProject,
  type NewSessionDefaults,
} from '@/session/newSessionDefaults';
import { readNewSessionOrigin } from '@/session/newSessionOrigin';

const devices: NewSessionDeviceOption[] = [
  { deviceId: 'a', name: 'A' },
  { deviceId: 'b', name: 'B' },
];
const recentA = [{ workingDir: '/recent/a', title: 'recent-a', sessionCount: 1, lastActivityAt: '2026-01-01T00:00:00Z' }];
const recentB = [{ workingDir: '/recent/b', title: 'recent-b', sessionCount: 1, lastActivityAt: '2026-01-01T00:00:00Z' }];

function defaults(overrides: {
  appDevice?: NewSessionDefaults['app']['device'];
  appWorkspace?: NewSessionDefaults['app']['workspace'];
  widgetDevice?: NewSessionDefaults['widget']['device'];
  widgetWorkspace?: NewSessionDefaults['widget']['workspace'];
} = {}): NewSessionDefaults {
  const base = createDefaultNewSessionDefaults();
  return {
    app: {
      device: overrides.appDevice ?? base.app.device,
      workspace: overrides.appWorkspace ?? base.app.workspace,
    },
    widget: {
      device: overrides.widgetDevice ?? base.widget.device,
      workspace: overrides.widgetWorkspace ?? base.widget.workspace,
    },
  };
}


describe('new session origin', () => {
  it('only the widget marker is a widget open; everything else is in-app', () => {
    expect(readNewSessionOrigin('widget')).toBe('widget');
    expect(readNewSessionOrigin(['widget'])).toBe('widget');
    expect(readNewSessionOrigin('app')).toBe('app');
    expect(readNewSessionOrigin(undefined)).toBe('app');
    expect(newSessionDefaultProfileForOrigin('widget')).toBe('widget');
    expect(newSessionDefaultProfileForOrigin('app')).toBe('app');
  });
});

describe('new session defaults normalization', () => {
  it('keeps follow-app only for the widget profile and rejects broken projects', () => {
    const normalized = normalizeNewSessionDefaults({
      app: {
        device: { kind: 'follow-app' },
        workspace: { kind: 'follow-app' },
      },
      widget: {
        device: { kind: 'device', deviceId: ' a ' },
        workspace: { kind: 'project', deviceId: '', workingDir: '/x' },
      },
    });
    expect(normalized.app.device).toEqual({ kind: 'follow-last' });
    expect(normalized.app.workspace).toEqual({ kind: 'follow-last' });
    // 设备名缺失时退回 id；项目缺少所属电脑时回到跟随应用内。
    expect(normalized.widget.device).toEqual({ kind: 'device', deviceId: 'a', name: 'a' });
    expect(normalized.widget.workspace).toEqual({ kind: 'follow-app' });
  });

  it('returns a fresh default set for malformed storage', () => {
    expect(normalizeNewSessionDefaults(null)).toEqual(createDefaultNewSessionDefaults());
    expect(normalizeNewSessionDefaults({ app: { device: { kind: 'device' } } })).toEqual(
      createDefaultNewSessionDefaults(),
    );
  });
});

describe('new session default device', () => {
  const appDefaultA = defaults({ appDevice: { kind: 'device', deviceId: 'a', name: 'A' } });

  it('lets an explicit entry computer win over every default', () => {
    const resolved = resolveNewSessionDefaultDevice({
      defaults: appDefaultA,
      profile: 'app',
      deviceOptions: devices,
      routeDevice: devices[1],
      routeDeviceExplicit: true,
    });
    expect(resolved).toMatchObject({ device: devices[1], source: 'entry', unavailable: null });
  });

  it('uses the configured default over the remembered computer', () => {
    const resolved = resolveNewSessionDefaultDevice({
      defaults: appDefaultA,
      profile: 'app',
      deviceOptions: devices,
      rememberedDeviceId: 'b',
      routeDevice: devices[1],
      routeDeviceExplicit: false,
    });
    expect(resolved).toMatchObject({ device: devices[0], source: 'default', unavailable: null });
  });

  it('falls back to the remembered computer and reports only the configured one as unavailable', () => {
    const resolved = resolveNewSessionDefaultDevice({
      defaults: defaults({ appDevice: { kind: 'device', deviceId: 'gone', name: 'Offline' } }),
      profile: 'app',
      deviceOptions: devices,
      rememberedDeviceId: 'b',
      routeDevice: devices[0],
      routeDeviceExplicit: false,
    });
    expect(resolved).toMatchObject({
      device: devices[1],
      source: 'last',
      unavailable: { deviceId: 'gone', name: 'Offline' },
    });
  });

  it('does not report a notice when the fallback chain already lands on the configured computer', () => {
    const resolved = resolveNewSessionDefaultDevice({
      defaults: defaults({ appDevice: { kind: 'device', deviceId: 'a', name: 'A' } }),
      profile: 'app',
      // a 不在可打开目录里（例如入口只带这一台），回退链仍返回它。
      deviceOptions: [],
      routeDevice: devices[0],
      routeDeviceExplicit: false,
    });
    expect(resolved).toMatchObject({ device: devices[0], source: 'default', unavailable: null });
  });

  it('resolves the widget profile through follow-app, follow-last, or a pinned computer', () => {
    expect(resolveNewSessionDefaultDevice({
      defaults: appDefaultA,
      profile: 'widget',
      deviceOptions: devices,
      rememberedDeviceId: 'b',
      routeDevice: null,
      routeDeviceExplicit: false,
    }).device).toEqual(devices[0]);

    expect(resolveNewSessionDefaultDevice({
      defaults: defaults({ appDevice: { kind: 'device', deviceId: 'a', name: 'A' }, widgetDevice: { kind: 'follow-last' } }),
      profile: 'widget',
      deviceOptions: devices,
      rememberedDeviceId: 'b',
      routeDevice: null,
      routeDeviceExplicit: false,
    }).device).toEqual(devices[1]);

    expect(resolveNewSessionDefaultDevice({
      defaults: defaults({ widgetDevice: { kind: 'device', deviceId: 'b', name: 'B' } }),
      profile: 'widget',
      deviceOptions: devices,
      rememberedDeviceId: 'a',
      routeDevice: null,
      routeDeviceExplicit: false,
    }).device).toEqual(devices[1]);
  });
});

describe('new session default workspace', () => {
  const appProjectA = defaults({
    appDevice: { kind: 'device', deviceId: 'a', name: 'A' },
    appWorkspace: { kind: 'project', deviceId: 'a', workingDir: '/projects/cindy' },
  });

  it('lets an explicit entry folder win over every default', () => {
    const resolved = resolveNewSessionDefaultWorkspace({
      defaults: appProjectA,
      profile: 'app',
      deviceId: 'a',
      initialWorkingDir: '/entry/project',
      recentWorkspaces: recentA,
    });
    expect(resolved).toMatchObject({ kind: 'project', workingDir: '/entry/project', source: 'entry' });
  });

  it('applies a project default only on its own computer', () => {
    expect(resolveNewSessionDefaultWorkspace({
      defaults: appProjectA,
      profile: 'app',
      deviceId: 'a',
      recentWorkspaces: recentA,
    })).toMatchObject({ kind: 'project', workingDir: '/projects/cindy', source: 'default' });

    const otherComputer = resolveNewSessionDefaultWorkspace({
      defaults: appProjectA,
      profile: 'app',
      deviceId: 'b',
      followLastKind: 'project',
      rememberedWorkingDir: null,
      recentWorkspaces: recentB,
    });
    expect(otherComputer).toMatchObject({
      kind: 'project',
      workingDir: '/recent/b',
      source: 'last',
      unavailableDefault: true,
    });
  });

  it('restores the last mode and folder chain; no folder opens the browser', () => {
    expect(resolveNewSessionDefaultWorkspace({
      defaults: createDefaultNewSessionDefaults(),
      profile: 'app',
      deviceId: 'a',
      followLastKind: 'dialogue',
      initialKind: 'project',
      recentWorkspaces: recentA,
    })).toMatchObject({ kind: 'dialogue', source: 'last' });

    expect(resolveNewSessionDefaultWorkspace({
      defaults: createDefaultNewSessionDefaults(),
      profile: 'app',
      deviceId: 'a',
      followLastKind: 'project',
      rememberedWorkingDir: '/remembered/a',
      recentWorkspaces: recentA,
    })).toMatchObject({ kind: 'project', workingDir: '/remembered/a', needsBrowse: false });

    expect(resolveNewSessionDefaultWorkspace({
      defaults: createDefaultNewSessionDefaults(),
      profile: 'app',
      deviceId: 'a',
      followLastKind: 'project',
      recentWorkspaces: [],
    })).toMatchObject({ kind: 'project', workingDir: '', needsBrowse: true });

    // 从未记过模式时，保留页面初始的「对话」，不擅自换成最近项目。
    expect(resolveNewSessionDefaultWorkspace({
      defaults: createDefaultNewSessionDefaults(),
      profile: 'app',
      deviceId: 'a',
      followLastKind: null,
      initialKind: 'dialogue',
      recentWorkspaces: recentA,
    })).toMatchObject({ kind: 'dialogue', source: 'last' });
  });

  it('delegates the widget follow-app value and lets follow-last bypass the app default', () => {
    expect(resolveNewSessionDefaultWorkspace({
      defaults: appProjectA,
      profile: 'widget',
      deviceId: 'a',
      recentWorkspaces: recentA,
    })).toMatchObject({ kind: 'project', workingDir: '/projects/cindy', source: 'default' });

    expect(resolveNewSessionDefaultWorkspace({
      defaults: { ...appProjectA, widget: { ...appProjectA.widget, workspace: { kind: 'follow-last' } } },
      profile: 'widget',
      deviceId: 'a',
      followLastKind: 'dialogue',
      recentWorkspaces: recentA,
    })).toMatchObject({ kind: 'dialogue', source: 'last' });
  });

  it('applies the widget-specific dialogue default without touching the app profile', () => {
    const resolved = resolveNewSessionDefaultWorkspace({
      defaults: defaults({ widgetWorkspace: { kind: 'dialogue' } }),
      profile: 'widget',
      deviceId: 'a',
      recentWorkspaces: recentA,
    });
    expect(resolved).toMatchObject({ kind: 'dialogue', source: 'default' });
  });
});

describe('new session default edits', () => {
  it('clears a project default when its computer changes, and keeps it on the same computer', () => {
    const base = defaults({
      appDevice: { kind: 'device', deviceId: 'a', name: 'A' },
      appWorkspace: { kind: 'project', deviceId: 'a', workingDir: '/projects/cindy' },
    });
    expect(withNewSessionDefaultDevice(base, 'app', { kind: 'device', deviceId: 'a', name: 'A' }).app.workspace)
      .toMatchObject({ kind: 'project', workingDir: '/projects/cindy' });
    expect(withNewSessionDefaultDevice(base, 'app', { kind: 'device', deviceId: 'b', name: 'B' }).app.workspace)
      .toEqual({ kind: 'follow-last' });
    expect(withNewSessionDefaultDevice(base, 'app', { kind: 'follow-last' }).app.workspace)
      .toEqual({ kind: 'follow-last' });
  });

  it('pins the computer when a project is picked and keeps the folder name for display', () => {
    const next = withNewSessionDefaultProject(createDefaultNewSessionDefaults(), 'widget', { deviceId: 'b', name: 'B' }, '/work/cindy');
    expect(next.widget).toMatchObject({
      device: { kind: 'device', deviceId: 'b', name: 'B' },
      workspace: { kind: 'project', deviceId: 'b', workingDir: '/work/cindy' },
    });
    expect(newSessionDefaultProjectName('/work/cindy/')).toBe('cindy');
    expect(newSessionDefaultProjectName('/work/主仓库')).toBe('主仓库');
  });
});
