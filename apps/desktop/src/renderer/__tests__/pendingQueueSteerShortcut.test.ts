import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pendingQueueSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'PendingQueuePanel.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('PendingQueuePanel steer shortcut contract', () => {
  it('routes Cmd/Ctrl+Enter on a queued row through the same steer path as the row action', () => {
    const shortcutHelper = extractBetween(
      pendingQueueSource,
      'function isPendingQueueSteerShortcut',
      'export function PendingQueuePanel',
    );
    const rowKeydownBlock = extractBetween(
      pendingQueueSource,
      'const handleRowKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {',
      'const handleDragHandleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {',
    );

    expect(shortcutHelper).toContain("event.key === 'Enter'");
    expect(shortcutHelper).toContain('event.metaKey || event.ctrlKey');
    expect(shortcutHelper).toContain('!event.nativeEvent.repeat');
    expect(rowKeydownBlock).toContain('isPendingQueueSteerShortcut(e)');
    expect(rowKeydownBlock).toContain('!canSteerRow || !onSteer || isSteering || isRowEditing');
    expect(rowKeydownBlock).toContain('e.preventDefault();');
    expect(rowKeydownBlock).toContain('e.stopPropagation();');
    expect(rowKeydownBlock).toContain('void onSteer(entry.clientId);');
  });

  it('keeps the drag handle from swallowing the row steer shortcut', () => {
    const dragKeydownBlock = extractBetween(
      pendingQueueSource,
      'const handleDragHandleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {',
      'if (dragDisabled || !onReorder) return;',
    );

    expect(dragKeydownBlock).toContain('if (isPendingQueueSteerShortcut(e)) return;');
  });

  it('exposes the shortcut in queue row accessibility and tooltip surfaces', () => {
    expect(pendingQueueSource).toContain("aria-keyshortcuts={canSteerRow ? 'Meta+Enter Control+Enter' : undefined}");
    expect(pendingQueueSource).toContain('steerShortcutLabel?: string;');
    expect(pendingQueueSource).toContain('`${base} · ${steerShortcutLabel}`');
    expect(chatInputSource).toContain('steerShortcutLabel={steerShortcutLabel}');
  });
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
