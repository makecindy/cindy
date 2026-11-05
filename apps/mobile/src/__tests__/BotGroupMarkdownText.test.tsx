// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { palettes, type ThemeMode } from '@/theme/tokens';

const theme = vi.hoisted(() => ({ mode: 'light' as 'light' | 'dark' }));

const actions = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => undefined), copy: vi.fn(async (_text: string) => undefined) }));

// 把 style 展平进 data-style,断言每个 Text 实际叠了哪些样式。
vi.mock('react-native', async () => {
  const React = await import('react');
  const flat = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
  const host = (tag: string) => ({ children, style, horizontal, onLayout, testID, selectable, onPress, onTouchStart, accessibilityRole }: any) => {
    React.useEffect(() => { onLayout?.({ nativeEvent: { layout: { width: 280 } } }); }, [onLayout]);
    return React.createElement(tag, { 'data-style': JSON.stringify(flat(style)),
      'data-horizontal': horizontal, 'data-testid': testID, 'data-selectable': selectable, 'data-role': accessibilityRole, onClick: onPress, onTouchStart }, children);
  };
  return {
    View: host('div'),
    ScrollView: host('section'),
    Text: host('span'),
    Pressable: host('button'),
    ActivityIndicator: () => null,
    Linking: { openURL: actions.open },
    useWindowDimensions: () => ({ width: 360, height: 800, fontScale: 1, scale: 3 }),
    StyleSheet: { create: (s: any) => s, flatten: flat, hairlineWidth: 1 },
    Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
  };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text, MAX_FONT_SIZE_MULTIPLIER: 1.5 }));
vi.mock('react-native-uitextview', async () => {
  const React = await import('react');
  const { StyleSheet } = await import('react-native');
  return { UITextView: ({ children, uiTextView, selectable, style, onPress, onTouchStart, accessibilityRole }: any) => React.createElement('span', {
    'data-uitextview': uiTextView ? 'root' : 'span', 'data-selectable': selectable,
    'data-style': JSON.stringify(StyleSheet.flatten(style) ?? {}), 'data-role': accessibilityRole, onClick: onPress, onTouchStart,
  }, children) };
});
vi.mock('@/session/SelectionMenuText', async () => ({ SelectionMenuText: (await import('react-native')).Text }));
vi.mock('@/session/ShareMessageCheckbox', () => ({ useCancelShareSelectionRowTap: () => null }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/theme', async () => ({
  ...await import('@/theme/tokens'), monoFont: 'Menlo',
  useThemedStyles: (make: (colors: any) => any) => make(palettes[theme.mode]),
  useTheme: () => ({ colors: palettes[theme.mode], mode: theme.mode }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({ Copy: () => null, Check: () => null, CircleAlert: () => null }));
vi.mock('@/session/messageActions', () => ({ writeClipboardText: actions.copy }));
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: 'mock-cache' } }));
vi.mock('react-native-webview', async () => {
  const React = await import('react');
  return { WebView: React.forwardRef(({ source, ...props }: any, ref) => {
    React.useImperativeHandle(ref, () => ({ injectJavaScript() {} }));
    return React.createElement('div', { 'data-webview': source?.html?.includes('katex') ? 'math' : 'mermaid', 'data-testid': props.testID });
  }) };
});

import { BotGroupMarkdownText, BotGroupUserText } from '@/session/BotGroupMessageText';

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  theme.mode = 'light';
  actions.open.mockClear();
  actions.copy.mockClear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});

// Unit / A04：补齐完整群正文的链接覆盖；HTTP(S) 可打开，本机及任务链接保持不可操作。
it('opens HTTP(S) links in rich group bodies while local and task links stay inert', async () => {
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    richContent: true,
    content: '[网页](https://example.com/a) http://example.com/b [文件](/private/report.md) [任务](cindy://session/private)',
  })));
  for (const label of ['网页', 'http://example.com/b']) {
    const span = [...node.querySelectorAll('span')].filter(el => el.textContent === label).at(-1)!;
    await act(async () => span.click());
    expect(styleOf(label).textDecorationLine).toBe('underline');
  }
  expect(actions.open.mock.calls.map(call => call[0])).toEqual(['https://example.com/a', 'http://example.com/b']);
  for (const label of ['文件', '任务']) {
    const span = [...node.querySelectorAll('span')].filter(el => el.textContent === label).at(-1)!;
    await act(async () => span.click());
    expect(styleOf(label).textDecorationLine).toBeUndefined();
  }
  expect(actions.open).toHaveBeenCalledTimes(2);
});

