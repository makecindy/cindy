// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * 创建伙伴的原生名称输入框必须由原生控件持有正在输入的文本。
 * `onTextChange` 是异步事件：打字或输入法组字时原生控件已经比它新，若此时按 JS 值回写，
 * SwiftUI 会重建字段、结束组字，未上屏的拼音字母被直接提交进输入框。
 */
const bridge = vi.hoisted(() => ({
  field: null as any,
  /** 每次 JS 写回原生控件的文本；输入过程中必须为空。 */
  writes: [] as string[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: { textSecondary: 'gray', inputCaret: 'blue' } }) }));
vi.mock('@/session/ComposerSheet', () => ({
  ComposerSheet: (p: any) => React.createElement('div', { 'data-testid': 'sheet' }, p.children),
}));
vi.mock('@/session/ComposerNativeSection', () => ({
  ComposerNativeSection: (p: any) => React.createElement('section', null, p.children),
}));
vi.mock('@/session/CompanionPortraitPicker', () => ({ CompanionPortraitPicker: () => null }));
vi.mock('@/session/CompanionNativeContent.ios', () => ({ CompanionNativeContent: (p: any) => p.children }));
vi.mock('@expo/ui/swift-ui', async () => {
  const React = await import('react');
  const control = (p: any) => React.createElement('div', null, p.children);
  return {
    Button: (p: any) => React.createElement('div', { 'data-testid': p.testID }, p.children),
    HStack: control,
    Spacer: () => null,
    ProgressView: () => null,
    Text: (p: any) => React.createElement('span', null, p.children),
    Section: control,
    TextField: (p: any) => {
      bridge.field = p;
      return null;
    },
    // 原生持有文本：`get()` 读的是控件里的当前文本（打字、组字都会先更新它），
    // `set()` 是 JS 侧唯一能改写控件的入口，这里逐次记录下来。
    useNativeState: (initial: string) => {
      const state = React.useRef({
        value: initial,
        get() { return this.value; },
        set(value: string) { bridge.writes.push(value); this.value = value; },
      });
      return state.current;
    },
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => Object.fromEntries(
  ['accessibilityLabel', 'buttonStyle', 'contentShape', 'disabled', 'font', 'foregroundStyle', 'frame']
    .map(key => [key, (value: any) => ({ [key]: value })])
    .concat([['shapes', { rectangle: () => ({}) }] as any]),
));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { CompanionCreateNativeView } from '@/session/CompanionCreateNativeView.ios';
type Props = Parameters<typeof CompanionCreateNativeView>[0];

const avatar = 'base64-portrait';
let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); bridge.field = null; bridge.writes = []; });

function mount(values: Props['values']) {
  const root = createRoot(document.createElement('div'));
  const onChange = vi.fn();
  const panel = { id: 'create', text: '', action: { label: 'create' }, values: {} } as any;
  const render = (next: Props['values']) => act(() => root.render(
    <CompanionCreateNativeView panel={panel} values={next} onChange={onChange} visible online
      deviceName="Mac" nameTaken={false} busy={false} loading={false} error={false} dirty={false}
      onSubmit={() => {}} onRetry={() => {}} onClose={() => {}} />,
  ));
  render(values);
  cleanup.push(() => act(() => root.unmount()));
  return { render, onChange };
}

it('打字和组字期间不回写原生控件，未上屏的字母不会被提交', () => {
  const { render } = mount({ name: '', avatarImageBase64: avatar });
  // 拼音输入法：控件里已经是 "hai"，而 JS 收到的是迟到一步的 "h"。
  act(() => { bridge.field.text.value = 'hai'; bridge.field.onTextChange('h'); });
  render({ name: 'h', avatarImageBase64: avatar });
  expect(bridge.writes).toEqual([]);
  // 组字继续：事件逐个追上原生，控件的文本一直由原生持有。
  act(() => { bridge.field.text.value = 'hai'; bridge.field.onTextChange('hai'); });
  render({ name: 'hai', avatarImageBase64: avatar });
  // 选词上屏。
  act(() => { bridge.field.text.value = '还'; bridge.field.onTextChange('还'); });
  render({ name: '还', avatarImageBase64: avatar });
  expect(bridge.writes).toEqual([]);
});

it('草稿被整体替换（重开表单）时才把新值同步回原生控件', () => {
  const { render } = mount({ name: '', avatarImageBase64: avatar });
  act(() => { bridge.field.text.value = '还'; bridge.field.onTextChange('还'); });
  render({ name: '还', avatarImageBase64: avatar });
  expect(bridge.writes).toEqual([]);
  // 关闭后重开：宿主把草稿重置为空，控件里的旧名字必须跟着清掉。
  render({ name: '', avatarImageBase64: avatar });
  expect(bridge.writes).toEqual(['']);
});

it('上报的草稿始终是原生控件的当前文本', () => {
  const { render, onChange } = mount({ name: '', avatarImageBase64: avatar });
  act(() => { bridge.field.text.value = '还'; bridge.field.onTextChange('还'); });
  render({ name: '还', avatarImageBase64: avatar });
  expect(onChange).toHaveBeenLastCalledWith({ name: '还', avatarImageBase64: avatar });
});
