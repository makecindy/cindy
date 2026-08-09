import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildMobileImageAttachmentCandidate } from '@/session/mobileImageAttachment';
import {
  buildPastedImageFileName,
  classifyPastedImageUri,
  resolvePastedImageAsset,
} from '@/session/pastedImageAttachment';

describe('classifyPastedImageUri', () => {
  it('白名单扩展名不转换、ext 原样(含大写与 query/hash)', () => {
    expect(classifyPastedImageUri('file:///tmp/a.png')).toEqual({ ext: 'png', needsJpegConversion: false });
    expect(classifyPastedImageUri('file:///tmp/b.JPG')).toEqual({ ext: 'jpg', needsJpegConversion: false });
    expect(classifyPastedImageUri('file:///tmp/c.jpeg?x=1#frag')).toEqual({ ext: 'jpeg', needsJpegConversion: false });
    expect(classifyPastedImageUri('file:///tmp/d.gif')).toEqual({ ext: 'gif', needsJpegConversion: false });
    expect(classifyPastedImageUri('file:///tmp/e.webp')).toEqual({ ext: 'webp', needsJpegConversion: false });
  });

  it('HEIC / HEIF / 未知 / 无扩展名 → 需转 JPEG、ext=jpg', () => {
    expect(classifyPastedImageUri('file:///tmp/a.heic')).toEqual({ ext: 'jpg', needsJpegConversion: true });
    expect(classifyPastedImageUri('file:///tmp/b.HEIF')).toEqual({ ext: 'jpg', needsJpegConversion: true });
    expect(classifyPastedImageUri('file:///tmp/c.tiff')).toEqual({ ext: 'jpg', needsJpegConversion: true });
    expect(classifyPastedImageUri('file:///tmp/no-ext')).toEqual({ ext: 'jpg', needsJpegConversion: true });
  });
});

describe('buildPastedImageFileName', () => {
  it('序号从 1 起、带扩展名', () => {
    expect(buildPastedImageFileName(0, 'png')).toBe('pasted-image-1.png');
    expect(buildPastedImageFileName(2, 'jpg')).toBe('pasted-image-3.jpg');
  });
});

describe('resolvePastedImageAsset', () => {
  it('白名单图不调转换器、uri 原样、mimeType 按扩展名推断', async () => {
    const convertToJpeg = vi.fn();
    const asset = await resolvePastedImageAsset('file:///tmp/shot.png', 0, { convertToJpeg });
    // mimeType 必须有值:candidate 缺 mimeType 时预签名不锁 Content-Type,原生直传层
    // 自动补 application/octet-stream,签名不一致 → OSS 403(2026-07 实撞回归)。
    expect(asset).toEqual({ uri: 'file:///tmp/shot.png', fileName: 'pasted-image-1.png', mimeType: 'image/png' });
    expect(convertToJpeg).not.toHaveBeenCalled();
  });

  it('HEIC 调转换器、产出 jpg 文件名与转换后 uri、mimeType=image/jpeg', async () => {
    const convertToJpeg = vi.fn().mockResolvedValue('file:///tmp/converted.jpg');
    const asset = await resolvePastedImageAsset('file:///tmp/photo.heic', 1, { convertToJpeg });
    expect(convertToJpeg).toHaveBeenCalledWith('file:///tmp/photo.heic');
    expect(asset).toEqual({ uri: 'file:///tmp/converted.jpg', fileName: 'pasted-image-2.jpg', mimeType: 'image/jpeg' });
  });

  it('解析结果可直接喂 buildMobileImageAttachmentCandidate:name 采用友好名、mime 推断正确', async () => {
    const asset = await resolvePastedImageAsset('file:///tmp/8F3A-UUID.png', 0, {});
    const candidate = buildMobileImageAttachmentCandidate({ fileName: asset.fileName, uri: asset.uri }, 0);
    expect(candidate.name).toBe('pasted-image-1.png');
    expect(candidate.mimeType).toBe('image/png');

    const converted = await resolvePastedImageAsset('file:///tmp/photo.heic', 1, {
      convertToJpeg: async () => 'file:///tmp/converted.jpg',
    });
    const jpegCandidate = buildMobileImageAttachmentCandidate({ fileName: converted.fileName, uri: converted.uri }, 1);
    expect(jpegCandidate.name).toBe('pasted-image-2.jpg');
    expect(jpegCandidate.mimeType).toBe('image/jpeg');
  });
});

