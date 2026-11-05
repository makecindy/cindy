import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { BotGroupTimelineItem } from '../../../src/renderer/features/bots/BotGroupTimelineItem';
import picture from '../../../src/renderer/assets/cindy-share-character.jpg';

function Example({ readOnly }: { readOnly: boolean }) {
  const [sent, setSent] = useState('');
  const nodes = [
    { id: 'heading', kind: 'heading', props: { text: '周末活动安排' } },
    { id: 'chart', kind: 'chart', props: { label: '活动时间（小时）', variant: 'bar', data: [{ label: '展览', value: 2 }, { label: '散步', value: 1 }, { label: '晚餐', value: 1.5 }] } },
    { id: 'svg', kind: 'svg', props: { label: '路线示意', viewBox: [0, 0, 240, 48], shapes: [
      { type: 'line', x1: 20, y1: 24, x2: 220, y2: 24, stroke: 'secondary', strokeWidth: 2 },
      ...[20, 120, 220].map(cx => ({ type: 'circle', cx, cy: 24, r: 7, fill: 'primary' })),
    ] } },
    { id: 'image', kind: 'image', props: { src: new URL(picture, location.href).href, alt: '活动插图', style: { maxHeight: 160 } } },
    { id: 'people', kind: 'input', props: { label: '同行人数', default: '2' } },
    { id: 'send', kind: 'button', props: { label: '确认活动安排', send: { op: 'concat', args: ['请为 ', { ref: 'people' }, ' 人安排周末活动。'] } } },
  ];
  const content = '把时间留给真正想做的事。\n\n```cindy-ui\n' + nodes.map((node, i) => JSON.stringify({ version: 1, seq: i + 1, op: 'create', ...node })).join('\n') + '\n```';
  return <main style={{ padding: 16, width: '100%', maxWidth: 800, margin: '0 auto' }}>
    <BotGroupTimelineItem message={{ id: 'answer', sequence: 1, kind: 'message', authorKind: 'bot', authorBotId: 'aster', authorName: 'Aster', content,
      mentions: { all: false, botIds: [] }, noticeCode: null, planId: null, files: [], attachments: [], createdAt: 1700000000000 }}
      continued={false} authorName="Aster" avatar={{ name: 'Aster', avatar: null, avatarColor: null }} members={[]}
      mentionLabels={[]} locale="zh-CN" shareScope="group-rich-answer" sharing={false} showActions={false} onChanged={() => {}}
      readOnly={readOnly} onRichSend={async text => { setSent(text); return true; }} />
    <div data-testid="sent-answer">{sent}</div>
  </main>;
}
mountPage({ render: ctx => <Example readOnly={ctx.case === 'readonly'} /> });
