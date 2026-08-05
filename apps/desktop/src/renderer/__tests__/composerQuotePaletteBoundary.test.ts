import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('composer quote palette boundary wiring', () => {
  it('resets slash and mention trigger scanning at composer quote atoms', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
      'utf8',
    );
    const triggerStart = source.indexOf('function detectTrigger');
    const triggerEnd = source.indexOf('// Slash detection', triggerStart);
    const triggerSource = source.slice(triggerStart, triggerEnd);

    expect(triggerSource).toMatch(
      /child\.type\.name === 'mentionChip'\s*\|\|\s*child\.type\.name === COMPOSER_QUOTE_NODE_TYPE/,
    );
    expect(triggerSource).toContain("textSoFar = ''; // chips reset the @ / slash run");
  });
});
