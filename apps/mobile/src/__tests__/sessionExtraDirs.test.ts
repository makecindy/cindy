import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  appendSessionExtraDirDraft,
  formatExtraDirsText,
  hasExtraDirsDraftChanged,
  parseSessionExtraDirsDraft,
  summarizeExtraDirs,
} from '@/session/sessionExtraDirs';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('session extraDirs controls', () => {
  it('formats mirrored session extraDirs for the mobile text area', () => {
    expect(formatExtraDirsText([' /repo/docs ', '/repo/docs', '', '/repo/tools'])).toBe('/repo/docs\n/repo/tools');
    expect(formatExtraDirsText(null)).toBe('');
  });

  it('parses draft text with the same de-dupe rules as new-session create args', () => {
    expect(parseSessionExtraDirsDraft(' /repo/docs\n/repo/tools, /repo/docs\n\n')).toEqual([
      '/repo/docs',
      '/repo/tools',
    ]);
  });

  it('appends remote browser selections without duplicating existing paths', () => {
    expect(appendSessionExtraDirDraft('/repo/docs', ' /repo/tools ')).toBe('/repo/docs\n/repo/tools');
    expect(appendSessionExtraDirDraft('/repo/docs\n/repo/tools', '/repo/docs')).toBe('/repo/docs\n/repo/tools');
  });

  it('detects whether the draft changed from the controlled-side accepted list', () => {
    expect(hasExtraDirsDraftChanged('/repo/docs\n/repo/tools', ['/repo/docs', '/repo/tools'])).toBe(false);
    expect(hasExtraDirsDraftChanged('/repo/docs\n/repo/more', ['/repo/docs', '/repo/tools'])).toBe(true);
  });

  it('summarizes the accepted list for the collapsed mobile controls', () => {
    expect(summarizeExtraDirs(['/repo/docs', '/repo/tools'])).toBe('当前 2 个附加目录');
    expect(summarizeExtraDirs([])).toBe('当前没有附加目录');
  });
});
