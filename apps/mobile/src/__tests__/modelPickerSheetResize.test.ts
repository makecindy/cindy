import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

describe('ModelPickerSheet window resize stability', () => {
  it('does not reset the open sheet when Android adjustResize changes window height', () => {
    const source = readTextLf(
      resolve(process.cwd(), 'src/session/ModelPickerSheet.tsx'),
      'utf8',
    );
    const resetEffect = source.match(
      /\/\/ 每次重新打开重置[\s\S]*?useEffect\(\(\) => \{[\s\S]*?\}\s*,\s*\[([^\]]*)\]\);/,
    );

    expect(resetEffect).not.toBeNull();
    expect(resetEffect?.[1]).not.toMatch(/\bwindowHeight\b/);
    expect(source).toContain('windowHeightRef.current = windowHeight;');
    expect(source).toContain('secondaryTranslate.setValue(windowHeightRef.current);');
  });
});
