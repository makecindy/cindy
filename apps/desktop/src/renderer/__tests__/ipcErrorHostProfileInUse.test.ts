/*
 * 测试价值
 * - 生产入口与可观察结果：shared/ipcError.ts 的 mapIpcErrorToI18nKey（renderer 与 main 共用的公共映射）给出的
 *   i18n key；这几个 key 在 renderer 的 i18n 实例与 main 的 createMainI18n 里各自取到的文案。
 * - 规则：并存方案 A 的 D（审核方 2026-11-17 定）。Host 因单独运行的桌面版占用数据而拒绝时，消息是
 *   `[PRECONDITION_FAILED] HOST_PROFILE_IN_USE_BY_DESKTOP(_AT_START): …`；公共映射认出这个标记，给出说清原因与
 *   做法的 key。不带标记的一律照旧；只是碰巧出现 PRECONDITION_FAILED 或标记不在开头的，仍是原来的 key。
 *   两边取文案的语言文件是同一套（main/i18n.ts 读 renderer/i18n/locales/*\/common.json），12 种语言都要有，
 *   缺了用户会看到 key 名。
 * - 现有覆盖缺口：之前这个拒绝只映射到笼统的 ipcError.PRECONDITION_FAILED。
 * - 最小失败输入：带标记的 PRECONDITION_FAILED（原样、经 Electron 包装、typed 错误对象）。
 * - tier：unit（纯函数与语言包，无 IO）。
 */
import { describe, expect, it } from 'vitest';

import { createIpcError } from '../../shared/ipc-errors';
import { hostProfileInUseI18nKey, mapIpcErrorToI18nKey } from '../../shared/ipcError';
import { SUPPORTED_LOCALES } from '../../shared/locale';
import { createMainI18n } from '../../main/i18n';
import { i18n } from '@/i18n';

const WRAP = (text: string) => new Error(`Error invoking remote method 'maker:sessions:set-model': Error: ${text}`);
const KEYS = ['logic.errors.hostProfileInUseByDesktop', 'logic.errors.hostProfileInUseByDesktopRetry',
  'logic.errors.hostProfileInUseByDesktopAtStart'];

describe('mapIpcErrorToI18nKey · a Host refusal while a desktop app uses its data', () => {
  it('maps the marked refusal in every form it reaches a caller', () => {
    const running = 'HOST_PROFILE_IN_USE_BY_DESKTOP: In use by the desktop app.';
    const atStart = 'HOST_PROFILE_IN_USE_BY_DESKTOP_AT_START: Quit that app, then restart the Host.';
    for (const err of [new Error(`[PRECONDITION_FAILED] ${running}`), WRAP(`[PRECONDITION_FAILED] ${running}`),
      createIpcError('PRECONDITION_FAILED', running), `[PRECONDITION_FAILED] ${running}`]) {
      expect(mapIpcErrorToI18nKey(err)).toBe('logic.errors.hostProfileInUseByDesktopRetry');
    }
    for (const err of [new Error(`[PRECONDITION_FAILED] ${atStart}`), WRAP(`[PRECONDITION_FAILED] ${atStart}`),
      createIpcError('PRECONDITION_FAILED', atStart)]) {
      expect(mapIpcErrorToI18nKey(err)).toBe('logic.errors.hostProfileInUseByDesktopAtStart');
    }
    // A failed send says "send again"; the start refusal reads the same either way.
    expect(hostProfileInUseI18nKey(WRAP(`[PRECONDITION_FAILED] ${running}`), 'send')).toBe('logic.errors.hostProfileInUseByDesktop');
    expect(hostProfileInUseI18nKey(WRAP(`[PRECONDITION_FAILED] ${atStart}`), 'send')).toBe('logic.errors.hostProfileInUseByDesktopAtStart');
  });

  it('leaves every other error on the key it had before', () => {
    const cases: Array<[unknown, string, { namespace?: string; fallback?: string }?]> = [
      [new Error('[PRECONDITION_FAILED] The Host account is not ready'), 'ipcError.PRECONDITION_FAILED'],
      [WRAP('[PRECONDITION_FAILED] The Host account is not ready'), 'ipcError.PRECONDITION_FAILED'],
      // PRECONDITION_FAILED, with the marker only mentioned later in the text.
      [new Error('[PRECONDITION_FAILED] blocked: see HOST_PROFILE_IN_USE_BY_DESKTOP: docs'), 'ipcError.PRECONDITION_FAILED'],
      [new Error('[PRECONDITION_FAILED] HOST_PROFILE_IN_USE_BY_DESKTOPX: not the marker'), 'ipcError.PRECONDITION_FAILED'],
      // The marker under another code.
      [new Error('[INTERNAL] HOST_PROFILE_IN_USE_BY_DESKTOP: x'), 'ipcError.INTERNAL'],
      [createIpcError('NOT_FOUND', 'Source task is unavailable'), 'ipcError.NOT_FOUND'],
      [WRAP('[PERMISSION_DENIED] The Host refused this window'), 'ipcError.PERMISSION_DENIED'],
      [new Error('PRECONDITION_FAILED HOST_PROFILE_IN_USE_BY_DESKTOP: no brackets'), 'ipcError.unknown'],
      [WRAP('network down'), 'ipcError.unknown'],
      ['not an error', 'ipcError.unknown'],
      [new Error('[NOT_FOUND] gone'), 'settings.x.NOT_FOUND', { namespace: 'settings.x' }],
      [new Error('plain'), 'settings.fallback', { fallback: 'settings.fallback' }],
    ];
    for (const [err, key, options] of cases) expect(mapIpcErrorToI18nKey(err, options)).toBe(key);
  });

  it('has the words in all 12 languages, read the way the renderer and main each read them', async () => {
    await i18n.loadLanguages([...SUPPORTED_LOCALES]);
    for (const locale of SUPPORTED_LOCALES) {
      const main = createMainI18n(() => [locale]);
      for (const key of KEYS) {
        const text = i18n.getResource(locale, 'common', key);
        expect(typeof text === 'string' && text.trim().length > 0, `${locale} ${key} in the renderer`).toBe(true);
        expect(i18n.getFixedT(locale)(key)).toBe(text);
        expect(main.t(key), `${locale} ${key} in main`).toBe(text);
      }
    }
  });
});
