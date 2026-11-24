// @vitest-environment jsdom
/**
 * useSessionDagEnabled.test.tsx — 「会话图」插件启用判定。
 *
 * 测试价值
 * - 生产入口：useSessionDagEnabled() 只消费本地会话图插件的启用状态；
 *   协作方契约：namespace='local' && enabled && manifest.id === 'session-dag'，
 *   不读插件设置。
 * - Bug/规则依据：不得把任意同名插件当启用（namespace 或 approval 不通过均应关闭）；
 *   不得依赖 manifest.mcpApps.settings（已移除）。
 * - 现有覆盖缺口：无既有单测。
 * - 最小失败输入：namespace 为 null 或 approval 非 approved 时，enabled 为 true
 *   仍应返回 false。
 * - tier：unit（jsdom，无资源，仅状态计算）。
 * - 实测耗时：<1s。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { InstalledGhost } from '../../../../shared/ghost';
import {
  __resetInstalledGhostsStoreForTest,
  useInstalledGhosts,
} from '../../../cindy-brain/useInstalledGhosts';
import { useSessionDagEnabled } from '../useSessionDagEnabled';

const ghost = (overrides: Partial<InstalledGhost> = {}): InstalledGhost => ({
  manifest: {
    schemaVersion: 3,
    id: 'session-dag',
    name: '会话图',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
  },
  dir: '/brain/session-dag',
  enabled: true,
  namespace: 'local',
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  ...overrides,
});

const listSync = vi.fn<() => { ghosts: InstalledGhost[] }>();
const changedCbs: Array<(payload: { ghosts: InstalledGhost[] }) => void> = [];
const onChanged = vi.fn((cb: (payload: { ghosts: InstalledGhost[] }) => void) => {
  changedCbs.push(cb);
  return vi.fn();
});

beforeEach(() => {
  __resetInstalledGhostsStoreForTest();
  listSync.mockReset();
  changedCbs.length = 0;
  onChanged.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: {
      listSync,
      onChanged,
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function enableWith(ghosts: InstalledGhost[]) {
  listSync.mockReturnValue({ ghosts });
  return renderHook(() => useSessionDagEnabled());
}

function pushGhosts(ghosts: InstalledGhost[]): void {
  changedCbs.forEach((cb) => cb({ ghosts }));
}

describe('useSessionDagEnabled', () => {
  it('本地 session-dag 插件已安装且启用时返回 true', () => {
    expect(enableWith([ghost()]).result.current).toBe(true);
  });

  it('namespace 不是 local（企业/未确认实例）时返回 false', () => {
    expect(enableWith([ghost({ namespace: null as string | null })]).result.current).toBe(false);
  });

  it('未启用时返回 false', () => {
    expect(enableWith([ghost({ enabled: false })]).result.current).toBe(false);
  });

  it('插件 id 不匹配时返回 false', () => {
    expect(
      enableWith([ghost({ manifest: { ...ghost().manifest, id: 'session-dag-clone' } })])
        .result.current,
    ).toBe(false);
  });

  it('审批未通过时返回 false', () => {
    expect(
      enableWith([ghost({ approval: { state: 'invalid' } })]).result.current,
    ).toBe(false);
  });

  it('清单里只有其他插件，且不含 session-dag 时返回 false', () => {
    expect(enableWith([ghost({ manifest: { ...ghost().manifest, id: 'other-plugin' } })]).result.current).toBe(false);
  });

  it('插件停用后即恢复 false（stop → 可恢复）', () => {
    const { result } = enableWith([ghost()]);
    expect(result.current).toBe(true);
    act(() => pushGhosts([ghost({ enabled: false })]));
    expect(result.current).toBe(false);
  });

  it('重新启用后返回 true（恢复可回退）', () => {
    const { result } = enableWith([ghost({ enabled: false })]);
    expect(result.current).toBe(false);
    act(() => pushGhosts([ghost()]));
    expect(result.current).toBe(true);
  });
});
