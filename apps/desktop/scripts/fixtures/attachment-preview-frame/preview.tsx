import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { FileLightbox } from '../../../src/renderer/components/chat/FileLightbox';
import { TextLightbox } from '../../../src/renderer/components/chat/TextLightbox';
import { ImageLightbox } from '../../../src/renderer/components/chat/ImageLightbox';
import { FileChangedBadge } from '../../../src/renderer/components/chat/FilePreviewLightboxHost';
import { ChatSessionFileProvider } from '../../../src/renderer/components/chat/ChatSessionFileContext';
import { LOCAL_FILE_ORIGIN } from '../../../src/renderer/lib/sessionFileOrigin';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';

const SHEET = '/fixture/2026-11-03-发票核对清单.xlsx';
const SHEET_CACHE = '/fixture/cache-473d6dd49fb70e80510e-internal-name.xlsx';
const MARKDOWN = '/fixture/2026-11-03-发票核对说明.md';
// 远端取回后的本地副本路径(stale 场景:远端不可达,只剩这份历史副本)。
const CACHED_SHEET = '/fixture/cached/2026-11-03-发票核对清单.xlsx';

const markdown = [
  '# 发票核对说明',
  '本文件为界面检查用的示例文档，不含真实数据。',
  '## 核对步骤',
  '1. 按卡号尾号分组，确认每张发票都有对应的消费记录。\n2. 金额不一致的条目单独列出。\n3. 核对完成后把清单发给财务。',
  '| 卡片 | 发票数 | 状态 |\n| --- | --- | --- |\n| 尾号 1024 | 3 | 已核对 |\n| 尾号 2048 | 2 | 待补充 |\n| 尾号 4096 | 3 | 已核对 |',
  ...Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 段：用于检查长文档在预览窗里的滚动与留白。`),
].join('\n\n');

function sampleImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1000;
  const c = canvas.getContext('2d')!;
  const gradient = c.createLinearGradient(0, 0, 1600, 1000);
  gradient.addColorStop(0, '#d8e3ef');
  gradient.addColorStop(1, '#f2e7d8');
  c.fillStyle = gradient;
  c.fillRect(0, 0, 1600, 1000);
  c.fillStyle = '#2c2c2a';
  c.font = 'bold 72px sans-serif';
  c.fillText('SAMPLE IMAGE', 96, 160);
  c.font = '44px sans-serif';
  c.fillText('1600 × 1000 · synthetic', 96, 236);
  return canvas.toDataURL('image/png');
}

/** 被预览窗盖住的对话,只用来看清浮窗旁边仍露出原界面,并验证可选中/可滚动。 */
function Conversation() {
  const bubble = 'rounded-2xl bg-[var(--surface-chip)] px-4 py-3 text-14 leading-relaxed';
  return (
    <main
      data-scroll-container=""
      className="flex h-screen flex-col gap-4 overflow-y-auto bg-[var(--surface)] px-10 pt-14 text-[var(--text-primary)]"
    >
      <div className="text-13 text-[var(--text-secondary)]">信用卡发票整理</div>
      <div className={`${bubble} self-end`}>把这八张信用卡的发票整理一下，做个核对清单。</div>
      <div
        data-conversation-copy=""
        className="max-w-[640px] text-14 leading-relaxed"
      >
        已整理完成：八张发票按卡片分组，金额不一致的两条单独标出，核对清单和原始发票一起打包。
      </div>
      <div className="w-fit rounded-xl border border-[var(--border-default)] px-4 py-3 text-13">
        2026-11-03-发票核对清单.xlsx · 59.7 KB
      </div>
      <div className="max-w-[640px] text-14 leading-relaxed text-[var(--text-secondary)]">
        需要的话，我可以再按月份拆分成单独的表格。
      </div>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="max-w-[640px] text-14 leading-relaxed text-[var(--text-tertiary)]">
          第 {i + 1} 条上下文：图片浮窗打开时，这里仍应能滚动、选中并复制。
        </div>
      ))}
    </main>
  );
}

function Fixture({ kind }: { kind: 'sheet' | 'markdown' | 'image' | 'changed' | 'stale' }) {
  const [open, setOpen] = useState(true);
  const [image] = useState(sampleImage);
  // stale 场景是远程会话:取回只拿到历史副本,面板上要标出来。
  const remote = kind === 'stale';
  return (
    <ChatSessionFileProvider
      value={{
        sessionId: 'fixture-session',
        workingDir: '/fixture',
        origin: remote ? { kind: 'device', deviceId: 'device-1' } : LOCAL_FILE_ORIGIN,
      }}
    >
      <Conversation />
      <ToastContainer />
      {open && kind === 'sheet' && <FileLightbox filePath={SHEET_CACHE} fileName={SHEET.split('/').pop()} onClose={() => setOpen(false)} />}
      {open && kind === 'markdown' && (
        <TextLightbox filePath={MARKDOWN} onClose={() => setOpen(false)} />
      )}
      {open && kind === 'changed' && (
        <TextLightbox
          filePath={MARKDOWN}
          onClose={() => setOpen(false)}
          changedBadge={<FileChangedBadge onClick={() => {}} />}
        />
      )}
      {open && kind === 'stale' && (
        <FileLightbox filePath={SHEET} fileName={SHEET.split('/').pop()} onClose={() => setOpen(false)} />
      )}
      {open && kind === 'image' && (
        <ImageLightbox src={image} filename="示例图片.png" onClose={() => setOpen(false)} />
      )}
    </ChatSessionFileProvider>
  );
}

mountPage({
  route: '/',
  host: () => ({
    platform: 'win32',
    openSystemPreview: async () => true,
    fileBrowser: {
      // 远程取回:只拿到历史副本(stale),面板上要标出来。
      chatFetch: async () => ({
        ok: true,
        cachePath: CACHED_SHEET,
        size: 61_133,
        stale: true,
      }),
      readFile: async () => ({ ok: false, code: 'BINARY_FILE', message: 'binary' }),
      stat: async ({ relPath }: { relPath: string }) => ({
        relPath,
        size: 61_133,
        mtimeMs: new Date('2026-11-03T18:33:00+08:00').getTime(),
        isDirectory: false,
      }),
      onEvent: subscription('file-browser'),
    },
    readTextFilePreview: async () => ({ success: true, data: markdown, size: markdown.length }),
    showItemInFolder: async () => ({ success: false }),
    openPath: async () => '',
  }),
  render: (ctx) => (
    <Fixture
      kind={
        ctx.case === 'image' || ctx.case === 'image-narrow'
          ? 'image'
          : ctx.case === 'markdown'
            ? 'markdown'
            : ctx.case === 'changed'
              ? 'changed'
              : ctx.case === 'stale'
                ? 'stale'
                : 'sheet'
      }
    />
  ),
});
