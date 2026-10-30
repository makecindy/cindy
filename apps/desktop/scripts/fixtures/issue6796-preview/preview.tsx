import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { ChatImageView } from '../../../src/renderer/components/chat/ChatImageView';
import { BotGroupMessageAttachments } from '../../../src/renderer/features/bots/BotGroupMessageAttachments';

function sample(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#f7f7f5';
  c.fillRect(0, 0, width, height);
  c.fillStyle = '#222222';
  c.font = 'bold 56px sans-serif';
  c.fillText('SYNTHETIC IMAGE', 48, 80);
  c.font = '48px sans-serif';
  c.fillText(`${width} × ${height}`, 48, 160);
  for (let y = 220, i = 1; y < height - 180; y += 280, i++) {
    c.fillStyle = '#ffffff';
    c.fillRect(32, y, width - 64, 250);
    c.fillStyle = '#222222';
    c.font = 'bold 56px sans-serif';
    c.fillText(`Section ${i}`, 64, y + 70);
    c.font = '48px sans-serif';
    c.fillText('A sample paragraph.', 64, y + 140);
    c.fillText('No private data.', 64, y + 210);
  }
  c.fillStyle = '#222222';
  c.font = 'bold 48px sans-serif';
  c.fillText('END OF ORIGINAL', 48, height - 35);
  return canvas.toDataURL('image/png');
}
const long = sample(1080, 6000);
const portrait = sample(1080, 2400);
const text =
  '请帮我检查这张页面长截图中的排版：标题、正文和各段之间的间距是否协调？这段文字仅用于复现图文气泡的宽度，图片也是专门生成的无隐私样例。';
function Replacement() {
  const [changed, setChanged] = useState(false);
  return (
    <>
      <button onClick={() => setChanged(!changed)}>Switch sample</button>
      <ChatImageView
        src={changed ? portrait : long}
        filename="replacement.png"
        variant="user-attached"
      />
    </>
  );
}
void mountPage({
  route: '/cc-agent/preview-6796',
  render: (ctx) => (
    <main data-ui-page-subject style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
        #{6796} · Synthetic images · Production components
      </p>
      {ctx.case === 'boundaries' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
          {[
            [1080, 3241],
            [1080, 3240],
            [1080, 2400],
            [1920, 1080],
          ].map(([w, h]) => (
            <section key={h} data-sample={`${w}x${h}`}>
              <p>
                {w} × {h}
              </p>
              <ChatImageView
                src={sample(w, h)}
                filename={`${w}x${h}.png`}
                variant="user-attached"
              />
            </section>
          ))}
          <section data-sample="tool">
            <p>Tool output</p>
            <ChatImageView src={long} filename="tool.png" variant="tool-output" />
          </section>
        </div>
      ) : ctx.case === 'shared' ? (
        <>
          <p>Task</p>
          <UserMessage
            workingDir="/synthetic-preview"
            content={text}
            images={[{ url: long, originalName: 'task.png' }]}
          />
          <p>Group / 180px container</p>
          <div style={{ width: 180, maxWidth: '100%' }}>
            <BotGroupMessageAttachments
              align="end"
              attachments={[
                {
                  id: 'synthetic',
                  name: 'group.png',
                  category: 'image',
                  mimeType: 'image/png',
                  size: 1,
                  url: long,
                  path: null,
                },
              ]}
            />
          </div>
        </>
      ) : ctx.case === 'replacement' ? (
        <Replacement />
      ) : (
        ['mixed', 'image'].map((kind) => (
          <section key={kind} data-sample={kind} style={{ marginBottom: 28 }}>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {kind === 'mixed' ? '图文混合' : '纯图片'}
            </p>
            <UserMessage
              workingDir="/synthetic-preview"
              simplifiedBotConversation
              content={kind === 'mixed' ? text : ''}
              images={[{ url: long, originalName: 'long.png' }]}
            />
          </section>
        ))
      )}
    </main>
  ),
});
