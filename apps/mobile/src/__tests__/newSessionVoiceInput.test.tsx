// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TextInputProps, TextStyle } from 'react-native';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileComposerInputRow, type MobileComposerInputRowProps } from '@/session/MobileComposerInputRow';
import { palettes } from '@/theme/tokens';

const native = vi.hoisted(() => ({
  platform: 'android',
  mode: 'light' as 'light' | 'dark',
  props: {} as TextInputProps,
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return native.platform; } },
  StyleSheet: { hairlineWidth: 1 },
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@/components/AppText', async () => {
  const { forwardRef } = await import('react');
  return { TextInput: forwardRef<HTMLTextAreaElement, TextInputProps>((props, ref) => {
    native.props = props;
    return createElement('textarea', {
      ref, value: props.value, readOnly: true,
      onMouseDown: () => props.onPressIn?.({} as never),
    });
  }) };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children: ReactNode }) => createElement('div', null, children) },
}));
vi.mock('@/platform/gestureHandler', () => ({}));
vi.mock('lucide-react-native', () => ({}));
vi.mock('expo-constants', () => ({
  default: { executionEnvironment: 'bare' }, ExecutionEnvironment: { StoreClient: 'storeClient' },
}));
vi.mock('expo-paste-input', () => ({
  TextInputWrapper: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@/theme', () => ({
  useThemedStyles: (make: (colors: typeof palettes.light) => unknown) => make(palettes[native.mode]),
}));

// Exercise the page's actual visibility/event expressions and the real input row.
// Extract only this boundary so unrelated screen/network/native dependencies are not loaded.
// Native drawing and hit testing still require the Android emulator regression.
const source = ts.createSourceFile('new.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findOne<T extends ts.Node>(guard: (node: ts.Node) => node is T): T {
  const found: T[] = [];
  function visit(node: ts.Node) {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (found.length !== 1) throw new Error(`Expected one source boundary, found ${found.length}`);
  return found[0];
}
const hiddenStyle = findOne((node): node is ts.PropertyAssignment =>
  ts.isPropertyAssignment(node) && node.name.getText(source) === 'inputVoiceHidden');
const composer = findOne((node): node is ts.JsxSelfClosingElement =>
  ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'MobileComposerInputRow');
const propNames = ['inputStyle', 'caretHidden', 'value', 'placeholder', 'onPressIn'];
const expressions = propNames.map((name) => {
  const prop = composer.attributes.properties.find((node) =>
    ts.isJsxAttribute(node) && node.name.getText(source) === name);
  if (!prop || !ts.isJsxAttribute(prop) || !prop.initializer
    || !ts.isJsxExpression(prop.initializer) || !prop.initializer.expression) {
    throw new Error(`Missing composer expression: ${name}`);
  }
  return `${name}: ${prop.initializer.expression.getText(source)}`;
});
const compiled = ts.transpileModule(`function pageProps(bindings) {
  const { Platform, voiceIsListening, draft, finishVoiceRecording, composerPlaceholder } = bindings;
  const styles = { inputVoiceHidden: ${hiddenStyle.initializer.getText(source)} };
  return { ${expressions.join(',\n')} };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const pageProps = new Function(`${compiled}; return pageProps;`)() as
  (bindings: Record<string, unknown>) => Partial<MobileComposerInputRowProps>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

function mountInput() {
  const container = document.createElement('div');
  const ref = createRef<HTMLTextAreaElement>();
  const finishVoiceRecording = vi.fn();
  root = createRoot(container);
  function render(listening: boolean, draft: string) {
    const colors = palettes[native.mode];
    act(() => root!.render(createElement(MobileComposerInputRow, {
      accessibilityLabel: 'Draft', inputTestID: 'draft', inputRef: ref,
      placeholder: 'Draft', placeholderTextColor: colors.textTertiary,
      value: draft, onChangeText: vi.fn(), onPasteImages: vi.fn(),
      ...pageProps({ Platform: { OS: native.platform }, voiceIsListening: listening,
        draft: { firstMessage: draft }, finishVoiceRecording, composerPlaceholder: 'Draft' }),
      inputOverlay: listening ? createElement('span', { 'data-testid': 'preview' }, draft) : null,
    })));
  }
  const inputStyle = () => {
    const styles: unknown[] = [native.props.style];
    return Object.assign({}, ...styles.flat(Infinity).filter(Boolean)) as TextStyle;
  };
  return { container, ref, render, inputStyle, finishVoiceRecording };
}

describe.each(['light', 'dark'] as const)('new-session dictation input (%s)', (mode) => {
  it('hides Android native drawing while keeping streamed drafts and the same mounted input', () => {
    native.platform = 'android';
    native.mode = mode;
    const input = mountInput();
    input.render(false, 'before suffix');
    const original = input.ref.current;
    expect(original).not.toBeNull();
    expect(input.inputStyle().opacity ?? 1).toBe(1);
    expect(input.inputStyle().color).toBe(palettes[mode].textPrimary);

    for (const draft of ['before hello suffix', 'before hello\nworld suffix']) {
      input.render(true, draft);
      expect(input.ref.current).toBe(original);
      expect(original?.value).toBe(draft);
      expect(input.inputStyle().opacity).toBe(0);
      expect(input.inputStyle().display).not.toBe('none');
      expect(native.props.caretHidden).toBe(true);
      expect(native.props.placeholder).toBe('');
      expect(input.container.querySelector('[data-testid="preview"]')?.textContent).toBe(draft);
    }
    act(() => original!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(input.finishVoiceRecording).toHaveBeenCalledOnce();

    input.render(false, 'before hello\nworld suffix');
    expect(input.ref.current).toBe(original);
    expect(original?.value).toBe('before hello\nworld suffix');
    expect(input.inputStyle().opacity ?? 1).toBe(1);
    expect(input.inputStyle().color).toBe(palettes[mode].textPrimary);
    expect(native.props.caretHidden).toBe(false);
    expect(input.container.querySelector('[data-testid="preview"]')).toBeNull();
    act(() => original!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(input.finishVoiceRecording).toHaveBeenCalledOnce();
  });

  it('retains transparent text on iOS without hiding the view from native hit testing', () => {
    native.platform = 'ios';
    native.mode = mode;
    const input = mountInput();
    input.render(true, 'dictation');
    expect(input.inputStyle().color).toBe('transparent');
    expect(input.inputStyle().opacity ?? 1).toBe(1);
    input.render(false, 'dictation');
    expect(input.inputStyle().color).toBe(palettes[mode].textPrimary);
  });
});
