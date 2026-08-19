/**
 * 「定时干活」在读取投影层一律归一为**开**。
 *
 * 产品裁决 2026-08-19:自动化是标配。建一条 Routine 就生效(创建门槛上一轮已经
 * 删掉),而 `capabilities.automation` 这个布尔仍然默认写 `false`,于是能力墙上
 * 「定时干活」常年显示「关」——一个和真实行为矛盾的假开关。开关面已经下线,
 * 剩下的字段只在**读取时**归一,不做 schema migration:
 *
 *  - 存量 profile 里 `automation: false` 的行原样留在库里,读出来按 `true` 用;
 *  - 新建伙伴与模板直接写 `true`;
 *  - 因此没有任何一条既有数据需要迁移,回滚到旧版本也只是回到旧的显示口径。
 *
 * 所有把 `capabilities.automation` 折算成布尔的地方(renderer 的两条 profile
 * 投影、main 的 profile 读取、runtime 快照、委派能力快照、scheduler 的 Routine
 * 执行计划)都走这里,避免某一处漏掉又变回「有的伙伴不能定时」。
 */

/** 新建伙伴 / 模板写入的值。 */
export const BOT_AUTOMATION_DEFAULT = true;

/**
 * 读取投影:任何取值都归一成 `true`。
 *
 * 参数刻意保留 —— 调用点因此仍然指向它原本读的那个字段,将来若要恢复成真
 * 开关,改这一个函数就够了,不必再去找七个散落的 `config.automation === true`。
 */
export function normalizeBotAutomation(_value: unknown): boolean {
  return true;
}
