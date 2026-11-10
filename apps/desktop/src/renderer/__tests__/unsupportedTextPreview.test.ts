/**
 * unsupportedTextPreview.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for file chips that route to TextLightbox. Non-text formats
 * use the unified type dispatcher instead of being decoded as text or silently
 * opened outside Cindy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isTextPreviewSupported } from '../lib/textPreview';
import { shouldOpenTextLightbox, shouldOpenTextLightboxForOrigin } from '../lib/filePreview';

afterEach(() => vi.unstubAllGlobals());

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

  it('routes non-text files through the in-app viewer without opening the system app', async () => {
    const openPath = vi.fn();
    vi.stubGlobal('window', { electronAPI: { openPath } });
    for (const filePath of ['spec.pdf', 'photo.png', 'archive.zip']) {
      expect(await shouldOpenTextLightbox(filePath)).toBe(true);
      expect(await shouldOpenTextLightboxForOrigin({ origin: { kind: 'local' }, workingDir: '/task' }, filePath)).toBe(true);
    }
    expect(await shouldOpenTextLightbox('')).toBe(false);
    expect(openPath).not.toHaveBeenCalled();
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
