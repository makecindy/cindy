import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { BotDmThreadPanel } from '../../../src/renderer/features/bots/BotDmThreadViews';
import { ChatThreadPanel } from '../../../src/renderer/features/bots/ChatThreadPanel';
import { BotGroupComposer } from '../../../src/renderer/features/bots/BotGroupComposer';
import { useWallpaperBackground } from '../../../src/renderer/hooks/useWallpaperBackground';
import wallpaper from '../../../src/renderer/assets/wallpapers/cindy-window.webp';
import type { BotGroupDetail } from '../../../src/shared/botGroupChat';

const text = '原消息开头 · Original message\n\n' + Array.from({ length: 6 }, (_,i) =>
  `### ${i + 1}. 完整阅读 · Full text\n\n原消息和回复一起滚动，不应被固定高度遮挡。The entire original message remains readable.\n\n- 第一项 First item\n- 第二项 Second item`).join('\n\n') + '\n\n原消息末尾 · End of original';
const bot = { id: 'fixture-bot', name: 'Aster', avatar: '🧪' };
const root = { id: 'root', sequence: 1, kind: 'message' as const, authorKind: 'bot' as const,
  authorBotId: bot.id, authorName: bot.name, content: text, mentions: { all: false, botIds: [] },
  noticeCode: null, planId: null, files: [], attachments: [], createdAt: 1792990000000 };

const report = '| 日期 | 站点 | 访问量 | 下载点击 | 访客 |\n| --- | --- | --- | --- | --- |\n| 10/28 | cindy.app | 4388 | 1048 | 759 |\n| 10/29 | cindy.app | 3621 | 639 | 466 |';
const reportName = '2026-10-29-Cindy双站逐日来源明细-完整报表.csv';
const reportRoot = { ...root, content: report + '\n\n交付物：逐日、分来源明细，可用 Excel 打开。', attachments: [
  { id: 'csv', name: reportName, path: '/fixture/report.csv', url: null, category: 'text' as const, mimeType: 'text/csv', size: 100 },
  { id: 'pending', name: reportName, path: null, url: null, category: 'text' as const, mimeType: 'text/csv', size: 100, state: 'loading' as const },
] };

function AttachmentComposer() {
  const [files, setFiles] = useState([{ id: 'csv', name: reportName, path: '/fixture/report.csv', ext: '.csv', category: 'text' as const, mimeType: 'text/csv', size: 100 }]);
  const noop = () => undefined;
  return <div className="flex h-screen flex-col justify-end" data-ui-page-subject><BotGroupComposer
    groupId="fixture-group" draftKey="fixture-composer" members={[]} running={false}
    attachments={{ attachments: files, rejections: [], addFiles: async () => undefined, addClipboardImage: async () => undefined,
      dismissRejection: noop, removeFile: id => setFiles(files => files.filter(file => file.id !== id)), updateFile: noop, restoreFiles: noop, clearFiles: noop }}
    onSent={noop} /></div>;
}

function Scenario({ kind }: { kind: string }) {
  const [closed, setClosed] = useState(false);
  const [wallpaperEnabled, setWallpaperEnabled] = useState(false);
  useWallpaperBackground({
    background: wallpaperEnabled ? `url("${wallpaper}")` : undefined,
    pending: false, visibility: 0.65, blur: 0, reducedMotion: true,
  });
  return <div className="flex h-screen" data-ui-page-subject>
    <div className="min-w-0 flex-1 p-4">
      <button type="button" aria-pressed={wallpaperEnabled}
        onClick={() => setWallpaperEnabled(enabled => !enabled)}>Wallpaper</button>
    </div>
    {closed ? <span data-closed="" /> : kind.startsWith('group') ? <ChatThreadPanel
      group={{ id: 'fixture-group', members: [], messages: [kind === 'group-narrow' ? reportRoot : root] } as unknown as BotGroupDetail}
      rootId="root" onClose={() => setClosed(true)} /> : <BotDmThreadPanel
      bot={bot} rootSessionId="fixture-main" rootClientId="root"
      state={kind === 'failed' ? { kind: 'failed', message: '暂时无法打开话题 · Could not open topic' } : { kind: 'opening' }}
      mentions={[]} lastAssistantAt={null} onRetry={() => undefined} onClose={() => setClosed(true)} />}
  </div>;
}

void mountPage({
  route: '/bots/fixture-bot/session/fixture-main',
  host: ctx => {
    let following = false;
    return {
      maker: { onBotGroupChanged: subscription('groupChanged'), chatServer: {
        thread: async () => ({ ok: true, root: ctx.case === 'group-narrow' ? reportRoot : root, replies: [], hasMore: false, following }),
        followThread: async (input: { following: boolean }) => {
          following = input.following;
          return { ok: true, following };
        },
      } },
    };
  },
  render: ctx => {
    // Only the source snapshot is simulated; both panels and root rendering are real.
    (window as unknown as { __threadRoot: unknown }).__threadRoot = {
      messages: [{ clientId: 'root', role: 'assistant', content: text, createdAt: new Date(root.createdAt).toISOString() }],
    };
    return ctx.case === 'composer-attachments' ? <AttachmentComposer /> : <Scenario kind={ctx.case} />;
  },
});
