/**
 * compactionStormErrorCopy.test.ts
 * ---------------------------------------------------------------------------
 * 压缩风暴熔断的两条 reason 与其本地化文案。
 *
 * 背景(Codex review):ErrorBanner / ErrorMessageCard 拿 reason 查 i18n key 后
 * **完全覆盖** maker-core 合成的 message(`displayError = key ? t(key) : error`)。
 * 所以 maker-core 那边"没有切换证据就不猜原因"的兜底 message 在 UI 上根本看不到 ——
 * 只要两种情形共用一个 reason,没切过模型(或 A→B→A 已切回)的用户照样会读到
 * 「本任务中途切换过模型…切回原模型可以继续」这种无从执行的指令。
 *
 * 这组用例锁住:两条 reason 各有独立 key,且**通用那条的四语文案不得出现切模型
 * 断言或"切回原模型"指令**。纯静态数据断言,node env。
 */

import { describe, it, expect } from 'vitest';

import { ERROR_REASON_I18N_KEYS } from '@/components/chat/errorReasonI18n';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';

// 与 packages/maker-core/src/agents/codex/compaction-storm.ts 的常量一致。
// 这里刻意写字面量而不是 import:renderer 不依赖 maker-core,而 reason 是跨进程的
// wire 值 —— 字面量对不上就说明有一侧改了没同步,正是要拦的事。
const REASON_GENERIC = 'codex_compaction_not_converging';
const REASON_MODEL_SWITCH = 'codex_compaction_not_converging_model_switch';

const LOCALES = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko } as Record<
  string,
  { logic: { errors: Record<string, string> } }
>;

/** 断言切模型的措辞 —— 通用文案里出现任何一个都是在无证据地指认原因。 */
const SWITCH_CLAIMS: Record<string, readonly string[]> = {
  en: ['switched model', 'Switch back', 'previous model'],
  'zh-CN': ['切换过模型', '切回原模型', '切换前'],
  'zh-TW': ['切換過模型', '切回原模型', '切換前'],
  ja: ['モデルを切り替え', '元のモデルに戻す', '切り替え前'],
  ko: ['모델을 변경', '원래 모델로', '변경 전'],
};

function copyFor(locale: string, reason: string): string {
  const key = ERROR_REASON_I18N_KEYS[reason];
  expect(key, `${reason} 必须有 i18n 映射`).toBeTruthy();
  // key 形如 'logic.errors.xxx' —— 取末段查 locale。
  const leaf = key.split('.').at(-1) as string;
  const text = LOCALES[locale].logic.errors[leaf];
  expect(text, `${locale} 缺少 ${key}`).toBeTruthy();
  return text;
}

describe('压缩风暴熔断的 reason → 文案映射', () => {
  it('两条 reason 各有独立的 i18n key', () => {
    const generic = ERROR_REASON_I18N_KEYS[REASON_GENERIC];
    const modelSwitch = ERROR_REASON_I18N_KEYS[REASON_MODEL_SWITCH];
    expect(generic).toBeTruthy();
    expect(modelSwitch).toBeTruthy();
    // 共用一个 key 等于没拆 —— 那正是这次要修的问题。
    expect(generic).not.toBe(modelSwitch);
  });

  it.each(Object.keys(LOCALES))('%s:通用文案不得断言切过模型', (locale) => {
    const text = copyFor(locale, REASON_GENERIC);
    for (const claim of SWITCH_CLAIMS[locale]) {
      expect(text, `${locale} 的通用文案不该出现「${claim}」—— 熔断时并没有切换证据`).not.toContain(
        claim,
      );
    }
  });

  it.each(Object.keys(LOCALES))('%s:切模型文案要点明切换并给出切回的出路', (locale) => {
    const text = copyFor(locale, REASON_MODEL_SWITCH);
    const claims = SWITCH_CLAIMS[locale];
    expect(
      claims.some((c) => text.includes(c)),
      `${locale} 的切模型文案应当点名切换过模型`,
    ).toBe(true);
  });

  it.each(Object.keys(LOCALES))('%s:两条文案都要给出可执行的下一步', (locale) => {
    // DESIGN.md §11.1「Errors = what happened + what to do」:两条都必须落到动作上。
    // 通用那条唯一能给的就是「新开一个任务」。
    const nextStep: Record<string, string> = {
      en: 'start a new task',
      'zh-CN': '新开一个任务',
      'zh-TW': '新開一個任務',
      ja: '新しいセッションを開始',
      ko: '새 세션을 시작',
    };
    for (const reason of [REASON_GENERIC, REASON_MODEL_SWITCH]) {
      expect(copyFor(locale, reason).toLowerCase()).toContain(nextStep[locale].toLowerCase());
    }
  });
});
