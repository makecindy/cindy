/**
 * thumbnailClickPreview.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: attachment-thumb-click (2026-04-19)
 *
 * The ChatInput attachment thumbnails (image + file) must:
 *   1) advertise a hand cursor (`cursor-pointer`) on hover, and
 *   2) open the same overlay used in the message stream on click —
 *        image  → ImageLightbox
 *        other  → TextLightbox
 *
 * Previously the thumbnail only showed a hover preview tooltip and had no
 * click-to-open affordance. This test pins the wiring at the source level so
 * a future refactor can't silently regress to "hover-only" behaviour.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 归一化 CRLF → LF：Windows autocrlf=true 检出下工作树是 CRLF，
// 而下面的 indexOf 子串里内嵌裸 \n，不归一化会在 Windows 上误报失败。
const chatInput = readFileSync(
  resolve(
    __dirname,
    '..',
    'components',
    'new-chat',
    'ChatInput.tsx',
  ),
  'utf8',
).replace(/\r\n/g, '\n');

describe('Attachment thumbnail — click opens lightbox (attachment-thumb-click)', () => {
  it('imports the same lightboxes UserMessage uses', () => {
    expect(chatInput).toMatch(
      /import\s+\{\s*ImageLightbox\s*\}\s+from\s+'@\/components\/chat\/ImageLightbox'/,
    );
    // 该模块还导出 formatBytes(文件卡的大小副行复用它),所以这里只钉
    // TextLightbox 在具名导入列表里,不锁死整条 import 的成员组成。
    expect(chatInput).toMatch(
      /import\s+\{[^}]*\bTextLightbox\b[^}]*\}\s+from\s+'@\/components\/chat\/TextLightbox'/,
    );
  });

  it('uses the shared image hover preview so composer and message chips stay identical', () => {
    expect(chatInput).toContain(
      "import { ImageHoverPreview } from '@/components/chat/ImageHoverPreview';",
    );
    const startIdx = chatInput.indexOf('function ThumbnailItem');
    const block = chatInput.slice(startIdx);
    expect(block).toContain('<ImageHoverPreview');
    expect(block).toContain('open={isHovered}');
    expect(block).toContain('anchorRef={thumbRef}');
  });

  it('ThumbnailItem preview button uses cursor-pointer (hand) and an onClick handler', () => {
    // Slice the ThumbnailItem function body so we don't accidentally match
    // some other unrelated `cursor-pointer` token elsewhere in the file.
    const startMarker = 'function ThumbnailItem';
    const startIdx = chatInput.indexOf(startMarker);
    expect(startIdx).toBeGreaterThan(-1);
    // ThumbnailItem is the last component in the file; slice to EOF.
    const block = chatInput.slice(startIdx);

    // The preview button carries the hand cursor; the outer wrapper owns the
    // hover boundary so moving onto the remove button does not hide the preview.
    expect(block).toContain("isDownloadOnly ? 'cursor-default' : 'cursor-pointer'");
    expect(block).toContain('disabled={isDownloadOnly}');

    // A click handler that delegates to handleOpenPreview must exist.
    expect(block).toMatch(/onClick=\{handleOpenPreview\}/);

    // The preview branch must distinguish image vs. other and mount the
    // matching lightbox (the assertion that locks the parity with
    // UserMessage's behaviour).
    expect(block).toMatch(/file\.category === 'image'/);
    expect(block).toMatch(/<ImageLightbox\s+src=\{lightboxSrc\}/);
    expect(block).toMatch(/<TextLightbox[\s\S]+filePath=\{file\.path\}/);
    expect(block).toMatch(
      /if \(isDownloadOnly\) return;[\s\S]+shouldOpenTextLightbox\(file\.path\)/,
    );
  });

  it('keeps thumbnail hover state on the outer wrapper so the remove button does not dismiss preview', () => {
    const startIdx = chatInput.indexOf('function ThumbnailItem');
    const block = chatInput.slice(startIdx);
    const wrapperStart = block.indexOf('<div\n      ref={thumbRef}');
    expect(wrapperStart).toBeGreaterThan(-1);
    const wrapperOpenTag = block.slice(wrapperStart, block.indexOf('{/* Thumbnail content */}', wrapperStart));
    const previewButtonStart = block.indexOf('<button', wrapperStart);
    expect(previewButtonStart).toBeGreaterThan(wrapperStart);
    const previewButtonOpenTag = block.slice(previewButtonStart, block.indexOf('{file.category', previewButtonStart));

    expect(wrapperOpenTag).toContain('onPointerEnter={() => setIsHovered(true)}');
    expect(wrapperOpenTag).toContain('onPointerLeave={() => setIsHovered(false)}');
    expect(previewButtonOpenTag).not.toContain('onPointerEnter={() => setIsHovered(true)}');
    expect(previewButtonOpenTag).not.toContain('onPointerLeave={() => setIsHovered(false)}');
  });

  it('Opening the lightbox dismisses the hover preview/tooltip (no leftover popover)', () => {
    // Bug repro: clicking a thumbnail opens the lightbox but the hover
    // popover (image preview portal) and the file-path tooltip stay visible
    // behind it — the moment the lightbox fades out they pop back into view
    // because the cursor never left the thumbnail. The fix resets isHovered
    // inside handleOpenPreview so the popover unmounts immediately.
    const startIdx = chatInput.indexOf('function ThumbnailItem');
    const block = chatInput.slice(startIdx);
    // handleOpenPreview must call setIsHovered(false) BEFORE choosing which
    // lightbox to mount — otherwise the popover lingers for at least one
    // render after the lightbox closes.
    const openIdx = block.indexOf('const handleOpenPreview');
    expect(openIdx).toBeGreaterThan(-1);
    const openBody = block.slice(openIdx, block.indexOf('}, [file]);', openIdx));
    expect(openBody).toMatch(/setIsHovered\(false\)/);
    // And the call must precede the image / file branches so it always runs.
    const resetAt = openBody.indexOf('setIsHovered(false)');
    const branchAt = openBody.indexOf("file.category === 'image'");
    expect(resetAt).toBeGreaterThan(-1);
    expect(branchAt).toBeGreaterThan(resetAt);
  });

  it('Remove (×) button still stops propagation so it does not open the lightbox', () => {
    // The × button stopPropagation contract was already in place; pin it so
    // future edits don't accidentally let the parent onClick fire and open
    // a lightbox right after the user removed the file.
    const startIdx = chatInput.indexOf('function ThumbnailItem');
    const block = chatInput.slice(startIdx);
    // The remove button's onClick must call stopPropagation BEFORE onRemove.
    expect(block).toMatch(/e\.stopPropagation\(\);\s*onRemove\(file\.id\)/);
  });
});
