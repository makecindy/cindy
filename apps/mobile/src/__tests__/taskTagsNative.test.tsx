// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onMove: null as null | ((sources: number[], destination: number) => void),
  textField: null as any,
  announce: vi.fn(),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: h.announce },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/theme', () => ({
  iconSize: { xs: 12, sm: 14, lg: 18 },
  useTheme: () => ({ colors: {} }),
}));
vi.mock('@/platform/chrome/nativeGlassButtonStyle.ios', () => ({
  useNativeGlassButtonStyle: () => [],
}));
vi.mock('@/session/ComposerNativeSection', () => ({
  ComposerNativeSection: ({ children }: any) => <section>{children}</section>,
}));
vi.mock('@/session/ComposerNativeRow', () => ({
  ComposerNativeRow: ({ title, onPress, onOptions, testID }: any) => (
    <div>
      <button data-testid={testID} onClick={onPress}>
        {title}
      </button>
      {onOptions ? (
        <button data-testid={`${testID}.options`} onClick={onOptions}>
          options
        </button>
      ) : null}
    </div>
  ),
}));
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children }: any) => <div>{children}</div>;
  const List: any = Box;
  List.ForEach = ({ children, onMove }: any) => {
    h.onMove = onMove;
    return <div>{children}</div>;
  };
  return {
    Button: ({ children, onPress, testID }: any) => (
      <button data-testid={testID} onClick={onPress}>
        {children}
      </button>
    ),
    Circle: () => null,
    Group: Box,
    HStack: Box,
    Image: () => null,
    List,
    ProgressView: () => null,
    Section: Box,
    Text: ({ children }: any) => <span>{children}</span>,
    TextField: (props: any) => {
      h.textField = props;
      return null;
    },
    VStack: Box,
    ZStack: Box,
    useNativeState: (value: string) => ({ get: () => value, set: () => {} }),
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    [
      'accessibilityAddTraits',
      'accessibilityLabel',
      'buttonStyle',
      'contentShape',
      'disabled',
      'font',
      'foregroundStyle',
      'frame',
      'listRowBackground',
      'listRowInsets',
      'listRowSeparator',
      'moveDisabled',
      'opacity',
      'strokeBorder',
      'tint',
    ].map((name) => [name, (value: unknown) => ({ [name]: value })]),
  ),
  shapes: { rectangle: () => ({}) },
}));

import { NativeTaskTagsExpanded } from '@/session/TaskTagsNative.ios';
import { taskTagMoveTarget } from '@/session/taskTagsNativePage';

const swatch = (id: string) => ({
  id,
  name: id,
  color: '#fff',
  checkColor: '#000',
  outlined: false,
  selected: false,
});
const baseState = (over: Record<string, unknown> = {}): any => ({
  page: 'list',
  tags: [swatch('a'), swatch('b'), swatch('c')],
  disabled: false,
  loading: false,
  canRetry: false,
  canAdd: true,
  onRetry: vi.fn(),
  onToggle: vi.fn(),
  onEdit: vi.fn(),
  onAdd: vi.fn(),
  onMove: vi.fn(),
  form: {
    name: 'Work',
    onNameChange: vi.fn(),
    locked: false,
    colors: ['red', 'blue'].map((value) => ({
      ...swatch(value),
      value,
      available: true,
    })),
    onColor: vi.fn(),
    hint: '',
    submitLabel: 'taskTags.save',
    canSubmit: true,
    onSubmit: vi.fn(),
    canDelete: true,
    onDelete: vi.fn(),
  },
  ...over,
});

let root: ReturnType<typeof createRoot>;
let node: HTMLDivElement;
const render = (state: any) =>
  act(async () => root.render(<NativeTaskTagsExpanded state={state} />));
const press = (testID: string) =>
  act(async () =>
    node.querySelector<HTMLButtonElement>(`[data-testid="${testID}"]`)!.click(),
  );

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  h.onMove = null;
  h.textField = null;
  h.announce.mockClear();
  node = document.createElement('div');
  root = createRoot(node);
});
afterEach(() => act(() => root.unmount()));

it('maps SwiftUI insertion points to the final index in both directions', () => {
  expect(taskTagMoveTarget(0, 3)).toBe(2);
  expect(taskTagMoveTarget(0, 2)).toBe(1);
  expect(taskTagMoveTarget(2, 0)).toBe(0);
  // Dropping a row where it already is must stay a no-op.
  expect(taskTagMoveTarget(1, 1)).toBe(1);
  expect(taskTagMoveTarget(1, 2)).toBe(1);
});

it('routes list drags, taps, edit and add through the shared state', async () => {
  const state = baseState();
  await render(state);
  act(() => h.onMove!([0], 3));
  expect(state.onMove).toHaveBeenLastCalledWith(0, 2);
  act(() => h.onMove!([2], 0));
  expect(state.onMove).toHaveBeenLastCalledWith(2, 0);
  await press('taskTags.tag.b');
  expect(state.onToggle).toHaveBeenCalledWith('b');
  await press('taskTags.tag.b.options');
  expect(state.onEdit).toHaveBeenCalledWith('b');
  await press('taskTags.add');
  expect(state.onAdd).toHaveBeenCalledTimes(1);
});

it('wires the editor name, colour, save and delete callbacks', async () => {
  const state = baseState({ page: 'edit' });
  await render(state);
  act(() => h.textField.onTextChange('Home'));
  expect(state.form.onNameChange).toHaveBeenCalledWith('Home');
  await press('taskTags.form.color.blue');
  expect(state.form.onColor).toHaveBeenCalledWith('blue');
  await press('taskTags.form.submit');
  expect(state.form.onSubmit).toHaveBeenCalledTimes(1);
  await press('taskTags.form.delete');
  expect(state.form.onDelete).toHaveBeenCalledTimes(1);
  expect(state.form.onSubmit).toHaveBeenCalledTimes(1);
});

it('keeps the add page free of the delete action', async () => {
  await render(baseState({ page: 'add', form: { ...baseState().form, canDelete: false } }));
  expect(node.querySelector('[data-testid="taskTags.form.delete"]')).toBeNull();
});

it('confirms deletion only from the confirmation page', async () => {
  const onConfirm = vi.fn();
  await render(baseState({ page: 'delete', deletion: { message: 'sure?', onConfirm } }));
  expect(node.querySelector('[data-testid="taskTags.form.submit"]')).toBeNull();
  await press('taskTags.delete.confirm');
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it('announces failures to VoiceOver once per message', async () => {
  await render(baseState());
  expect(h.announce).not.toHaveBeenCalled();
  await render(baseState({ message: 'taskTags.failed' }));
  expect(h.announce).toHaveBeenCalledTimes(1);
  expect(h.announce).toHaveBeenCalledWith('taskTags.failed');
  await render(baseState({ message: 'taskTags.failed' }));
  expect(h.announce).toHaveBeenCalledTimes(1);
  await render(baseState({ message: 'taskTags.offline' }));
  expect(h.announce).toHaveBeenLastCalledWith('taskTags.offline');
});
