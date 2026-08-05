import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

describe('persisted page zoom menu accelerators', () => {
  it('keeps both macOS zoom-in accelerator paths', () => {
    expect(bootstrapSource).toContain("'CommandOrControl+Plus'");
    expect(bootstrapSource).toContain("accelerator: 'CommandOrControl+='");
    expect(bootstrapSource).toContain('acceleratorWorksWhenHidden: true');
    expect(bootstrapSource).toContain("id: 'persisted-page-zoom-in-unshifted'");
  });
});
