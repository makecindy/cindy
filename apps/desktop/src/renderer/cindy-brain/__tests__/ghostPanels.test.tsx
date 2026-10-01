// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import {
  ghostInstallApprovalToken,
  type GhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost';
import {
  __resetGhostPanelBubbleStateForTest,
  getGhostPanelBubbleState,
  minimizeGhostPanel,
} from '../../lib/ghostPanelBubbleState';
import {
  __resetPanelRegistryForTest,
  getPanelKind,
  hasPanelKind,
  listPanelKinds,
} from '../../panels/registry';
import {
  __resetGhostPanelsForTest,
  ensureGhostPanelsRegistered,
  pickGhostPanelMediaUri,
  syncGhostPanelRegistrations,
} from '../ghostPanels';
import { __resetInstalledGhostsStoreForTest } from '../useInstalledGhosts';

// 仓库同款 i18n mock:t 返回 key(带参拼上,便于断言)。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

// 面板体是 webview 供片,jsdom 渲不了也不该渲 —— 置空,只测宿主壳(标准头/关闭链路)。
vi.mock('../ghostPanelBody', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ghostPanelBody')>()),
  GhostChipPanelBody: ({ ghost: installed }: { ghost: InstalledGhost }) => (
    <div
      data-testid="ghost-body"
      data-dir={installed.dir}
      data-approval={ghostInstallApprovalToken(installed.approval)}
    />
  ),
  GhostPanelError: () => null,
}));

