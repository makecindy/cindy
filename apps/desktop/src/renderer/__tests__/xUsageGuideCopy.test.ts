/**
 * X 用法与风险告知的多语言文案契约。
 *
 * 为什么需要专门一测:这一节的文案里有两样东西**没有任何编译期约束**,而写错的后果
 * 都是用户可见的 ——
 *
 *   1. **bot handle `@askmycindy` 硬编码在各 locale 里。** 它不来自 binding:这一节
 *      在用户还没绑定时就要显示(评估阶段最需要看到风险), 那时候拿不到 scopeName。
 *      改 handle 时四份都得改, 漏一份就会让那个语言的用户去 @ 一个不存在的账号。
 *      (硬编码是安全的: cn 与 global 两份 endpoint manifest 的 xHookWsUrl 指向同一个
 *      x-hook 服务, 也就是同一个 bot。)
 *   2. **`/删除` 只该出现在 zh-CN。** 中文命令词对非中文用户是噪音 —— 他们既不会打,
 *      也会被这串看不懂的字符干扰(Dash 2026-08-02 明确)。而服务端两个词都收, 所以
 *      少宣传一个不影响任何功能。
 *
 * 三组文案本身的准确性由 XUsageGuide 的注释与 HookConnectionsSection 的用例守着;
 * 这里只钉这两条「跨语言必须一致 / 必须不一致」的契约。
 */

import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

const BOT_HANDLE = '@askmycindy';

type GuideCopy = {
  usageLabel: string;
  usageBody: string;
  riskLabel: string;
  riskPublicBody: string;
  riskWorkdirBody: string;
  withdrawLabel: string;
  withdrawBody: string;
  ackTitle: string;
  ackConfirm: string;
};

const LOCALES: Record<string, GuideCopy> = {
  'zh-CN': (zhCN as never as { settings: { remoteControl: { hook: { x: { guide: GuideCopy } } } } })
    .settings.remoteControl.hook.x.guide,
  'zh-TW': (zhTW as never as { settings: { remoteControl: { hook: { x: { guide: GuideCopy } } } } })
    .settings.remoteControl.hook.x.guide,
  en: (en as never as { settings: { remoteControl: { hook: { x: { guide: GuideCopy } } } } })
    .settings.remoteControl.hook.x.guide,
  ja: (ja as never as { settings: { remoteControl: { hook: { x: { guide: GuideCopy } } } } })
    .settings.remoteControl.hook.x.guide,
  ko: (ko as never as { settings: { remoteControl: { hook: { x: { guide: GuideCopy } } } } })
    .settings.remoteControl.hook.x.guide,
};

