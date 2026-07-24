/** installFlow.test — Renderer 只展示权限清单，Node 真授权由 Main 原生弹窗负责。 */

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
  installResult: { ghost: { manifest: object } } | { canceled: true } = { ghost: { manifest } },
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

describe('installFlow · Node 原生确认交接', () => {
  it('Main 原生风险提示取消时，不显示安装完成提示', async () => {
    const { install } = setupWindow(baseManifest, { canceled: true });
    const confirm = vi.fn(async () => true);

    await confirmAndInstallGhost('/tmp/node.cindy', deps(confirm));

    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('Renderer 权限清单确认后把 Node 安装交给 Main', async () => {
    const { install } = setupWindow(baseManifest);
    const confirm = vi.fn(async () => true);

    await confirmAndInstallGhost('/tmp/node.cindy', deps(confirm));

    // confirmWithCheckbox 是第一层权限清单；普通 confirm 不再伪装成安全边界。
    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledWith('/tmp/node.cindy', {
      enable: false,
      expectedPackageSha256: 'a'.repeat(64),
    });
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

  it('停靠形态(position: right)勾选只带电,不打开页签', async () => {
    setupWindow({
      ...tabManifest,
      panel: { html: 'panel.html', position: 'right' as const },
    });
    const openGhostTab = vi.fn(async () => undefined);
    const { deps: d, confirmWithCheckbox } = tabDeps({ sessionId: 's1', openGhostTab });

    await confirmAndInstallGhost('/tmp/dock.cindy', d);

    expect(confirmWithCheckbox).toHaveBeenCalledWith(
      expect.objectContaining({ checkboxLabel: 'settings.ghosts.installConfirm.enableNow' }),
    );
    expect(openGhostTab).not.toHaveBeenCalled();
  });

  it('Main 原生确认取消(canceled)→ 不打开页签', async () => {
    setupWindow(tabManifest, { canceled: true });
    const openGhostTab = vi.fn(async () => undefined);
    const { deps: d } = tabDeps({ sessionId: 's1', openGhostTab });

    await confirmAndInstallGhost('/tmp/tab.cindy', d);

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
});
