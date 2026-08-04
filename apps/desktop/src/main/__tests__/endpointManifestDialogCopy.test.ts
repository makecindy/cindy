/**
 * 端点清单阻断框的四语文案与内容组装。
 *
 * 覆盖两件事:
 *  1. 文案完整性——四种语言的 key 集合一致、无空值,且**单语言输出**(这个框原先
 *     把中英两段拼在同一个 detail 里,用户看到一屏混排,是本次要修的现象);
 *  2. 组装规则——离线按钮只在「网络层失败 + 有可用缓存」时出现,choices 与 buttons
 *     一一对应(宿主按 index 取语义,错位就会把"退出"当成"重试")。
 */
import { describe, expect, it } from 'vitest';

import {
  ENDPOINT_MANIFEST_DIALOG_COPY,
  buildEndpointManifestDialogContent,
  type EndpointManifestDialogLocale,
} from '../endpointManifestDialogCopy';

const LOCALES: EndpointManifestDialogLocale[] = ['zh-CN', 'en', 'ja', 'ko'];

/** CJK 与拉丁字母混排检测用:排除产品名与占位符后还剩英文单词即视为混排。 */
function stripAllowedLatin(text: string): string {
  return text
    .replace(/\{\{\w+\}\}/g, ' ')
    .replace(/Cindy/g, ' ');
}

describe('端点清单弹框文案', () => {
  it('四种语言 key 集合一致且无空值', () => {
    const reference = Object.keys(ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN']).sort();
    for (const locale of LOCALES) {
      const copy = ENDPOINT_MANIFEST_DIALOG_COPY[locale];
      expect(Object.keys(copy).sort(), `${locale} key 集合`).toEqual(reference);
      for (const [key, value] of Object.entries(copy)) {
        expect(value.trim(), `${locale}.${key} 不得为空`).not.toBe('');
      }
    }
  });

  it('带占位的行都保留了自己的占位符', () => {
    for (const locale of LOCALES) {
      const copy = ENDPOINT_MANIFEST_DIALOG_COPY[locale];
      expect(copy.sourceLine).toContain('{{source}}');
      expect(copy.reasonLine).toContain('{{reason}}');
      expect(copy.diagnosisLine).toContain('{{diagnosis}}');
      expect(copy.logLine).toContain('{{path}}');
      expect(copy.offlineHint).toContain('{{savedAt}}');
    }
  });

  it('CJK 语言的文案不夹带英文句子(不再中英混排)', () => {
    for (const locale of ['zh-CN', 'ja', 'ko'] as const) {
      for (const [key, value] of Object.entries(ENDPOINT_MANIFEST_DIALOG_COPY[locale])) {
        const leftover = stripAllowedLatin(value);
        expect(/[A-Za-z]{3,}/.test(leftover), `${locale}.${key} 夹带英文:${value}`).toBe(false);
      }
    }
  });

  it('网络失败 + 有缓存:三个按钮,choices 与 buttons 对齐', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'zh-CN',
      kind: 'network',
      reason: 'fetch-failed:ERR_FAILED',
      source: 'https://cdn.example.com/endpoint.json',
      diagnosis: 'proxy=DIRECT dns=ok(1.2.3.4) tcp=ok(12ms)',
      logPath: '/tmp/logs',
      offlineSavedAt: '2026/7/29 06:22',
    });
    const copy = ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN'];
    expect(content.buttons).toEqual([
      copy.retryButton,
      copy.offlineButton,
      copy.quitButton,
    ]);
    expect(content.choices).toEqual(['retry', 'offline', 'exit']);
    expect(content.buttons).toHaveLength(content.choices.length);
    expect(content.defaultId).toBe(0);
    expect(content.cancelId).toBe(2);
    expect(content.message).toBe(copy.title);
    expect(content.detail).toContain('fetch-failed:ERR_FAILED');
    expect(content.detail).toContain('https://cdn.example.com/endpoint.json');
    expect(content.detail).toContain('proxy=DIRECT');
    expect(content.detail).toContain('/tmp/logs');
    expect(content.detail).toContain('2026/7/29 06:22');
  });

  it('网络失败但没有缓存:不出现离线按钮', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'en',
      kind: 'network',
      reason: 'fetch-failed:ERR_FAILED',
      source: 'https://cdn.example.com/endpoint.json',
      offlineSavedAt: null,
    });
    expect(content.choices).toEqual(['retry', 'exit']);
    expect(content.detail).not.toContain(
      ENDPOINT_MANIFEST_DIALOG_COPY.en.offlineHint.split('{{')[0],
    );
  });

  it('配置事故即使有缓存也不给离线出口', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'zh-CN',
      kind: 'config',
      reason: 'invalid-json',
      source: 'https://cdn.example.com/endpoint.json',
      offlineSavedAt: '2026/7/29 06:22',
    });
    expect(content.choices).toEqual(['retry', 'exit']);
    expect(content.detail).toContain(ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN'].configBody);
    expect(content.detail).not.toContain('2026/7/29 06:22');
  });

  it('诊断与日志缺失时不留空行占位', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'zh-CN',
      kind: 'network',
      reason: 'fetch-failed',
      source: 'https://cdn.example.com/endpoint.json',
      diagnosis: null,
      logPath: null,
      offlineSavedAt: null,
    });
    expect(content.detail).not.toContain('{{');
    expect(content.detail.split('\n').filter((line) => line === '')).toHaveLength(1);
  });
});
