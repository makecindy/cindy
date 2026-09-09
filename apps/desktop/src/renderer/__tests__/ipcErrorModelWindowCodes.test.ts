import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';
import { extractIpcError, mapIpcErrorToI18nKey } from '../utils/ipcError';

const codes = [
  'MODEL_CONTEXT_USAGE_UNKNOWN',
  'MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN',
  'MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN',
  'MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED',
  'MODEL_WINDOW_PROTECTION_UNAVAILABLE',
  'MODEL_SWITCH_TASK_RUNNING',
  'MODEL_WINDOW_PREPARATION_IN_PROGRESS',
] as const;

const locales = { en, ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW } as const;

describe('model-window switch IPC errors', () => {
  it.each(codes)('decodes %s after Electron wraps the main-process error', (code) => {
    const error = new Error(
      `Error invoking remote method 'maker:set-model': Error: [${code}] internal detail`,
    );

    expect(extractIpcError(error)).toEqual({ code, message: 'internal detail' });
    expect(mapIpcErrorToI18nKey(error)).toBe(`ipcError.${code}`);
  });

  it('provides actionable copy for every supported Desktop locale', () => {
    for (const [locale, catalog] of Object.entries(locales)) {
      for (const code of codes) {
        expect(catalog.ipcError[code], `${locale}:${code}`).toEqual(expect.any(String));
        expect(catalog.ipcError[code].length, `${locale}:${code}`).toBeGreaterThan(20);
      }
      expect(
        catalog.newChat.chatInput.modelWindowUnknown.custom,
        `${locale}:custom recovery`,
      ).toContain('{{model}}');
      expect(
        catalog.newChat.chatInput.modelWindowUnknown.builtin,
        `${locale}:builtin recovery`,
      ).toContain('{{provider}}');
      expect(
        catalog.newChat.chatInput.modelWindowUnknown.openSettings,
        `${locale}:settings action`,
      ).toEqual(expect.any(String));
    }
    expect(zhCN.ipcError.MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN).toBe(
      '模型未切换：无法确认当前模型的上下文窗口。请检查自定义模型的窗口设置；若无法修改，请保留当前模型或新建任务',
    );
    expect(en.ipcError.MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN).toBe(
      'Model not switched: Cindy can’t verify the target model’s context window. Check the window setting for a custom model. If it can’t be changed, choose another model or start a new task.',
    );
    expect(zhCN.ipcError.MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED).toBe(
      '模型未切换：远程任务无法为更小的上下文窗口安全整理上下文。请保留当前模型，或新建任务后选择目标模型',
    );
  });
});