describe('X 用法与风险告知的多语言文案', () => {
  it('所有 locale 都齐全, 没有空串', () => {
    for (const [loc, guide] of Object.entries(LOCALES)) {
      for (const [key, value] of Object.entries(guide)) {
        expect(typeof value, `${loc}.${key}`).toBe('string');
        expect(value.trim().length, `${loc}.${key} 不能为空`).toBeGreaterThan(0);
      }
    }
  });

  it('每份 locale 的用法说明都写出 bot handle: 漏一份就让那个语言的用户 @ 错账号', () => {
    for (const [loc, guide] of Object.entries(LOCALES)) {
      expect(guide.usageBody, `${loc}.usageBody 必须含 ${BOT_HANDLE}`).toContain(BOT_HANDLE);
    }
  });

  it('撤回说明都写出 /delete: 这是跨语言通用的命令词', () => {
    for (const [loc, guide] of Object.entries(LOCALES)) {
      expect(guide.withdrawBody, `${loc}.withdrawBody 必须含 /delete`).toContain('/delete');
    }
  });

  it('中文命令词按简繁中文展示, 对非中文用户不产生噪音', () => {
    expect(LOCALES['zh-CN'].withdrawBody).toContain('/删除');
    expect(LOCALES['zh-TW'].withdrawBody).toContain('/刪除');
    for (const loc of ['en', 'ja', 'ko']) {
      expect(LOCALES[loc].withdrawBody, `${loc} 不该提 /删除`).not.toContain('删除');
    }
  });

  it('风险那两条都点明了公开可见与默认工作目录', () => {
    // 这一节存在的理由。zh-CN 用关键词钉住, 其它语言只钉「两条都非空且互不相同」——
    // 关键词逐语言硬编码会变成翻译的枷锁, 而空/重复才是真正会丢信息的失败形态。
    expect(LOCALES['zh-CN'].riskPublicBody).toContain('公开');
    expect(LOCALES['zh-CN'].riskWorkdirBody).toContain('默认工作目录');
    for (const [loc, guide] of Object.entries(LOCALES)) {
      expect(guide.riskPublicBody, `${loc} 两条风险不得相同`).not.toBe(guide.riskWorkdirBody);
    }
  });

  it('确认按钮必须点名确认对象, 不能是泛化应答词', () => {
    // DESIGN.md §11.1「Actions = verb + object, never a bare verb」明确禁 Confirm /
    // OK / 确定 / 提交 这类无对象应答词, 并**点名 confirm-dialog 主按钮**必须带对象
    // ——「so they read correctly out of context」。这个按钮是风险告知的同意门, 被读屏
    // 单独播报时若只念「我明白」, 用户根本不知道自己在确认什么(#1347 review 由 codex
    // 指出 P2; 初版四语分别是「我明白」/ Got it / 了解しました / 이해했어요)。
    const BANNED: Record<string, readonly string[]> = {
      'zh-CN': ['我明白', '知道了', '确定', '提交'],
      'zh-TW': ['我明白', '知道了', '確定', '提交'],
      en: ['Got it', 'Got It', 'OK', 'Confirm'],
      ja: ['了解しました', 'OK'],
      ko: ['이해했어요', '확인'],
    };
    // 对象 = 风险本身。四语各自的说法, 比"长度下限"之类的代理判据准确。
    const OBJECT: Record<string, string> = {
      'zh-CN': '风险',
      'zh-TW': '風險',
      en: 'Risk',
      ja: 'リスク',
      ko: '위험',
    };
    for (const [loc, guide] of Object.entries(LOCALES)) {
      for (const word of BANNED[loc]) {
        expect(guide.ackConfirm, `${loc}.ackConfirm 不能是泛化应答词「${word}」`).not.toContain(
          word,
        );
      }
      expect(guide.ackConfirm, `${loc}.ackConfirm 必须点名确认对象（${OBJECT[loc]}）`).toContain(
        OBJECT[loc],
      );
    }
  });

  it('工作目录那条不能用方位指代: 同一份文案也渲染在弹窗里, 弹窗里没有目录选择器', () => {
    // XUsageGuide 被**两处**渲染:X 卡内的常驻小节, 以及首次绑定的确认门弹窗。
    // 卡内「下面设的默认工作目录」是对的(选择器就在下方), 但弹窗里下方只有撤回那组
    // 和确认按钮 —— 方位指代会把用户指向一个不存在的控件, 而这恰好是他最需要去
    // 检查/更改那个目录的时刻(#1347 review 由 codex 指出 P2)。
    //
    // 修法刻意选「与上下文无关的措辞」而不是给组件加 variant:这一节的设计前提就是
    // 「一份文案、两处渲染, 不各写一份」, 加 variant 等于把它想消掉的漂移风险请回来。
    const BANNED: Record<string, readonly string[]> = {
      'zh-CN': ['下面', '下方', '以下'],
      'zh-TW': ['下面', '下方', '以下'],
      en: ['below'],
      ja: ['下で', '以下'],
      ko: ['아래'],
    };
    for (const [loc, guide] of Object.entries(LOCALES)) {
      for (const word of BANNED[loc]) {
        expect(
          guide.riskWorkdirBody,
          `${loc}.riskWorkdirBody 不能出现方位指代「${word}」—— 弹窗里指不到东西`,
        ).not.toContain(word);
      }
    }
  });

  it('公开风险那条必须给出「适合 / 不适合」的判断, 不能只陈述事实', () => {
    // Dash 2026-08-02 的产品表态:光说「回复是公开的」用户还得自己推导该拿它干什么。
    // 要明确说这个功能适合公开地找答案、解决问题, **不适合处理私事**(有隐私暴露风险)。
    // 这是最容易在后续翻译润色里被抹平的一句 —— 抹平之后风险告知就退回纯事实陈述。
    expect(LOCALES['zh-CN'].riskPublicBody).toContain('不适合');
    expect(LOCALES['zh-CN'].riskPublicBody).toContain('隐私');
    // 其它语言只钉长度:能承载「事实 + 适用性判断」两句的下限, 比逐语言硬编码关键词
    // 稳(译法可以变, 但把两句压成一句必然掉到这个长度以下)。
    for (const [loc, guide] of Object.entries(LOCALES)) {
      expect(
        guide.riskPublicBody.length,
        `${loc}.riskPublicBody 短到不可能同时讲清事实与适用性`,
      ).toBeGreaterThan(40);
    }
  });
});
