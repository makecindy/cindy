/**
 * loginCaptchaGate — 登录邮箱发码人机验证闸的注册点。
 *
 * AuthContext.dispatchLoginAction 的「唯一邮箱方式自动发码」快捷链(discover
 * 返回 sole email_code 时内联派发 request-code)不经过 LoginPage 的
 * dispatchRequestCode,若不在此处过闸,global 开启 captcha 后这条链会不带
 * token 发码直接吃 400。挑战 overlay 属于 LoginPage 的视图层,经本模块注册
 * 回调借用——独立小模块而非放进 AuthContext,是为了 LoginPage 不必 import
 * 重量级的 AuthContext 模块图(单测下会拖入全部 store 依赖)。
 *
 * 返回语义:undefined = 本部署不需要人机验证,直接发码;string = 已取得
 * token;null = 用户取消挑战(调用方不发码,停在当前步)。
 */
export type LoginEmailCaptchaGate = () => Promise<string | null | undefined>;

let gate: LoginEmailCaptchaGate | null = null;

/** LoginPage 挂载时注册、卸载时置 null。 */
export function setLoginEmailCaptchaGate(value: LoginEmailCaptchaGate | null): void {
  gate = value;
}

export function getLoginEmailCaptchaGate(): LoginEmailCaptchaGate | null {
  return gate;
}
