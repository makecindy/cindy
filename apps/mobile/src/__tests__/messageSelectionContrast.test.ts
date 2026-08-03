import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile message text selection contrast', () => {
  it('uses the themed interactive color rather than a low-contrast chip surface', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).not.toContain('selectionColor={colors.surfaceChip}');
    expect(source.match(/selectionColor=\{colors\.inputCaret\}/g)).toHaveLength(8);
  });
});
