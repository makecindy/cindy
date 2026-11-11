// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sheet: null as any,
  sortingChanged: null as null | ((sorting: boolean) => void),
  pageChange: null as null | ((page: string | null, back: () => void, backDisabled?: boolean) => void),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: {} }),
  radius: {},
  spacing: {},
}));
vi.mock('@/session/SheetModal', () => ({ SheetModal: () => null }));
vi.mock('@/session/TaskTagsNative', () => ({
  NativeTaskTagsExpanded: ({ onSortingChange }: any) => { h.sortingChanged = onSortingChange; return null; },
}));
vi.mock('@/session/ComposerSheet', () => ({
  ComposerSheet: (props: any) => {
    h.sheet = props;
    return <div>{props.children}</div>;
  },
}));
vi.mock('@/session/TaskTags', () => ({
  TaskTagsPanel: ({ onPageChange, renderExpanded }: any) => {
    h.pageChange = onPageChange;
    return renderExpanded?.({});
  },
}));

import { TaskTagsSheet } from '@/session/TaskTagsSheet';

let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  h.sheet = null;
  h.pageChange = null;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

it('lets the list close the sheet and the editor pages step back inside it', async () => {
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <TaskTagsSheet
        session={{ id: 's', canonicalDeviceId: 'host' } as any}
        visible
        onClose={onClose}
        onClosed={() => {}}
      />,
    ),
  );
  // The list is the first page the user sees, and it still needs a back arrow.
  expect(h.sheet.onBack).toBe(onClose);

  const back = vi.fn();
  await act(async () => h.pageChange!('edit', back));
  expect(h.sheet.onBack).not.toBe(onClose);
  h.sheet.onBack();
  expect(back).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

it('passes a saving editor page down so the back arrow is disabled', async () => {
  await act(async () =>
    root.render(
      <TaskTagsSheet
        session={{ id: 's', canonicalDeviceId: 'host' } as any}
        visible
        onClose={() => {}}
        onClosed={() => {}}
      />,
    ),
  );
  expect(h.sheet.backDisabled).toBe(false);
  await act(async () => h.pageChange!('edit', () => {}, true));
  expect(h.sheet.backDisabled).toBe(true);
  // The list can always close the sheet, even while a request is in flight.
  await act(async () => h.pageChange!('list', () => {}, true));
  expect(h.sheet.backDisabled).toBe(false);
});


it('sets edit mode on the containing sheet when native tag sorting changes', async () => {
  await act(async () => root.render(
    <TaskTagsSheet session={{ id: 's', canonicalDeviceId: 'host' } as any}
      visible onClose={() => {}} onClosed={() => {}} />,
  ));
  expect(h.sheet.nativeEditMode).toBe(false);
  await act(async () => h.sortingChanged!(true));
  expect(h.sheet.nativeEditMode).toBe(true);
  await act(async () => h.sortingChanged!(false));
  expect(h.sheet.nativeEditMode).toBe(false);
});
