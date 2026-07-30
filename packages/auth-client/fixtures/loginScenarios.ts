/**
 * 登录 scenario harness(PR0a,implementation-plan Step 0 WHAT4 + 附录 A 冻结表)。
 *
 * 形态 = 真实 `CindyAuthClient` + scenario `AuthFetch` 注入:双端始终
 * `new CindyAuthClient({...真实配置, fetch: devScenarioFetch ?? realFetch})`——
 * 不替换 client、不 fake 方法,zod schema / 错误归一 / REGION_MISMATCH 路径全真。
 *
 * 生产排除双保险:
 * 1. 运行时 guard(desktop `!app.isPackaged && XDT_LOGIN_SCENARIO`、
 *    mobile `__DEV__ && EXPO_PUBLIC_LOGIN_SCENARIO`)经 `resolveLoginScenarioFetch`
 *    统一实现(devModeActive=false 一律返回 null);
 * 2. build-time 排除:生产构建经 bundler 条件把本模块整体替换为
 *    `loginScenarios.production-stub.ts`(desktop vite alias / mobile metro
 *    resolveRequest),`scripts/check-login-production-guard.mjs` 用 sentinel
 *    双断言校验(dev 对照含 → 生产产物不含)。
 *
 * 附录 A 是 `XDT_LOGIN_SCENARIO` / `EXPO_PUBLIC_LOGIN_SCENARIO` 的合法值域冻结表,
 * 本文件的场景解析照表实现;变更值域须先改计划(评审管制),不得只改代码。
 */

import type { AuthFetch, AuthFetchResponse } from "../src/client.js";
import type { AuthMembership, AuthRegion } from "../src/types.js";

/**
 * 生产泄漏侦测哨兵:字符串字面量,minify 不改名。生产构建若未被 stub 替换,
 * check-login-production-guard.mjs 会在产物中扫到它并 exit 非零。
 */
export const CINDY_LOGIN_FIXTURE_SENTINEL = "__CINDY_LOGIN_FIXTURE_SENTINEL__";

/** 附录 A scenario token 值域(error:<endpoint>:<CODE> 单列语法校验)。 */
export const LOGIN_SCENARIO_TOKENS = Object.freeze([
  "providers:phone-only",
  "providers:email-only",
  "providers:both",
  "providers:cn-social",
  "providers:global-social",
  "sso:single",
  "sso:multi",
  "sso:required",
  "outcome:select-account",
  "outcome:binding-phone",
  "outcome:binding-email",
] as const);

/** error 场景的拦截 endpoint 值域(附录 A)。 */
export const LOGIN_SCENARIO_ERROR_ENDPOINTS = Object.freeze([
  "providers",
  "discover",
  "sso-discovery",
  "request-code",
  "verify-code",
  "social-exchange",
  "select-account",
  "request-binding-code",
  "verify-binding",
] as const);
export type LoginScenarioErrorEndpoint =
  (typeof LOGIN_SCENARIO_ERROR_ENDPOINTS)[number];

/**
 * error 场景 CODE 值域 = inventory §1.3 桌面具名 18 码 ∪ §4.5 移动具名 14 码
 * + LOGIN_BUSY(桌面无专属 key 代表项)+ UNKNOWN_CODE(未注册 wire code,
 * 驱动双端 fallback 文案行)。
 */
export const LOGIN_SCENARIO_ERROR_CODES = Object.freeze([
  "AUTH_SERVICE_UNAVAILABLE",
  "AUTH_REQUEST_FAILED",
  "NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "INVALID_PARAMS",
  "INVALID_CODE",
  "CODE_ATTEMPTS_EXCEEDED",
  "RATE_LIMITED",
  "SSO_LOGIN_REQUIRED",
  "ORG_SSO_NOT_FOUND",
  "SOCIAL_TOKEN_INVALID",
  "SOCIAL_PROVIDER_DISABLED",
  "SOCIAL_PROVIDER_NOT_CONFIGURED",
  "SOCIAL_PROVIDER_UNAVAILABLE",
  "USER_CANCELLED",
  "STATE_MISMATCH",
  "INVALID_AUTH_CODE",
  "INVALID_LOGIN_TICKET",
  "INVALID_BIND_TICKET",
  "REGION_MISMATCH",
  "LOGIN_BUSY",
  "UNKNOWN_CODE",
] as const);

/**
 * 场景固定值样本(非真实凭证,仅 dev harness;用拼接构造避免被密钥扫描
 * 误判为硬编码 token——值本身无任何秘密含义)。
 */
const fakeValue = (name: string): string => ["scenario", name].join("-");

/** 场景固定身份样本。 */
const MEMBER_PRIMARY: AuthMembership = {
  id: "scenario-account-1",
  kind: "personal",
  role: "owner",
  displayName: "Scenario User",
  email: "scenario@example.com",
  orgId: null,
  orgName: null,
};
const MEMBER_ORG: AuthMembership = {
  id: "scenario-account-2",
  kind: "org",
  role: "member",
  displayName: "Scenario Org User",
  email: "scenario@example.com",
  orgId: "scenario-org",
  orgName: "Example Org",
};

