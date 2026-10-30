/**
 * unsupportedTextPreview.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for file chips that route to TextLightbox. PDF and other
 * non-text formats must fall back to the OS default app instead of mounting
 * the text previewer.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isTextPreviewSupported } from '../lib/textPreview';

const source = (relative: string) =>
  readFileSync(resolve(__dirname, '..', ...relative.split('/')), 'utf8');

describe('unsupported text preview guard', () => {
  it('allows text-like files and rejects non-text formats', () => {
    expect(isTextPreviewSupported('src/App.tsx')).toBe(true);
    expect(isTextPreviewSupported('debug.log')).toBe(true);
    expect(isTextPreviewSupported('data.csv')).toBe(true);
    expect(isTextPreviewSupported('Dockerfile')).toBe(true);
    expect(isTextPreviewSupported('LICENSE')).toBe(true);
    expect(isTextPreviewSupported('.gitignore')).toBe(true);

    expect(isTextPreviewSupported('spec.pdf')).toBe(false);
    expect(isTextPreviewSupported('photo.png')).toBe(false);
    expect(isTextPreviewSupported('archive.zip')).toBe(false);
  });

  it('fallback helper opens unsupported formats through the system app', () => {
    const src = source('lib/filePreview.ts');
    expect(src).toContain('isTextPreviewSupported(filePath)');
    expect(src).toContain('window.electronAPI.openPath(filePath)');
    expect(src).toContain('toast.error');
  });

  it('guards all TextLightbox entry points that can receive file chips', () => {
    const files = [
      'components/chat/UserMessage.tsx',
      'components/chat/UserAttachmentChip.tsx',
      'components/chat/MarkdownRenderer.tsx',
      'components/chat/ToolCallCard.tsx',
      'components/chat/AgentActionRow.tsx',
      'components/new-chat/ComposerAttachments.tsx',
    ];

    for (const file of files) {
      const src = source(file);
      expect(src).toContain('shouldOpenTextLightbox');
    }
  });
});
