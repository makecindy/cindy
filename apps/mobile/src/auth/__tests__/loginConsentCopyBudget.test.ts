import { expect, it } from "vitest";

import { parseLegalSegments } from "@/auth/legalText";
import { loginMessages } from "@/auth/loginMessages";
import { LOGIN_CONSENT_DIALOG, LOGIN_CONSENT_ROW } from "@/auth/loginSkinLayout";

// Guard tier (engineering-conventions §3.2): a static cross-file design contract between
// the catalog and the layout constants, not a render of the production component.
// If it stops running, an overlong consent row or dialog title ships clipped again.
// DESIGN.md §16.2 长度预算:单行槽超长是文案 bug,只能改文案,禁止缩字号 / 折行吸收。
// 协议行在固定宽度里居中,超预算时两端被裁(pt-BR 实机:radio 只剩半个、隐私链接被切);
// 弹窗标题单行,超预算时出省略号。估宽公式与桌面 legalSegments.catalog.test.ts 同源,
// 唯一差异是西里尔/希腊等"窄全角"字母按 0.6 em 计(理由见 charWidth)。
// 取 catalog 的全部语言,新增语言(如文言)自动进入预算。

/**
 * 单字符宽度(em)。Latin-1 约 0.5 em;CJK/假名/谚文等全角字符 1 em;
 * 西里尔、希腊、亚美尼亚字母在无衬线字体里是窄字母,实测 0.52–0.6 em
 * (Arial/Segoe UI 20px 测「Принимаю Условия и Политику конфиденциальности」
 * =517–520px,单字符 ≈0.55 em),取 0.6 em 作保守上界。
 * 旧公式把所有非 Latin-1 一律当 1 em,对 ru 文案会虚增近一倍预算,
 * 把本来一行放得下的协议行误判成超长。
 */
function charWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code <= 0xff) return 0.5;
  if (/[\u0370-\u03ff\u0400-\u052f\u0530-\u058f\u10a0-\u10ff]/.test(character)) return 0.6;
  return 1;
}

it.each(Object.keys(loginMessages) as (keyof typeof loginMessages)[])(
  "%s:协议行与弹窗标题在单行长度预算内",
  (locale) => {
    const estimate = (text: string, font: number) =>
      [...text].reduce((sum, character) => sum + charWidth(character) * font, 0);
    const messages = loginMessages[locale];
    const statement = parseLegalSegments(messages.consentStatement).map((s) => s.text).join("");
    const rowWidth = LOGIN_CONSENT_ROW.width - LOGIN_CONSENT_ROW.radio.hitSize - LOGIN_CONSENT_ROW.gap;
    expect(estimate(statement, LOGIN_CONSENT_ROW.font), statement).toBeLessThanOrEqual(rowWidth * 0.95);
    expect(estimate(messages.consentDialogTitle, LOGIN_CONSENT_DIALOG.title.font), messages.consentDialogTitle)
      .toBeLessThanOrEqual(LOGIN_CONSENT_DIALOG.width * 0.95);
  },
);
