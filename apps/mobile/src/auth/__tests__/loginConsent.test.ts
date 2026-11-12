import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import ts from "typescript";

import { parseLegalSegments } from "@/auth/legalText";
import { LOGIN_CONSENT_ROW } from "@/auth/loginSkinLayout";
import { LEGAL_LINKS } from "@/config/legalLinks";
import { loginPalettes } from "@/theme/tokens";
import { loginMessages } from "@/auth/loginMessages";

it('evaluates the production regional legal links for the Global build', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/config/legalLinks.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  new Function('require', 'exports', compiled)(() => ({ AUTH_REGION: 'global' }), exports);
  expect(exports.LEGAL_LINKS).toEqual({ termsOfService: 'https://cindy.app/terms', privacyPolicy: 'https://cindy.app/privacy' });
});

// The P1 was clipped Android hit bounds and an unlabeled checkbox. Run the
// production component, checking actual hit geometry and accessible properties.
it.each(['light', 'dark'] as const)('keeps consent reachable, labeled and interactive in %s mode', (mode) => {
  const source = ts.createSourceFile('controls.tsx', readFileSync(resolve(process.cwd(), 'src/components/LoginSkinControls.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const row = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'LoginConsentRow');
  if (!row) throw new Error('Missing production consent row');
  const code = ts.transpileModule(row.getText(source).replace(/^export\s+/, ''), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const bindings = { React, View: 'View', Pressable: 'Pressable', ConsentCheckGlyph: 'Check', LegalStatementText: 'LegalText',
    useTheme: () => ({ colors: { login: loginPalettes[mode] } }), LOGIN_CONSENT_ROW, parseLegalSegments };
  const render = new Function(...Object.keys(bindings), code + '\nreturn LoginConsentRow;')(...Object.values(bindings));
  const toggle = vi.fn();
  const tree = render({ checked: true, onToggle: toggle, statement: loginMessages.en.consentStatement, onOpenTerms: vi.fn(), onOpenPrivacy: vi.fn() });
  const radio = tree.props.children[0];
  expect(radio.props.accessibilityRole).toBe('checkbox');
  expect(radio.props.accessibilityState).toEqual({ checked: true });
  expect(radio.props.accessibilityLabel).not.toMatch(/[<>]/);
  expect(radio.props.style.height).toBeGreaterThanOrEqual(88);
  expect(radio.props.style.width).toBeGreaterThanOrEqual(88);
  expect(radio.props.hitSlop).toBeUndefined();
  expect(tree.props.style.top + tree.props.style.height).toBe(LOGIN_CONSENT_ROW.y + LOGIN_CONSENT_ROW.height);
  radio.props.onPress();
  expect(toggle).toHaveBeenCalledOnce();
  expect(radio.props.children.props.style.backgroundColor).toBe(loginPalettes[mode].consentRadioCheckedBg);
});

/**
 * 协议同意链路专测(consent PR,移动端):
 * 组件树依赖 expo/RN 运行时,node vitest 下沿用仓内「纯数据断言 + 读源码接线断言」
 * 模式(loginSkinVisual/loginScenarioHarness 同款)。行为级续接/拦截语义与桌面
 * LoginPage.consent.test.tsx 同源(桌面 jsdom 全交互覆盖)。
 */


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
  it("cn 构建 → cindy.cn 双链接", () => {
    expect(LEGAL_LINKS.termsOfService).toBe(
      "https://cindy.cn/terms",
    );
    expect(LEGAL_LINKS.privacyPolicy).toBe(
      "https://cindy.cn/privacy",
    );
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
  it.each(["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-PT", "pt-BR"] as const)(
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
  it.each(["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-PT", "pt-BR"] as const)(
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

  it("读屏标签:accessibilityLabel = 协议声明剥标记纯文本,多语随 i18n 无新增 key", () => {
    // 剥标记结果对全部 catalog 均为非空、无残留标记的完整句子
    for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-PT", "pt-BR"] as const) {
      const label = parseLegalSegments(loginMessages[locale].consentStatement)
        .map((segment) => segment.text)
        .join("");
      expect(label.length).toBeGreaterThan(5);
      expect(label).not.toMatch(/[<>]/);
    }
  });
});
