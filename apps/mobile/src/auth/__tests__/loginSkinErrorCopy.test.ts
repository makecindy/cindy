import { describe, expect, it, vi } from "vitest";

/**
 * PR4a 错误文案行测试(SC-7 slice pr4a error-copy 族):
 * inventory §4.5 移动具名 14 码 + REGION_MISMATCH + UNKNOWN_CODE 兜底,
 * 逐码断言 5 语 catalog verbatim 路由(vi.mock expo-localization 轮换系统 locale,
 * authErrorText 走真实解析链)。皮肤层错误条消费 authErrorText 输出,
 * 文案权威在 loginMessages catalog(translation-review SHA 绑定)。
 */
const mockLanguageTag = { current: "en-US" };
vi.mock("expo-localization", () => ({
  getLocales: () => [{ languageTag: mockLanguageTag.current }],
}));

import {
  authErrorMessages,
  authErrorText,
  loginMessages,
  type LoginLocale,
} from "@/auth/loginMessages";
import { LOGIN_SCENARIO_ERROR_CODES } from "@cindy/auth-client/fixtures";

/** locale → 代表性系统 languageTag(catalog 解析规则全路径过一遍)。 */
const LOCALE_TAGS: Record<LoginLocale, string> = {
  "zh-CN": "zh-Hans-CN",
  "zh-TW": "zh-Hant-TW",
  en: "en-US",
  ja: "ja-JP",
  ko: "ko-KR",
};
const LOCALES = Object.keys(LOCALE_TAGS) as LoginLocale[];

/** 逐 locale 断言 authErrorText 命中 catalog verbatim(且非空、码间不串词)。 */
function expectCodeRoutedVerbatim(code: string) {
  const perLocale = authErrorMessages[code];
  expect(perLocale, `code=${code} 必须在 catalog 注册`).toBeTruthy();
  expect(Object.keys(perLocale).sort()).toEqual([...LOCALES].sort());
  // scenario 值域对齐:具名码必须能被 error:<endpoint>:<CODE> 场景驱动
  expect(
    (LOGIN_SCENARIO_ERROR_CODES as readonly string[]).includes(code),
    `code=${code} 应在附录 A error 场景值域内`,
  ).toBe(true);
  for (const locale of LOCALES) {
    mockLanguageTag.current = LOCALE_TAGS[locale];
    const text = authErrorText(code);
    expect(text, `code=${code} locale=${locale}`).toBe(perLocale[locale]);
    expect(text?.trim(), `code=${code} locale=${locale} 非空`).not.toBe("");
    expect(text, `code=${code} locale=${locale} 不落 fallback`).not.toBe(
      loginMessages[locale].errorFallback,
    );
  }
}

