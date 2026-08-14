import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseLegalSegments } from "@/auth/legalText";
import { LOGIN_CONSENT_ROW } from "@/auth/loginSkinLayout";
import { LEGAL_LINKS } from "@/config/legalLinks";
import { loginPalettes } from "@/theme/tokens";
import { loginMessages } from "@/auth/loginMessages";

/**
 * 协议同意链路专测(consent PR,移动端):
 * 组件树依赖 expo/RN 运行时,node vitest 下沿用仓内「纯数据断言 + 读源码接线断言」
 * 模式(loginSkinVisual/loginScenarioHarness 同款)。行为级续接/拦截语义与桌面
 * LoginPage.consent.test.tsx 同源(桌面 jsdom 全交互覆盖)。
 */

const loginSource = readFileSync(
  resolve(process.cwd(), "app/(auth)/login.tsx"),
  "utf8",
);
const controlsSource = readFileSync(
  resolve(process.cwd(), "src/components/LoginSkinControls.tsx"),
  "utf8",
);

describe("parseLegalSegments(单 key 内联链接标记,词序无关)", () => {
  it("zh 语序:前缀文本 + terms/privacy 链接段 + 连接词", () => {
    expect(
      parseLegalSegments(
        "我已阅读并同意 <terms>服务条款</terms> 和 <privacy>隐私协议</privacy>",
      ),
    ).toEqual([
      { kind: "text", text: "我已阅读并同意 " },
      { kind: "terms", text: "服务条款" },
      { kind: "text", text: " 和 " },
      { kind: "privacy", text: "隐私协议" },
    ]);
  });

  it("ja 语序:链接前置 + 尾缀文本", () => {
    expect(
      parseLegalSegments(
        "<terms>利用規約</terms>と<privacy>プライバシーポリシー</privacy>を読み、同意します",
      ),
    ).toEqual([
      { kind: "terms", text: "利用規約" },
      { kind: "text", text: "と" },
      { kind: "privacy", text: "プライバシーポリシー" },
      { kind: "text", text: "を読み、同意します" },
    ]);
  });

  it("无标记文本原样单段透传", () => {
    expect(parseLegalSegments("plain")).toEqual([
      { kind: "text", text: "plain" },
    ]);
  });
});

describe("LEGAL_LINKS(区域分流,测试构建 = cn)", () => {
  it("cn 构建 → protocol.xd.cn 双链接", () => {
    expect(LEGAL_LINKS.termsOfService).toBe(
      "https://protocol.xd.cn/cindy/agreement.html",
    );
    expect(LEGAL_LINKS.privacyPolicy).toBe(
      "https://protocol.xd.cn/cindy/privacy-1.0.html",
    );
  });

  it("global 分支 URL 固化在源码(protocol.xd.com 双链接)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/config/legalLinks.ts"),
      "utf8",
    );
    expect(source).toContain(
      "https://protocol.xd.com/cindy/agreement-1.0.html",
    );
    expect(source).toContain("https://protocol.xd.com/cindy/privacy.html");
    expect(source).toContain("AUTH_REGION === 'global'");
  });
});

