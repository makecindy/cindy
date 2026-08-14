/**
 * 区域代号的跨机制一致性 —— 界面展示(走 i18n)与常量(走 CINDY_REGION_CODE)必须
 * 对同一个区域给出同一个代号,且各条消费链路之间不得互相漂移。
 *
 * 为什么需要专门一测:界面文案与常量走的是不同机制(界面按 DESIGN.md §16.3 要求走
 * i18n,便于日后改判为可译文案;issue 正文直接落常量,因为读者是维护者、不跟随界面
 * 语言)。机制不同就没有编译期约束——改了一边的取值、或新增区域 / 新增消费链路只补了
 * 一边,typecheck 与各自的单测都不会响。issue 链路还额外有「卡片展示的就是最终写进
 * issue 正文的内容」这条契约,漂移会直接骗到用户;侧栏版本行与登录页徽标则会让同一个
 * 构建在不同界面报出不同的区域身份。这一测就是补上那道缺失的信号。
 *
 * 当前覆盖三条消费链路:issue 提交确认卡片、侧栏用户卡片版本行、登录页标题旁区域
 * 徽标。**新增消费链路时把它的 i18n 命名空间加进 CONSUMERS 即可**,不要另写一份平行
 * 断言——漏进表就等于那条链路不受约束(2026-07-29 review 即因此漏掉登录页徽标)。
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import { CINDY_REGION_CODE, shouldLabelRegion } from '../../shared/regionCode';
import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

type Bundle = Record<string, unknown>;

const LOCALES: Record<string, Bundle> = {
  'zh-CN': zhCN as Bundle,
  'zh-TW': zhTW as Bundle,
  en: en as Bundle,
  ja: ja as Bundle,
  ko: ko as Bundle,
};

/** region → 多数链路的 i18n key 后缀(cn → regionCodeCn)。 */
function regionCodeKeyFor(region: string): string {
  return `regionCode${region.charAt(0).toUpperCase()}${region.slice(1)}`;
}

/**
 * 消费区域代号的各条链路:i18n key 所在对象 + 该链路的 key 命名。
 *
 * 登录页徽标的 key 命名与另两条不同(`login.regionPill.cn` 而非 `regionCodeCn`),
 * 所以 keyFor 可按链路覆盖。
 *
 * ⚠️ 本表只覆盖 **i18n bundle 侧**:某个区域在全部语言包里有没有 key、取值对不对。
 * 「组件里有没有真的引用到那个 key」是另一回事,由下面的 SOURCE_CONSUMERS 用源码
 * 字面量扫描覆盖(各组件都把 key 写成字面量分支而非动态拼接,为的是 `pnpm check:i18n`
 * 的静态提取能看到——正好也让这种扫描可行)。两者缺一都留口子:只有 bundle 就防不住
 * 组件漏引用,只有源码扫描就防不住 bundle 缺 key 或取值被译走。
 */
const CONSUMERS: ReadonlyArray<{
  label: string;
  prefix: string;
  pick: (b: Bundle) => Bundle;
  keyFor?: (region: string) => string;
}> = [
  {
    label: 'issue 提交确认卡片',
    prefix: 'issueAgent.confirm',
    pick: (b) => (b.issueAgent as { confirm: Bundle }).confirm,
  },
  {
    label: '侧栏用户卡片版本行',
    prefix: 'sidebar.user',
    pick: (b) => (b.sidebar as { user: Bundle }).user,
  },
  {
    label: '登录页标题旁区域徽标',
    prefix: 'login.regionPill',
    pick: (b) => (b.login as { regionPill: Bundle }).regionPill,
    keyFor: (region) => region,
  },
];

/** 取某条链路上该区域的 i18n key 名。 */
function keyOf(consumer: (typeof CONSUMERS)[number], region: string): string {
  return (consumer.keyFor ?? regionCodeKeyFor)(region);
}

/**
 * 各消费点组件源码 + 它引用 i18n key 的完整路径写法。
 *
 * 为什么要扫源码:三条链路的「哪个区域用哪个 key」都由组件自己维护(LoginPage 的
 * REGION_PILL_KEY 映射表、侧栏与 issue 卡片的三元字面量分支)。新增区域时只补了
 * CINDY_REGION_CODE 与多语 bundle、忘了补组件分支,上面的 bundle 断言照样全绿,而
 * 该区域在界面上拿不到文案 —— 这一组断言补的就是那道信号。
 */
const SOURCE_CONSUMERS: ReadonlyArray<{
  label: string;
  file: string;
  keyPathFor: (region: string) => string;
}> = [
  {
    label: '登录页标题旁区域徽标',
    file: 'components/login/LoginPage.tsx',
    keyPathFor: (region) => `login.regionPill.${region}`,
  },
  {
    label: '侧栏用户卡片版本行',
    file: 'components/sidebar/UserInfoSection.tsx',
    keyPathFor: (region) => `sidebar.user.${regionCodeKeyFor(region)}`,
  },
  {
    label: 'issue 提交确认卡片',
    file: 'features/cc-agent/IssueConfirmCard.tsx',
    keyPathFor: (region) => `issueAgent.confirm.${regionCodeKeyFor(region)}`,
  },
];

