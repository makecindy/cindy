import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('slash palette empty-result keyboard guard', () => {
  it('captures Enter and Tab while the slash palette is open with no focused result', () => {
    const selectionBlock = chatInputSource.slice(
      chatInputSource.indexOf("case 'Enter':"),
      chatInputSource.indexOf("case 'Escape':", chatInputSource.indexOf("case 'Enter':")),
    );

    expect(selectionBlock).toContain('if (slashOpen) {');
    expect(selectionBlock).toContain('const focusedCommand = filteredCommands[slashFocus];');
    expect(selectionBlock).toContain('if (!focusedCommand) {');
    expect(selectionBlock).toContain("if (trigger.kind === 'slash') setSuppressedSlashAt(trigger.from);");
    expect(selectionBlock.indexOf('return true;')).toBeLessThan(
      selectionBlock.indexOf('if (\n              atOpen'),
    );
  });

  it('inserts the human command name so Pi runtime aliases stay off the display layer', () => {
    const insertBlock = chatInputSource.slice(
      chatInputSource.indexOf('const insertSlashCommand = useCallback'),
      chatInputSource.indexOf('const resolveEffectiveAtRange'),
    );
    expect(insertBlock).toContain('cmd.name');
    expect(insertBlock).not.toContain('slashCommandInvocationName');
  });
});
