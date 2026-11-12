import type { UiMockTask } from './uiMock';

/** Synthetic mixed-script text for layout, editing and copy regression checks. */
export const UI_MOCK_BIDI_TEXT = [
  'سلام، فایل index.html با API 123 آماده است.',
  'English paragraph: API 123 and https://example.com/docs.',
  'مرحبا، الإصدار API 123 جاهز.',
  'שלום, הקובץ index.html מוכן.',
  '中文段落：文件 index.html，版本 123。',
].join('\n');

export const UI_MOCK_BIDI_ORCA_MESSAGES = (['lead', 'worker'] as const).map((orcaSource) => ({
  role: 'user' as const,
  text: JSON.stringify({ orcaSource, content: UI_MOCK_BIDI_TEXT }),
}));

export const UI_MOCK_BIDI_MARKDOWN = [
  '# سلام، گزارش API 123',
  '',
  UI_MOCK_BIDI_TEXT.split('\n').join('\n\n'),
  '',
  '- سلام، مورد اول API 123.',
  '- English list item 456.',
  '',
  '> مرحبا، هذا اقتباس API 123.',
  '>',
  '> English quote 456.',
  '',
  '| فارسی | English |',
  '| --- | --- |',
  '| سلام API 123. | Value 456. |',
  '',
  'سلام، مسیر `C:\\demo\\index.html` و [راهنما](https://example.com/docs).',
  '',
  '```js',
  'const greeting = "سلام";',
  'console.log(greeting, 123);',
  '```',
].join('\n');

const richSource = [
  { id: 'heading', kind: 'heading', props: { text: 'سلام، گزارش API 123' } },
  { id: 'text', kind: 'text', props: { text: UI_MOCK_BIDI_TEXT } },
  { id: 'captioned-markdown', kind: 'markdown', props: { text: 'Captioned content.', caption: 'سلام، توضیح API 123.' } },
  { id: 'centered-markdown', kind: 'markdown', props: { text: '# Centered\n\nEnglish paragraph', caption: 'مرحبا، وصف API 123.', style: { textAlign: 'center' } } },
  { id: 'aligned-group', kind: 'stack', props: { style: { textAlign: 'right' } } },
  { id: 'inherited-heading', parent: 'aligned-group', kind: 'heading', props: { text: 'Container-aligned heading' } },
  { id: 'inherited-text', parent: 'aligned-group', kind: 'text', props: { text: 'Container-aligned English text.' } },
  { id: 'inherited-markdown', parent: 'aligned-group', kind: 'markdown', props: { text: 'Container-aligned Markdown.', caption: 'Container-aligned caption.' } },
].map((node, i) => JSON.stringify({ version: 1, seq: i + 1, op: 'create', ...node })).join('\n');

export const UI_MOCK_BIDI_TASK: UiMockTask = {
  id: 'ui-mock-bidi', title: 'BiDi — فارسی / العربية / עברית', project: 'cindy-demo',
  agentKind: 'codex', model: 'mock-model', effort: 'high', status: 'active',
  source: 'desktop', minutesAgo: 1,
  messages: [
    { role: 'user', text: UI_MOCK_BIDI_TEXT },
    { role: 'assistant', text: UI_MOCK_BIDI_MARKDOWN },
    { role: 'assistant', text: `\`\`\`cindy-ui\n${richSource}\n\`\`\`` },
    ...UI_MOCK_BIDI_ORCA_MESSAGES,
  ],
};
