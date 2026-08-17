import { describe, expect, it } from "vitest";

import { CindyAuthClient, AuthApiError } from "../../src/client.js";
import {
  reduceAuthFlow,
  soleAutoStartSsoMethod,
  soleLoginMethod,
  ssoOrgDiscoveryToMethods,
  type ProviderConfig,
} from "../../src/types.js";
import {
  CINDY_LOGIN_FIXTURE_SENTINEL,
  LOGIN_SCENARIO_ERROR_ENDPOINTS,
  createMalformedResponseFetch,
  createScenarioFetch,
  parseLoginScenario,
  resolveLoginScenarioFetch,
} from "../loginScenarios.js";

/**
 * Package 级 adapter 测试(implementation-plan Step 0 WHAT4):
 * 真实 CindyAuthClient + scenario fetch 全 endpoint 走查 + 附录 A 场景表逐行断言
 * (断言目标 action/state,非仅 code)+ malformed → 真实 zod 校验抛 INVALID_RESPONSE。
 */
function clientFor(scenario: string, region: "cn" | "global" = "cn") {
  return new CindyAuthClient({
    baseUrl: "https://auth.scenario.invalid",
    region,
    deviceId: "scenario-device",
    clientType: "desktop",
    locale: "zh-CN",
    fetch: createScenarioFetch(scenario, { region }),
  });
}

describe("附录 A providers:* 场景(identifier 态渲染组合)", () => {
  it("providers:phone-only → 仅手机 tab,无社交", async () => {
    const providers = await clientFor("providers:phone-only").getProviders();
    expect(providers).toMatchObject({ phone: true, email: false, social: [], attribution: "phone" });
  });
  it("providers:email-only → 仅邮箱 tab,无社交", async () => {
    const providers = await clientFor("providers:email-only").getProviders();
    expect(providers).toMatchObject({ phone: false, email: true, social: [], attribution: "email" });
  });
  it("providers:both → 双 tab,无社交", async () => {
    const providers = await clientFor("providers:both").getProviders();
    expect(providers).toMatchObject({ phone: true, email: true, social: [] });
  });
  it("providers:cn-social → cn 社交组合(apple)", async () => {
    const providers = await clientFor("providers:cn-social").getProviders();
    expect(providers.social).toEqual(["apple"]);
  });
  it("providers:global-social → global 社交组合(apple+google),region 不冒充构建区域", async () => {
    const providers = await clientFor("providers:global-social").getProviders();
    expect(providers.social).toEqual(["apple", "google"]);
    // 附录 A:仅验 provider 组合,不冒充构建区域——cn 构建下 region 仍为 cn,
    // 真实 client 的 REGION_MISMATCH 守卫不触发。
    expect(providers.region).toBe("cn");
    // reduceAuthFlow 目标 state:providers-loaded → identifier
    const state = reduceAuthFlow(null, { type: "providers-loaded", providers });
    expect(state.step).toBe("identifier");
  });
});

describe("附录 A sso:* 场景(method-choice 行)", () => {
  it("sso:single → 单 connection 行(email_code + 1 sso,ssoRequired=false)", async () => {
    const methods = await clientFor("sso:single").discover("user@example.com");
    const ssoRows = methods.filter((m) => m.type === "sso");
    expect(ssoRows).toHaveLength(1);
    expect(ssoRows[0]).toMatchObject({ ssoRequired: false });
    const state = reduceAuthFlow(null, { type: "discovery-loaded", email: "user@example.com", methods });
    expect(state.step).toBe("method-choice");
    expect(soleAutoStartSsoMethod(methods)).toBeNull();
  });
  it("sso:multi → 多 connection 行", async () => {
    const methods = await clientFor("sso:multi").discover("user@example.com");
    expect(methods.filter((m) => m.type === "sso")).toHaveLength(2);
    expect(soleAutoStartSsoMethod(methods)).toBeNull();
  });
  it("sso:required → 该企业要求通过 SSO 登录(ssoRequired=true,无 email_code)", async () => {
    const methods = await clientFor("sso:required").discover("user@example.com");
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ type: "sso", ssoRequired: true });
    expect(soleAutoStartSsoMethod(methods)).toMatchObject({ type: "sso", ssoRequired: true });
  });
  it("sso discovery(企业 ID 入口)→ connection 列表", async () => {
    const discovery = await clientFor("sso:multi").discoverSsoOrg("example");
    expect(discovery.connections).toHaveLength(2);
    expect(discovery.orgName).toBe("Example Org");
    expect(soleAutoStartSsoMethod(ssoOrgDiscoveryToMethods(discovery))).toBeNull();
  });
  it("sso discovery 单连接 → 无真正选择，控制器应跳过 method-choice", async () => {
    const discovery = await clientFor("sso:single").discoverSsoOrg("example");
    const methods = ssoOrgDiscoveryToMethods(discovery);
    expect(methods).toHaveLength(1);
    expect(soleAutoStartSsoMethod(methods)).toMatchObject({ type: "sso" });
  });
  it("纯邮箱 discovery → 唯一 email_code，应跳过 method-choice 直接发码", async () => {
    const methods = await clientFor("providers:both").discover("personal@example.com");
    expect(soleLoginMethod(methods)).toEqual({ type: "email_code" });
    expect(soleAutoStartSsoMethod(methods)).toBeNull();
  });
});

