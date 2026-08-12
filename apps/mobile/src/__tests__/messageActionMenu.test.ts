import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { buildMobileMessageMenu } from '@/session/messageActionMenu';

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
      { id: 'add-to-chat', label: '添加到对话' },
      { id: 'copy-link', label: '复制当前消息链接' },
      { id: 'rewind', label: '回到此处' },
      { id: 'delete', label: '删除本条消息', destructive: true, separatorBefore: true },
    ]);
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
