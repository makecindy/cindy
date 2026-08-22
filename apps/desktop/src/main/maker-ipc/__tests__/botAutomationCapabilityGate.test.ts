import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeBotAutomation } from '../../../shared/botAutomationCapability';

/**
 * 「定时干活」的能力位归一,在 main 侧的落地检查。
 *
 * 背景:产品裁决 2026-08-19 把自动化定为标配,开关面下线,
 * `shared/botAutomationCapability.ts` 负责把**所有**读取口径归一成 `true`,并在
 * 注释里承诺「所有把 capabilities.automation 折算成布尔的地方都走这里」。
 *
 * 但 `bot-automation.ts` 的准入检查漏了这一条,留着裸的 `config.automation !== true`。
 * 存量 profile 的 capabilitiesJson 里仍然躺着 `"automation": false`,于是这些伙伴的
 * 设置页照常渲染并**启用**「新建 Routine」按钮,点下去必然抛错,错误文案还叫用户
 * 「先在 Bot Profile 里打开自动化」—— 那个开关已经不存在了,用户没有任何办法照做。
 * 一个点了就报错、报错还指向不存在的控件的按钮,就是要清掉的空头支票。
 *
 * `readBotAutomationPolicy` 是 create / update / pause / resume / run-now 五个入口
 * 的共同前置,直接跑它要拉起真实 DB;这里改用源码契约把「必须经过归一函数」钉死,
 * 成本低且正是回归会破坏的那一点。
 */
const automationSource = readFileSync(
  path.resolve(__dirname, '../bot-automation.ts'),
  'utf8',
);

describe('Bot 自动化准入', () => {
  it('归一函数对任何存量取值都放行', () => {
    expect(normalizeBotAutomation(false)).toBe(true);
    expect(normalizeBotAutomation(undefined)).toBe(true);
    expect(normalizeBotAutomation(null)).toBe(true);
    expect(normalizeBotAutomation('nonsense')).toBe(true);
  });

  it('准入检查经过归一函数，而不是裸比较 automation 字段', () => {
    expect(automationSource).toContain('normalizeBotAutomation(config.automation)');
    // 裸比较会让 automation:false 的存量伙伴永远建不了 Routine。
    expect(automationSource).not.toMatch(/config\.automation\s*!==\s*true/);
    expect(automationSource).not.toMatch(/config\.automation\s*===\s*false/);
  });

  it('权限门槛不受影响：trusted 仍然是真实前置', () => {
    // 这一条不是空头支票——UI 侧「新建」按钮本来就按 trusted 置灰，两边一致。
    expect(automationSource).toContain("config.permissions !== 'trusted'");
  });
});