describe("附录 A outcome:* 场景(目标 state 断言)", () => {
  it("outcome:select-account → verify-code 返回 select_account → account-selection 态", async () => {
    const client = clientFor("outcome:select-account");
    await client.requestCode("phone", "13800000000"); // 前置:request-code 正常
    const outcome = await client.verifyCode("phone", "13800000000", "123456");
    expect(outcome.status).toBe("select_account");
    const state = reduceAuthFlow(null, { type: "outcome", outcome });
    expect(state.step).toBe("account-selection");
    if (state.step === "account-selection") expect(state.accounts).toHaveLength(2);
  });
  it("outcome:binding-phone → binding_required(phone) → binding 态", async () => {
    const outcome = await clientFor("outcome:binding-phone").verifyCode("email", "a@b.com", "123456");
    expect(outcome).toMatchObject({ status: "binding_required", bindType: "phone" });
    const state = reduceAuthFlow(null, { type: "outcome", outcome });
    expect(state).toMatchObject({ step: "binding", bindType: "phone", codeRequested: false });
  });
  it("outcome:binding-email → binding_required(email)", async () => {
    const outcome = await clientFor("outcome:binding-email").verifyCode("phone", "13800000000", "123456");
    expect(outcome).toMatchObject({ status: "binding_required", bindType: "email" });
  });
  it("callback exchange(social-exchange 拦截点)同样吃 outcome 场景", async () => {
    const outcome = await clientFor("outcome:select-account").exchangeAuthorizationCode("code", "verifier");
    expect(outcome.status).toBe("select_account");
  });
});

describe("附录 A error:<endpoint>:<CODE> 全 endpoint 走查(真实 AuthApiError 传播)", () => {
  const cases: Array<{ endpoint: string; code: string; invoke: (c: CindyAuthClient) => Promise<unknown> }> = [
    { endpoint: "providers", code: "AUTH_SERVICE_UNAVAILABLE", invoke: (c) => c.getProviders() },
    { endpoint: "discover", code: "NETWORK_ERROR", invoke: (c) => c.discover("a@b.com") },
    { endpoint: "sso-discovery", code: "ORG_SSO_NOT_FOUND", invoke: (c) => c.discoverSsoOrg("nope") },
    { endpoint: "request-code", code: "RATE_LIMITED", invoke: (c) => c.requestCode("phone", "13800000000") },
    { endpoint: "verify-code", code: "INVALID_CODE", invoke: (c) => c.verifyCode("phone", "13800000000", "000000") },
    { endpoint: "social-exchange", code: "SOCIAL_TOKEN_INVALID", invoke: (c) => c.exchangeAuthorizationCode("x", "y") },
    { endpoint: "select-account", code: "INVALID_LOGIN_TICKET", invoke: (c) => c.selectAccount("t", "a") },
    { endpoint: "request-binding-code", code: "INVALID_BIND_TICKET", invoke: (c) => c.requestBindingCode("t", "phone", "138") },
    { endpoint: "verify-binding", code: "INVALID_BIND_TICKET", invoke: (c) => c.verifyBinding("t", "phone", "138", "000000") },
  ];
  it.each(cases)("error:$endpoint:$code → 仅该端点注错,AuthApiError.code 精确传播", async ({ endpoint, code, invoke }) => {
    const client = clientFor(`error:${endpoint}:${code}`);
    await expect(invoke(client)).rejects.toMatchObject({ name: "AuthApiError", code });
  });
  it("覆盖附录 A 全部 9 个 endpoint(用例与值域一一对应)", () => {
    expect(new Set(cases.map((c) => c.endpoint))).toEqual(new Set(LOGIN_SCENARIO_ERROR_ENDPOINTS));
  });
  it("error:verify-code:UNKNOWN_CODE → 未注册 wire code 原样传播(双端 fallback 行)", async () => {
    const client = clientFor("error:verify-code:UNKNOWN_CODE");
    await expect(client.verifyCode("phone", "13800000000", "1")).rejects.toMatchObject({ code: "UNKNOWN_CODE" });
  });
  it("error 场景的其余端点按前置正常返回(前置动作脚本可走)", async () => {
    const client = clientFor("error:verify-code:INVALID_CODE");
    await expect(client.requestCode("phone", "13800000000")).resolves.toBeUndefined();
    const providers: ProviderConfig = await client.getProviders();
    expect(providers.region).toBe("cn");
  });
  it("三票据码 → reduceAuthFlow failed 落 error 态(recoverTo 由平台层给定)", async () => {
    const state = reduceAuthFlow(null, { type: "failed", code: "INVALID_LOGIN_TICKET", recoverTo: "identifier" });
    expect(state).toMatchObject({ step: "error", code: "INVALID_LOGIN_TICKET" });
  });
});

