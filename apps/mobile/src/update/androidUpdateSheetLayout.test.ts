import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'AndroidUpdateSheet.tsx'), 'utf8');

describe('Android update sheet layout', () => {
  it('stretches the measured native card and footer actions to the sheet width', () => {
    expect(source).toMatch(/card:\s*\{[^}]*alignSelf: 'stretch'[^}]*width: '100%'/s);
    expect(source).toMatch(/actions:\s*\{[^}]*width: '100%'/s);
  });
});
