import { describe, expect, it, vi } from 'vitest';

import {
  getSidebarNewWindowShortcutKey,
  isSidebarNewWindowActivation,
  preventMiddleClickAutoscroll,
  resolveRailPanelClickModifiers,
  resolveSidebarSessionClickAction,
} from '../sidebarNewWindowActivation';
import { companionWindowBootRoute } from '@/features/bots/companionChatTarget';

describe('sidebarNewWindowActivation', () => {
  it.each([
    { label: 'macOS Cmd+click', platform: 'darwin', event: { metaKey: true, button: 0 }, expected: true },
    { label: 'macOS Ctrl+click (OS context menu)', platform: 'darwin', event: { ctrlKey: true, button: 0 }, expected: false },
    { label: 'macOS Option+click', platform: 'darwin', event: { altKey: true, button: 0 }, expected: false },
    { label: 'macOS Cmd+Shift+click', platform: 'darwin', event: { metaKey: true, shiftKey: true, button: 0 }, expected: false },
    { label: 'macOS Cmd+Option+click', platform: 'darwin', event: { metaKey: true, altKey: true, button: 0 }, expected: false },
    { label: 'macOS middle-click', platform: 'darwin', event: { button: 1 }, expected: true },
    { label: 'macOS right-click with Cmd', platform: 'darwin', event: { metaKey: true, button: 2 }, expected: false },
    { label: 'Windows Ctrl+click', platform: 'win32', event: { ctrlKey: true, button: 0 }, expected: true },
    { label: 'Windows Meta+click (Win key)', platform: 'win32', event: { metaKey: true, button: 0 }, expected: false },
    { label: 'Windows Alt+click', platform: 'win32', event: { altKey: true, button: 0 }, expected: false },
    { label: 'Windows Ctrl+Shift+click', platform: 'win32', event: { ctrlKey: true, shiftKey: true, button: 0 }, expected: false },
    { label: 'Windows middle-click', platform: 'win32', event: { button: 1 }, expected: true },
    { label: 'Linux Ctrl+click', platform: 'linux', event: { ctrlKey: true, button: 0 }, expected: true },
    { label: 'Linux Super/Meta+click', platform: 'linux', event: { metaKey: true, button: 0 }, expected: false },
    { label: 'Linux Alt+click (WM drag)', platform: 'linux', event: { altKey: true, button: 0 }, expected: false },
    { label: 'Linux middle-click', platform: 'linux', event: { button: 1 }, expected: true },
    { label: 'Plain click', platform: 'darwin', event: { button: 0 }, expected: false },
  ])('$label -> $expected', ({ platform, event, expected }) => {
    expect(isSidebarNewWindowActivation(event, platform)).toBe(expected);
  });

  it('picks platform-specific shortcut i18n keys', () => {
    expect(getSidebarNewWindowShortcutKey('darwin')).toBe('ccAgent.sidebar.sessionMenu.openInNewWindowShortcutMac');
    expect(getSidebarNewWindowShortcutKey('win32')).toBe('ccAgent.sidebar.sessionMenu.openInNewWindowShortcutOther');
    expect(getSidebarNewWindowShortcutKey('linux')).toBe('ccAgent.sidebar.sessionMenu.openInNewWindowShortcutOther');
  });

  it('only prevents default on middle-button mousedown to suppress autoscroll', () => {
    const leftPrevent = vi.fn();
    preventMiddleClickAutoscroll({ button: 0, preventDefault: leftPrevent });
    expect(leftPrevent).not.toHaveBeenCalled();

    const middlePrevent = vi.fn();
    preventMiddleClickAutoscroll({ button: 1, preventDefault: middlePrevent });
    expect(middlePrevent).toHaveBeenCalledTimes(1);
  });

  it('preserves new-window gestures in collapsed rail panels while suppressing panel multi-select', () => {
    const macNewWin = resolveRailPanelClickModifiers({ metaKey: true, button: 0 }, 'darwin');
    expect(macNewWin).toEqual({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, button: 1 });
    // Even if expanded sidebar selection is non-empty, panel new-window click opens in a new window.
    expect(
      resolveSidebarSessionClickAction({
        id: 's2',
        modifiers: macNewWin,
        selectedIds: new Set(['s1']),
        anchorId: 's1',
        getVisibleIds: () => ['s1', 's2'],
        platform: 'darwin',
      }),
    ).toEqual({ kind: 'open-new-window' });

    expect(resolveRailPanelClickModifiers({ ctrlKey: true, button: 0 }, 'win32')).toEqual(macNewWin);
    expect(resolveRailPanelClickModifiers({ button: 1 }, 'linux')).toEqual(macNewWin);
    expect(resolveRailPanelClickModifiers({ shiftKey: true, button: 0 }, 'darwin')).toBeUndefined();
    expect(resolveRailPanelClickModifiers({ ctrlKey: true, button: 0 }, 'darwin')).toBeUndefined();
    expect(resolveRailPanelClickModifiers({ button: 0 }, 'darwin')).toBeUndefined();
  });
});

