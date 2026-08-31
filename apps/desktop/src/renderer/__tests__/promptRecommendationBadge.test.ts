import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(__dirname, '..');
const chatInputSource = readFileSync(
  resolve(rendererRoot, 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);

describe('prompt recommendation shortcut badge', () => {
  it('keeps a keycap badge beside the prompt while allowing long text to truncate', () => {
    expect(chatInputSource).toContain(
      "'pointer-events-none absolute left-0 top-0 inline-flex max-w-full min-w-0 items-center py-[3px]'",
    );
    expect(chatInputSource).toContain('className="min-w-0 truncate"');
    expect(chatInputSource).toContain(
      "'pointer-events-auto ml-1 inline-flex h-4 min-w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-current'",
    );
    expect(chatInputSource).toContain(
      "'bg-transparent px-0.5 text-11 font-normal leading-none text-inherit'",
    );
    expect(chatInputSource).toContain(
      "'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]'",
    );
    expect(chatInputSource).toContain('onMouseDown={(event) => event.preventDefault()}');
    expect(chatInputSource).toContain('onClick={acceptPromptRecommendation}');
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