describe("loginSkin 错误文案 5 语(catalog verbatim 路由)", () => {
  it("INVALID_CODE:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("INVALID_CODE");
    expect(authErrorMessages.INVALID_CODE["zh-CN"]).toBe(
      "验证码无效或已过期。",
    );
  });

  it("INVALID_PARAMS:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("INVALID_PARAMS");
    expect(authErrorMessages.INVALID_PARAMS["zh-CN"]).toBe(
      "输入内容格式不正确。",
    );
  });

  it("CAPTCHA_REQUIRED:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("CAPTCHA_REQUIRED");
    expect(authErrorMessages.CAPTCHA_REQUIRED["zh-CN"]).toBe(
      "请先完成安全验证。",
    );
  });

  it("CAPTCHA_INVALID:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("CAPTCHA_INVALID");
    expect(authErrorMessages.CAPTCHA_INVALID["zh-CN"]).toBe(
      "安全验证未通过，请重试。",
    );
  });

  it("CAPTCHA_UNAVAILABLE:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("CAPTCHA_UNAVAILABLE");
    expect(authErrorMessages.CAPTCHA_UNAVAILABLE["zh-CN"]).toBe(
      "安全验证服务暂不可用，请稍后再试。",
    );
  });

  it("INVALID_AUTH_CODE:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("INVALID_AUTH_CODE");
    expect(authErrorMessages.INVALID_AUTH_CODE["zh-CN"]).toBe(
      "登录授权已过期，请重新发起。",
    );
  });

  it("INVALID_LOGIN_TICKET:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("INVALID_LOGIN_TICKET");
    expect(authErrorMessages.INVALID_LOGIN_TICKET["zh-CN"]).toBe(
      "身份选择已过期，请重新登录。",
    );
  });

  it("INVALID_BIND_TICKET:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("INVALID_BIND_TICKET");
    expect(authErrorMessages.INVALID_BIND_TICKET["zh-CN"]).toBe(
      "绑定流程已过期，请重新登录。",
    );
  });

  it("STATE_MISMATCH:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("STATE_MISMATCH");
    expect(authErrorMessages.STATE_MISMATCH["zh-CN"]).toBe(
      "登录状态校验失败，请重新登录。",
    );
  });

  it("REGION_MISMATCH:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("REGION_MISMATCH");
    expect(authErrorMessages.REGION_MISMATCH["zh-CN"]).toBe(
      "客户端区域与登录服务不匹配。",
    );
  });

  it("NETWORK_ERROR:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("NETWORK_ERROR");
    expect(authErrorMessages.NETWORK_ERROR["zh-CN"]).toBe(
      "网络连接失败，请检查网络后重试。",
    );
  });

  it("REQUEST_TIMEOUT:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("REQUEST_TIMEOUT");
    expect(authErrorMessages.REQUEST_TIMEOUT["zh-CN"]).toBe(
      "登录请求超时，请重试。",
    );
  });

  it("USER_CANCELLED:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("USER_CANCELLED");
    expect(authErrorMessages.USER_CANCELLED["zh-CN"]).toBe("已取消登录。");
  });

  it("SOCIAL_PROVIDER_NOT_CONFIGURED:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("SOCIAL_PROVIDER_NOT_CONFIGURED");
    expect(authErrorMessages.SOCIAL_PROVIDER_NOT_CONFIGURED["zh-CN"]).toBe(
      "该登录方式尚未完成配置。",
    );
  });

  it("SOCIAL_PROVIDER_UNAVAILABLE:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("SOCIAL_PROVIDER_UNAVAILABLE");
    expect(authErrorMessages.SOCIAL_PROVIDER_UNAVAILABLE["zh-CN"]).toBe(
      "当前设备无法使用该登录方式。",
    );
  });

  it("AUTH_REQUEST_FAILED:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("AUTH_REQUEST_FAILED");
    expect(authErrorMessages.AUTH_REQUEST_FAILED["zh-CN"]).toBe(
      "登录服务暂时不可用，请稍后重试。",
    );
  });

  it("ORG_SSO_NOT_FOUND:5 语 catalog verbatim 路由", () => {
    expectCodeRoutedVerbatim("ORG_SSO_NOT_FOUND");
    expect(authErrorMessages.ORG_SSO_NOT_FOUND["zh-CN"]).toBe(
      "未找到该企业，或该企业未启用 SSO 登录。",
    );
  });

  it("UNKNOWN_CODE:未注册 wire code 逐 locale 回退 errorFallback,null 返回 null", () => {
    expect(authErrorMessages.UNKNOWN_CODE).toBeUndefined();
    for (const locale of LOCALES) {
      mockLanguageTag.current = LOCALE_TAGS[locale];
      expect(authErrorText("UNKNOWN_CODE"), locale).toBe(
        loginMessages[locale].errorFallback,
      );
    }
    mockLanguageTag.current = "zh-Hans-CN";
    expect(authErrorText("UNKNOWN_CODE")).toBe("登录未完成，请重试。");
    expect(authErrorText(null)).toBeNull();
  });
});
