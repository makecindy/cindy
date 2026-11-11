import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { TextLightbox } from '../../../src/renderer/components/chat/TextLightbox';
import { ImageLightbox } from '../../../src/renderer/components/chat/ImageLightbox';

const ZIP = '/fixture/2026-11-03-八张信用卡发票与核对清单.zip';
const MARKDOWN = '/fixture/2026-11-03-发票核对说明.md';

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

/** 被预览窗盖住的对话,只用来看清遮罩后面还露出原界面。 */
function Conversation() {
  const bubble = 'rounded-2xl bg-[var(--surface-chip)] px-4 py-3 text-14 leading-relaxed';
  return (
    <main className="flex h-screen flex-col gap-4 overflow-hidden bg-[var(--surface)] px-10 pt-14 text-[var(--text-primary)]">
      <div className="text-13 text-[var(--text-secondary)]">信用卡发票整理</div>
      <div className={`${bubble} self-end`}>把这八张信用卡的发票整理一下，做个核对清单。</div>
      <div className="max-w-[640px] text-14 leading-relaxed">
        已整理完成：八张发票按卡片分组，金额不一致的两条单独标出，核对清单和原始发票一起打包。
      </div>
      <div className="w-fit rounded-xl border border-[var(--border-default)] px-4 py-3 text-13">
        2026-11-03-八张信用卡发票与核对清单.zip · 269.4 KB
      </div>
      <div className="max-w-[640px] text-14 leading-relaxed text-[var(--text-secondary)]">
        需要的话，我可以再按月份拆分成单独的表格。
      </div>
    </main>
  );
}

function Fixture({ kind }: { kind: 'zip' | 'markdown' | 'image' }) {
  const [open, setOpen] = useState(true);
  const [image] = useState(sampleImage);
  return (
    <>
      <Conversation />
      {open && kind === 'zip' && <TextLightbox filePath={ZIP} onClose={() => setOpen(false)} />}
      {open && kind === 'markdown' && (
        <TextLightbox filePath={MARKDOWN} onClose={() => setOpen(false)} />
      )}
      {open && kind === 'image' && (
        <ImageLightbox src={image} filename="示例图片.png" onClose={() => setOpen(false)} />
      )}
    </>
  );
}

mountPage({
  route: '/',
  host: () => ({
    fileBrowser: {
      readFile: async () => ({ ok: false, code: 'BINARY_FILE', message: 'binary' }),
      stat: async ({ relPath }: { relPath: string }) => ({
        relPath,
        size: 275_866,
        mtimeMs: new Date('2026-11-03T18:33:00+08:00').getTime(),
        isDirectory: false,
      }),
      onEvent: subscription('file-browser'),
    },
    readTextFilePreview: async () => ({ success: true, data: markdown, size: markdown.length }),
    showItemInFolder: async () => ({ success: true }),
    openPath: async () => '',
  }),
  render: (ctx) => (
    <Fixture
      kind={ctx.case === 'markdown' ? 'markdown' : ctx.case === 'image' ? 'image' : 'zip'}
    />
  ),
});