/** 造一个已装意识(panel 可覆写/置空;enabled 默认 true)。 */
function ghost(id: string, panel?: GhostManifest['panel'] | null, enabled = true): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: `${id} 意识`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    ...(panel === null ? {} : { panel: panel ?? { title: id, html: 'panel.html' } }),
  };
  return {
    manifest,
    dir: `/fake/${id}`,
    enabled,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

function bridgeGhosts(initial: InstalledGhost[], setEnabled = vi.fn()) {
  let roster = initial;
  const listeners = new Set<(event: { ghosts: InstalledGhost[] }) => void>();
  const api = {
    setEnabled,
    listSync: vi.fn(() => ({ ghosts: roster })),
    onChanged: vi.fn((listener: (event: { ghosts: InstalledGhost[] }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    change(next: InstalledGhost[]) {
      roster = next;
      listeners.forEach((listener) => listener({ ghosts: next }));
    },
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { ghosts: api };
  return api;
}

afterEach(() => {
  cleanup();
  __resetPanelRegistryForTest();
  __resetGhostPanelsForTest();
  __resetInstalledGhostsStoreForTest();
  __resetGhostPanelBubbleStateForTest();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('syncGhostPanelRegistrations · 注册表与已装清单对齐', () => {
  it('装入的意识面板进注册表;无面板声明的意识不进', () => {
    syncGhostPanelRegistrations([ghost('hello'), ghost('toolonly', null)]);
    expect(hasPanelKind('ghost:hello')).toBe(true);
    expect(hasPanelKind('ghost:toolonly')).toBe(false);
  });

  it('卸下(清单里消失)→ 注销;其余不动', () => {
    syncGhostPanelRegistrations([ghost('a'), ghost('b')]);
    expect(hasPanelKind('ghost:a')).toBe(true);
    syncGhostPanelRegistrations([ghost('b')]);
    expect(hasPanelKind('ghost:a')).toBe(false);
    expect(hasPanelKind('ghost:b')).toBe(true);
  });

  it('清单没变 → 不重注册(组件身份稳定,不触发重挂载)', () => {
    syncGhostPanelRegistrations([ghost('a')]);
    const before = listPanelKinds().length;
    syncGhostPanelRegistrations([ghost('a')]);
    expect(listPanelKinds().length).toBe(before);
  });

  it('全卸光 → 注册表回空', () => {
    syncGhostPanelRegistrations([ghost('a'), ghost('b')]);
    syncGhostPanelRegistrations([]);
    expect(hasPanelKind('ghost:a')).toBe(false);
    expect(hasPanelKind('ghost:b')).toBe(false);
  });

  it.each(['approval', 'directory', 'manifest'] as const)('广播更新 %s 后使用当前实例,不替换面板组件', (field) => {
    const installed = ghost('demo');
    const api = bridgeGhosts([installed]);
    ensureGhostPanelsRegistered();
    const Component = getPanelKind('ghost:demo')!.Component;
    render(<ConfirmDialogProvider><Component paneId="pane-1" /></ConfirmDialogProvider>);
    const updated: InstalledGhost = {
      ...installed,
      ...(field === 'approval'
        ? { approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' } }
        : {}),
      ...(field === 'directory' ? { dir: '/other/demo' } : {}),
      ...(field === 'manifest'
        ? { manifest: { ...installed.manifest, panel: { ...installed.manifest.panel!, title: 'updated title' } } }
        : {}),
    };
    act(() => {
      syncGhostPanelRegistrations([updated]);
      api.change([updated]);
    });
    expect(getPanelKind('ghost:demo')!.Component).toBe(Component);
    expect(screen.getByTestId('ghost-body').getAttribute('data-dir')).toBe(updated.dir);
    expect(screen.getByTestId('ghost-body').getAttribute('data-approval'))
      .toBe(ghostInstallApprovalToken(updated.approval));
    if (field === 'manifest') expect(screen.getByText('updated title')).toBeTruthy();
    expect(api.listSync).toHaveBeenCalledTimes(1);
  });

  it('同名 root / 组织面板各自消费物理实例,清单移除后不显示旧实例', () => {
    const root = { ...ghost('helper'), namespace: null };
    const organization = { ...ghost('helper'), namespace: 'acme', dir: '/fake/_ns/acme/helper' };
    const api = bridgeGhosts([root, organization]);
    ensureGhostPanelsRegistered();
    const Root = getPanelKind('ghost:helper')!.Component;
    const Organization = getPanelKind('ghost:_ns__acme__helper')!.Component;
    render(
      <ConfirmDialogProvider>
        <Root paneId="root" />
        <Organization paneId="organization" />
      </ConfirmDialogProvider>,
    );
    expect(screen.getAllByTestId('ghost-body').map((element) => element.getAttribute('data-dir')))
      .toEqual([root.dir, organization.dir]);
    act(() => api.change([root]));
    expect(screen.getAllByTestId('ghost-body')).toHaveLength(1);
    expect(screen.getByTestId('ghost-body').getAttribute('data-dir')).toBe(root.dir);
    expect(api.listSync).toHaveBeenCalledTimes(1);
  });

  it('同步时对齐气泡状态:卸载删条目、停用强制还原(不留死角)', () => {
    minimizeGhostPanel('gone');
    minimizeGhostPanel('disabled');
    syncGhostPanelRegistrations([ghost('disabled', undefined, false)]);
    const bubbles = getGhostPanelBubbleState();
    expect(bubbles.gone).toBeUndefined();
    expect(bubbles.disabled?.minimized).not.toBe(true);
  });
});

describe('pickGhostPanelMediaUri · 右键命中参数挑媒体地址', () => {
  const HASH = 'a'.repeat(64);
  const MEDIA = `cindy-ghost://art/media/${HASH}.png`;
  const PREVIEW = `cindy-ghost://art/preview/${HASH}.mp4`;

  it('srcURL 优先(直接右键在 img/video 上);linkURL 兜底(视频缩略命中外层 <a>)', () => {
    expect(pickGhostPanelMediaUri({ srcURL: MEDIA, linkURL: PREVIEW }, 'art')).toBe(MEDIA);
    expect(pickGhostPanelMediaUri({ srcURL: '', linkURL: PREVIEW }, 'art')).toBe(PREVIEW);
  });

  it('非媒体 cell(普通元素/外部地址)返回 null,不弹菜单', () => {
    expect(pickGhostPanelMediaUri({}, 'art')).toBeNull();
    expect(pickGhostPanelMediaUri({ srcURL: 'https://evil.example/x.png' }, 'art')).toBeNull();
    expect(pickGhostPanelMediaUri({ linkURL: `cindy-ghost://art/gallery` }, 'art')).toBeNull();
  });

  it('只认本面板意识 id 前缀,别的意识地址不弹', () => {
    expect(pickGhostPanelMediaUri({ srcURL: MEDIA }, 'other')).toBeNull();
  });

  it('多级路径 / query 形状拒绝(严校验仍在 main 闸,这里是粗筛)', () => {
    expect(pickGhostPanelMediaUri({ srcURL: `cindy-ghost://art/media/../${HASH}.png` }, 'art')).toBeNull();
    expect(pickGhostPanelMediaUri({ srcURL: `${MEDIA}?x=1` }, 'art')).toBeNull();
  });
});

describe('syncGhostPanelRegistrations · 停用即休眠', () => {
  it('停用的意识不注册面板;重新启用后同一条对齐路径复活', () => {
    syncGhostPanelRegistrations([ghost('a', undefined, false)]);
    expect(hasPanelKind('ghost:a')).toBe(false);
    syncGhostPanelRegistrations([ghost('a', undefined, true)]);
    expect(hasPanelKind('ghost:a')).toBe(true);
  });

  it('运行中停用 → 已注册的面板被注销', () => {
    syncGhostPanelRegistrations([ghost('a')]);
    expect(hasPanelKind('ghost:a')).toBe(true);
    syncGhostPanelRegistrations([ghost('a', undefined, false)]);
    expect(hasPanelKind('ghost:a')).toBe(false);
  });
});

describe('GhostPanel · 标准头关闭按钮(二次确认后停用插件)', () => {
  function renderPanel(setEnabled: ReturnType<typeof vi.fn>): void {
    bridgeGhosts([ghost('demo')], setEnabled);
    syncGhostPanelRegistrations([ghost('demo')]);
    const def = getPanelKind('ghost:demo');
    if (!def) throw new Error('面板未注册');
    const Component = def.Component;
    render(
      <ConfirmDialogProvider>
        <Component paneId="pane-1" />
      </ConfirmDialogProvider>,
    );
  }

  it('点关闭 → 弹确认框;确认后 setEnabled(id, false)', async () => {
    const setEnabled = vi.fn().mockResolvedValue({ ok: true });
    renderPanel(setEnabled);
    fireEvent.click(screen.getByRole('button', { name: 'panelChrome.closeAria' }));
    // 确认框标题带插件名(t mock 把插值参数拼在 key 后)。
    await screen.findByText('ghostPanel.disableConfirm.title:{"name":"demo 意识"}');
    expect(setEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ghostPanel.disableConfirm.confirm' }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith('demo', false));
    expect(setEnabled).toHaveBeenCalledTimes(1);
  });

  it('点关闭后取消 → 不停用', async () => {
    const setEnabled = vi.fn().mockResolvedValue({ ok: true });
    renderPanel(setEnabled);
    fireEvent.click(screen.getByRole('button', { name: 'panelChrome.closeAria' }));
    await screen.findByText('ghostPanel.disableConfirm.title:{"name":"demo 意识"}');
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByText('ghostPanel.disableConfirm.title:{"name":"demo 意识"}'),
      ).toBeNull(),
    );
    expect(setEnabled).not.toHaveBeenCalled();
  });
});