// Unit / A04：复制不含围栏、图表传递原文、公式挂载现有 WebView；原生宿主用 fake 替代。
it('reuses code coloring and block copy, diagram opening and formula rendering in complete group bodies', async () => {
  const openDiagram = vi.fn();
  const code = 'const answer = 42;';
  const diagram = 'flowchart LR\nA --> B';
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    richContent: true, onOpenDiagram: openDiagram,
    content: '```typescript\n' + code + '\n```\n\n```mermaid\n' + diagram + '\n```\n\n$$\n\\frac{1}{2}\n$$\n\n$x^2$',
  })));
  expect(styleOf('const').color).toBe(palettes.light.syntaxKeyword);
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="message.markdownCodeCopyButton"]')!.click());
  expect(actions.copy).toHaveBeenCalledWith(code);
  expect(node.querySelector('[data-testid="botGroup.mermaidDiagram"]')).not.toBeNull();
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="botGroup.openDiagram"]')!.click());
  expect(openDiagram).toHaveBeenCalledWith(diagram);
  expect(node.querySelector('[data-testid="botGroup.mathFormula"]')).not.toBeNull();
  expect(node.textContent).toContain('x²');
});

it('keeps group image selection free of link, code-copy and diagram actions', async () => {
  const openDiagram = vi.fn();
  await act(async () => root.render(createElement(BotGroupMarkdownText, {
    richContent: true, interactive: false, onOpenDiagram: openDiagram,
    content: '[网页](https://example.com)\n\n```js\nconst a = 1;\n```\n\n```mermaid\ngraph LR\nA --> B\n```',
  })));
  await act(async () => [...node.querySelectorAll('span')].filter(el => el.textContent === '网页').at(-1)!.click());
  expect(actions.open).not.toHaveBeenCalled();
  expect(node.querySelector('[data-testid="message.markdownCodeCopyButton"]')).toBeNull();
  expect(node.querySelector('[data-testid="botGroup.openDiagram"]')).toBeNull();
  expect(styleOf('const').color).toBe(palettes.light.syntaxKeyword);
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

// A01 / unit: production sent body must resolve ids before exposing a touch action.
// Existing selection tests cover carriers only. Minimal failure: @Ann with one
// explicit id; namesakes, broadcasts and email/code must never open the wrong person.
it.each([['ios', 'light'], ['ios', 'dark'], ['android', 'light'], ['android', 'dark']])('keeps PC mention styling, identity and text boundaries on %s / %s', async (platform, mode) => {
  theme.mode = mode as ThemeMode;
  const { Platform } = await import('react-native');
  Platform.OS = platform as typeof Platform.OS;
  const member = (botId: string, name: string) => ({ botId, name, avatar: '', avatarColor: '', status: 'active' as const });
  const ann = member('ann-1', 'Ann');
  const other = member('ann-2', 'Ann');
  const reserved = member('all', '所有人');
  const onPress = vi.fn();
  const context = { members: [ann, other, reserved], mentions: { all: false, botIds: ['ann-1'] },
    serverBacked: false, allLabels: ['所有人'], allBotsLabels: ['所有伙伴'], labels: ['Ann', '所有人', '所有伙伴'], onPress };
  const renderBody = async (content: string, changes = {}) => {
    const nextContext = { ...context, ...changes };
    await act(async () => root.render(createElement(BotGroupUserText, {
      content, mentionLabels: nextContext.labels, mentionContext: nextContext,
    })));
  };
  const links = () => [...node.querySelectorAll('span')].filter(span => span.getAttribute('data-role') === 'link');
  try {
    await renderBody('@Ann mail@Ann.test @Anna @Unknown 正文');
    expect(links().map(span => span.textContent)).toEqual(['@Ann']);
    const mentionStyle = JSON.parse(links()[0]!.getAttribute('data-style')!);
    expect(mentionStyle).toMatchObject({ color: palettes[theme.mode].groupMentionText });
    expect(mentionStyle.textDecorationLine).toBeUndefined();
    expect(mentionStyle.fontWeight).toBeUndefined();
    expect(mentionStyle.backgroundColor).toBeUndefined();
    const touch = new Event('touchstart', { bubbles: true });
    Object.defineProperties(touch, { pageX: { value: 108 }, pageY: { value: 246 } });
    await act(async () => { links()[0]!.dispatchEvent(touch); links()[0]!.click(); });
    expect(onPress).toHaveBeenLastCalledWith(ann, { x: 108, y: 246 });
    expect(node.textContent).toBe('@Ann mail@Ann.test @Anna @Unknown 正文');
    await renderBody('@Ann', { mentions: { all: false, botIds: ['ann-1', 'ann-2'] } });
    expect(links()).toHaveLength(0);
    await renderBody('@Ann', { serverBacked: true, mentions: { all: false, botIds: [] } });
    expect(links()).toHaveLength(0); // Server fallback still refuses namesakes.
    await renderBody('@Ann', { members: [ann], serverBacked: true, mentions: { all: false, botIds: [] } });
    expect(links()).toHaveLength(1);
    await renderBody('@Ann', { members: [] });
    expect(links()).toHaveLength(0); // Departed/unknown target.
    await renderBody('@所有人 @所有伙伴', { mentions: { all: true, allBots: true, botIds: [] } });
    expect(links()).toHaveLength(0);
    const broadcasts = [...node.querySelectorAll('span')].filter(span => ['@所有人', '@所有伙伴'].includes(span.textContent ?? ''));
    expect(broadcasts).toHaveLength(2);
    for (const span of broadcasts) expect(JSON.parse(span.getAttribute('data-style')!)).toMatchObject({ color: palettes[theme.mode].groupMentionText });
    await renderBody('@所有人', { mentions: { all: false, botIds: ['all'] } });
    expect(links()).toHaveLength(1); // Explicitly picked namesake is a person, as on PC.
    // Localized teammate broadcast with a colliding member name (PR #8818).
    const spanish = { members: [member('todos', 'Todos los compañeros')], allBotsLabels: ['Todos los compañeros'],
      labels: ['Todos los compañeros'], mentions: { all: false, allBots: true, botIds: ['todos'] } };
    await renderBody('@Todos los compañeros', spanish);
    expect(links()).toHaveLength(0);
    await renderBody('@Todos los compañeros', { ...spanish, mentions: { all: false, botIds: ['todos'] } });
    expect(links()).toHaveLength(1); // Without broadcast intent the explicit person remains clickable.
    await act(async () => root.render(createElement(BotGroupMarkdownText, {
      content: '**@Ann** `@Ann` [website](https://example.test)\n\n~~~text\n@Ann\n~~~', mentionContext: context,
    })));
    expect(links().map(span => span.textContent)).toEqual(['@Ann']);
    expect(JSON.parse(links()[0]!.getAttribute('data-style')!)).toMatchObject({ fontWeight: '600', color: palettes[theme.mode].groupMentionText });
    expect(styleOf('website').textDecorationLine).toBeUndefined();
  } finally { Platform.OS = 'ios'; }
});

// PR #8818 / component: per-inline matching mistook **@Ann**a for Ann.
// Existing carrier/identity tests do not cross formatting boundaries. Check the
// rendered word through the production body, including a valid split mention.
it.each(['ios', 'android'])('matches complete rendered words across formatting on %s', async platform => {
  const { Platform } = await import('react-native');
  Platform.OS = platform as typeof Platform.OS;
  const ann = { botId: 'ann', name: 'Ann', avatar: '', avatarColor: '', status: 'active' as const };
  const context = { members: [ann], mentions: { all: false, botIds: [] }, serverBacked: true,
    allLabels: ['所有人'], allBotsLabels: ['所有伙伴'], labels: ['Ann'], onPress: vi.fn() };
  try {
    await act(async () => root.render(createElement(BotGroupMarkdownText, {
      richContent: true,
      content: '**@Ann**a mail**@Ann**.test @**Ann** [网页](https://example.com)', mentionContext: context,
    })));
    expect(node.textContent).toBe('@Anna mail@Ann.test @Ann 网页');
    const links = [...node.querySelectorAll('[data-role="link"]')];
    expect(links.map(span => span.textContent)).toEqual(['@', 'Ann']);
    const highlighted = [...node.querySelectorAll('[data-style]')].filter(span =>
      JSON.parse(span.getAttribute('data-style')!).color === palettes.light.groupMentionText);
    expect(highlighted.map(span => span.textContent)).toEqual(['@', 'Ann']);
    expect(styleOf('网页').textDecorationLine).toBe('underline');
    await act(async () => [...node.querySelectorAll('span')].find(span => span.textContent === '网页')!.click());
    expect(actions.open).toHaveBeenCalledWith('https://example.com');
  } finally { Platform.OS = 'ios'; }
});
