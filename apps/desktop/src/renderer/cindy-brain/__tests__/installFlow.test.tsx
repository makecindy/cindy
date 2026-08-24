/** installFlow.test — 装入确认卡权限清单确认后直接交给 Main 落盘(无二次弹窗)。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/lib/toast';
import { confirmAndInstallGhost } from '../installFlow';
import type { InstalledGhost } from '../../../shared/ghost';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// node 环境无 window:logger 桩掉。
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
  installedGhosts: InstalledGhost[] = [],
) {
  const install = vi.fn(async () => installResult);
  const update = vi.fn(async () => installResult);
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
      listSync: vi.fn(() => ({ ghosts: installedGhosts })),
      install,
      update,
      abandonPackTicket: vi.fn(async () => ({ ok: true })),
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI },
    configurable: true,
  });
  return { install, update };
}

function deps(confirm: (options: unknown) => Promise<boolean>) {
  return {
    t: ((key: string) => key) as never,
    confirm,
  };
}

/** agent-forge 来源:触发来源横幅与高危加重。 */
const AGENT_ORIGIN = {
  kind: 'agent-forge' as const,
  sessionTitle: '处理外部文档',
  sourceRelPath: 'plugins/evil',
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('installFlow · 装入确认', () => {
  it('带 manual 的包把篇数传给装入确认信息行', async () => {
    const manifest = {
      ...baseManifest,
      manual: {
        items: [
          { dir: 'manual/ops', name: 'ops', description: '操作手册' },
          { dir: 'manual/faq', name: 'faq', description: '常见问题' },
        ],
      },
    };
    setupWindow(manifest);
    const confirm = vi.fn(async (_options: unknown) => true);
    await confirmAndInstallGhost('/tmp/manual.cindy', deps(confirm));
    const options = confirm.mock.calls[0]?.[0] as {
      content?: { props?: { manualCount?: number } };
    };
    expect(options.content?.props?.manualCount).toBe(2);
  });

  it('新装一律直接生效(勾选框已删):install 带 enable:true', async () => {
    const { install } = setupWindow(baseManifest);
    const confirm = vi.fn(async (_options: unknown) => true);

    await confirmAndInstallGhost('/tmp/node.cindy', deps(confirm));

    // confirm 是唯一确认层(权限清单含 Node 高风险行);无勾选框、装入即生效。
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith('/tmp/node.cindy', {
      enable: true,
      expectedPackageSha256: 'a'.repeat(64),
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('手动来源不加来源横幅、不加手输 id 闸', async () => {
    const { install } = setupWindow(baseManifest);
    const confirm = vi.fn(async (_options: unknown) => true);

    // 不传 origin = 手动入口(拖入/双击/设置页选文件)。
    await confirmAndInstallGhost('/tmp/plain.cindy', deps(confirm));

    const options = confirm.mock.calls[0]?.[0] as {
      content?: { props?: { agentOrigin?: unknown } };
      requireTypedConfirmation?: unknown;
    };
    expect(options.content?.props?.agentOrigin).toBeUndefined();
    expect(options.requireTypedConfirmation).toBeUndefined();
    expect(install).toHaveBeenCalledTimes(1);
  });
});

describe('installFlow · Agent 发起分级加重', () => {
  it('高危(node)+ Agent 发起 → 手输插件 id 才能确认,横幅点破 node', async () => {
    setupWindow(baseManifest);
    const confirm = vi.fn(async (_options: unknown) => true);

    await confirmAndInstallGhost('/tmp/node.cindy', deps(confirm), AGENT_ORIGIN);

    const options = confirm.mock.calls[0]?.[0] as {
      content?: { props?: { agentOrigin?: { firstInstall: boolean; hazards: { node: boolean } } } };
      requireTypedConfirmation?: { expected: string };
    };
    // 手输 id 闸:目标串 = 插件 id。
    expect(options.requireTypedConfirmation?.expected).toBe('node-ghost');
    // 来源横幅:首次安装 + node 高危点破。
    expect(options.content?.props?.agentOrigin?.firstInstall).toBe(true);
    expect(options.content?.props?.agentOrigin?.hazards.node).toBe(true);
  });

  it('低危(card)+ Agent 发起 → 只加来源横幅,不加手输 id 闸', async () => {
    const manifest = { ...baseManifest, slots: ['card'], node: undefined };
    setupWindow(manifest);
    const confirm = vi.fn(async (_options: unknown) => true);

    await confirmAndInstallGhost('/tmp/card.cindy', deps(confirm), AGENT_ORIGIN);

    const options = confirm.mock.calls[0]?.[0] as {
      content?: { props?: { agentOrigin?: { hazards: { node: boolean; skill: boolean } } } };
      requireTypedConfirmation?: unknown;
    };
    expect(options.requireTypedConfirmation).toBeUndefined();
    // 横幅仍在(来源事实),但无高危点破。
    expect(options.content?.props?.agentOrigin).toBeDefined();
    expect(options.content?.props?.agentOrigin?.hazards.node).toBe(false);
    expect(options.content?.props?.agentOrigin?.hazards.skill).toBe(false);
  });

  it('用户取消手输 id(confirm 返回 false)→ 不落盘', async () => {
    const { install } = setupWindow(baseManifest);
    const confirm = vi.fn(async (_options: unknown) => false);

    await confirmAndInstallGhost('/tmp/node.cindy', deps(confirm), AGENT_ORIGIN);

    expect(install).not.toHaveBeenCalled();
  });
});

describe('installFlow · approved update binding', () => {
  function installed(
    approval: InstalledGhost['approval'],
  ): InstalledGhost {
    return {
      manifest: {
        ...baseManifest,
        version: '0.9.0',
        slots: ['card'],
        node: undefined,
      },
      dir: '/brain/node-ghost',
      enabled: true,
      approval,
    };
  }

  it('passes the reviewed approved revision to Main', async () => {
    const current = installed({
      state: 'approved',
      revision: '00000000-0000-4000-8000-000000000001',
    });
    const { update } = setupWindow(baseManifest, undefined, [current]);
    const confirm = vi.fn(async (_options: unknown) => true);

    await confirmAndInstallGhost('/tmp/node-update.cindy', deps(confirm));

    expect(update).toHaveBeenCalledWith('/tmp/node-update.cindy', {
      expectedPackageSha256: 'a'.repeat(64),
      expectedInstalledApproval:
        'approved:00000000-0000-4000-8000-000000000001',
    });
  });

  it('treats every target permission as added when no approved baseline exists', async () => {
    const current = installed({ state: 'legacy-unapproved' });
    const { update } = setupWindow(baseManifest, undefined, [current]);
    const confirm = vi.fn(async (_options: unknown) => true);

    await confirmAndInstallGhost('/tmp/legacy-update.cindy', deps(confirm));

    const review = (confirm.mock.calls[0]![0] as {
      content: { props: { diff: { added: unknown[]; unchanged: unknown[] } } };
    }).content;
    expect(review.props.diff.added.length).toBeGreaterThan(0);
    expect(review.props.diff.unchanged).toEqual([]);
    expect(update).toHaveBeenCalledWith(
      '/tmp/legacy-update.cindy',
      expect.objectContaining({
        expectedInstalledApproval: 'legacy-unapproved',
      }),
    );
  });
});

describe('installFlow · tab 型插件装入即开面板', () => {
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

  function tabDeps(openPluginPanel?: (ghostId: string) => void) {
    return {
      t: ((key: string) => key) as never,
      confirm: vi.fn(async (_options: unknown) => true),
      ...(openPluginPanel ? { openPluginPanel } : {}),
    };
  }

  it('tab 清单 → enable 装入(勾选框已删)并原地打开插件页面板', async () => {
    const { install } = setupWindow(tabManifest);
    const openPluginPanel = vi.fn();

    await confirmAndInstallGhost('/tmp/tab.cindy', tabDeps(openPluginPanel));

    expect(install).toHaveBeenCalledWith('/tmp/tab.cindy', {
      enable: true,
      expectedPackageSha256: 'a'.repeat(64),
    });
    expect(openPluginPanel).toHaveBeenCalledWith('tab-demo-a');
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('入口未提供 openPluginPanel → 装入即生效但不许诺打开', async () => {
    const { install } = setupWindow(tabManifest);

    await confirmAndInstallGhost('/tmp/tab.cindy', tabDeps());

    expect(install).toHaveBeenCalledWith('/tmp/tab.cindy', {
      enable: true,
      expectedPackageSha256: 'a'.repeat(64),
    });
  });

  it('停靠形态(position: left)只带电,不打开面板', async () => {
    setupWindow({
      ...tabManifest,
      panel: { html: 'panel.html', position: 'left' as const },
    });
    const openPluginPanel = vi.fn();

    await confirmAndInstallGhost('/tmp/dock.cindy', tabDeps(openPluginPanel));

    expect(openPluginPanel).not.toHaveBeenCalled();
  });
});
