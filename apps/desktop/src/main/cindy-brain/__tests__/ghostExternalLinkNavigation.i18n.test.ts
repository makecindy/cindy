import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;
const OPEN_WEBSITE_COPY = {
  'zh-CN': '打开网站',
  'zh-TW': '開啟網站',
  en: 'Open Website',
  ja: 'ウェブサイトを開く',
  ko: '웹사이트 열기',
} as const;

function readCopy(locale: (typeof LOCALES)[number]) {
  const path = resolve(__dirname, `../../../renderer/i18n/locales/${locale}/common.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as {
    ghostPanel?: {
      externalLinkConfirm?: {
        title?: string;
        message?: string;
        open?: string;
        cancel?: string;
      };
    };
  };
}

describe('Ghost 外链原生确认框 i18n', () => {
  it.each(LOCALES)('%s 补齐 main t() 消费的四个 key', (locale) => {
    expect(readCopy(locale).ghostPanel?.externalLinkConfirm).toEqual({
      title: expect.any(String),
      message: expect.any(String),
      open: expect.any(String),
      cancel: expect.any(String),
    });
  });

  it.each(LOCALES)('%s 主操作使用“动词 + 对象”文案', (locale) => {
    expect(readCopy(locale).ghostPanel?.externalLinkConfirm?.open).toBe(
      OPEN_WEBSITE_COPY[locale],
    );
  });

  it('zh-CN 使用已确认的精确文案', () => {
    expect(readCopy('zh-CN').ghostPanel?.externalLinkConfirm).toEqual({
      title: '是否要 Cindy 打开外部网站',
      message: '是否要 Cindy 打开外部网站',
      open: '打开网站',
      cancel: '取消',
    });
  });
});
