import { z } from "zod";

export const authRegionSchema = z.enum(["cn", "global"]);
export type AuthRegion = z.infer<typeof authRegionSchema>;

export const socialProviderSchema = z.enum(["apple", "google", "wechat"]);
export type SocialProvider = z.infer<typeof socialProviderSchema>;

export const membershipSchema = z.object({
  id: z.string().min(1),
  passportId: z.string().min(1).optional(),
  kind: z.enum(["personal", "org"]),
  role: z.enum(["owner", "admin", "member"]),
  displayName: z.string(),
  // 用户自助设置的头像(auth-server PATCH /api/me/profile);null = 未设置。
  // optional 兼容尚未升级的旧 auth-server 响应(缺字段不整份拒绝)。
  avatarUrl: z.string().nullable().optional(),
  email: z.string().nullable(),
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
  // 企业 logo(auth console 组织设置上传);personal 或未设置 = null。
  // optional 兼容尚未升级的旧 auth-server 响应(缺字段不整份拒绝)。
  orgLogoUrl: z.string().nullable().optional(),
});
export type AuthMembership = z.infer<typeof membershipSchema>;

export const providerConfigSchema = z.object({
  region: authRegionSchema,
  attribution: z.enum(["phone", "email"]),
  email: z.boolean(),
  phone: z.boolean(),
  social: z.array(socialProviderSchema),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** 企业 SSO discovery（POST /api/auth/sso/discovery，按组织 ID/slug/已验证域名探测）。 */
export const ssoOrgConnectionSchema = z.object({
  connectionId: z.string().min(1),
  protocol: z.enum(["oidc", "saml", "cas"]),
  connectionName: z.string(),
});
export type SsoOrgConnection = z.infer<typeof ssoOrgConnectionSchema>;

export const ssoOrgDiscoverySchema = z.object({
  region: authRegionSchema,
  orgName: z.string(),
  // 不设 min(1)：服务端对「企业存在但未启用 SSO」可能返回 200 + connections:[]。
  // 让空数组通过 schema 校验，由 CindyAuthClient.discoverSsoOrg 显式映射成精确的
  // ORG_SSO_NOT_FOUND，而不是被当成 INVALID_RESPONSE 落到通用错误文案。
  connections: z.array(ssoOrgConnectionSchema),
});
export type SsoOrgDiscovery = z.infer<typeof ssoOrgDiscoverySchema>;

export const loginMethodSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email_code") }),
  z.object({
    type: z.literal("sso"),
    connectionId: z.string().min(1),
    protocol: z.enum(["oidc", "saml", "cas"]),
    orgName: z.string(),
    connectionName: z.string(),
    ssoRequired: z.boolean(),
  }),
]);
export type LoginMethod = z.infer<typeof loginMethodSchema>;

/**
 * 把企业 SSO discovery 结果映射成 LoginMethod 列表，复用 method-choice 步骤
 * 渲染连接选择（ssoRequired=false：入口本身即用户主动选 SSO，无需再提示强制）。
 */
export function ssoOrgDiscoveryToMethods(
  discovery: SsoOrgDiscovery,
): LoginMethod[] {
  return discovery.connections.map((connection) => ({
    type: "sso" as const,
    connectionId: connection.connectionId,
    protocol: connection.protocol,
    orgName: discovery.orgName,
    connectionName: connection.connectionName,
    ssoRequired: false,
  }));
}

export const tokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  membership: membershipSchema,
});
export type AuthTokenPair = z.infer<typeof tokenPairSchema>;

const optionalAccountTokenFields = {
  accountToken: z.string().min(1).optional(),
  accountRefreshToken: z.string().min(1).optional(),
  accountDeletionRestored: z.literal(true).optional(),
};

const okOutcomeSchema = tokenPairSchema.extend({
  status: z.literal("ok"),
  ...optionalAccountTokenFields,
});
const selectAccountOutcomeSchema = z.object({
  status: z.literal("select_account"),
  loginTicket: z.string().min(1),
  accounts: z.array(membershipSchema).min(1),
  ...optionalAccountTokenFields,
});
const bindingRequiredOutcomeSchema = z.object({
  status: z.literal("binding_required"),
  bindType: z.enum(["phone", "email"]),
  bindTicket: z.string().min(1),
});
const ssoVerificationRequiredOutcomeSchema = z.object({
  status: z.literal("sso_verification_required"),
  verificationTicket: z.string().min(1),
  channel: z.enum(["email", "sms"]),
  targetMasked: z.string().min(1),
});
export const loginOutcomeSchema = z
  .discriminatedUnion("status", [
    okOutcomeSchema,
    selectAccountOutcomeSchema,
    bindingRequiredOutcomeSchema,
    ssoVerificationRequiredOutcomeSchema,
  ])
  .superRefine((outcome, ctx) => {
    if (outcome.status !== "ok" && outcome.status !== "select_account") return;
    if (
      Boolean(outcome.accountToken) !== Boolean(outcome.accountRefreshToken)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "accountToken and accountRefreshToken must be returned together",
      });
    }
  });
export type LoginOutcome = z.infer<typeof loginOutcomeSchema>;
export type AuthSuccess = z.infer<typeof okOutcomeSchema>;

export const accountMembershipSchema = membershipSchema.extend({
  orgSlug: z.string().nullable(),
});
export type AccountMembership = z.infer<typeof accountMembershipSchema>;

export const meResponseSchema = z.object({
  membership: membershipSchema,
  passportId: z.string().min(1),
  identities: z.array(membershipSchema),
});
export type AuthMe = z.infer<typeof meResponseSchema>;

