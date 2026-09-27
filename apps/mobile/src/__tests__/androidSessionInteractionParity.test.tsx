// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sheet = vi.hoisted(() => ({ onClosed: undefined as (() => void) | undefined }));

vi.mock('react-native', () => ({
  ActivityIndicator: () => null,
  Pressable: ({ children, onPress, testID }: { children?: ReactNode; onPress?: () => void; testID?: string }) =>
    createElement('button', { 'data-testid': testID, onClick: onPress }, children as ReactNode),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  useWindowDimensions: () => ({ height: 800, width: 400 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('@/theme', () => ({
  fontWeight: {}, iconSize: {}, iconStroke: {}, lineHeight: {}, radius: {}, spacing: {}, typeScale: {},
  useTheme: () => ({ colors: {} }),
  useThemedStyles: () => new Proxy({}, { get: () => ({}) }),
}));
vi.mock('@/session/contextSheetModel', () => ({ computeContextSheetSnapHeights: () => ({}) }));
vi.mock('@/session/SheetModal', () => ({
  SheetModal: ({ children, onClosed, visible }: { children?: ReactNode; onClosed?: () => void; visible: boolean }) => {
    sheet.onClosed = onClosed;
    return visible ? createElement('div', null, children) : null;
  },
}));
vi.mock('@/session/SheetSurface', () => ({
  SheetSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

import { ContextSheet, ContextSheetRow } from '@/session/ContextSheet';

const readTextLf = (path: string) => String(readFileSync(resolve(process.cwd(), path), 'utf8')).replace(/\r\n/g, '\n');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  sheet.onClosed = undefined;
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

describe('Android context sheet follows the iOS dismiss-then-present order', () => {
  function render(onClose: () => void, onPress: () => void, dismissBeforePress: boolean) {
    act(() => root.render(createElement(ContextSheet, {
      visible: true,
      onClose,
      title: 'Context',
      keyboardAvoidingBehavior: undefined,
      children: createElement(ContextSheetRow, {
        dismissBeforePress,
        icon: null,
        label: 'Photos',
        onPress,
        testID: 'row',
      }),
    })));
  }

  it('closes the sheet first and runs the picker only after the close finishes', () => {
    const order: string[] = [];
    render(() => order.push('close'), () => order.push('picker'), true);
    act(() => (container.querySelector('[data-testid="row"]') as HTMLButtonElement).click());
    expect(order).toEqual(['close']);
    act(() => sheet.onClosed?.());
    expect(order).toEqual(['close', 'picker']);
    // A later close without a pending row action does not replay the picker.
    act(() => sheet.onClosed?.());
    expect(order).toEqual(['close', 'picker']);
  });

  it('drops a pending picker when the sheet reopens before the close finishes', () => {
    const order: string[] = [];
    render(() => order.push('close'), () => order.push('picker'), true);
    act(() => (container.querySelector('[data-testid="row"]') as HTMLButtonElement).click());
    // Reopened mid-dismiss: the close never completed, then the user closes normally.
    act(() => root.render(createElement(ContextSheet, {
      visible: false, onClose: () => undefined, title: 'Context', keyboardAvoidingBehavior: undefined, children: null,
    })));
    render(() => order.push('close'), () => order.push('picker'), true);
    act(() => sheet.onClosed?.());
    expect(order).toEqual(['close']);
  });

  it('keeps ordinary rows immediate', () => {
    const order: string[] = [];
    render(() => order.push('close'), () => order.push('open'), false);
    act(() => (container.querySelector('[data-testid="row"]') as HTMLButtonElement).click());
    expect(order).toEqual(['open']);
  });
});

describe('Android session chrome matches the iOS entry points', () => {
  const source = readTextLf('app/sessions/[sessionId].tsx');

  it('shows remote desktop, files and details; search lives in the details sheet', () => {
    expect(source).toContain(".filter((action) => action.id === 'files');");
    const header = source.slice(source.indexOf('<View style={styles.sessionHeaderActions}>'));
    const more = header.slice(header.indexOf('icon={Ellipsis}') - 200, header.indexOf('testID="session.controlsToggle"'));
    expect(more).not.toContain('messageOnly');
    expect(more).toContain("accessibilityLabel={t('session.menu.details')}");
    const menu = readTextLf('src/session/SessionMenuSheet.tsx');
    expect(menu).toContain('testID="session.detailsSearch"');
  });

  it('uses the same compact search tool as iOS', () => {
    const start = source.indexOf('function SessionSearchSheet(');
    const search = source.slice(start, source.indexOf('function SessionSyncPlaceholder(', start));
    expect(search).toContain("? hasHits ? `${activeIndex + 1} / ${hitCount}` : '0 / 0'");
    expect(search).toContain('autoFocus={visible}');
    expect(search).toContain('testID="session.searchClearButton"');
    expect(search).not.toContain('session.searchPreview');
    expect(search).not.toContain('MOBILE_VISUAL_MOCK_ENABLED');
  });
});