describe("consent 双态色板(figma wave5 SVG 源码核对值,与桌面 --login-consent-* 同源)", () => {
  it("radio 四态双模式反色(选中 = 对勾非圆点)", () => {
    expect(loginPalettes.light.consentRadioBg).toBe("#F1F0F1");
    expect(loginPalettes.light.consentRadioBorder).toBe("#434343");
    expect(loginPalettes.light.consentRadioCheckedBg).toBe("#2A2828");
    expect(loginPalettes.light.consentRadioCheck).toBe("#FFFFFF");
    expect(loginPalettes.dark.consentRadioBg).toBe("#2A2828");
    expect(loginPalettes.dark.consentRadioBorder).toBe("#F1F0F1");
    expect(loginPalettes.dark.consentRadioCheckedBg).toBe("#F1F0F1");
    expect(loginPalettes.dark.consentRadioCheck).toBe("#2A2828");
  });

  it("弹窗遮罩黑 85% 两模式同值;次级钮 wave5 双色小按钮双态", () => {
    expect(loginPalettes.light.consentOverlay).toBe("rgba(0, 0, 0, 0.85)");
    expect(loginPalettes.dark.consentOverlay).toBe("rgba(0, 0, 0, 0.85)");
    expect(loginPalettes.light.secondaryButtonBg).toBe("#EEEEEE");
    expect(loginPalettes.light.secondaryButtonBorder).toBe("#FFFFFF");
    expect(loginPalettes.light.secondaryButtonText).toBe("#2A2828");
    expect(loginPalettes.dark.secondaryButtonBg).toBe("#434141");
    expect(loginPalettes.dark.secondaryButtonBorder).toBe("#565454");
    expect(loginPalettes.dark.secondaryButtonText).toBe("#EEEEEE");
    // wave5 pressed 口径:亮浅底黑 10% / 暗 Dark_button_Normal 黑 20%
    expect(loginPalettes.light.overlaySecondaryPressed).toBe(
      "rgba(0, 0, 0, 0.1)",
    );
    expect(loginPalettes.dark.overlaySecondaryPressed).toBe(
      "rgba(0, 0, 0, 0.2)",
    );
  });
});

describe("consent 文案(5 语 catalog 全给标记链接段)", () => {
  it.each(["zh-CN", "zh-TW", "en", "ja", "ko"] as const)(
    "%s:statement 与 body 均含 terms/privacy 标记",
    (locale) => {
      const messages = loginMessages[locale];
      for (const key of ["consentStatement", "consentDialogBody"] as const) {
        const text = messages[key];
        expect(text).toMatch(/<terms>.+<\/terms>/);
        expect(text).toMatch(/<privacy>.+<\/privacy>/);
      }
      expect(messages.consentDialogTitle.length).toBeGreaterThan(0);
      expect(messages.consentAgree.length).toBeGreaterThan(0);
      expect(messages.consentDisagree.length).toBeGreaterThan(0);
    },
  );

  // parser 对坏标记 fail-open(嵌套/未闭合时原样显示)——法律文案不许依赖这种降级,
  // 全部 catalog 必须过严校验:恰一 terms + 恰一 privacy,链接文本非空,
  // 纯文本段无残留尖括号(codex 审查 P2:翻译误改标记时在 CI 就地拦截)
  it.each(["zh-CN", "zh-TW", "en", "ja", "ko"] as const)(
    "%s:catalog 过 parser 严校验",
    (locale) => {
      const messages = loginMessages[locale];
      for (const key of ["consentStatement", "consentDialogBody"] as const) {
        const segments = parseLegalSegments(messages[key]);
        expect(segments.filter((s) => s.kind === "terms")).toHaveLength(1);
        expect(segments.filter((s) => s.kind === "privacy")).toHaveLength(1);
        for (const s of segments) {
          expect(s.text.length).toBeGreaterThan(0);
          // 所有段(含链接段)禁残留尖括号:嵌套坏标记的残余会落在链接段文本里
          expect(s.text).not.toMatch(/[<>]/);
          if (s.kind !== "text") expect(s.text.length).toBeGreaterThan(1);
        }
      }
    },
  );
});

