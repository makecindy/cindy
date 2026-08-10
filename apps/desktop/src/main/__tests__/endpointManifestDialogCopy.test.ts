/**
 * 端点清单阻断框的多语文案与内容组装。
 *
 * 覆盖两件事:
 *  1. 文案完整性——各语言的 key 集合一致、无空值,且**单语言输出**(这个框原先
 *     把中英两段拼在同一个 detail 里,用户看到一屏混排,是本次要修的现象);
 *  2. 组装规则——离线按钮只在「网络层失败 + 有可用缓存」时出现,choices 与 buttons
 *     一一对应(宿主按 index 取语义,错位就会把"退出"当成"重试")。
 */
import { describe, expect, it } from 'vitest';

import {
  ENDPOINT_MANIFEST_DIALOG_COPY,
  buildEndpointManifestDiagnosticsText,
  buildEndpointManifestDialogContent,
  formatEndpointManifestVisibleError,
  type EndpointManifestDialogLocale,
} from '../endpointManifestDialogCopy';

const LOCALES: EndpointManifestDialogLocale[] = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'];

/** CJK 与拉丁字母混排检测用:排除产品名、已裁决术语与占位符后仍有英文单词即视为混排。 */
function stripAllowedLatin(text: string): string {
  return text.replace(/\{\{\w+\}\}/g, ' ').replace(/Cindy|Proxy/g, ' ');
}

describe('端点清单弹框文案', () => {
  it('全部语言 key 集合一致且无空值', () => {
    const reference = Object.keys(ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN']).sort();
    for (const locale of LOCALES) {
      const copy = ENDPOINT_MANIFEST_DIALOG_COPY[locale];
      expect(Object.keys(copy).sort(), `${locale} key 集合`).toEqual(reference);
      for (const [key, value] of Object.entries(copy)) {
        expect(value.trim(), `${locale}.${key} 不得为空`).not.toBe('');
      }
    }
  });

  it('动态文案保留自己的占位符', () => {
    for (const locale of LOCALES) {
      const copy = ENDPOINT_MANIFEST_DIALOG_COPY[locale];
      expect(copy.offlineHint).toContain('{{savedAt}}');
      expect(copy.errorLine).toContain('{{error}}');
    }
  });

  it('CJK 语言的文案不夹带英文句子(不再中英混排)', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'ja', 'ko'] as const) {
      for (const [key, value] of Object.entries(ENDPOINT_MANIFEST_DIALOG_COPY[locale])) {
        const leftover = stripAllowedLatin(value);
        expect(/[A-Za-z]{3,}/.test(leftover), `${locale}.${key} 夹带英文:${value}`).toBe(false);
      }
    }
  });

  it('网络失败 + 有缓存:复制诊断与离线出口都出现,choices 与 buttons 对齐', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'zh-CN',
      kind: 'network',
      reason: 'fetch-failed:ERR_CONNECTION_RESET',
      offlineSavedAt: '2026/7/29 06:22',
    });
    const copy = ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN'];
    expect(content.buttons).toEqual([
      copy.retryButton,
      copy.copyDiagnosticsButton,
      copy.offlineButton,
      copy.quitButton,
    ]);
    expect(content.choices).toEqual(['retry', 'copy-diagnostics', 'offline', 'exit']);
    expect(content.buttons).toHaveLength(content.choices.length);
    expect(content.defaultId).toBe(0);
    expect(content.cancelId).toBe(3);
    expect(content.message).toBe(copy.networkTitle);
    expect(content.detail).toContain(copy.networkBody);
    expect(content.detail).toContain('ERR_CONNECTION_RESET');
    expect(content.detail).toContain('2026/7/29 06:22');
  });

  it('网络失败但没有缓存:不出现离线按钮', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'en',
      kind: 'network',
      reason: 'fetch-failed:ERR_CONNECTION_RESET',
      offlineSavedAt: null,
    });
    expect(content.choices).toEqual(['retry', 'copy-diagnostics', 'exit']);
    expect(content.detail).toContain(ENDPOINT_MANIFEST_DIALOG_COPY.en.noSavedConfigurationHint);
    expect(content.detail).not.toContain(
      ENDPOINT_MANIFEST_DIALOG_COPY.en.offlineHint.split('{{')[0],
    );
  });

  it('配置事故即使有缓存也不给离线出口', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'zh-CN',
      kind: 'config',
      reason: 'invalid-json',
      offlineSavedAt: '2026/7/29 06:22',
    });
    expect(content.choices).toEqual(['retry', 'copy-diagnostics', 'exit']);
    expect(content.message).toBe(ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN'].configTitle);
    expect(content.detail).toContain(ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN'].configBody);
    expect(content.detail).not.toContain('2026/7/29 06:22');
  });

  it('可见文案展示简短错误信息,不暴露来源、诊断或本机路径', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'zh-CN',
      kind: 'network',
      reason: 'fetch-failed:ERR_CONNECTION_RESET',
      source: 'https://cdn.example.com/endpoint.json',
      diagnosis: 'proxy=DIRECT dns=ok(1.2.3.4)',
      logPath: '/Users/example/Library/Logs/Cindy/capture.json',
      offlineSavedAt: null,
    });
    expect(content.detail).not.toContain('{{');
    expect(content.detail).toContain(ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN'].networkBody);
    expect(content.detail).toContain('错误信息：ERR_CONNECTION_RESET');
    expect(content.detail).not.toContain('fetch-failed:');
    expect(content.detail).not.toContain('cdn.example.com');
    expect(content.detail).not.toContain('proxy=DIRECT');
    expect(content.detail).not.toContain('/Users/example');
    expect(content.diagnosticsText).toContain('ERR_CONNECTION_RESET');
    expect(content.diagnosticsText).toContain('cdn.example.com');
    expect(content.diagnosticsText).toContain('proxy=DIRECT');
    expect(content.diagnosticsText).toContain('/Users/example');
  });

  it('可见错误去掉 fetch-failed 包装,配置错误保持原值', () => {
    expect(formatEndpointManifestVisibleError('fetch-failed:ERR_CONNECTION_RESET')).toBe(
      'ERR_CONNECTION_RESET',
    );
    expect(formatEndpointManifestVisibleError('invalid-json')).toBe('invalid-json');
  });

  it('诊断文本缺失可选字段时使用 n/a,不留 undefined', () => {
    const text = buildEndpointManifestDiagnosticsText({
      kind: 'config',
      reason: 'invalid-json',
    });
    expect(text).not.toContain('undefined');
    expect(text).toContain('reason=invalid-json');
    expect(text).toContain('source=n/a');
  });

  it('复制失败时展示可见失败反馈,不误报为已复制', () => {
    const content = buildEndpointManifestDialogContent({
      locale: 'zh-CN',
      kind: 'network',
      reason: 'fetch-failed:ERR_CONNECTION_RESET',
      copyStatus: 'failed',
      offlineSavedAt: null,
    });

    expect(content.detail).toContain(ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN'].copyFailedHint);
    expect(content.detail).not.toContain(ENDPOINT_MANIFEST_DIALOG_COPY['zh-CN'].copiedHint);
  });
});