export const accountDeletionAvailabilitySchema = z.object({
  available: z.boolean(),
  verification: z
    .object({
      channel: z.enum(["email", "sms"]),
      maskedTarget: z.string().min(1),
    })
    .optional(),
  manualAppleRevocationRequired: z.boolean(),
});
export type AccountDeletionAvailability = z.infer<
  typeof accountDeletionAvailabilitySchema
>;

export const accountDeletionChallengeSchema = z.object({
  challengeId: z.string().min(1),
  receiptToken: z.string().min(1),
  channel: z.enum(["email", "sms"]),
  maskedTarget: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export type AccountDeletionChallenge = z.infer<
  typeof accountDeletionChallengeSchema
>;

export const accountDeletionStatusSchema = z.object({
  status: z.enum(["pending", "processing", "completed", "cancelled"]),
  requestedAt: z.string().datetime(),
  deleteAfter: z.string().datetime(),
  processingAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  cancelledAt: z.string().datetime().optional(),
});
export type AccountDeletionStatus = z.infer<
  typeof accountDeletionStatusSchema
>;

/**
 * 托管回调链路(desktop 系统浏览器登录)的授权码取回结果。
 *
 * 背景:RFC 8252 loopback 会把 `127.0.0.1:<port>` 与授权码一起暴露在浏览器地址栏,
 * 唤起 app 的系统弹框也显示该 IP。托管回调改为让 auth-server 接住 provider 回调、
 * 按 clientState 短期暂存授权码,客户端轮询取回——浏览器全程停在自有域名上。
 *
 * 语义:
 *  - `pending`:用户尚未完成授权,继续轮询;
 *  - `ok`:取到一次性授权码(服务端应即时失效),客户端接着走 PKCE 换 token;
 *  - `error`:provider 或 auth-server 侧失败,`error` 为可展示的错误码;
 *  - `expired`:暂存已过 TTL 或已被取走,本次尝试作废。
 */
export const desktopAuthorizationPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("ok"), code: z.string().min(1) }),
  z.object({ status: z.literal("error"), error: z.string().min(1) }),
  z.object({ status: z.literal("expired") }),
]);
export type DesktopAuthorizationPoll = z.infer<
  typeof desktopAuthorizationPollSchema
>;

export type AuthClientType = "desktop" | "mobile" | "web";
export type VerificationKind = "email" | "phone";
export type SsoVerificationChannel = "email" | "sms";

export type AuthFlowState =
  | { step: "identifier"; providers: ProviderConfig }
  | {
      step: "realm-confirmation";
      targetRegion: AuthRegion;
      providers: ProviderConfig;
      methods: LoginMethod[];
    }
  | { step: "method-choice"; email: string; methods: LoginMethod[] }
  | { step: "verification-code"; kind: VerificationKind; identifier: string }
  | { step: "browser-redirect"; label: string }
  | { step: "account-selection"; accounts: AuthMembership[] }
  | {
      step: "sso-verification";
      channel: SsoVerificationChannel;
      targetMasked: string;
      codeRequested: boolean;
    }
  | {
      step: "binding";
      bindType: VerificationKind;
      codeRequested: boolean;
      contact?: string;
    }
  | { step: "completed"; membership: AuthMembership }
  | {
      step: "error";
      code: string;
      recoverTo: Exclude<AuthFlowState["step"], "error">;
    };

export type AuthFlowAction =
  | { type: "providers-loaded"; providers: ProviderConfig }
  | {
      type: "realm-switch-required";
      targetRegion: AuthRegion;
      providers: ProviderConfig;
      methods: LoginMethod[];
    }
  | { type: "discovery-loaded"; email: string; methods: LoginMethod[] }
  | { type: "code-requested"; kind: VerificationKind; identifier: string }
  | { type: "browser-started"; label: string }
  | { type: "outcome"; outcome: LoginOutcome }
  | {
      type: "sso-verification-code-requested";
      channel: SsoVerificationChannel;
      targetMasked: string;
    }
  | {
      type: "binding-code-requested";
      bindType: VerificationKind;
      contact: string;
    }
  | {
      type: "failed";
      code: string;
      recoverTo: Exclude<AuthFlowState["step"], "error">;
    };

/** Pure UI-state projection. Secret login/bind tickets stay in platform controllers. */
export function reduceAuthFlow(
  _state: AuthFlowState | null,
  action: AuthFlowAction,
): AuthFlowState {
  switch (action.type) {
    case "providers-loaded":
      return { step: "identifier", providers: action.providers };
    case "realm-switch-required":
      return {
        step: "realm-confirmation",
        targetRegion: action.targetRegion,
        providers: action.providers,
        methods: action.methods,
      };
    case "discovery-loaded":
      return {
        step: "method-choice",
        email: action.email,
        methods: action.methods,
      };
    case "code-requested":
      return {
        step: "verification-code",
        kind: action.kind,
        identifier: action.identifier,
      };
    case "browser-started":
      return { step: "browser-redirect", label: action.label };
    case "binding-code-requested":
      return {
        step: "binding",
        bindType: action.bindType,
        codeRequested: true,
        contact: action.contact,
      };
    case "sso-verification-code-requested":
      return {
        step: "sso-verification",
        channel: action.channel,
        targetMasked: action.targetMasked,
        codeRequested: true,
      };
    case "failed":
      return { step: "error", code: action.code, recoverTo: action.recoverTo };
    case "outcome":
      if (action.outcome.status === "ok") {
        return { step: "completed", membership: action.outcome.membership };
      }
      if (action.outcome.status === "select_account") {
        return { step: "account-selection", accounts: action.outcome.accounts };
      }
      if (action.outcome.status === "sso_verification_required") {
        return {
          step: "sso-verification",
          channel: action.outcome.channel,
          targetMasked: action.outcome.targetMasked,
          codeRequested: false,
        };
      }
      return {
        step: "binding",
        bindType: action.outcome.bindType,
        codeRequested: false,
      };
  }
}
