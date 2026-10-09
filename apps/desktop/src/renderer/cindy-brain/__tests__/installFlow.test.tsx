/** installFlow.test — 用户明确选择本地包后直接安装／更新，不追加权限确认。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/lib/toast';
import { installGhostFromFile, pickAndUpdateGhost } from '../installFlow';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const baseManifest = {
  schemaVersion: 3 as const,
  id: 'node-ghost',
  name: 'Node Ghost',
  version: '1.0.0',
  minCindyVersion: '1.0.0',
  kind: 'chip' as const,
  entry: 'main.js',
  capabilities: [{ type: 'node-runtime' as const, entry: 'node/worker.cjs' }],
};

function setupWindow(manifest: object, installed: object[] = []) {
  const install = vi.fn(async () => ({
    ghost: { manifest, dir: '/tmp/installed', enabled: true },
  }));
  const update = vi.fn(async () => ({
    ghost: { manifest, dir: '/tmp/installed', enabled: true },
  }));
  const inspect = vi.fn(async () => ({
    manifest,
    packageSha256: 'a'.repeat(64),
    unsupportedSlots: [],
    trust: {
      level: 'unverified',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: false,
    },
  }));
  Object.defineProperty(globalThis, 'window', {
    value: {
      electronAPI: {
        appVersion: '1.0.0',
        ghosts: {
          inspect,
          pickFile: vi.fn(async () => ({ filePath: '/tmp/node.cindy' })),
          listSync: vi.fn(() => ({ ghosts: installed })),
          install,
          update,
        },
      },
    },
    configurable: true,
  });
  return { install, update, inspect };
}

afterEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('installFlow · 本地包安装', () => {
  it.each(['node-ghost', '_ns__xd__node-ghost'])(
    'binds local update inspect and commit to %s',
    async (instanceId) => {
      const namespace = instanceId === 'node-ghost' ? null : 'xd';
      const installed = {
        manifest: baseManifest,
        namespace,
        dir: namespace ? '/tmp/brain/_ns/xd/node-ghost' : '/tmp/brain/node-ghost',
        approval: { state: 'approved', revision: 'selected-receipt' },
      };
      const { inspect, update } = setupWindow(baseManifest, [installed]);
      await pickAndUpdateGhost(instanceId, { t: ((key: string) => key) as never });
      const target = {
        expectedInstalledInstanceId: instanceId,
        expectedInstalledApproval: 'approved:selected-receipt',
      };
      expect(inspect).toHaveBeenCalledWith('/tmp/node.cindy', target);
      expect(update).toHaveBeenCalledWith('/tmp/node.cindy', {
        ...target,
        expectedPackageSha256: 'a'.repeat(64),
      });
    },
  );

  it('does not silently rebind an update after inspect to a replaced receipt', async () => {
    const installed = [
      {
        manifest: baseManifest,
        dir: '/tmp/brain/node-ghost',
        namespace: null,
        approval: { state: 'approved', revision: 'original-receipt' },
      },
    ];
    const { inspect, update } = setupWindow(baseManifest, installed);
    const original = inspect.getMockImplementation()!;
    inspect.mockImplementation(async () => {
      installed[0] = {
        ...installed[0],
        approval: { state: 'approved', revision: 'replacement-receipt' },
      };
      return original();
    });
    await pickAndUpdateGhost('node-ghost', { t: ((key: string) => key) as never });
    expect(update).toHaveBeenCalledWith(
      '/tmp/node.cindy',
      expect.objectContaining({ expectedInstalledApproval: 'approved:original-receipt' }),
    );
  });

  it('直接启用安装，并把真实包摘要交给 Main', async () => {
    const { install } = setupWindow(baseManifest);

    await installGhostFromFile('/tmp/node.cindy', {
      t: ((key: string) => key) as never,
    });

    expect(install).toHaveBeenCalledWith('/tmp/node.cindy', {
      enable: true,
      expectedPackageSha256: 'a'.repeat(64),
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('tab 型插件安装后由具备宿主的入口直接打开面板', async () => {
    const manifest = {
      ...baseManifest,
      id: 'tab-demo',
      panel: { html: 'panel.html', position: 'tab' as const },
    };
    const { install } = setupWindow(manifest);
    const openPluginPanel = vi.fn();

    await installGhostFromFile('/tmp/tab.cindy', {
      t: ((key: string) => key) as never,
      openPluginPanel,
    });

    expect(install).toHaveBeenCalledWith('/tmp/tab.cindy', {
      enable: true,
      expectedPackageSha256: 'a'.repeat(64),
    });
    expect(openPluginPanel).toHaveBeenCalledWith('tab-demo');
  });

  it('同 id 已安装时直接原位更新，并绑定当前安装 receipt', async () => {
    const installed = {
      manifest: { ...baseManifest, version: '0.9.0' },
      dir: '/tmp/installed',
      enabled: false,
      approval: {
        state: 'approved',
        revision: '00000000-0000-4000-8000-000000000001',
      },
    };
    const { install, update } = setupWindow(baseManifest, [installed]);

    await installGhostFromFile('/tmp/node.cindy', {
      t: ((key: string) => key) as never,
    });

    expect(install).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('/tmp/node.cindy', {
      expectedPackageSha256: 'a'.repeat(64),
      expectedInstalledApproval: 'approved:00000000-0000-4000-8000-000000000001',
      expectedInstalledInstanceId: 'node-ghost',
    });
  });

  it('本地包不由客户端按 minCindyVersion 二次拦截', async () => {
    const incompatibleManifest = { ...baseManifest, minCindyVersion: '2.0.0' };
    const { install } = setupWindow(incompatibleManifest);

    await installGhostFromFile('/tmp/node.cindy', {
      t: ((key: string) => key) as never,
    });

    expect(install).toHaveBeenCalledWith('/tmp/node.cindy', {
      enable: true,
      expectedPackageSha256: 'a'.repeat(64),
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
