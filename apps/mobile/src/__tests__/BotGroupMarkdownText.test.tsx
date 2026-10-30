// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 把 style 展平进 data-style,断言每个 Text 实际叠了哪些样式。
vi.mock('react-native', async () => {
  const React = await import('react');
  const flat = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
  const host = (tag: string) => ({ children, style, horizontal, onLayout, testID, selectable }: any) => {
    React.useEffect(() => { onLayout?.({ nativeEvent: { layout: { width: 280 } } }); }, [onLayout]);
    return React.createElement(tag, { 'data-style': JSON.stringify(flat(style)),
      'data-horizontal': horizontal, 'data-testid': testID, 'data-selectable': selectable }, children);
  };
  return {
    View: host('div'),
    ScrollView: host('section'),
    Text: host('span'),
    useWindowDimensions: () => ({ width: 360, height: 800, fontScale: 1, scale: 3 }),
    StyleSheet: { create: (s: any) => s, flatten: flat, hairlineWidth: 1 },
    Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
  };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text, MAX_FONT_SIZE_MULTIPLIER: 1.5 }));
vi.mock('react-native-uitextview', async () => {
  const React = await import('react');
  const { StyleSheet } = await import('react-native');
  return { UITextView: ({ children, uiTextView, selectable, style }: any) => React.createElement('span', {
    'data-uitextview': uiTextView ? 'root' : 'span', 'data-selectable': selectable,
    'data-style': JSON.stringify(StyleSheet.flatten(style) ?? {}),
  }, children) };
});
vi.mock('@/session/SelectionMenuText', async () => ({ SelectionMenuText: (await import('react-native')).Text }));
vi.mock('@/session/ShareMessageCheckbox', () => ({ useCancelShareSelectionRowTap: () => null }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/theme', () => ({
  fontWeight: { regular: '400', medium: '500', semibold: '600', bold: '700' },
  monoFont: 'Menlo',
  useThemedStyles: (make: (colors: any) => any) => make(new Proxy({}, { get: () => '#000' })),
}));

import { BotGroupMarkdownText, BotGroupUserText } from '@/session/BotGroupMessageText';

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});

// #6713: real group body previously flattened tables into one Text. DOM hosts do not
// measure RN layout; verify the rendered row/cell geometry here, then test native scrolling in Simulator.
it('keeps table columns aligned across short, long and empty cells, with horizontal overflow', async () => {
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    content: '| 项目 | 说明 | 状态 |\n| --- | --- | --- |\n| A | **很长的说明内容需要在所属单元格内换行，不能串到下一列** | 完成 |\n| B | | 进行中 |',
  })));
  const scroll = node.querySelector('section[data-horizontal="true"]');
  expect(scroll).not.toBeNull();
  const rows = [...scroll!.firstElementChild!.children];
  expect(rows).toHaveLength(3);
  const widths = rows.map(row => [...row.children].map(cell => JSON.parse(cell.getAttribute('data-style')!).width));
  expect(widths[0]).toHaveLength(3);
  expect(widths[1]).toEqual(widths[0]);
  expect(widths[2]).toEqual(widths[0]);
  expect(widths[0].reduce((a, b) => a + b, 0)).toBeGreaterThan(280);
  expect([...rows[2].children].map(cell => cell.textContent)).toEqual(['B', '', '进行中']);
  expect(styleOf('很长的说明内容需要在所属单元格内换行，不能串到下一列').fontWeight).toBe('600');
  expect(node.textContent).not.toContain(' | ');
});

it('expands a short table to the measured message width without changing code blocks', async () => {
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    content: '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n~~~text\na | b\n~~~',
  })));
  const row = node.querySelector('section')!.firstElementChild!.firstElementChild!;
  const widths = [...row.children].map(cell => JSON.parse(cell.getAttribute('data-style')!).width);
  expect(widths.reduce((a, b) => a + b, 0)).toBe(280);
  expect(styleOf('a | b').fontFamily).toBe('Menlo');
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});

const styleOf = (text: string): Record<string, unknown> => {
  // 取最内层的匹配(强调外层 Text 与内层代码 Text 文本相同)。
  const span = [...node.querySelectorAll('span')].filter((el) => el.textContent === text).at(-1);
  expect(span, `未找到文本 ${text}`).toBeDefined();
  return JSON.parse(span!.getAttribute('data-style')!);
};

it('群聊不打开链接:段落和表格链接不加下划线,强调样式仍保留', async () => {
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    content: '**https://a.example/x** ~~https://b.example/y~~ **`a.ts`** [段落链接](https://c.example)\n\n| 链接 | 地址 |\n| --- | --- |\n| [表格链接](https://d.example) | https://e.example |',
  })));
  expect(styleOf('https://a.example/x')).toMatchObject({ fontWeight: '600' });
  expect(styleOf('https://a.example/x').textDecorationLine).toBeUndefined();
  expect(styleOf('https://b.example/y').textDecorationLine).toBe('line-through');
  // 强调里的行内代码照常套代码样式。
  expect(styleOf('a.ts')).toMatchObject({ fontFamily: 'Menlo' });
  for (const label of ['段落链接', '表格链接', 'https://e.example']) {
    expect(styleOf(label).textDecorationLine).toBeUndefined();
  }
});

