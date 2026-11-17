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
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { buildMediaPayload } from '@/session/messagePayload';
import type { RemoteMessage } from '@/session/types';
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
const mediaPreview = vi.fn(({ media, onOpen }: any) => React.createElement(
  'button', { 'data-testid': 'process-media', 'data-url': media.url, onClick: onOpen }, 'Open image',
));
const source = ['ToolActionRow', 'WorkGroupCard', 'mediaLabel'].map(name => rendererFunction(name).getText(rendererSource)).join(String.fromCharCode(10));
const components = executeRenderer<Record<string, React.ComponentType<any>>>(source + '; return { ToolActionRow, WorkGroupCard };', {
  useState: React.useState, useRef: React.useRef, useEffect: React.useEffect, useLayoutEffect: React.useLayoutEffect, useMemo: React.useMemo,
  useTranslation, useFoldableExpandedState, summarizeWorkGroupPresentation,
  mobilePresentationLocalizer, buildMessageHierarchyLayout, buildMessageContentLayout, readToolProcessMedia,
  buildMediaPayload, MediaPreview: mediaPreview,
  View, Text: View, Pressable: View, useTheme: () => ({ colors: lightColors }),
  useThemedStyles: () => ({}), makeStyles: leaf, iconSize, iconStroke,
  ChevronDown: leaf, ChevronRight: leaf, Layers: leaf, ToolRowStatusIcon: leaf,
  CompactActivityIndicator: leaf, WorkGroupElapsed: leaf, PluginInvocationHeader: leaf,
  Rail: View, RenderItemView: child, ExpandedWorkThinkingRow: child,
  MessageContentOpenButton: View,
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
  __test_internals.reset(); child.mockClear(); mediaPreview.mockClear();
  await i18n.changeLanguage('zh-CN');
});
describe('message detail lifecycle', () => {
  // Phone preview regression / unit: the actual tool row must render a decoded
  // saved image result and open the existing media viewer. Prior fixtures used
  // string results or supplied normalized media directly, missing text unwrapping.
  // Single-file Vitest run on Windows: 3.91s (including module collection).
  it('opens a saved tool image from a decoded history result', () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const base = { sessionId: 'image-task', toolUseId: 'read-image', agentMeta: null,
      createdAt: '2026-01-01T00:00:00.000Z' };
    const rows: RemoteMessage[] = [
      { ...base, id: 'read', clientId: 'read', role: 'tool_use',
        content: { toolName: 'Read', input: { file_path: '/project/capture.png' } } },
      { ...base, id: 'result', clientId: 'result', role: 'tool_result', content: {
        text: '[Image: source: /provider/tool-results/capture.png]',
        cindy_process_media: [{ kind: 'image', url }],
      } },
    ];
    const [tool] = normalizeRemoteMessages(rows);
    const onOpenPayload = vi.fn(), onResolveRemoteMedia = vi.fn();
    const h = mount('ToolActionRow', { tool, contentLayout: {},
      actions: { onOpenPayload, onResolveRemoteMedia },
      row: { label: 'Read', status: 'done', hasError: false },
    });
    try {
      const button = h.host.querySelector<HTMLButtonElement>('[data-testid="process-media"]');
      expect(button?.getAttribute('data-url')).toBe(url);
      expect(mediaPreview.mock.lastCall?.[0].onResolveRemoteMedia).toBe(onResolveRemoteMedia);
      act(() => button!.click());
      expect(onOpenPayload).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'media', media: { kind: 'image', url, previewable: false },
      }));
    } finally { h.unmount(); }
  });

  it('keeps folded work lazy and retains projected lines until expanded details arrive', () => {
    const release = vi.fn();
    const setVisible = vi.fn(() => release);
    const item: any = { type: 'work_group', key: 'work', children: [{ type: 'message', key: 'detail' }],
      isStreaming: true, durationMs: 0, deferred: { owner: 'host', key: 'work', setVisible,
        awaitingDetails: true, lines: [{ key: 'line', kind: 'thinking', text: 'Reading' }] } };
    const h = mount('WorkGroupCard', { item, actions: {} });
    try {
      expect(child).not.toHaveBeenCalled(); expect(h.host.textContent).toContain('Reading');
      act(() => h.host.querySelector('button')!.click());
      expect(setVisible).toHaveBeenLastCalledWith(true, true);
      expect(h.host.textContent).toContain('Reading'); expect(child).not.toHaveBeenCalled();
      h.update({ item: { ...item, deferred: { ...item.deferred, awaitingDetails: false } }, actions: {} });
      expect(h.host.textContent).toContain('detail'); expect(h.host.textContent).not.toContain('Reading');
    } finally { h.unmount(); }
    expect(release).toHaveBeenCalledTimes(2);
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

  // The group supplies its full-input action separately from the clipped row
  // detail. Exercise the real row's disclosure and button, not a JSX scan.
  it('offers the group full-input action only inside the expanded tool row', () => {
    const onOpenInput = vi.fn();
    const props = { actions: {}, onOpenInput, contentLayout: {},
      row: { label: 'Bash', detail: 'x'.repeat(200), status: 'done', hasError: false },
      tool: { key: 'bash', body: 'input summary' } };
    const h = mount('ToolActionRow', props);
    const inputButton = () => h.host.querySelector<HTMLButtonElement>('[data-testid="message.toolInputPayloadButton"]');
    try {
      expect(inputButton()).toBeNull();
      act(() => h.host.querySelector('button')!.click());
      expect(inputButton()).not.toBeNull();
      act(() => inputButton()!.click());
      expect(onOpenInput).toHaveBeenCalledOnce();
      h.update({ ...props, onOpenInput: undefined });
      expect(inputButton()).toBeNull();
    } finally { h.unmount(); }
  });
});
