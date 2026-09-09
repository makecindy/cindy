import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { buildMobileMessageMenu } from '@/session/messageActionMenu';
import { iconSize } from '@/theme/tokens';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('mobile message action menu', () => {
  it('matches desktop order, natural language, and destructive grouping', () => {
    expect(buildMobileMessageMenu({
      canAddToChat: true,
      canCopyLink: true,
      canDelete: true,
      canRewind: true,
    })).toEqual([
      { id: 'add-to-chat', label: '添加到对话', image: 'cindy-message-square-plus' },
      { id: 'copy-link', label: '复制当前消息链接', image: 'cindy-link-2' },
      { id: 'rewind', label: '回到此处', image: 'cindy-undo-2' },
      { id: 'delete', label: '删除本条消息', image: 'cindy-trash-2', destructive: true, separatorBefore: true },
    ]);
  });

  it('ships each native menu image as a template at every iOS scale', () => {
    const items = buildMobileMessageMenu({ canAddToChat: true, canCopyLink: true, canDelete: true, canRewind: true });
    for (const item of items) {
      const directory = resolve(process.cwd(), 'assets/message-menu', `${item.image}.imageset`);
      const fingerprintConfig = require('../../fingerprint.config.cjs');
      expect(fingerprintConfig.extraSources).toContainEqual({
        type: 'dir',
        filePath: `assets/message-menu/${item.image}.imageset`,
        reasons: ['native message menu assets'],
      });
      const catalog = JSON.parse(readFileSync(resolve(directory, 'Contents.json'), 'utf8'));
      expect(catalog.properties['template-rendering-intent']).toBe('template');
      expect(catalog.images.map((image: { scale: string }) => image.scale)).toEqual(['1x', '2x', '3x']);
      for (const image of catalog.images) {
        const png = readFileSync(resolve(directory, image.filename));
        const size = iconSize.lg * Number.parseInt(image.scale, 10);
        expect(png.subarray(1, 4).toString()).toBe('PNG');
        expect(png.readUInt32BE(16)).toBe(size);
        expect(png.readUInt32BE(20)).toBe(size);
      }
    }
  });

  it('reuses the shared sheet lifecycle and dispatches a choice after close', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageActionSheet.tsx'), 'utf8');
    expect(source).toContain('<SheetModal');
    expect(source).toContain('onClosed={handleClosed}');
    expect(source).toContain('pendingActionRef.current = action');
    expect(source).not.toContain('<Modal');
    expect(source).not.toContain('Animated.timing');
  });
});
