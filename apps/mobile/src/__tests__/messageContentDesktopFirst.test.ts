import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile message content desktop-first surface', () => {
  it('uses desktop-matching file icons instead of text badges for file chips', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const desktopSource = readFileSync(resolve(process.cwd(), '../../apps/desktop/src/renderer/components/chat/UserMessage.tsx'), 'utf8');
    const layoutSource = readFileSync(resolve(process.cwd(), 'src/session/messageContentLayout.ts'), 'utf8');
    const fileChipStart = source.indexOf('function FileChip');
    const fileChipEnd = source.indexOf('function DiffPreview', fileChipStart);
    const fileChipSource = source.slice(fileChipStart, fileChipEnd);

    expect(desktopSource).toContain("'h-7 px-2.5 py-1.5'");
    expect(desktopSource).toContain('<span className="truncate">{file.name}</span>');
    expect(source).toContain('File as FileIcon,');
    expect(source).toContain('<FileIcon color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />');
    expect(source).toContain('style={[styles.fileIconFrame, { width: layout.fileChipIconWidth }]}');
    expect(fileChipSource).toContain('<Text style={styles.fileName} numberOfLines={1}>{preview.title}</Text>');
    expect(fileChipSource).not.toContain('preview.detail');
    expect(layoutSource).toContain('fileChipMinHeight: 32');
    expect(source).not.toContain('function fileChipLabel');
    expect(source).not.toContain("return 'FILE';");
    expect(source).not.toContain('<Text style={[styles.fileIcon');
    expect(source).not.toContain('filePath: { color: colors.textTertiary');
  });

  it('uses icon-only payload header actions like desktop lightboxes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).toContain('ExternalLink,');
    expect(source).toContain('X,');
    expect(source).toContain('<Copy color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />');
    expect(source).toContain('<ExternalLink color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />');
    expect(source).toContain('<X color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />');
    expect(source).not.toContain('function payloadCopyLabel');
    expect(source).not.toContain('payloadHeaderButtonText');
    expect(source).not.toContain('payloadGalleryButtonText');
    expect(source).not.toContain('<Text style={styles.payloadHeaderButtonText}>打开</Text>');
    expect(source).not.toContain('<Text style={styles.payloadGalleryButtonText}>上一张</Text>');
    expect(source).not.toContain('<Text style={styles.payloadGalleryButtonText}>下一张</Text>');
  });

  it('titles payload detail panels by user-facing content instead of debug labels', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const mediaFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/media_smoke.yaml'), 'utf8');
    const mediaExpoGoFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/media_smoke_expo_go.yaml'), 'utf8');
    const fileFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/file_preview.yaml'), 'utf8');
    const visualPayloadFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/visual_session_payload.yaml'), 'utf8');
    const flowSmokeSource = readFileSync(resolve(process.cwd(), 'scripts/maestro-flow-smoke.mjs'), 'utf8');
    const modalStart = source.indexOf('function MessagePayloadModal');
    const modalEnd = source.indexOf('type RemoteMediaState', modalStart);
    const modalSource = source.slice(modalStart, modalEnd);
    const e2eSource = [
      mediaFlow,
      mediaExpoGoFlow,
      fileFlow,
      visualPayloadFlow,
      flowSmokeSource,
    ].join('\n');

    expect(modalSource).toContain('testID="message.payloadViewerHeader"');
    expect(modalSource).toContain('<Text style={styles.payloadTitle} numberOfLines={headerLayout.titleNumberOfLines}>{payloadSummary?.title ?? \'\'}</Text>');
    expect(modalSource).toContain('testID="message.payloadSubtitle"');
    expect(source).not.toContain('styles.payloadTitleMetaRow');
    expect(source).not.toContain('payloadTitleMetaRow: {');
    expect(source).not.toContain('styles.payloadEyebrow');
    expect(source).not.toContain('payloadEyebrow: {');
    expect(source).not.toContain('PAYLOAD');
    expect(source).not.toContain('message.payloadKind');
    expect(source).not.toContain('message.payloadSeverity');
    expect(source).not.toContain('payloadKindPill');
    expect(source).not.toContain('payloadSeverityPill');
    expect(source).not.toContain('function payloadSeverityLabel');
    expect(e2eSource).not.toContain('message.payloadKind');
    expect(e2eSource).not.toContain('message.payloadSeverity');
    // 图片流已改走全屏 ImageLightbox(无标题/正文),烟测断言 lightbox 出现与可关闭
    expect(mediaFlow).toContain('visible: "Mock image fixture"');
    expect(mediaFlow).toContain('id: "message.imageLightbox"');
    expect(mediaExpoGoFlow).toContain('id: "message.imageLightbox"');
    expect(fileFlow).toContain('assertVisible: "mock-spec.md"');
    expect(visualPayloadFlow).toContain('text: "Visual payload fixture"');
    expect(visualPayloadFlow).toContain('id: "message.imageLightbox"');
  });

  it('does not pin desktop-only media follow-up guidance in the main message stream', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const layoutSource = readFileSync(resolve(process.cwd(), 'src/session/messageContentLayout.ts'), 'utf8');

    expect(source).toContain('function ToolMediaBlock');
    expect(source).toContain('buildMediaPayload(entry, entry.title || mediaLabel(entry))');
    expect(source).not.toContain('function ToolMediaActionsNotice');
    expect(source).not.toContain('message.mediaActionsNotice');
    expect(source).not.toContain('桌面操作');
    expect(source).not.toContain('手机版暂不触发');
    expect(source).not.toContain('mediaActionButtonLabel');
    expect(layoutSource).not.toContain('mediaActionChipMinHeight');
  });

  it('keeps generic tool input summaries visible when structured row detail is absent', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).toContain('row.detail || tool.body');
    expect(source).toContain('{row.detail ?? tool.body}');
  });

  it('keeps mobile markdown typography close to the desktop message hierarchy', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const tokenSource = readFileSync(resolve(process.cwd(), 'src/theme/tokens.ts'), 'utf8');

    expect(tokenSource).toContain('code: 15');
    expect(source).toContain('messageText: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge }');
    expect(source.match(/fontSize: typeScale\.code/g)).toHaveLength(4);
  });

  it('keeps message content readable on iPad and phone landscape', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).toContain('buildMobileReadableViewportLayout');
    expect(source).toContain('viewportLayout.contentWidth');
    expect(source).toContain('viewportLayout.wideViewport && styles.messagesWide');
    expect(source).toContain('viewportLayout.wideViewport && { maxWidth: viewportLayout.contentMaxWidth }');
  });
});
