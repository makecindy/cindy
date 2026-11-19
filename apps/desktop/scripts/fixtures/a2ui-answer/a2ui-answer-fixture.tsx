import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import { SessionQuickSendProvider } from '../../../src/renderer/components/chat/SessionQuickSendContext';

// UI regression fixture, not a tutor conversation or book excerpt. No model runs.
const source = '这是一条界面回归测试消息。\n\n```a2ui\n' + JSON.stringify({
  version: '1.0', createSurface: {
    surfaceId: 'ui-check', catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
    components: [
      { id: 'root', component: 'Column', children: ['title', 'paragraphs', 'answer', 'submit'] },
      { id: 'title', component: 'Text', text: '## 精读 · 段落与作答', variant: 'body' },
      { id: 'paragraphs', component: 'Tabs', tabs: [{ title: '第 1 段', child: 'first' }, { title: '第 2 段', child: 'second' }] },
      { id: 'first', component: 'Text', text: '段落一：这里验证段落切换。此处是测试文字，不是教材原文。' },
      { id: 'second', component: 'Text', text: '段落二：输入主旨后，先核对按钮上方的发送内容，再点击提交。' },
      { id: 'answer', component: 'TextField', label: '中文主旨', variant: 'longText', value: { '@path': '/draft/answer' } },
      { id: 'submit', component: 'Button', child: 'label', action: { event: { name: 'cindy.sendMessage', userMessage: '请反馈我的主旨', context: { answer: { '@path': '/draft/answer' } } } } },
      { id: 'label', component: 'Text', text: '提交主旨' },
    ], dataModel: { draft: { answer: '' } },
  },
}) + '\n```\n\n普通 Markdown 继续显示。\n\n```cindy-ui\n' + JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'compat', kind: 'text', props: { text: '现有 cindy-ui 继续显示。' } }) + '\n```';

function Example({ readOnly, invalid, nested }: { readOnly: boolean; invalid: boolean; nested: boolean }) {
  const [received, setReceived] = useState('');
  const content = nested ? source.replace(/```a2ui[\s\S]*?```/, block => '- 格式示例\n\n' + block.split('\n').map(line => `  ${line}`).join('\n'))
    : invalid ? source.replace('"version":"1.0"', '"version":"9.9"') : source;
  return <main style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
    <SessionQuickSendProvider value={readOnly ? null : { send: async text => { setReceived(text); return true; } }}>
      <MarkdownRenderer content={content} workingDir="." currentSessionId="a2ui-ui-test" streamFadeKey="a2ui-ui-message" renderRichAnswers />
    </SessionQuickSendProvider>
    <p>测试接收文本（未调用模型）</p>
    <pre data-testid="received" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{received}</pre>
  </main>;
}
mountPage({ render: ctx => <Example readOnly={ctx.case === 'readonly'} invalid={ctx.case === 'invalid'} nested={ctx.case === 'nested'} /> });
