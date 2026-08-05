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

  it('routes @ plugin selection through the shared command placement', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
      'utf8',
    );

    expect(source).toContain("type: 'plugin-command'");
    expect(source).toContain('placeGhostAtComposerStart(editor, ghost, installedGhostsRef.current)');
    expect(source).not.toContain('scanPluginAtResources');
  });

  it('records a scheduled mention query before reserving its scan sequence', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
      'utf8',
    );
    const guard = 'if (normalizedQuery === atLastScanQueryRef.current) return;';
    const record = 'atLastScanQueryRef.current = normalizedQuery;';
    const reserve = 'const seq = ++atScanSeqRef.current;';
    const effectStart = source.indexOf(guard, source.indexOf('// Derive query string'));

    expect(effectStart).toBeGreaterThan(-1);
    expect(source.indexOf(record, effectStart)).toBeLessThan(source.indexOf(reserve, effectStart));
  });
});
