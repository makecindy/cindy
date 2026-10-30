// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslation } from 'react-i18next';
import { readToolProcessMedia } from '@cindy/maker-shared/tool-process-media';
import { i18n } from '@/i18n';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import { useFoldableExpandedState, __test_internals } from '@/session/expandedBlockMemory';
import { summarizeWorkGroupPresentation } from '@/session/messagePresentation';
import { buildMessageHierarchyLayout } from '@/session/messageHierarchyLayout';
import { buildMessageContentLayout } from '@/session/messageContentLayout';
import { iconSize, iconStroke, lightColors } from '@/theme/tokens';
import { executeRenderer, rendererFunction, rendererSource } from './fixtures/messageRendererComponents';

// §3.2: actual component bodies, React hooks and shared folding memory protect
// lazy work-detail reads, retained pending lines and generic tool input fallback.
// The prior source/geometry scans never exercised these visible transitions.
function View({ children, testID, onPress, disabled }: any) {
  return React.createElement(onPress ? 'button' : 'div', { 'data-testid': testID, onClick: onPress, disabled }, children);
}
const leaf = () => null;
const child = vi.fn(({ item }: any) => React.createElement('span', null, item.key));
const source = ['ToolActionRow', 'WorkGroupCard'].map(name => rendererFunction(name).getText(rendererSource)).join(String.fromCharCode(10));
const components = executeRenderer<Record<string, React.ComponentType<any>>>(source + '; return { ToolActionRow, WorkGroupCard };', {
  useState: React.useState, useRef: React.useRef, useEffect: React.useEffect, useLayoutEffect: React.useLayoutEffect, useMemo: React.useMemo,
  useTranslation, useFoldableExpandedState, summarizeWorkGroupPresentation,
  mobilePresentationLocalizer, buildMessageHierarchyLayout, buildMessageContentLayout, readToolProcessMedia,
  View, Text: View, Pressable: View, useTheme: () => ({ colors: lightColors }),
  useThemedStyles: () => ({}), makeStyles: leaf, iconSize, iconStroke,
  ChevronDown: leaf, ChevronRight: leaf, Layers: leaf, ToolRowStatusIcon: leaf,
  CompactActivityIndicator: leaf, WorkGroupElapsed: leaf, PluginInvocationHeader: leaf,
  Rail: View, RenderItemView: child, ExpandedWorkThinkingRow: child,
  projectMobileWorkActivities: () => ({ isPureExploration: false, toolActivitiesByChildKey: new Map() }),
  FoldablePanel: ({ children, collapsedBody, controlledExpanded, onControlledToggle, testID }: any) =>
    React.createElement('div', null,
      React.createElement('button', { 'data-testid': testID, onClick: onControlledToggle }, 'toggle'),
      controlledExpanded ? children : collapsedBody),
  WorkLineRow: ({ line, onPress }: any) => React.createElement('button', { onClick: onPress }, line.text),
});
function mount(name: string, props: any) {
  const host = document.createElement('div'), root = createRoot(host);
  const update = (next: any) => act(() => root.render(React.createElement(components[name], next)));
  update(props);
  return { host, update, unmount: () => act(() => root.unmount()) };
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  __test_internals.reset(); child.mockClear();
  await i18n.changeLanguage('zh-CN');
});
describe('message detail lifecycle', () => {
  it('keeps folded work lazy and retains projected lines until expanded details arrive', () => {
    const setVisible = vi.fn();
    const item: any = { type: 'work_group', key: 'work', children: [{ type: 'message', key: 'detail' }],
      isStreaming: true, durationMs: 0, deferred: { owner: 'host', key: 'work', setVisible,
        awaitingDetails: true, lines: [{ key: 'line', kind: 'thinking', text: 'Reading' }] } };
    const h = mount('WorkGroupCard', { item, actions: {} });
    try {
      expect(child).not.toHaveBeenCalled(); expect(h.host.textContent).toContain('Reading');
      act(() => h.host.querySelector('button')!.click());
      expect(setVisible).toHaveBeenCalledWith(true, false);
      expect(h.host.textContent).toContain('Reading'); expect(child).not.toHaveBeenCalled();
      h.update({ item: { ...item, deferred: { ...item.deferred, awaitingDetails: false } }, actions: {} });
      expect(h.host.textContent).toContain('detail'); expect(h.host.textContent).not.toContain('Reading');
    } finally { h.unmount(); }
    expect(setVisible).toHaveBeenLastCalledWith(false, false);
  });

  it('reveals generic tool input when structured detail is absent and remembers row folding', () => {
    const props = { actions: {}, contentLayout: {}, row: { label: 'Custom tool', status: 'done', hasError: false },
      tool: { key: 'custom', body: 'original input summary' } };
    let h = mount('ToolActionRow', props);
    try {
      expect(h.host.textContent).not.toContain('original input summary');
      act(() => h.host.querySelector('button')!.click());
      expect(h.host.textContent).toContain('original input summary');
      h.update({ ...props, row: { ...props.row, detail: 'structured input' } });
      expect(h.host.textContent).toContain('structured input');
      expect(h.host.textContent).not.toContain('original input summary');
    } finally { h.unmount(); }
    h = mount('ToolActionRow', props);
    try { expect(h.host.textContent).toContain('original input summary'); } finally { h.unmount(); }
  });
});
