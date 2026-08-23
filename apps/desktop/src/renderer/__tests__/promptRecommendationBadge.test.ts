import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(__dirname, '..');
const chatInputSource = readFileSync(
  resolve(rendererRoot, 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);

describe('prompt recommendation shortcut badge', () => {
  it('keeps the prompt shrinkable while reserving space for a pill badge', () => {
    expect(chatInputSource).toContain('className="min-w-0 flex-1 truncate"');
    expect(chatInputSource).toContain(
      "'ml-1.5 inline-flex shrink-0 items-center rounded-full border'",
    );
  });

  it('uses the complete locale catalog for the visible key label', () => {
    expect(chatInputSource).toContain("t('newChat.chatInput.recommendationShortcut')");
    for (const locale of ['en', 'ja', 'ko', 'zh-CN', 'zh-TW']) {
      const catalog = JSON.parse(
        readFileSync(resolve(rendererRoot, 'i18n', 'locales', locale, 'common.json'), 'utf8'),
      ) as { newChat?: { chatInput?: { recommendationShortcut?: string } } };
      expect(catalog.newChat?.chatInput?.recommendationShortcut).toBe('Tab');
    }
  });
});
