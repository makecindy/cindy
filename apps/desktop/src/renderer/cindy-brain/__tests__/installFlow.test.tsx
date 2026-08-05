/** installFlow.test — 装入确认卡权限清单确认后直接交给 Main 落盘(无二次弹窗)。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/lib/toast';
import { confirmAndInstallGhost } from '../installFlow';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// node 环境无 window:logger 与真实的开页签实现(拉起 right-sidebar store 链)都桩掉。
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../features/right-sidebar/lib/openGhostTabInSidebar', () => ({
  openGhostTabInSidebar: vi.fn(async () => undefined),
}));

const baseManifest = {
  schemaVersion: 2 as const,
  id: 'node-ghost',
  name: 'Node Ghost',
  version: '1.0.0',
  kind: 'chip' as const,
  entry: 'main.js',
  slots: ['node'] as const,
  node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' as const },
};

function setupWindow(
  manifest: object,
  installResult: { ghost: { manifest: object } } = { ghost: { manifest } },
) {
  const install = vi.fn(async () => installResult);
  const electronAPI = {
    ghosts: {
      inspect: vi.fn(async () => ({
        manifest,
        packageSha256: 'a'.repeat(64),
        trust: {
          level: 'unverified',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        },
      })),
      listSync: vi.fn(() => ({ ghosts: [] })),
      install,
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI },
    configurable: true,
  });
  return { install };
}

function deps(confirm: (options: unknown) => Promise<boolean>) {
  return {
    t: ((key: string) => key) as never,
    confirm,
    confirmWithCheckbox: vi.fn(async () => ({ ok: true, checked: false })),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('installFlow · 装入确认', () => {
  it('Renderer 权限清单确认后把 Node 插件安装交给 Main,并提示装入完成', async () => {
    const { install } = setupWindow(baseManifest);
    const confirm = vi.fn(async () => true);

    await confirmAndInstallGhost('/tmp/node.cindy', deps(confirm));

    // confirmWithCheckbox 是唯一确认层(权限清单含 Node 高风险行);
    // 普通 confirm 不再伪装成安全边界。
    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledWith('/tmp/node.cindy', {
      enable: false,
      expectedPackageSha256: 'a'.repeat(64),
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('普通浏览器沙箱插件同样只走现有权限清单', async () => {
    const manifest = { ...baseManifest, slots: ['card'], node: undefined };
    const { install } = setupWindow(manifest);
    const confirm = vi.fn(async () => true);

    await confirmAndInstallGhost('/tmp/plain.cindy', deps(confirm));

    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
  });
});

describe('installFlow · tab 型插件「立即开启并打开页签」', () => {
  const tabManifest = {
    schemaVersion: 2 as const,
    id: 'tab-demo-a',
    name: '页签演示 A',
    version: '1.0.0',
    kind: 'chip' as const,
    entry: 'main.js',
    slots: ['panel'] as const,
    panel: { html: 'panel.html', position: 'tab' as const },
  };

  function tabDeps(overrides: {
    checked?: boolean;
    sessionId?: string | null;
    openGhostTab?: (sessionId: string, ghostId: string) => Promise<void>;
  }) {
    const confirmWithCheckbox = vi.fn(async () => ({
      ok: true,
      checked: overrides.checked ?? true,
    }));
    return {
      deps: {
        t: ((key: string) => key) as never,
        confirm: vi.fn(async () => true),
        confirmWithCheckbox,
        ...(overrides.sessionId !== undefined
          ? { getSidebarSessionId: () => overrides.sessionId ?? null }
          : {}),
        ...(overrides.openGhostTab ? { openGhostTab: overrides.openGhostTab } : {}),
      },
      confirmWithCheckbox,
    };
  }

  it('tab 清单 + 有会话 + 勾选 → enable 装入并打开 ghost:<id> 页签,勾选文案换 open 版', async () => {
    const { install } = setupWindow(tabManifest);
    const openGhostTab = vi.fn(async () => undefined);
    const { deps: d, confirmWithCheckbox } = tabDeps({ sessionId: 's1', openGhostTab });

    await confirmAndInstallGhost('/tmp/tab.cindy', d);

    expect(confirmWithCheckbox).toHaveBeenCalledWith(
      expect.objectContaining({
        checkboxLabel: 'settings.ghosts.installConfirm.enableNowOpenTab',
        // 2026-07-25 起"立即开启"默认勾选:装入即带电,取消勾选才沉睡。
        checkboxDefaultChecked: true,
      }),
    );
    expect(install).toHaveBeenCalledWith('/tmp/tab.cindy', {
      enable: true,
      expectedPackageSha256: 'a'.repeat(64),
    });
    expect(openGhostTab).toHaveBeenCalledWith('s1', 'tab-demo-a');
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('不勾选 → 沉睡装入,不打开页签', async () => {
    setupWindow(tabManifest);
    const openGhostTab = vi.fn(async () => undefined);
    const { deps: d } = tabDeps({ checked: false, sessionId: 's1', openGhostTab });

    await confirmAndInstallGhost('/tmp/tab.cindy', d);

    expect(openGhostTab).not.toHaveBeenCalled();
  });

  it('无会话入口(getter 缺省/返回 null)→ 勾选文案保持旧版,勾了也不打开', async () => {
    setupWindow(tabManifest);
    const openGhostTab = vi.fn(async () => undefined);

    const noGetter = tabDeps({ openGhostTab });
    await confirmAndInstallGhost('/tmp/tab.cindy', noGetter.deps);
    expect(noGetter.confirmWithCheckbox).toHaveBeenCalledWith(
      expect.objectContaining({ checkboxLabel: 'settings.ghosts.installConfirm.enableNow' }),
    );

    const nullGetter = tabDeps({ sessionId: null, openGhostTab });
    await confirmAndInstallGhost('/tmp/tab.cindy', nullGetter.deps);

    expect(openGhostTab).not.toHaveBeenCalled();
  });

  it('停靠形态(position: left)勾选只带电,不打开页签', async () => {
    setupWindow({
      ...tabManifest,
      panel: { html: 'panel.html', position: 'left' as const },
    });
    const openGhostTab = vi.fn(async () => undefined);
    const { deps: d, confirmWithCheckbox } = tabDeps({ sessionId: 's1', openGhostTab });

    await confirmAndInstallGhost('/tmp/dock.cindy', d);

    expect(confirmWithCheckbox).toHaveBeenCalledWith(
      expect.objectContaining({
        checkboxLabel: 'settings.ghosts.installConfirm.enableNow',
        checkboxDefaultChecked: true,
      }),
    );
    expect(openGhostTab).not.toHaveBeenCalled();
  });

  it('打开页签失败只记日志:装入成功 toast 不改口、不冒错误', async () => {
    setupWindow(tabManifest);
    const openGhostTab = vi.fn(async () => {
      throw new Error('sidebar exploded');
    });
    const { deps: d } = tabDeps({ sessionId: 's1', openGhostTab });

    await confirmAndInstallGhost('/tmp/tab.cindy', d);

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('安装期间切换会话(getter 变 null)→ 不打开页签(避免写入旧会话)', async () => {
    setupWindow(tabManifest);
    const openGhostTab = vi.fn(async () => undefined);
    let currentSession: string | null = 's1';
    const confirmWithCheckbox = vi.fn(async () => {
      // 模拟用户在确认弹窗期间切走会话
      currentSession = null;
      return { ok: true, checked: true };
    });
    const deps = {
      t: ((key: string) => key) as never,
      confirm: vi.fn(async () => true),
      confirmWithCheckbox,
      getSidebarSessionId: () => currentSession,
      openGhostTab,
    };

    await confirmAndInstallGhost('/tmp/tab.cindy', deps);

    expect(openGhostTab).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
