/** Turnstile token 官方上限(与桌面 IPC 界校验、服务端 schema 同值)。 */
const MAX_CAPTCHA_TOKEN_LENGTH = 2048;

/**
 * 挑战页 postMessage 回传 payload 解析(wire 契约,与 auth-server 托管页内联
 * 脚本对齐;桌面宿主走 location.hash 通道,见 desktop LoginCaptchaOverlay)。
 * 纯函数、零 RN 依赖:node vitest 直接单测(LoginCaptchaWebView 组件本体因
 * react-native 依赖链不宜在 node 环境加载)。
 */
export function parseCaptchaWebViewMessage(
  raw: string,
): { ok: true; token: string } | { ok: false; code: string } | null {
  let data: { type?: unknown; ok?: unknown; token?: unknown; code?: unknown };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return null;
  }
  if (data.type !== 'cindy-captcha') return null;
  if (
    data.ok === true &&
    typeof data.token === 'string' &&
    data.token.length > 0 &&
    data.token.length <= MAX_CAPTCHA_TOKEN_LENGTH
  ) {
    return { ok: true, token: data.token };
  }
  if (data.ok === false) {
    return { ok: false, code: typeof data.code === 'string' ? data.code : 'unknown' };
  }
  return null;
}
