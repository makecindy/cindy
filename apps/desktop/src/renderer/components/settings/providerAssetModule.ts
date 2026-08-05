/**
 * 供应商详情头下方「账户资产模块」的状态判定（纯函数，与渲染分离）。
 *
 * 这个槽位是通用的：网关账号填「可用余额 + 充值」，将来订阅账号可以填「当前套餐 +
 * 用量」。目前只有 Cindy AI 网关一种填充，判定逻辑先集中在这里，避免把三种互斥
 * 状态（不渲染 / 故障 / 有余额）散进 JSX 的嵌套三元里。
 *
 * 三种状态刻意区分开：
 *   - `hidden`：**本来就不该有**。org 账号（`canAccessBillingSettings` 同一判据）、
 *     local / 未登录、企业未开通网关，以及账户不支持余额查询。此时不显示「—」占位、
 *     也不留空的资产区 —— 卡片退化成标题行 + 状态 + 菜单。
 *   - `fault`：**本该有、这次拿不到**（凭据同步失败）。所以给一条故障说明 + 重试。
 *   - `balance`：正常态，标签 + 金额 + 右侧动作。
 *
 * 「不渲染」与「故障」的分野是这份判定存在的理由：把两者合成一个空态会让确实有钱
 * 的用户看不到恢复入口，把两者都给重试又会让 org 账号看到一个永远重试不出结果的
 * 按钮。
 */

import type { ModelAccessStatus } from '../../../shared/modelAccess';

export type ProviderAssetModuleState =
  { kind: 'hidden' } | { kind: 'fault' } | { kind: 'balance'; available: string };

export interface XdAssetModuleInput {
  /** `canAccessBillingSettings` 的结果：cloud + personal 才为 true。 */
  billingAccessible: boolean;
  /** 网关凭据自动下发的同步状态（useModelAccessStatus）。 */
  syncState: ModelAccessStatus['state'];
  /** 额度池账本里的可用余额（useModelAccessCreditUsage）；拿不到为 null。 */
  available: string | null;
}

export function resolveXdAssetModuleState(input: XdAssetModuleInput): ProviderAssetModuleState {
  const { billingAccessible, syncState, available } = input;
  // 企业账号 / 未登录 / local：整个余额与充值面都不属于这个账号，连故障态都不该有。
  if (!billingAccessible) return { kind: 'hidden' };
  // 企业未开通网关（unsupported）不是故障：没有可恢复的东西，给重试是假承诺。
  if (syncState === 'unsupported' || syncState === 'disabled') return { kind: 'hidden' };
  // 凭据没同步上 → 余额本该有但这次拿不到，给说明 + 重试。
  if (syncState === 'failed') return { kind: 'fault' };
  // 账户未开通余额 / 租户不提供余额查询 / 首次请求还没回来 → 什么都不渲染。
  if (available === null) return { kind: 'hidden' };
  return { kind: 'balance', available };
}
