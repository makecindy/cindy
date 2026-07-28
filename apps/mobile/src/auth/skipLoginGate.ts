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
 * 口径:只看「会产出身份的动作是否未决」+ auth 冷启动是否已收敛,**不看** mobile 配置
 * 缺失(`getMobileConfigIssues()`)、**也不看** provider bootstrap 那类不产出身份的忙碌
 * —— 跳过登录不发任何请求,配置缺失 / 认证服务不可达恰恰是用户最需要这个逃生入口的
 * 场景,不能被登录按钮那条 `disabled` 一并锁死(2026-07-28 review P2)。
 */

/** 判门所需的 auth 状态切片(只取会造成竞态的两项)。 */
export type SkipLoginGateState = {
  /**
   * **会产出身份**的登录提交在飞(发码 / 验证码 / 社交 / SSO 回调完成 / 选择账号):
   * 这类动作落地会 `applyUser` 并清「跳过」标记,与跳过登录构成竞态,必须锁门。
   *
   * 刻意**不含** provider bootstrap(冷启动 `dispatch({type:'reset'})` →
   * `getProviders()`):它只填 `loginState`、永不产出身份,而它挂住 / 失败(离线、
   * 认证服务不可达)正是最需要逃生入口的时刻。调用方按「`isBusy` ∧ 已有 loginState」
   * 推导即可,不需要额外状态机(见 login.tsx 的 `skipDisabled`)。
   */
  loginSubmissionInFlight: boolean;
  /** auth 冷启动恢复是否已收敛(未收敛时本地态还可能被盘上值推翻) */
  initialized: boolean;
};

/** 入口是否应处于禁用态(交互禁用;视觉按文字按钮口径不变色)。 */
export function isSkipLoginDisabled({
  loginSubmissionInFlight,
  initialized,
}: SkipLoginGateState): boolean {
  return loginSubmissionInFlight || !initialized;
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
