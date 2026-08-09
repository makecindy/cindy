import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, '..', 'CodexAutomationImportDialog.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('CodexAutomationImportDialog spinner contract', () => {
  it('uses the shared HTML-wrapper Spinner for both loading states', () => {
    expect(source).toContain("import { Spinner } from '@/components/ui/spinner';");
    expect(source).toContain('<Spinner size={16} />');
    expect(source).toContain('<Spinner size={13} />');
    expect(source).not.toMatch(/<Loader2[^>]*animate-spin/);
  });
});