describe("malformed payload → 真实 zod 校验抛 INVALID_RESPONSE", () => {
  it.each(["providers", "verify-code", "sso-discovery"] as const)(
    "%s 端点返回坏形状 → INVALID_RESPONSE",
    async (endpoint) => {
      const client = new CindyAuthClient({
        baseUrl: "https://auth.scenario.invalid",
        region: "cn",
        deviceId: "scenario-device",
        clientType: "desktop",
        fetch: createMalformedResponseFetch(endpoint, { region: "cn" }),
      });
      const invoke =
        endpoint === "providers"
          ? client.getProviders()
          : endpoint === "verify-code"
            ? client.verifyCode("phone", "13800000000", "123456")
            : client.discoverSsoOrg("example");
      await expect(invoke).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    },
  );
});

describe("完整 happy path 全 endpoint 走查(真实 client + 默认前置)", () => {
  it("providers→discover→request→verify→select→binding→refresh→me→logout 全链 schema 通过", async () => {
    const client = clientFor("outcome:select-account");
    await client.getProviders();
    await client.discover("user@example.com");
    await client.requestCode("email", "user@example.com");
    const outcome = await client.verifyCode("email", "user@example.com", "123456");
    expect(outcome.status).toBe("select_account");
    const ok = await client.selectAccount("ticket", "scenario-account-1");
    expect(ok.status).toBe("ok");
    const bindingClient = clientFor("outcome:binding-email");
    await bindingClient.requestBindingCode("ticket", "email", "user@example.com");
    const bound = await bindingClient.verifyBinding("ticket", "email", "user@example.com", "123456");
    expect(bound.status).toBe("ok");
    const pair = await client.refresh("refresh");
    expect(pair.membership.id).toBe("scenario-account-1");
    const me = await client.getMe("token");
    expect(me.identities).toHaveLength(2);
    await expect(client.logout("token")).resolves.toBeUndefined();
  });
});

describe("guard 与值域(生产双保险第 1 层)", () => {
  it("resolveLoginScenarioFetch:devModeActive=false → 恒 null(production-mode 断言)", () => {
    expect(
      resolveLoginScenarioFetch({ devModeActive: false, scenario: "providers:both", region: "cn" }),
    ).toBeNull();
  });
  it("scenario 缺省/空白 → null", () => {
    expect(resolveLoginScenarioFetch({ devModeActive: true, scenario: undefined, region: "cn" })).toBeNull();
    expect(resolveLoginScenarioFetch({ devModeActive: true, scenario: "  ", region: "cn" })).toBeNull();
  });
  it("dev + 合法 token → 返回可用 AuthFetch", async () => {
    const fetch = resolveLoginScenarioFetch({ devModeActive: true, scenario: "providers:both", region: "cn" });
    expect(fetch).toBeTypeOf("function");
  });
  it("非法 token → 抛错(不静默)", () => {
    expect(() => parseLoginScenario("splash:updating")).toThrow(/非法 scenario token/);
    expect(() => parseLoginScenario("error:verify-code:NOT_A_CODE")).toThrow();
    expect(() => parseLoginScenario("error:not-an-endpoint:INVALID_CODE")).toThrow();
  });
  it("sentinel 为冻结字面量(生产泄漏机器门的扫描目标)", () => {
    expect(CINDY_LOGIN_FIXTURE_SENTINEL).toBe("__CINDY_LOGIN_FIXTURE_SENTINEL__");
  });
});