describe('粘贴接线源码断言(防重构掉线)', () => {
  const mobileRoot = join(__dirname, '..', '..');
  // Windows checkout 使用 CRLF；源码接线断言统一到 LF，避免把换行风格误判成逻辑缺失。
  const read = (rel: string) => readFileSync(join(mobileRoot, rel), 'utf8').replace(/\r\n/g, '\n');

  it('共享输入行组件包 TextInputWrapper 并只上抛 images', () => {
    const source = read('src/session/MobileComposerInputRow.tsx');
    expect(source).toContain("from 'expo-paste-input'");
    expect(source).toContain('TextInputWrapper');
    expect(source).toContain("payload.type === 'images'");
    expect(source).toContain('onPasteImages?: (uris: string[]) => void');
  });

  it('粘贴入队 candidate 与 resolve 钩子都携带 mimeType(缺失会 OSS 签名不匹配 403)', () => {
    const source = read('src/session/useMobileLocalAttachments.ts');
    expect(source).toContain('mimeType: mimeTypeForPastedImageExt(classified.ext)');
    expect(source).toContain('mimeType: resolved.mimeType');
  });

  it('两个 composer 页面都接了 onPasteImages → addPastedImageAttachments', () => {
    for (const page of ['app/sessions/new.tsx', 'app/sessions/[sessionId].tsx']) {
      const source = read(page);
      // 粘贴已迁入 useMobileLocalAttachments 乐观管线,页面经 hook 解构别名接线。
      expect(source, page).toContain('addPastedImages: addPastedImageAttachments');
      expect(source, page).toContain('onPasteImages={(uris) => void addPastedImageAttachments(uris)}');
    }
  });

  it('输入行组件处理粘贴占位事件(images-loading / images-load-failed,原生 patch 扩展)', () => {
    const source = read('src/session/MobileComposerInputRow.tsx');
    expect(source).toContain("payload.type === 'images-loading'");
    expect(source).toContain("payload.type === 'images-load-failed'");
    expect(source).toContain('onPasteImagesLoading?: (count: number) => void');
    expect(source).toContain('onPasteImagesLoadFailed?: () => void');
  });

  it('两个 composer 页面都接了占位回调,托盘计入占位卡', () => {
    for (const page of ['app/sessions/new.tsx', 'app/sessions/[sessionId].tsx']) {
      const source = read(page);
      expect(source, page).toContain('onPasteImagesLoading={beginPastePlaceholders}');
      expect(source, page).toContain('onPasteImagesLoadFailed={failPastePlaceholders}');
      expect(source, page).toContain('pastePlaceholderCount={pastePlaceholderCount}');
    }
  });

  it('发送等待把粘贴占位当在途工作:占位未落定前 waitForPendingUploads 不放行(防抢发漏图)', () => {
    const source = read('src/session/useMobileLocalAttachments.ts');
    // waitForPendingUploads 必须先等占位批次全部落定,再等 controller 队列;
    // 占位窗口(原生还在读剪贴板 / 编码写盘)任务尚未入队,只等 waitForIdle
    // 会让「粘贴后立刻点发送」把图漏在消息外。
    expect(source).toContain('await waitForPastePlaceholders();');
    expect(source).toContain('const result = await controller.waitForIdle();');
    expect(source).toContain('return isAttachmentScopeActive() ? result : { failedCount: 0 };');
    // 兜底路径(超时清零 / 卸载)都要放行等待者,防发送永久悬挂。
    expect(source).toContain('flushPastePlaceholderWaiters();');
  });

  it('占位卡有超时兜底、计入附件限额、兑现按 FIFO 批次出列(hook 内闭环)', () => {
    const source = read('src/session/useMobileLocalAttachments.ts');
    expect(source).toContain('PASTE_PLACEHOLDER_TIMEOUT_MS');
    // 限额:占位并入统一的在途占坑真源(getPendingSlotCount = 上传中 + 占位),
    // beginPick 与对外暴露的 getPendingUploadCount 同源(review P2:直接入队
    // 路径不能绕过占位占坑)。
    expect(source).toContain('const getPendingSlotCount = () => controller.pendingCount() + getPastePlaceholderTotal();');
    expect(source).toContain('- getPendingSlotCount()');
    expect(source).toContain('getPendingUploadCount: () => (isAttachmentScopeActive() ? getPendingSlotCount() : 0),');
    // 批次 FIFO(review P2):兑现 / 失败只出列最早一批,并发粘贴时第一批完成
    // 不清掉第二批还在原生处理中的占位;addPastedImages 进限额检查前先出列
    // 本批(防双扣)。
    expect(source).toContain('const pastePlaceholderBatchesRef = useRef<number[]>([]);');
    expect(source).toContain('pastePlaceholderBatchesRef.current.shift();');
    expect(source).toContain('shiftPastePlaceholderBatch();');
  });

  it('composer 草稿作废时同步清上传队列、粘贴占位与等待者', () => {
    const source = read('src/session/useMobileLocalAttachments.ts');
    const start = source.indexOf('const discardAllPendingUploads = useCallback(() => {');
    const end = source.indexOf('useEffect(() => () => {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const discard = source.slice(start, end);
    expect(discard).toContain('controller.removeAll();');
    expect(discard).toContain('pastePlaceholderBatchesRef.current = [];');
    expect(discard).toContain('setPastePlaceholderCount(0);');
    expect(discard).toContain('clearTimeout(pastePlaceholderTimerRef.current);');
    expect(discard).toContain('pastePlaceholderWaitersRef.current = [];');
    expect(discard).toContain('for (const resolve of waiters) resolve();');
    expect(source).toContain('attachmentScopeGenerationRef.current += 1;');
    expect(source).toContain('discardAllPendingUploadsForScopeChange,');
  });

  it('session 作用域闸拒绝旧 picker / 粘贴入口与迟到上传完成结果', () => {
    const source = read('src/session/useMobileLocalAttachments.ts');
    expect(source).toContain('optionsRef.current.attachmentScopeKey === attachmentScopeKey');
    expect(source).toContain('attachmentScopeGenerationRef.current === attachmentScopeGeneration');
    expect(source).toContain('if (count <= 0 || !isAttachmentScopeActive()) return;');
    expect(source).toContain('if (candidates.length === 0 || !isAttachmentScopeActive()) return;');
    expect(source).toContain('if (!isAttachmentScopeActive()) {\n      if (ownedUris.length > 0) void deleteLocalUris(ownedUris);');
    expect(source).toContain('optionsRef.current.attachmentScopeKey !== candidateScopeKey');
    expect(source).toContain('candidate.attachmentScopeGeneration !== attachmentScopeGenerationRef.current');
    expect(source).toContain('discardMobileUploadedAttachment(attachment');
    expect(source).toContain('onFailed: (err, localId, candidate) => {');
    expect(source).toContain('if (!isAttachmentScopeActive()) return { failedCount: 0 };');
    expect(source).toContain('if (!isAttachmentScopeActive()) return [];');
    const sessionSource = read('app/sessions/[sessionId].tsx');
    expect(sessionSource).toContain('attachmentScopeKey: sessionId,');
  });

  it('富文本输入按 session 重挂载时作废旧粘贴批次，迟到写盘不回调新任务', () => {
    const source = read('src/session/ComposerRichInput.tsx');
    expect(source).toContain('pendingImagePastesRef.current.clear();');
    expect(source).toContain('pendingImagePasteOrderRef.current = [];');
  });

  it('context-sheet 选图限额走同一占坑真源(直接入队路径不绕过粘贴占位)', () => {
    for (const page of ['app/sessions/new.tsx', 'app/sessions/[sessionId].tsx']) {
      const source = read(page);
      expect(source, page).toContain('attachments.length + pendingMediaAssets.length + getPendingUploadCount() >= MOBILE_MAX_ATTACHMENTS');
    }
  });
});