function readConsumerSource(file: string): string {
  return readFileSync(resolve(__dirname, '..', file), 'utf8');
}

describe('区域代号:界面 i18n 与常量一致', () => {
  it('有代号的区域: 每条链路的多语 i18n 值逐字等于常量,且不被翻译', () => {
    const labeled = Object.entries(CINDY_REGION_CODE).filter(([, code]) => code !== null);
    // 防塌陷:常量或消费链路被清空时下面的循环会变成空跑而全绿。
    expect(labeled.length).toBeGreaterThan(0);
    expect(CONSUMERS.length).toBeGreaterThan(0);
    for (const [region, code] of labeled) {
      for (const consumer of CONSUMERS) {
        for (const [locale, bundle] of Object.entries(LOCALES)) {
          const key = keyOf(consumer, region);
          expect(
            consumer.pick(bundle)[key],
            `${locale} 的 ${consumer.prefix}.${key}(${consumer.label})应为 ${code}(区域代号多语同文、不翻译)`,
          ).toBe(code);
        }
      }
    }
  });

  it('不标注的区域: 各链路所有语言都不得存在对应 key,避免出现「能显示但契约不写」的半套实现', () => {
    const unlabeled = Object.entries(CINDY_REGION_CODE).filter(([, code]) => code === null);
    expect(unlabeled.length).toBeGreaterThan(0);
    for (const [region] of unlabeled) {
      for (const consumer of CONSUMERS) {
        for (const [locale, bundle] of Object.entries(LOCALES)) {
          const key = keyOf(consumer, region);
          expect(
            consumer.pick(bundle)[key],
            `${locale} 不应有 ${consumer.prefix}.${key}——${region} 按产品规则不标注(DESIGN.md §16.3)`,
          ).toBeUndefined();
        }
      }
    }
  });

  it('global 不标是硬规则(DESIGN.md §16.3 不得回退),缺失 region 同样不标', () => {
    expect(CINDY_REGION_CODE.global).toBeNull();
    expect(shouldLabelRegion('global')).toBe(false);
    expect(shouldLabelRegion(undefined)).toBe(false);
    expect(shouldLabelRegion('cn')).toBe(true);
    expect(shouldLabelRegion('dev')).toBe(true);
  });

  it('每个消费点组件都真的引用了各自的 key —— 只补 bundle 不补组件分支要能被发现', () => {
    const labeled = Object.keys(CINDY_REGION_CODE).filter(
      (region) => CINDY_REGION_CODE[region as CindyRegion] !== null,
    );
    expect(labeled.length).toBeGreaterThan(0);
    expect(SOURCE_CONSUMERS.length).toBeGreaterThan(0);
    for (const consumer of SOURCE_CONSUMERS) {
      const source = readConsumerSource(consumer.file);
      for (const region of labeled) {
        const keyPath = consumer.keyPathFor(region);
        expect(
          source.includes(`'${keyPath}'`),
          `${consumer.file}(${consumer.label})应引用 '${keyPath}'——${region} 有代号却没在组件里落地,界面会拿不到文案`,
        ).toBe(true);
      }
    }
  });

  it('不标注的区域不得在任何消费点组件里出现 key 引用', () => {
    const unlabeled = Object.keys(CINDY_REGION_CODE).filter(
      (region) => CINDY_REGION_CODE[region as CindyRegion] === null,
    );
    expect(unlabeled.length).toBeGreaterThan(0);
    for (const consumer of SOURCE_CONSUMERS) {
      const source = readConsumerSource(consumer.file);
      for (const region of unlabeled) {
        const keyPath = consumer.keyPathFor(region);
        expect(
          source.includes(`'${keyPath}'`),
          `${consumer.file}(${consumer.label})不应引用 '${keyPath}'——${region} 按产品规则不标注(DESIGN.md §16.3)`,
        ).toBe(false);
      }
    }
  });

  it('未知 region 按不标处理 —— 表里取不到值时不得落进「有代号」分支', () => {
    // issue 链路的 region 来自 IPC payload,运行期不受 CindyRegion 类型保证。
    // 旧实现用 `!== null` 判定,undefined !== null 成立 → 未知区域被误判为要标注。
    for (const bogus of ['xx', 'GLOBAL', 'Cn', '', 'production']) {
      expect(
        shouldLabelRegion(bogus as CindyRegion),
        `未知 region ${JSON.stringify(bogus)} 必须 fail-closed 到不标注`,
      ).toBe(false);
    }
  });
});
