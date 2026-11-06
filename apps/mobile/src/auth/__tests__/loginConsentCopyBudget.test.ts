import { expect, it } from "vitest";

import { parseLegalSegments } from "@/auth/legalText";
import { loginMessages } from "@/auth/loginMessages";
import { LOGIN_CONSENT_DIALOG, LOGIN_CONSENT_ROW } from "@/auth/loginSkinLayout";

// Guard tier (engineering-conventions §3.2): a static cross-file design contract between
// the catalog and the layout constants, not a render of the production component.
// If it stops running, an overlong consent row or dialog title ships clipped again.
// DESIGN.md §16.2 长度预算:单行槽超长是文案 bug,只能改文案,禁止缩字号 / 折行吸收。
// 协议行在固定宽度里居中,超预算时两端被裁(pt-BR 实机:radio 只剩半个、隐私链接被切);
// 弹窗标题单行,超预算时出省略号。估宽公式与桌面 legalSegments.catalog.test.ts 同源。
// 取 catalog 的全部语言,新增语言(如文言)自动进入预算。
it.each(Object.keys(loginMessages) as (keyof typeof loginMessages)[])(
  "%s:协议行与弹窗标题在单行长度预算内",
  (locale) => {
    const estimate = (text: string, font: number) =>
      [...text].reduce((sum, character) => sum + ((character.codePointAt(0) ?? 0) <= 0xff ? 0.5 : 1) * font, 0);
    const messages = loginMessages[locale];
    const statement = parseLegalSegments(messages.consentStatement).map((s) => s.text).join("");
    const rowWidth = LOGIN_CONSENT_ROW.width - LOGIN_CONSENT_ROW.radio.hitSize - LOGIN_CONSENT_ROW.gap;
    expect(estimate(statement, LOGIN_CONSENT_ROW.font), statement).toBeLessThanOrEqual(rowWidth * 0.95);
    expect(estimate(messages.consentDialogTitle, LOGIN_CONSENT_DIALOG.title.font), messages.consentDialogTitle)
      .toBeLessThanOrEqual(LOGIN_CONSENT_DIALOG.width * 0.95);
  },
);
