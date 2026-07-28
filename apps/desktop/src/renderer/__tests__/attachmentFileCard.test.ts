/**
 * attachmentFileCard.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: attachment file card (2026-07-27)
 *
 * 输入框托盘里的非图片附件(PDF / Office / 文本)此前渲染成一个 56×56 方块,
 * 正中只印大写扩展名 —— 并排两份 PDF 完全认不出谁是谁,文件名只在 hover
 * tooltip 里出现。现在改成横向文件卡:图标块 + 文件名 + 「类型 · 大小」。
 *
 * 与同目录 thumbnailClickPreview.test.ts 同族,走源码断言:ThumbnailItem 依赖
 * ChatInput 的大量本地状态,单独挂载成本远高于收益,这里把关键契约钉在源码层,
 * 防止后续重构悄悄退回「只有扩展名」的形态。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 归一化 CRLF → LF：Windows autocrlf=true 检出下工作树是 CRLF。
const chatInput = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

function thumbnailItemBlock(): string {
  const startIdx = chatInput.indexOf('function ThumbnailItem');
  expect(startIdx).toBeGreaterThan(-1);
  // ThumbnailItem 是文件里最后一个组件,切到 EOF。
  return chatInput.slice(startIdx);
}

/** 文件卡分支(非图片)的 JSX 片段:卡片容器 → Remove 按钮注释之前。 */
function fileCardBlock(): string {
  const block = thumbnailItemBlock();
  const cardStart = block.indexOf('items-center gap-2 rounded-xl px-2');
  expect(cardStart).toBeGreaterThan(-1);
  const cardEnd = block.indexOf('{/* Remove button', cardStart);
  expect(cardEnd).toBeGreaterThan(cardStart);
  return block.slice(cardStart, cardEnd);
}

describe('Attachment thumbnail — non-image file card (attachment-file-card)', () => {
  it('文件卡直接渲染文件名,不再只印扩展名', () => {
    const card = fileCardBlock();
    expect(card).toContain('{file.name}');
    // 缩略区交给 AttachmentTypeThumb(PDF 首页预览 / 类型图标),不再是扩展名方块。
    expect(card).toContain('<AttachmentTypeThumb file={file} onByteSize={setLiveByteSize} />');
    expect(chatInput).toMatch(
      /import\s+\{\s*AttachmentTypeThumb\s*\}\s+from\s+'\.\/AttachmentTypeThumb'/,
    );
  });

  it('副行给出「类型 · 大小」,大小复用 TextLightbox 的 formatBytes', () => {
    const block = thumbnailItemBlock();
    expect(block).toContain('{metaLine}');
    // metaLine 由扩展名 + formatBytes(当前大小)组成,size 缺失时只留类型。
    expect(block).toMatch(/const metaLine = \[[\s\S]*formatBytes\(shownSize\)[\s\S]*\]/);
    expect(block).toMatch(/hasSize \? formatBytes\(shownSize\) : null/);
    // 复核回来的 0 是真实的当前大小(文件被清空),要照实显示 0 B。
    expect(block).toMatch(/liveByteSize !== null \? shownSize >= 0 : shownSize > 0/);
    // 显示的大小优先用复核回来的当前值,file.size 只是拖入那一刻的快照。
    expect(block).toMatch(/const shownSize = liveByteSize \?\? file\.size/);
    // formatBytes 走 TextLightbox 的具名导出,不要在这里重造一份。
    expect(chatInput).toMatch(
      /import\s+\{\s*formatBytes,\s*TextLightbox\s*\}\s+from\s+'@\/components\/chat\/TextLightbox'/,
    );
  });

  it('文件卡颜色全部走语义 token,不含硬编码色值', () => {
    const card = fileCardBlock();
    // 旧实现是 `text-white` 压 --file-chip-bg,Light 模式下几乎读不出来。
    expect(card).not.toContain('text-white');
    // 硬编码色值:style 值里的 '#xxx' 与 Tailwind 任意值 bg-[#xxx]。
    // (注释里引用具体 hex 说明取色理由是允许的,所以不能整块 grep '#'。)
    expect(card).not.toMatch(/:\s*'#[0-9a-fA-F]{3,8}'/);
    expect(card).not.toMatch(/-\[#[0-9a-fA-F]{3,8}\]/);
    expect(card).toContain("backgroundColor: 'var(--surface-chip)'");
    // 缩略区再抬一层,否则 Light 下与卡片底色只差一档灰、看不出块。
    expect(card).toContain("backgroundColor: 'var(--surface-elevated)'");
    expect(card).toContain("color: 'var(--text-primary)'");
    expect(card).toContain("color: 'var(--text-secondary)'");
  });

  it('图片附件仍是 56×56 方块,文件卡按内容自适应且不超过 220px', () => {
    const block = thumbnailItemBlock();
    expect(block).toMatch(
      /style=\{isImageThumb \? \{ width: 56, height: 56 \} : \{ height: 56, maxWidth: 220 \}\}/,
    );
    // isImageThumb 必须与渲染分支同条件:缓存写失败的图片(无 url / base64)
    // 会落到文件卡分支,宽度也得跟着走文件卡的规则。
    expect(block).toMatch(
      /const isImageThumb = file\.category === 'image' && Boolean\(file\.url \|\| file\.base64\)/,
    );
  });
});
