import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/new-chat/ChatInput.tsx', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

describe('composer synthetic suggestion open contract', () => {
  it('device-link 远程草稿没有工作目录时不发起资源扫描', () => {
    const start = source.indexOf('const runAtScan = useCallback');
    const end = source.indexOf('const syntheticAtQuery', start);
    const scanner = source.slice(start, end);
    const guard = 'if (remoteDeviceId && !workingDir?.trim()) {';

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(scanner).toContain(guard);
    expect(scanner.indexOf(guard)).toBeLessThan(scanner.indexOf('scanAtResources('));
    expect(scanner).toContain("setAtState({ kind: 'ready', items: [], truncated: false });");
  });

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
