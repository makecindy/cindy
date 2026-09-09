/**
 * DS-4 第一批 component 角色：只随 Button 消费建立，不预先铺设。
 * 依赖单向 component → semantic → reference。
 *
 * 本层刻意很薄：DS-4 的 hover / pressed 值是 color-mix 运行期派生
 * （见 colors.ts 的 DS-4 注释——暗色下 surface-hover 与 surface-chip 同值，
 * alias 会让悬停不可见），按治理合同 §3.4「运行时派生值不迁」只在
 * classification.json 登记为 runtime-derived-or-protected，不进 DTCG。
 * 唯一可建模的是 button-cta-hover：它是对 semantic 角色 accent-hover 的
 * 纯 alias，DS-8 生成时能落回 semantic。
 * rest 态填充按治理合同 §3.3「Primitive 默认只绑定 semantic 角色」由组件直接
 * 消费 Tier-1 slot，不再复制一层 component token。
 */
export type ComponentGroup = 'button';

export interface ComponentRole {
  id: string;
  group: ComponentGroup;
}

export const COMPONENT_ROLES: readonly ComponentRole[] = [
  { id: 'button-cta-hover', group: 'button' },
] as const;

export const COMPONENT_ROLE_IDS = new Set(COMPONENT_ROLES.map((role) => role.id));

/**
 * DS-4 的运行期派生状态值：只登记存在与去向（治理合同 §3.4），不建模。
 * 守卫测试据此断言它们确实落在 runtime-derived-or-protected 分类里，
 * 防止有人日后把它们悄悄改成字面量又不登记。
 */
export const RUNTIME_DERIVED_BUTTON_STATE_IDS = [
  'button-primary-hover',
  'button-primary-pressed',
  'button-secondary-hover',
  'button-secondary-pressed',
  'button-cta-pressed',
] as const;
