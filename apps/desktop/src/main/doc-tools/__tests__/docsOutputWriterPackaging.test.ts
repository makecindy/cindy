import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(__dirname, '../../../..');

describe('docs output writer packaging', () => {
  it('ships the cwd-bound utility entry and forks that packaged file', () => {
    const forge = readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    const controller = readFileSync(
      path.join(desktopRoot, 'src/main/doc-tools/docsOutputWriter.ts'),
      'utf8',
    );
    expect(forge).toContain("entry: 'src/main/doc-tools/docsOutputWriterUtilityProcess.ts'");
    expect(controller).toContain("path.join(__dirname, 'docsOutputWriterUtilityProcess.js')");
    expect(controller).toContain('cwd: rootDir');
  });
});
