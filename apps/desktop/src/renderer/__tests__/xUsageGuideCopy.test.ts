/**
 * X 用法与风险告知的四语言文案契约。
 *
 * 为什么需要专门一测:这一节的文案里有两样东西**没有任何编译期约束**,而写错的后果
 * 都是用户可见的 ——
 *
 *   1. **bot handle `@askmycindy` 硬编码在四份 locale 里。** 它不来自 binding:这一节
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
  en: (en as never as { settings: { remoteControl: { hook: { x: { guide: GuideCopy } } } } })
    .settings.remoteControl.hook.x.guide,
  ja: (ja as never as { settings: { remoteControl: { hook: { x: { guide: GuideCopy } } } } })
    .settings.remoteControl.hook.x.guide,
  ko: (ko as never as { settings: { remoteControl: { hook: { x: { guide: GuideCopy } } } } })
    .settings.remoteControl.hook.x.guide,
};

describe('X 用法与风险告知的四语言文案', () => {
  it('四份 locale 都齐全, 没有空串', () => {
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

  it('撤回说明都写出 /delete: 那是唯一四语通用的命令词', () => {
    for (const [loc, guide] of Object.entries(LOCALES)) {
      expect(guide.withdrawBody, `${loc}.withdrawBody 必须含 /delete`).toContain('/delete');
    }
  });

  it('中文命令词 /删除 只出现在 zh-CN: 对非中文用户是噪音', () => {
    expect(LOCALES['zh-CN'].withdrawBody).toContain('/删除');
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