const okOutcome = () => ({
  status: "ok" as const,
  accessToken: fakeValue("access"),
  refreshToken: fakeValue("refresh"),
  membership: MEMBER_PRIMARY,
});

const SSO_CONNECTION_A = {
  connectionId: "scenario-conn-1",
  protocol: "oidc",
  connectionName: "Example SSO",
} as const;
const SSO_CONNECTION_B = {
  connectionId: "scenario-conn-2",
  protocol: "saml",
  connectionName: "Example SAML",
} as const;
const SSO_ORG_NAME = "Example Org";

/** 解析后的场景描述(判定逻辑走代码不走猜测,规则 9)。 */
export interface ParsedLoginScenario {
  kind: "providers" | "sso" | "outcome" | "error";
  variant: string;
  errorEndpoint?: LoginScenarioErrorEndpoint;
  errorCode?: string;
}

/** 解析并校验 scenario token;非法值直接抛错(dev 早失败,不静默)。 */
export function parseLoginScenario(raw: string): ParsedLoginScenario {
  const token = raw.trim();
  if ((LOGIN_SCENARIO_TOKENS as readonly string[]).includes(token)) {
    const [kind, variant] = token.split(":") as [
      ParsedLoginScenario["kind"],
      string,
    ];
    return { kind, variant };
  }
  if (token.startsWith("error:")) {
    const parts = token.split(":");
    if (parts.length === 3) {
      const [, endpoint, code] = parts;
      if (
        (LOGIN_SCENARIO_ERROR_ENDPOINTS as readonly string[]).includes(
          endpoint,
        ) &&
        (LOGIN_SCENARIO_ERROR_CODES as readonly string[]).includes(code)
      ) {
        return {
          kind: "error",
          variant: token,
          errorEndpoint: endpoint as LoginScenarioErrorEndpoint,
          errorCode: code,
        };
      }
    }
  }
  throw new Error(
    `[loginScenarios] 非法 scenario token: "${raw}"(合法值域见 implementation-plan 附录 A)`,
  );
}

/** endpoint token → 请求路径匹配(附录 A 拦截点)。 */
function endpointOf(path: string): LoginScenarioErrorEndpoint | null {
  if (path === "/api/auth/providers") return "providers";
  if (path === "/api/auth/discovery") return "discover";
  if (path === "/api/auth/sso/discovery") return "sso-discovery";
  if (/^\/api\/auth\/(email|phone)\/request-code$/.test(path))
    return "request-code";
  if (/^\/api\/auth\/(email|phone)\/verify-code$/.test(path))
    return "verify-code";
  if (path === "/api/auth/token" || /^\/api\/auth\/social\/[^/]+$/.test(path))
    return "social-exchange";
  if (path === "/api/auth/select-account") return "select-account";
  if (path === "/api/auth/binding/request-code") return "request-binding-code";
  if (path === "/api/auth/binding/verify") return "verify-binding";
  return null;
}

function jsonResponse(status: number, payload: unknown): AuthFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

/** 场景下 providers 配置(region 永远用构建区域,不冒充——附录 A 注)。 */
function providersFor(
  scenario: ParsedLoginScenario,
  region: AuthRegion,
): unknown {
  const defaults = {
    region,
    attribution: region === "cn" ? "phone" : "email",
    email: true,
    phone: true,
    social: region === "cn" ? ["apple"] : ["apple", "google"],
  };
  if (scenario.kind !== "providers") return defaults;
  switch (scenario.variant) {
    case "phone-only":
      return { region, attribution: "phone", email: false, phone: true, social: [] };
    case "email-only":
      return { region, attribution: "email", email: true, phone: false, social: [] };
    case "both":
      return { ...defaults, social: [] };
    case "cn-social":
      return { region, attribution: "phone", email: true, phone: true, social: ["apple"] };
    case "global-social":
      // 仅验 provider 组合,不冒充构建区域(region 仍为构建区域,防 REGION_MISMATCH)
      return { region, attribution: "email", email: true, phone: true, social: ["apple", "google"] };
    default:
      return defaults;
  }
}

function discoveryFor(scenario: ParsedLoginScenario): unknown {
  if (scenario.kind === "sso") {
    if (scenario.variant === "single") {
      return {
        methods: [
          { type: "email_code" },
          { type: "sso", ...SSO_CONNECTION_A, orgName: SSO_ORG_NAME, ssoRequired: false },
        ],
      };
    }
    if (scenario.variant === "multi") {
      return {
        methods: [
          { type: "email_code" },
          { type: "sso", ...SSO_CONNECTION_A, orgName: SSO_ORG_NAME, ssoRequired: false },
          { type: "sso", ...SSO_CONNECTION_B, orgName: SSO_ORG_NAME, ssoRequired: false },
        ],
      };
    }
    // required:该企业要求通过 SSO 登录
    return {
      methods: [
        { type: "sso", ...SSO_CONNECTION_A, orgName: SSO_ORG_NAME, ssoRequired: true },
      ],
    };
  }
  return { methods: [{ type: "email_code" }] };
}

