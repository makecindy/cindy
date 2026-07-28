// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';

import { InlineReferenceChip } from '@/components/chat/InlineReferenceChip';

afterEach(cleanup);

describe('InlineReferenceChip', () => {
  it('keeps one compact pill geometry with primary text and no close action', () => {
    const { container } = render(
      <InlineReferenceChip
        label="src/very-long-file-name.ts"
        icon={<File />}
      />,
    );
    const chip = container.querySelector('[data-inline-reference-chip]');
    expect(chip?.className).toContain('rounded-full');
    expect(chip?.className).toContain('gap-1.5');
    expect(chip?.className).toContain('text-[12px]');
    expect(chip?.className).toContain('px-2');
    expect(chip?.className).toContain('text-[var(--text-primary)]');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders sent/static chips without remove or drag controls', () => {
    const { container } = render(<InlineReferenceChip label="Static reference" />);
    const chip = container.querySelector('[data-inline-reference-chip]');
    expect(chip?.className).toContain('px-2');
    expect(screen.queryByRole('button')).toBeNull();
    expect(chip?.getAttribute('draggable')).toBeNull();
    expect(chip?.getAttribute('title')).toBeNull();
  });

  // 剪贴板契约。复制一段聊天消息时 Chromium 会把选区原样序列化进 text/html:
  //   - `<button>` 不在外部富文本编辑器(Slack / 飞书 / Notion)的粘贴白名单里,
  //     整个节点连同文字会被丢弃,只留下一个断行;
  //   - `user-select: none` 让文字连 text/plain 都进不了剪贴板。
  // 两条都会让用户复制出来的消息**缺内容**,所以固化成回归测试。
  it('stays a <span> even when interactive, so pasted HTML keeps the label', () => {
    const { container } = render(
      <InlineReferenceChip label="endpoint.json" onClick={() => {}} />,
    );
    const chip = container.querySelector('[data-inline-reference-chip]');
    expect(chip?.tagName).toBe('SPAN');
    expect(container.querySelector('button')).toBeNull();
    // 交互语义靠 role/tabIndex 补齐,不靠原生按钮元素。
    expect(chip?.getAttribute('role')).toBe('button');
    expect(chip?.getAttribute('tabindex')).toBe('0');
  });

  it('keeps chip text selectable by default, and only opts out for composer atoms', () => {
    const { container: sent } = render(<InlineReferenceChip label="sent.ts" />);
    expect(sent.querySelector('[data-inline-reference-chip]')?.className).not.toContain(
      'select-none',
    );

    const { container: composer } = render(
      <InlineReferenceChip label="composer.ts" textSelectable={false} />,
    );
    expect(composer.querySelector('[data-inline-reference-chip]')?.className).toContain(
      'select-none',
    );
  });

  it('activates on Enter and Space like the native button it replaced', async () => {
    const user = userEvent.setup();
    let clicks = 0;
    const { container } = render(
      <InlineReferenceChip label="endpoint.json" onClick={() => { clicks += 1; }} />,
    );
    const chip = container.querySelector('[data-inline-reference-chip]') as HTMLElement;
    chip.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(clicks).toBe(2);
  });
});
