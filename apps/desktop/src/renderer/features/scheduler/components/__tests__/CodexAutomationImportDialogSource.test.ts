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

  it('disables the footer close button while preview or import is busy', () => {
    expect(source).toContain('disabled={loading || importing}');
  });

  it('uses a translated fallback for unknown RRULE values', () => {
    expect(source).not.toContain("'RRULE ?'");
    expect(source).toContain("t('scheduler.codexImport.unknownRrule')");
  });

  it('defines the unknown RRULE fallback in every supported locale', async () => {
    const localeFiles = ['en', 'ja', 'ko', 'zh-CN'].map((locale) =>
      resolve(__dirname, '../../../../i18n/locales', locale, 'common.json'),
    );
    for (const localeFile of localeFiles) {
      const messages = JSON.parse(readFileSync(localeFile, 'utf8')) as {
        scheduler?: { codexImport?: { unknownRrule?: unknown } };
      };
      expect(typeof messages.scheduler?.codexImport?.unknownRrule).toBe('string');
    }
  });
});