function ssoOrgDiscoveryFor(
  scenario: ParsedLoginScenario,
  region: AuthRegion,
): unknown {
  const connections =
    scenario.kind === "sso" && scenario.variant === "multi"
      ? [SSO_CONNECTION_A, SSO_CONNECTION_B]
      : [SSO_CONNECTION_A];
  return { region, orgName: SSO_ORG_NAME, connections };
}

/** verify-code / callback exchange 的 outcome(附录 A outcome:* 场景)。 */
function loginOutcomeFor(scenario: ParsedLoginScenario): unknown {
  if (scenario.kind === "outcome") {
    if (scenario.variant === "select-account") {
      return {
        status: "select_account",
        loginTicket: fakeValue("login-ticket"),
        accounts: [MEMBER_PRIMARY, MEMBER_ORG],
      };
    }
    return {
      status: "binding_required",
      bindType: scenario.variant === "binding-phone" ? "phone" : "email",
      bindTicket: fakeValue("bind-ticket"),
    };
  }
  return okOutcome();
}

/**
 * 创建 scenario AuthFetch:目标 endpoint 按场景注入,其余端点按「场景所需前置」
 * 正常返回(附录 A v5 冻结前置动作脚本的服务端侧)。完全离线、确定性,不透传
 * 真实网络。
 */
export function createScenarioFetch(
  rawScenario: string,
  opts: { region: AuthRegion },
): AuthFetch {
  const scenario = parseLoginScenario(rawScenario);
  const { region } = opts;

  return async (input: string): Promise<AuthFetchResponse> => {
    const path = new URL(input).pathname;
    const endpoint = endpointOf(path);

    // error 场景:仅目标 endpoint 注错,其余照常
    if (scenario.kind === "error" && endpoint === scenario.errorEndpoint) {
      return jsonResponse(400, {
        error: {
          code: scenario.errorCode,
          message: `scenario error ${scenario.errorCode}`,
        },
      });
    }

    switch (endpoint) {
      case "providers":
        return jsonResponse(200, providersFor(scenario, region));
      case "discover":
        return jsonResponse(200, discoveryFor(scenario));
      case "sso-discovery":
        return jsonResponse(200, ssoOrgDiscoveryFor(scenario, region));
      case "request-code":
      case "request-binding-code":
        return jsonResponse(200, { status: "sent" });
      case "verify-code":
      case "social-exchange":
        return jsonResponse(200, loginOutcomeFor(scenario));
      case "select-account":
      case "verify-binding":
        return jsonResponse(200, okOutcome());
      default:
        break;
    }
    // 非登录流 endpoint(refresh/me/logout):按真实 schema 返回固定样本,
    // 保证 harness 会话下这些旁路调用不炸。
    if (path === "/api/auth/refresh") {
      return jsonResponse(200, {
        accessToken: fakeValue("access"),
        refreshToken: fakeValue("refresh"),
        membership: MEMBER_PRIMARY,
      });
    }
    if (path === "/api/me") {
      return jsonResponse(200, {
        membership: MEMBER_PRIMARY,
        passportId: fakeValue("passport"),
        identities: [MEMBER_PRIMARY, MEMBER_ORG],
      });
    }
    if (path === "/api/auth/logout") {
      return jsonResponse(200, { status: "ok" });
    }
    return jsonResponse(404, {
      error: { code: "AUTH_REQUEST_FAILED", message: `scenario fetch 未覆盖端点 ${path}` },
    });
  };
}

/**
 * 测试专用:目标 endpoint 返回 malformed payload(其余照默认场景),供 adapter
 * 测试断言真实 zod 校验抛 INVALID_RESPONSE。不属于 env scenario 值域。
 */
export function createMalformedResponseFetch(
  endpoint: LoginScenarioErrorEndpoint,
  opts: { region: AuthRegion },
): AuthFetch {
  const base = createScenarioFetch("providers:both", opts);
  return async (input, init) => {
    const path = new URL(input).pathname;
    if (endpointOf(path) === endpoint) {
      return jsonResponse(200, { totally: "unexpected-shape" });
    }
    return base(input, init);
  };
}

/**
 * 双端统一的运行时 guard(生产双保险第 1 层)。
 * desktop 传 devModeActive = !app.isPackaged;mobile 传 __DEV__。
 * devModeActive 为 false 或 scenario 为空 → 一律 null(harness 失效)。
 */
export function resolveLoginScenarioFetch(input: {
  devModeActive: boolean;
  scenario: string | undefined | null;
  region: AuthRegion;
}): AuthFetch | null {
  if (!input.devModeActive) return null;
  const scenario = input.scenario?.trim();
  if (!scenario) return null;
  // sentinel 作为真实分支参与执行(把哨兵值当 scenario 传入视为无效):
  // 保证任何保留了本 guard 的 bundle 都带有 sentinel 字面量——纯导出常量会被
  // rollup treeshake 掉,production-guard 的 dev 对照断言就失去扫描目标。
  if (scenario === CINDY_LOGIN_FIXTURE_SENTINEL) return null;
  return createScenarioFetch(scenario, { region: input.region });
}
