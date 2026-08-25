/** installFlow.test — 用户明确选择本地包后直接安装／更新，不追加权限确认。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/lib/toast';
import { installGhostFromFile } from '../installFlow';

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
  Object.defineProperty(globalThis, 'window', {
    value: {
      electronAPI: {
        appVersion: '1.0.0',
        ghosts: {
          inspect: vi.fn(async () => ({
            manifest,
            packageSha256: 'a'.repeat(64),
            unsupportedSlots: [],
            trust: {
              level: 'unverified',
              publisherSigned: false,
              publisherVerified: false,
              reviewed: false,
            },
          })),
          listSync: vi.fn(() => ({ ghosts: installed })),
          install,
          update,
        },
      },
    },
    configurable: true,
  });
  return { install, update };
}

afterEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('installFlow · 本地包安装', () => {
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
