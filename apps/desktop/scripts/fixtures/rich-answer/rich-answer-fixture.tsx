import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { RichAnswer } from '../../../src/renderer/components/chat/RichAnswer';
import { SessionQuickSendProvider } from '../../../src/renderer/components/chat/SessionQuickSendContext';

const source = [
  { id: 'title', kind: 'heading', props: { text: '周末去哪儿' } },
  { id: 'where', kind: 'select', props: { label: '目的地', default: '公园', options: [{ label: '公园', value: '公园' }, { label: '博物馆', value: '博物馆' }] } },
  { id: 'note', kind: 'input', props: { label: '补充要求', default: '慢慢逛，不赶时间' } },
  { id: 'send', kind: 'button', props: { label: '请帮我安排', send: { op: 'concat', args: ['请安排周末去', { ref: 'where' }, '。', { ref: 'note' }] } } },
].map((node, i) => JSON.stringify({ version: 1, seq: i + 1, op: 'create', ...node })).join('\n');
function Example({ readOnly }: { readOnly: boolean }) {
  const [messages, setMessages] = useState<string[]>([]);
  return <main style={{ padding: 16, maxWidth: 560, margin: '0 auto' }}>
    <SessionQuickSendProvider value={readOnly ? null : { send: async text => { setMessages(current => [...current, text]); return true; } }}>
      <RichAnswer source={source} complete stateKey={readOnly ? 'readonly-fixture' : 'fixture'} renderMarkdown={text => <p>{text}</p>} />
    </SessionQuickSendProvider>
    <div data-testid="sent-messages">{messages.map((text, i) => <p key={i}>{text}</p>)}</div>
  </main>;
}
mountPage({ render: ctx => <Example readOnly={ctx.case === 'readonly'} /> });
