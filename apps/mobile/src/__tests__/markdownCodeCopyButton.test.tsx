// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 测试价值：真实组件入口应复制完整代码并展示成功、失败和重试状态；旧移动端
// 只有长按选择，缺少整块复制入口。相邻 messageActions 纯逻辑测试无法覆盖组件
// 生命周期，因此这里用独立 jsdom 夹具验证最小代码块及列表复用时的文本切换。
// PR #8098 review：仅图标后，null 图标 mock 会漏掉状态图标缺失或显示错误。
// 在已有 unit 用例中让各图标输出无文字标记，验证非空代码的默认/加载/成功/失败反馈。
const h = vi.hoisted(() => ({ write: vi.fn() }));

vi.mock('react-native', () => ({
  ActivityIndicator: () => <span data-copy-icon="loading" />,
  Pressable: ({ children, accessibilityLabel, accessibilityState, disabled, onPress, testID }: any) => (
    <button
      aria-busy={accessibilityState?.busy}
      aria-disabled={accessibilityState?.disabled}
      aria-label={accessibilityLabel}
      data-testid={testID}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({
  Check: () => <svg data-copy-icon="check" />,
  CircleAlert: () => <svg data-copy-icon="error" />,
  Copy: () => <svg data-copy-icon="copy" />,
}));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => <span>{children}</span> }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return {
    ...tokens,
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: any) => make(tokens.lightColors),
  };
});
vi.mock('@/session/messageActions', () => ({ writeClipboardText: h.write }));

import { MarkdownCodeCopyButton } from '@/session/MarkdownCodeCopyButton';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;

async function render(text: string) {
  await act(async () => root.render(createElement(MarkdownCodeCopyButton, { text })));
}

function button(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="message.markdownCodeCopyButton"]')!;
}

function expectIcon(name: string) {
  expect(Array.from(button().querySelectorAll('[data-copy-icon]'), (icon) =>
    icon.getAttribute('data-copy-icon'))).toEqual([name]);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.write.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it('copies the complete code once while pending, shows success, then restores the action', async () => {
  const code = 'const answer = 42;\n\n  console.log(answer);';
  let finish!: () => void;
  h.write.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await render(code);

  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyCode');
  expect(button().textContent).toBe('');
  expectIcon('copy');
  await act(async () => button().click());
  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyStateCopying');
  expectIcon('loading');
  await act(async () => button().click());
  expect(h.write).toHaveBeenCalledExactlyOnceWith(code);

  await act(async () => { finish(); await Promise.resolve(); });
  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyStateCopied');
  expect(button().textContent).toBe('');
  expectIcon('check');

  await act(async () => { vi.advanceTimersByTime(1500); });
  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyCode');
  expectIcon('copy');
});

it('reports a failed write and allows copying again after the feedback resets', async () => {
  h.write.mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined);
  await render('line 1\nline 2');

  await act(async () => button().click());
  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyStateFailed');
  expect(button().textContent).toBe('');
  expectIcon('error');

  await act(async () => { vi.advanceTimersByTime(1500); });
  await act(async () => button().click());
  expect(h.write).toHaveBeenCalledTimes(2);
  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyStateCopied');
});

it('resets for a recycled code block and ignores a late result from its previous text', async () => {
  let finishFirst!: () => void;
  h.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
  h.write.mockResolvedValueOnce(undefined);
  await render('old code');
  await act(async () => button().click());

  await render('new code');
  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyCode');
  await act(async () => { finishFirst(); await Promise.resolve(); });
  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyCode');

  await act(async () => button().click());
  expect(h.write.mock.calls).toEqual([['old code'], ['new code']]);
  expect(button().getAttribute('aria-label')).toBe('message.renderer.copyStateCopied');
});
