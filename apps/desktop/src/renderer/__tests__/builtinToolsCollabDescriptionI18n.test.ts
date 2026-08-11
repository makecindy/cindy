import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const expectedDescriptions = {
  'zh-CN': '关闭后仅影响后续新建的任务，不会中止当前 Worker；用于多 Worker 团队编排',
  'zh-TW': '關閉後僅影響後續新建的任務，不會中止當前 Worker；用於多 Worker 團隊編排',
  en: 'Turning it off only affects newly created sessions and does not stop active workers; supports multi-worker team orchestration',
  ja: 'オフにしても今後作成するセッションにのみ反映され、現在の Worker は停止しません。マルチ Worker のチーム編成に使用します',
  ko: '끄면 이후 새로 만드는 세션에만 적용되며 현재 Worker는 중지되지 않습니다. 멀티 Worker 팀 편성에 사용합니다',
} as const;

describe('built-in tools collaboration description i18n', () => {
  it('states that disabling collaboration only affects newly created sessions', () => {
    for (const [locale, expectedDescription] of Object.entries(expectedDescriptions)) {
      const localeFile = resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json');
      const translations = JSON.parse(readFileSync(localeFile, 'utf8')) as {
        settings?: { builtinTools?: { plugins?: { collab?: { description?: unknown } } } };
      };

      expect(translations.settings?.builtinTools?.plugins?.collab?.description, locale).toBe(
        expectedDescription,
      );
    }
  });
});