// #6550: real group-body renderer must not reinterpret literal component text as markup.
it('keeps component literal punctuation and Markdown formatting distinct', async () => {
  const content = '```cindy-ui\n' + [
    { seq: 1, version: 1, op: 'create', id: 'literal', kind: 'text', props: { text: '<name> *literal* & \n    indented' } },
    { seq: 2, op: 'create', id: 'md', kind: 'markdown', props: { text: '**authored bold**' } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n```';
  await act(async () => root.render(createElement(BotGroupMarkdownText, { content, authorKind: 'bot' })));
  expect(node.textContent).toContain('<name> *literal* & \n    indented');
  expect(styleOf('authored bold')).toMatchObject({ fontWeight: '600' });
  expect(node.textContent).not.toContain('"op":"create"');
});

// #7492: media src filtering removed the only visible access path for public URLs.
it('keeps public component media URLs readable without exposing internal sources', async () => {
  const sources = ['https://example.test/image.png', 'https://example.test/video.mp4', 'https://example.test/audio.mp3'];
  const content = '```cindy-ui\n' + [
    ...sources.map((src, i) => ({ seq: i + 1, version: 1, op: 'create', id: `public${i}`, kind: ['image', 'video', 'audio'][i], props: { src } })),
    { seq: 4, op: 'create', id: 'local', kind: 'image', props: { src: 'cindy-media://blobs/private.png', alt: 'Local description' } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n```';
  await act(async () => root.render(createElement(BotGroupMarkdownText, { content, authorKind: 'bot' })));
  for (const src of sources) expect(node.textContent).toContain(src);
  expect(node.textContent).toContain('Local description');
  expect(node.textContent).not.toContain('cindy-media://');
});

// #6716 review: group images render as alt text, not 150px native previews.
it.each([['x', ''], ['a long image description that wraps inside its column', 'y']])(
  'measures image cells like their visible fallback text (%s / %s)', async (alt, otherAlt) => {
    const renderTable = async (first: string, second: string) => {
      await act(async () => root.render(createElement(BotGroupMarkdownText, {
        content: `| ${first} | ${second} |\n| --- | --- |\n| ${second} | ${first} |`, authorKind: 'bot',
      })));
      const row = node.querySelector('section')!.firstElementChild!.firstElementChild!;
      return [...row.children].map(cell => JSON.parse(cell.getAttribute('data-style')!).width);
    };
    const imageWidths = await renderTable(`![${alt}](https://example.com/a.png)`, `![${otherAlt}](https://example.com/b.png)`);
    expect(node.textContent).toBe([alt, otherAlt, otherAlt, alt].map(text => text ? `[${text}]` : '').join(''));
    const textWidths = await renderTable(alt ? `[${alt}]` : '', otherAlt ? `[${otherAlt}]` : '');
    expect(imageWidths).toEqual(textWidths);
    if (!otherAlt) expect(imageWidths.reduce((a, b) => a + b, 0)).toBe(280);
  },
);

// Regression: iOS RN Text selectable offers only whole-block Copy. Exercise the
// production body with native-carrier fakes; real selection handles need Simulator.
// Existing layout tests did not cover the UITextView root/child native contract.
it.each(['ios', 'android'])('uses system partial-selection text for formatted group bodies and own mentions on %s', async (platform) => {
  const { Platform } = await import('react-native');
  Platform.OS = platform as typeof Platform.OS;
  try {
    await act(async () => root.render(createElement('div', null,
      createElement(BotGroupMarkdownText, { content: 'Select **part** of this paragraph.\n\n> quote\n\n- item\n\n~~~text\ncode\n~~~\n\n| Cell | Other |\n| --- | --- |\n| value | next |' }),
      createElement(BotGroupUserText, { content: '@Cindy keep my words', mentionLabels: ['Cindy'] }),
    )));
    const roots = [...node.querySelectorAll('[data-selectable="true"]')];
    expect(roots.map(el => el.textContent)).toEqual([
      'Select part of this paragraph.', 'quote', 'item', 'code', 'Cell', 'Other', 'value', 'next', '@Cindy keep my words',
    ]);
    for (const text of roots) {
      if (platform === 'ios') {
        expect(text.getAttribute('data-uitextview')).toBe('root');
        // Mixing RN Text descendants into a UITextView breaks styled selection.
        expect(text.querySelector('span:not([data-uitextview="span"])')).toBeNull();
      } else {
        expect(text.hasAttribute('data-uitextview')).toBe(false);
        expect(text.querySelector('[data-uitextview]')).toBeNull();
      }
    }
    expect(styleOf('part').fontWeight).toBe('600');
  } finally {
    Platform.OS = 'ios';
  }
});
