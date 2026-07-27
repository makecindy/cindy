/**
 * skipLoginGate — 「跳过登录」入口的可用性门(纯函数,规则 9)。
 *
 * 背景(2026-07-27 P1):跳过登录会把路由门切到无账号主界面,而登录动作(discover /
 * 发码 / OAuth 回调完成)是异步的。若入口在登录未决时仍可点,迟到的登录结果会再写
 * user 并清「跳过」标记,最终落在无账号态还是账号态取决于异步完成顺序。
 *
 * 因此与桌面同入口一致地上**双保险**:组件收原生 `disabled`(交互禁用,视觉不变色,
 * 见 LoginSkipLoginLink)+ handler 内再验一次门(防将来接线退化)。桌面对应实现见
 * apps/desktop/src/renderer/components/login/LoginPage.tsx 的 `openLocalMode`
 * (`isLoading || localModePending` guard + `disabled` prop)。
 *
 * 口径:只看 auth 自身是否未决(`isBusy` / 未 `initialized`),**不看** mobile 配置缺失
 * (`getMobileConfigIssues()`)—— 跳过登录不发任何请求,配置缺失恰恰是用户最需要这个
 * 逃生入口的场景,不能被登录按钮那条 `disabled` 一并锁死。
 */

/** 判门所需的 auth 状态切片(只取会造成竞态的两项)。 */
export type SkipLoginGateState = {
  /** auth 是否有动作在飞(discover / 发码 / 社交登录 / OAuth 回调完成) */
  isBusy: boolean;
  /** auth 冷启动恢复是否已收敛(未收敛时本地态还可能被盘上值推翻) */
  initialized: boolean;
};

/** 入口是否应处于禁用态(交互禁用;视觉按文字按钮口径不变色)。 */
export function isSkipLoginDisabled({
  isBusy,
  initialized,
}: SkipLoginGateState): boolean {
  return isBusy || !initialized;
}

/**
 * 处理一次「跳过登录」点击:门开才进无账号态。
 *
 * 返回是否真的派发了(便于测试与将来埋点);`enterLocalMode` 的落盘失败按 store 的
 * best-effort 语义静默,不阻断本次进入主界面。
 */
export function requestSkipLogin(
  state: SkipLoginGateState & { enterLocalMode: () => Promise<void> },
): boolean {
  if (isSkipLoginDisabled(state)) return false;
  void state.enterLocalMode();
  return true;
}