describe("login.tsx 接线(源码断言)", () => {
  it("个人链路发起点全部过 requireConsent,含 email discover(产品拍板 2026-07-24 二次)", () => {
    const guarded = loginSource.match(/requireConsent\(/g) ?? [];
    // 调用点 ≥5 处(email discover/phone 发码/邮箱个人行发码/apple/nonApple)
    expect(guarded.length).toBeGreaterThanOrEqual(5);
    // 手机号/邮箱提交一律先弹协议弹窗(拍板压过审查侧「discover 纯查询可放行」建议)
    expect(loginSource).toMatch(
      /requireConsent\(\(\) =>[\s\S]{0,140}?type: 'discover'/,
    );
    // 发码点(phone + 邮箱个人行)与社交圆钮为实际发起点,必须过门
    expect(loginSource).toMatch(
      /requireConsent\(\(\) =>[\s\S]{0,200}?kind: 'phone'/,
    );
    expect(loginSource).toMatch(
      /requireConsent\(\(\) =>[\s\S]{0,240}?kind: 'email'/,
    );
    const appleStart = loginSource.indexOf("label={loginText('apple')}");
    const appleEnd = loginSource.indexOf('testID="login.appleButton"', appleStart);
    expect(appleStart).toBeGreaterThan(0);
    expect(appleEnd).toBeGreaterThan(appleStart);
    const appleBlock = loginSource.slice(appleStart, appleEnd);
    expect(appleBlock).toContain('requireConsent(() =>');
    expect(appleBlock).toContain("provider: 'apple'");
  });

  it("企业 SSO 入口豁免:ssoEntryButton onPress 不过 requireConsent", () => {
    // 取 SSO 圆钮自身的 JSX 段:label={loginText('ssoEntry')} → testID="login.ssoEntryButton"
    const start = loginSource.indexOf("label={loginText('ssoEntry')}");
    const end = loginSource.indexOf('testID="login.ssoEntryButton"');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const ssoEntryBlock = loginSource.slice(start, end);
    expect(ssoEntryBlock).toContain("setSsoOrgMode(true)");
    expect(ssoEntryBlock).not.toContain("requireConsent");
  });

  it("P1 回归锁:容器 bounds 恒含协议行区间;弹窗前收键盘;radio 无 hitSlop", () => {
    // ① 外层测量盒与内层设计容器都用 flowBottomDesignPx(622),协议行在父 bounds 内
    expect(loginSource).toMatch(/height: flowBottomDesignPx \* groupScale/);
    expect(loginSource).toMatch(/height: flowBottomDesignPx,/);
    // ⑤ flow bottom 全步骤恒定(不随 showConsentRow 切换,消除步骤跳变)
    expect(loginSource).not.toMatch(
      /showConsentRow\s*\?\s*LOGIN_CONSENT_ROW\.bottomOverflow/,
    );
    // ② requireConsent 打开弹窗前收键盘(同意钮不被键盘遮挡)
    expect(loginSource).toMatch(
      /Keyboard\.dismiss\(\);[\s\S]{0,400}?setConsentDialogOpen\(true\)/,
    );
  });

  it("协议行 + 弹窗已挂载;安全区抬升含协议行溢出量;手机端无游客入口", () => {
    expect(loginSource).toContain("<LoginConsentRow");
    expect(loginSource).toContain("<LoginConsentDialog");
    expect(loginSource).toContain("LOGIN_CONSENT_ROW.bottomOverflow");
    expect(loginSource).toContain("loginText('consentStatement')");
    // 手机/pad 为远程连接客户端,必须有账号——不加游客登录(产品拍板 2026-07-24;
    // 断言不存在游客入口的具体接线:本地模式 IPC / 游客文案 key / 游客图标)
    expect(loginSource).not.toContain("authEnterLocal");
    expect(loginSource).not.toContain("localModeEntry");
    expect(loginSource).not.toContain("GuestGlyph");
  });

  it("协议链接经 Linking.openURL 打开(settings.tsx 同款模式)", () => {
    expect(loginSource).toMatch(/Linking\.openURL\(\s*\n?\s*kind === 'terms'/);
  });
});

describe("consent radio 无障碍(codex P1 双修:读屏标签 + 44pt 触摸区)", () => {
  it("触摸区常量:pressSize ≥88 设计px(phone ~0.5 缩放 → ≈44pt),行底 622 不变", () => {
    const { radio } = LOGIN_CONSENT_ROW;
    expect(radio.pressSize).toBeGreaterThanOrEqual(88);
    // 视觉几何冻结:圈体/槽位不随命中区扩大而变
    expect(radio.hitSize).toBe(24);
    expect(radio.ringSize).toBe(20);
    // 右下锚定不变式:行容器向上扩、底边恒 622(= 组高 560 + bottomOverflow 62),
    // 命中区完整落在父容器 flowBottom bounds 内(Android 界外不派发)
    expect(LOGIN_CONSENT_ROW.y + LOGIN_CONSENT_ROW.height).toBe(
      560 + LOGIN_CONSENT_ROW.bottomOverflow,
    );
    expect(radio.pressSize).toBeLessThanOrEqual(
      LOGIN_CONSENT_ROW.y + LOGIN_CONSENT_ROW.height,
    );
  });

  it("组件接线:命中区右下锚定 + 负 margin 占位回收 + 禁 hitSlop(历史结论回归锁)", () => {
    // 行容器:top 上移 pressExpand、paddingTop 压回原内容带,行底不动
    expect(controlsSource).toContain(
      "const pressExpand = radio.pressSize - LOGIN_CONSENT_ROW.height",
    );
    expect(controlsSource).toContain("top: LOGIN_CONSENT_ROW.y - pressExpand");
    expect(controlsSource).toContain("paddingTop: pressExpand");
    // Pressable:88×88 bounds,右缘对齐 24 槽位右缘(不侵协议链接命中区)、底缘对齐行底
    expect(controlsSource).toContain("height: radio.pressSize");
    expect(controlsSource).toContain("width: radio.pressSize");
    expect(controlsSource).toContain(
      "marginLeft: -(radio.pressSize - radio.hitSize)",
    );
    expect(controlsSource).toMatch(/alignSelf: 'flex-end'/);
    // hitSlop 方案已被否(父 bounds 裁剪、Android 界外触摸不派发),不许倒退
    // (只拦属性用法 hitSlop= / hitSlop:,注释中说明历史结论的字样放行)
    expect(controlsSource).not.toMatch(/hitSlop[=:]/);
  });

  it("读屏标签:accessibilityLabel = 协议声明剥标记纯文本,多语随 i18n 无新增 key", () => {
    expect(controlsSource).toContain("accessibilityLabel={statementLabel}");
    expect(controlsSource).toMatch(
      /parseLegalSegments\(statement\)[\s\S]{0,120}?\.join\(''\)/,
    );
    expect(controlsSource).toContain('accessibilityRole="checkbox"');
    expect(controlsSource).toContain("accessibilityState={{ checked }}");
    // 剥标记结果对全部 catalog 均为非空、无残留标记的完整句子
    for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko"] as const) {
      const label = parseLegalSegments(loginMessages[locale].consentStatement)
        .map((segment) => segment.text)
        .join("");
      expect(label.length).toBeGreaterThan(5);
      expect(label).not.toMatch(/[<>]/);
    }
  });
});

describe("LoginSkinControls 接线(源码断言)", () => {
  it("consent 组件只消费 colors.login.* 双态 token,弹窗按 groupScale 缩放", () => {
    expect(controlsSource).toContain("login.consentRadioCheckedBg");
    expect(controlsSource).toContain("login.consentOverlay");
    expect(controlsSource).toContain("login.secondaryButtonBg");
    expect(controlsSource).toContain("login.overlaySecondaryPressed");
    // 弹窗 = stage 内全屏遮罩 + 680×380 设计坐标系整层缩放(与登录组同口径)
    expect(controlsSource).toMatch(
      /LOGIN_CONSENT_DIALOG[\s\S]*transform: \[\{ scale \}\]/,
    );
    // 区域确认与协议确认共用设计标准正文 26/40，不允许按文案临时缩字号。
    expect(controlsSource).toContain("fontSize={D.body.font}");
    expect(controlsSource).toContain("lineHeight={D.body.lineHeight}");
    expect(controlsSource).not.toContain("compactBody");
    expect(loginSource).not.toContain("compactBody");
  });
});
