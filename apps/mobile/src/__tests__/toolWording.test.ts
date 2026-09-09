import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import { createMobileToolRowWording } from '@/i18n/toolWording';
import {
  summarizeToolRowPresentation,
  summarizeWorkGroupPresentation,
} from '@/session/messagePresentation';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import type { MobileWorkGroupItem } from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';

function source(id: string, content: unknown = {}): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 's1',
    role: 'tool_use',
    content,
    toolUseId: id,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function tool(id: string, patch: Partial<NormalizedRemoteMessage> = {}): NormalizedRemoteMessage {
  return {
    key: id,
    source: source(id),
    kind: 'tool',
    role: 'tool_use',
    label: 'Read',
    body: 'Read(/repo/src/app.ts)',
    align: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

const readTool = tool('read-1', {
  source: source('read-1', { toolName: 'Read', input: { file_path: '/repo/src/app.ts' } }),
});

const multiFileChange = tool('change-1', {
  source: source('change-1', {
    toolName: 'file_change',
    input: {
      changes: [
        { path: '/repo/a.ts', kind: { type: 'update' }, diff: '-a\n+b' },
        { path: '/repo/b.ts', kind: { type: 'add' }, diff: '+b' },
      ],
    },
  }),
});

const workGroup: MobileWorkGroupItem = {
  type: 'work_group',
  key: 'work-1',
  durationMs: 65_000,
  children: [],
};

async function withLanguage<T>(language: string, run: () => T | Promise<T>): Promise<T> {
  const previous = i18n.language;
  await i18n.changeLanguage(language);
  try {
    return await run();
  } finally {
    await i18n.changeLanguage(previous);
  }
}

/**
 * fileChange 多文件短语必须整句取词:ja 语序是「N ファイルを更新」、ko 是
 * 「파일 N개 업데이트」,按「动词 + 文件数」拼接会拼出不成句的
 * 「更新 2 ファイル」/「업데이트 파일 2개」。
 */
describe('多文件 fileChange 短语按语言整句取词', () => {
  const expected: Record<string, string> = {
    en: 'Updated 2 files',
    'zh-CN': '更新 2 个文件',
    'zh-TW': '更新 2 個檔案',
    ja: '2 ファイルを更新',
    ko: '파일 2개 업데이트',
  };

  for (const [locale, label] of Object.entries(expected)) {
    it(`${locale} → ${label}`, async () => {
      await withLanguage(locale, () => {
        const wording = createMobileToolRowWording();
        expect(summarizeToolRowPresentation(multiFileChange, { wording }).label).toBe(label);
      });
    });
  }
});

describe('mobile tool/work-group wording', () => {
  it('uses English catalog verbs and work-group titles', async () => {
    await withLanguage('en', () => {
      const wording = createMobileToolRowWording();
      const row = summarizeToolRowPresentation(readTool, { wording });
      expect(row.label).toBe('Read app.ts');
      expect(row.label).not.toContain('读取');

      expect(summarizeWorkGroupPresentation(workGroup, mobilePresentationLocalizer).title)
        .toBe('Worked for 1m 5s');
      expect(summarizeWorkGroupPresentation(
        { ...workGroup, isStreaming: true },
        mobilePresentationLocalizer,
      ).title).toBe('Working…');
      expect(summarizeWorkGroupPresentation(
        { ...workGroup, durationMs: undefined, isStreaming: false },
        mobilePresentationLocalizer,
      ).title).toBe('Work details');
    });
  });

  it('uses zh-CN catalog verbs and work-group titles', async () => {
    await withLanguage('zh-CN', () => {
      const wording = createMobileToolRowWording();
      const row = summarizeToolRowPresentation(readTool, { wording });
      expect(row.label).toBe('读取 app.ts');

      expect(summarizeWorkGroupPresentation(workGroup, mobilePresentationLocalizer).title)
        .toBe('已工作 1m 5s');
      expect(summarizeWorkGroupPresentation(
        { ...workGroup, isStreaming: true },
        mobilePresentationLocalizer,
      ).title).toBe('正在工作…');
      expect(summarizeWorkGroupPresentation(
        { ...workGroup, durationMs: undefined, isStreaming: false },
        mobilePresentationLocalizer,
      ).title).toBe('工作过程');
    });
  });
});
