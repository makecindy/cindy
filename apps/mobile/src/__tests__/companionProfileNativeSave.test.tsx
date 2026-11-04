// @vitest-environment jsdom
// User regression: the model form's save was below the scrollable content.
// Exercise the actual iOS view and sheet together: one native Save beside Back,
// outside the form, retaining submission and disabled states. Existing profile
// tests replace this iOS view; sheet tests alone never render its model page.
// Minimal input: page=models, an actionable panel and a dirty online draft (unit).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionProfileNativeView } from '@/session/CompanionProfileNativeView.ios';
import type { CompanionProfileNativeViewProps } from '@/session/CompanionProfileNativeView';
import { parseCompanionProfileData } from '@/session/companionProfileData';
const native = vi.hoisted(() => ({ glass: true }));
vi.mock('@/session/useLiquidGlassAvailable', () => ({ useLiquidGlassAvailable: () => native.glass }));

vi.mock('@/session/ComposerSheet', () => import('@/session/ComposerSheet.ios'));
vi.mock('react-native', () => ({
  View: 'div', ScrollView: 'div', useWindowDimensions: () => ({ width: 402, height: 874 }),
}));
vi.mock('@expo/ui', () => ({ Host: ({ children }: any) => <div>{children}</div> }));
vi.mock('@expo/ui/swift-ui', () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  return {
    BottomSheet: Container, Group: Container, HStack: Container, VStack: Container, ZStack: Container,
    RNHostView: Container, ScrollView: Container, Text: Container, Image: () => null,
    Spacer: () => null, ProgressView: () => null, Toggle: () => null, Picker: Container, TextField: () => null,
    Form: ({ children }: any) => <form>{children}</form>, List: Container,
    Button: ({ children, onPress, modifiers = [], testID }: any) => <button type="button"
      data-testid={testID} data-button-style={modifiers.find((m: any) => m.buttonStyle)?.buttonStyle}
      disabled={modifiers.some((m: any) => m.disabled)} onClick={onPress}>{children}</button>,
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(['accessibilityLabel', 'accessibilityElement', 'accessibilityHidden', 'alignmentGuide',
    'buttonStyle', 'contentShape', 'disabled', 'environment', 'font', 'foregroundStyle', 'frame', 'lineLimit',
    'listRowInsets', 'pickerStyle', 'tag', 'tint', 'opacity', 'scrollDisabled', 'containerRelativeFrame',
    'onGeometryChange', 'padding', 'presentationDetents', 'interactiveDismissDisabled',
    'presentationDragIndicator', 'scrollContentBackground', 'listStyle', 'scrollDismissesKeyboard',
    'background', 'buttonBorderShape', 'controlSize', 'glassEffect']
    .map(key => [key, (value: unknown) => ({ [key]: value })])),
  shapes: { rectangle: () => ({}) },
}));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ mode: 'light', colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string) => key === 'devices.common.save' ? '保存' : key,
  i18n: { language: 'zh-CN' },
}) }));
vi.mock('@/session/ComposerNativeSection', () => ({ ComposerNativeSection: ({ children, title }: any) => <section>{title ? <h3>{title}</h3> : null}{children}</section> }));
vi.mock('@/session/CompanionNativeContent.ios', () => ({ CompanionNativeContent: ({ children }: any) => children }));
vi.mock('@/session/CompanionPortraitPicker', () => ({ CompanionPortraitPicker: () => null }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/session/nativeTextDraft', () => ({ useNativeTextDraft: (text: string) => ({ text, onTextChange: vi.fn() }) }));
vi.mock('@/session/companionReplyTargetPreference', () => ({
  useCompanionReplyTargetPreference: () => false, saveCompanionReplyTargetPreference: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const panel = { id: 'models', text: '', values: {}, action: { id: 'models-save', label: '保存更改', fields: [] } };
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); native.glass = true; });
function mount(overrides: Partial<CompanionProfileNativeViewProps> = {}) {
  const container = document.createElement('div');
  const root = createRoot(container); roots.push(root);
  const props: CompanionProfileNativeViewProps = {
    visible: true, title: '模型候选链', name: 'Cindy', page: 'models', deviceId: 'host', deviceName: 'Mac',
    resource: null, data: null, editor: null, panel, values: {}, busy: false, online: true, dirty: true,
    loading: false, error: false, conflict: false, receipt: null, confirmation: null, deleted: false,
    models: <span>Model chain</span>, channels: null, artifacts: null, memoryPage: null, hasMemoryEntries: false,
    onClose: vi.fn(), onBack: vi.fn(), onOpen: vi.fn(), onChange: vi.fn(), onSubmit: vi.fn(),
    onConfirm: vi.fn(), onRetry: vi.fn(), onDiscard: vi.fn(), onEditor: vi.fn(), onEditorPanel: vi.fn(),
    ...overrides,
  };
  const render = (next: Partial<CompanionProfileNativeViewProps>) => {
    Object.assign(props, next);
    act(() => root.render(<CompanionProfileNativeView {...props} />));
  };
  render({});
  return { container, props, render };
}

it('places the native 保存 beside Back outside the scrolling form and submits the same panel', () => {
  const { container, props } = mount();
  const save = container.querySelector<HTMLButtonElement>('[data-testid="companionProfile.models.save"]')!;
  expect(save.textContent).toBe('保存');
  expect(save.dataset.buttonStyle).toBe('glass');
  expect(save.closest('form')).toBeNull();
  const header = save.parentElement!;
  expect(header.textContent).toContain('模型候选链');
  const back = header.querySelector('button')!;
  expect(back).not.toBe(save);
  expect(header.querySelectorAll('button')).toHaveLength(2);
  expect(container.querySelector('form')!.textContent).toBe('Model chain');
  act(() => save.click());
  expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(panel);
  act(() => back.click());
  expect(props.onBack).toHaveBeenCalledOnce();
});

it('uses the existing bordered native button fallback when Liquid Glass is unavailable', () => {
  native.glass = false;
  const { container } = mount();
  expect(container.querySelector<HTMLElement>('[data-testid="companionProfile.models.save"]')!.dataset.buttonStyle).toBe('bordered');
});

it.each([{ dirty: false }, { busy: true }, { online: false }, { conflict: true }])(
  'preserves the disabled save condition %j', overrides => {
    const { container, props } = mount(overrides);
    const save = container.querySelector<HTMLButtonElement>('[data-testid="companionProfile.models.save"]')!;
    expect(save.disabled).toBe(true);
    act(() => save.click());
    expect(props.onSubmit).not.toHaveBeenCalled();
  },
);

it('keeps other form saves in place and removes the model action on page changes or unavailable forms', () => {
  const { container, render } = mount();
  render({ page: 'profile', panel: { ...panel, id: 'profile' } });
  expect(container.querySelector('[data-testid="companionProfile.models.save"]')).toBeNull();
  expect(container.querySelector('form')!.textContent).toContain('devices.companionProfile.save');
  render({ page: 'models', panel: undefined });
  expect(container.querySelector('[data-testid="companionProfile.models.save"]')).toBeNull();
  render({ panel, loading: true });
  expect(container.querySelector('[data-testid="companionProfile.models.save"]')).toBeNull();
});

// Skill layers (cindy-bots-runtime.md §6「伙伴技能分层」) on the real iOS editor list: block titles become section
// headers and a subtitle (a Skill turned off) sits under the row title; untitled hosts keep one section.
// Minimal input: the host's skills page parsed by the real reader; unit.
it('sections a host editor list by block title and shows entry subtitles', () => {
  const id = 'settings:bot/skills'; const ref = { collectionId: 'teammates', kind: 'bot', id };
  const editor = parseCompanionProfileData({ ref, revision: 'r1', display: { title: 'Skills' }, links: [], blocks: [
    { id: 'core', primitive: 'list', fallbackMarkdown: '', data: { entries: [{ id: 'core', title: 'Core Skill', subtitle: 'Shared by every teammate', resourceId: `${id}/_core` }] } },
    { id: 'system', title: 'System Skills', primitive: 'list', fallbackMarkdown: '', data: { entries: [
      { id: 'todo', title: 'Todos', resourceId: `${id}/_todo` }, { id: 'routine', title: 'Routines', subtitle: 'Off', resourceId: `${id}/_routine` }] } },
    { id: 'skills', title: 'Personal Skills', primitive: 'list', fallbackMarkdown: '', data: { entries: [{ id: 'learned', title: 'Write briefs', resourceId: `${id}/learned` }] } },
  ] }, ref);
  const { container, props } = mount({ page: 'editor', panel: undefined, editor, dirty: false });
  const sections = [...container.querySelectorAll('section')].filter(node => node.querySelector('button'));
  expect(sections.map(node => [node.querySelector('h3')?.textContent ?? null, [...node.querySelectorAll('button')].map(button => button.textContent)])).toEqual([
    [null, ['Core SkillShared by every teammate']], ['System Skills', ['Todos', 'RoutinesOff']], ['Personal Skills', ['Write briefs']]]);
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'RoutinesOff')!.click());
  expect(props.onEditor).toHaveBeenCalledExactlyOnceWith(`${id}/_routine`);
});
