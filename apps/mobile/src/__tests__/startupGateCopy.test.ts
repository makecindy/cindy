import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * 启动闸门文案 key 化状态测试(implementation-plan Step 1 v6.3 点名两处 / SC-4):
 * ① endpoint 失败屏(app/_layout.tsx)错误态文案必须走 loginMessages key,
 *    不得残留硬编码中文字符串字面量;
 * ② config issue(src/config/env.ts)只产出 messageKey,由登录屏用 loginText 渲染。
 * 组件树依赖 expo/RN 运行时,node vitest 下沿用仓内既有「读源码断言」模式;
 * key → 5 语文案的桥接用 catalog 行为断言补齐。
 */
vi.mock("expo-localization", () => ({
  getLocales: () => [{ languageTag: "en-US" }],
}));

import { loginMessages } from "@/auth/loginMessages";
import { getMobileConfigIssues } from "@/config/env";

const layoutSource = readFileSync(
  resolve(process.cwd(), "app/_layout.tsx"),
  "utf8",
);
const envSource = readFileSync(
  resolve(process.cwd(), "src/config/env.ts"),
  "utf8",
);
const loginSource = readFileSync(
  resolve(process.cwd(), "app/(auth)/login.tsx"),
  "utf8",
);

describe("endpoint 闸门失败屏(_layout.tsx)文案 key 化", () => {
  it("error 态文案与动态动作全部走 loginMessages key", () => {
    expect(layoutSource).toContain("loginText('endpointGateTitle')");
    expect(layoutSource).toContain("loginText('endpointGateSubtitle')");
    expect(layoutSource).toContain("'endpointGateResetToDev' : 'retry'");
    expect(layoutSource).toContain('endpointGate.resetToDev');
    // {reason} 占位符在渲染点替换,保留闸门失败原因透出
    expect(layoutSource).toContain("'{reason}'");
    expect(layoutSource).toContain("endpointGate.reason ?? 'unknown'");
  });

  it("旧硬编码中文字面量已清理", () => {
    expect(layoutSource).not.toContain("无法获取服务器配置");
    expect(layoutSource).not.toContain("请检查网络连接后重试");
    expect(layoutSource).not.toContain('"重试"');
  });

  it("闸门 key 在 5 语 catalog 全部就位", () => {
    for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko"] as const) {
      const catalog = loginMessages[locale];
      expect(catalog.endpointGateTitle.trim(), locale).not.toBe("");
      expect(catalog.endpointGateSubtitle, locale).toContain("{reason}");
      expect(catalog.endpointGateResetToDev.trim(), locale).not.toBe("");
      expect(catalog.retry.trim(), locale).not.toBe("");
    }
  });
});

describe("config issue(env.ts)文案 key 化", () => {
  it("issue 只产出 messageKey,旧裸文案已清理", () => {
    expect(envSource).toContain("messageKey: 'configIssueAuthBaseUrl'");
    expect(envSource).not.toContain("登录服务地址必须是");
  });

  it("登录屏用 loginText 渲染 messageKey", () => {
    expect(loginSource).toContain("loginText(issue.messageKey)");
    expect(loginSource).not.toContain("issue.message}");
  });

  it("行为桥接:非法 URL → messageKey → 5 语文案非空", () => {
    const issues = getMobileConfigIssues({
      EXPO_PUBLIC_CINDY_AUTH_BASE_URL: "ftp://auth.example.com",
    });
    expect(issues).toHaveLength(1);
    const key = issues[0].messageKey;
    for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko"] as const) {
      expect(loginMessages[locale][key].trim(), locale).not.toBe("");
    }
  });
});
