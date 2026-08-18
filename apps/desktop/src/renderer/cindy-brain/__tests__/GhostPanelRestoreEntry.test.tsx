// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import {
  __resetGhostPanelRestoreModeForTest,
  setGhostPanelRestoreMode,
} from '../../hooks/useGhostPanelRestoreMode';
import {
  __resetGhostPanelBubbleStateForTest,
  getGhostPanelBubbleState,
  minimizeGhostPanel,
} from '../../lib/ghostPanelBubbleState';
import { __resetGhostPanelWindowsStateForTest } from '../../lib/ghostPanelWindowState';
import { GhostPanelRestoreEntry } from '../GhostPanelRestoreEntry';
import { __resetInstalledGhostsStoreForTest } from '../useInstalledGhosts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

function ghost(id: string): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: `${id} 插件`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: { title: `${id} 面板`, html: 'panel.html' },
  };
  return {
    manifest,
    dir: `/fake/${id}`,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

function stubGhostsBridge(ghosts: InstalledGhost[]): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: {
      listSync: () => ({ ghosts }),
      onChanged: () => () => undefined,
    },
  };
}

afterEach(() => {
  cleanup();
  __resetGhostPanelBubbleStateForTest();
  __resetGhostPanelRestoreModeForTest();
  __resetGhostPanelWindowsStateForTest();
  __resetInstalledGhostsStoreForTest();
  window.localStorage.removeItem('ghostPanel.restoreMode');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('GhostPanelRestoreEntry', () => {
  it('气泡模式或没有最小化面板时不占侧栏位置', () => {
    stubGhostsBridge([ghost('a')]);
    minimizeGhostPanel('a');
    const view = render(<GhostPanelRestoreEntry variant="row" />);
    expect(screen.queryByTestId('ghost-panel-restore-entry')).toBeNull();

    act(() => setGhostPanelRestoreMode('sidebar'));
    const trigger = screen.getByTestId('ghost-panel-restore-entry');
    expect(screen.getByTestId('ghost-panel-restore-label').textContent).toBe('a 面板');
    expect(trigger.getAttribute('title')).toBe('a 面板');
    expect(trigger.getAttribute('aria-label')).toContain('ghostPanelRestore.single');

    act(() => {
      fireEvent.click(trigger);
    });
    expect(getGhostPanelBubbleState().a?.minimized).not.toBe(true);
    expect(screen.queryByTestId('ghost-panel-restore-entry')).toBeNull();
    view.unmount();
  });

  it('多个面板显示聚合入口并从菜单恢复指定面板', () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    minimizeGhostPanel('b');
    setGhostPanelRestoreMode('sidebar');
    render(<GhostPanelRestoreEntry variant="row" />);

    const trigger = screen.getByTestId('ghost-panel-restore-entry');
    expect(screen.getByTestId('ghost-panel-restore-label').textContent).toBe(
      'ghostPanelRestore.multiple',
    );
    expect(screen.getByTestId('ghost-panel-restore-label').className).toContain('text-left');
    expect(screen.getByTestId('ghost-panel-restore-count').textContent).toBe('2');
    expect(trigger.getAttribute('title')).toBe('ghostPanelRestore.multiple');
    expect(trigger.getAttribute('aria-label')).toContain('"count":2');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByText('a 面板'));

    expect(getGhostPanelBubbleState().a?.minimized).not.toBe(true);
    expect(getGhostPanelBubbleState().b?.minimized).toBe(true);
  });
});
