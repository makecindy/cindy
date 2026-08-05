import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMobileMessageMenu } from '@/session/messageActionMenu';

describe('mobile message action menu', () => {
  it('matches desktop order, natural language, and destructive grouping', () => {
    expect(buildMobileMessageMenu({
      canAddToChat: true,
      canCopyLink: true,
      canDelete: true,
      canFork: true,
      canRewind: true,
    })).toEqual([
      { id: 'fork', label: '在新对话中继续' },
      { id: 'add-to-chat', label: '添加到对话' },
      { id: 'copy-link', label: '复制当前对话链接' },
      { id: 'rewind', label: '回到此处' },
      { id: 'delete', label: '删除本条对话', destructive: true, separatorBefore: true },
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