describe('resolveSidebarSessionClickAction (Plan A)', () => {
  const visible = ['s1', 's2', 's3', 's4'];
  const getVisibleIds = () => visible;

  it('opens in a new window on platform primary modifier outside multi-select', () => {
    expect(
      resolveSidebarSessionClickAction({
        id: 's2',
        modifiers: { shiftKey: false, metaKey: true, ctrlKey: false, button: 0 },
        selectedIds: new Set(),
        anchorId: 's1',
        getVisibleIds,
        platform: 'darwin',
      }),
    ).toEqual({ kind: 'open-new-window' });

    expect(
      resolveSidebarSessionClickAction({
        id: 's2',
        modifiers: { shiftKey: false, metaKey: false, ctrlKey: true, button: 0 },
        selectedIds: new Set(),
        anchorId: 's1',
        getVisibleIds,
        platform: 'win32',
      }),
    ).toEqual({ kind: 'open-new-window' });
  });

  it('enters range multi-select on Shift+click and supports additive Shift+mod+click', () => {
    const range = resolveSidebarSessionClickAction({
      id: 's3',
      modifiers: { shiftKey: true, metaKey: false, ctrlKey: false, button: 0 },
      selectedIds: new Set(),
      anchorId: 's1',
      getVisibleIds,
      platform: 'darwin',
    });
    expect(range).toEqual({
      kind: 'update-selection',
      selectedIds: new Set(['s1', 's2', 's3']),
      anchorId: 's1',
    });

    const additive = resolveSidebarSessionClickAction({
      id: 's4',
      modifiers: { shiftKey: true, metaKey: true, ctrlKey: false, button: 0 },
      selectedIds: new Set(['s1']),
      anchorId: 's3',
      getVisibleIds,
      platform: 'darwin',
    });
    expect(additive).toEqual({
      kind: 'update-selection',
      selectedIds: new Set(['s1', 's3', 's4']),
      anchorId: 's3',
    });
  });

  it('toggles individual rows on plain or primary-mod click while in multi-select, and exits when empty', () => {
    const toggledOn = resolveSidebarSessionClickAction({
      id: 's4',
      modifiers: { shiftKey: false, metaKey: true, ctrlKey: false, button: 0 },
      selectedIds: new Set(['s1']),
      anchorId: 's1',
      getVisibleIds,
      platform: 'darwin',
    });
    expect(toggledOn).toEqual({
      kind: 'update-selection',
      selectedIds: new Set(['s1', 's4']),
      anchorId: 's4',
    });

    const toggledOff = resolveSidebarSessionClickAction({
      id: 's1',
      modifiers: { shiftKey: false, metaKey: false, ctrlKey: false, button: 0 },
      selectedIds: new Set(['s1']),
      anchorId: 's1',
      getVisibleIds,
      platform: 'darwin',
    });
    expect(toggledOff).toEqual({
      kind: 'update-selection',
      selectedIds: new Set(),
      anchorId: 's1',
    });
  });

  it('keeps middle-click opening in a new window even while multi-select is active', () => {
    expect(
      resolveSidebarSessionClickAction({
        id: 's3',
        modifiers: { shiftKey: false, metaKey: false, ctrlKey: false, button: 1 },
        selectedIds: new Set(['s1', 's2']),
        anchorId: 's1',
        getVisibleIds,
        platform: 'win32',
      }),
    ).toEqual({ kind: 'open-new-window' });
  });

  it('navigates and clears selection on programmatic switches without click modifiers', () => {
    expect(
      resolveSidebarSessionClickAction({
        id: 's2',
        modifiers: undefined,
        selectedIds: new Set(['s1']),
        anchorId: 's1',
        getVisibleIds,
        platform: 'darwin',
      }),
    ).toEqual({ kind: 'navigate', anchorId: 's2', clearSelection: true });
  });
});

describe('companionWindowBootRoute', () => {
  const msgUuid = '11111111-2222-3333-4444-555555555555';
  const rootUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it.each([
    ['/bots/mate', '/bots/mate'],
    ['/bots/remote/mac/mate', '/bots/remote/mac/mate'],
    ['/bots/groups/g1', '/bots/groups/g1'],
    ['/bots/groups/g1?conversationKind=direct', '/bots/groups/g1?conversationKind=direct'],
    [
      `/bots/groups/g1?messageId=${msgUuid}&threadRootId=${rootUuid}`,
      `/bots/groups/g1?messageId=${msgUuid}&threadRootId=${rootUuid}`,
    ],
    [
      `/bots/groups/g1?conversationKind=direct&messageId=${msgUuid}`,
      `/bots/groups/g1?conversationKind=direct&messageId=${msgUuid}`,
    ],
    ['/bots/list', null],
    ['/bots/mate?settings=1', null],
    ['/bots/groups/g1?groupSettings=1', null],
    ['/bots/groups/g1?messageId=not-a-uuid', null],
    [`/bots/groups/g1?threadRootId=${rootUuid}`, null],
    ['/bots/../settings', null],
  ])('validates %s -> %s', (input, expected) => {
    expect(companionWindowBootRoute(input)).toBe(expected);
  });
});
