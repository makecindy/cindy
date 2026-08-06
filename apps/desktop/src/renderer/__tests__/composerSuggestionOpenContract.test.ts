import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/new-chat/ChatInput.tsx', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

describe('composer synthetic suggestion open contract', () => {
  it('打开 + 时保留同一 typed @ run 的 Esc suppression', () => {
    const start = source.indexOf('const handleComposerSuggestionOpenChange = useCallback');
    const end = source.indexOf('const composerSuggestionFocusTarget', start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain('setSuppressedAtAt(trigger.from);');
    expect(handler).not.toContain('setSuppressedAtAt(null);');
    expect(handler).toContain('setSyntheticAtAnchor(editor.state.selection.from);');
  });
});
