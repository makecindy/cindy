import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import {
  buildSessionOperationLayout,
  composerDisabledReasonI18nKey,
} from "@/session/sessionOperationLayout";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("session operation layout", () => {
  it("keeps the footer empty except the resync hint when the session is not synchronized", () => {
    expect(
      buildSessionOperationLayout({
        hasCurrentSession: false,
        hasActivePendingInteraction: true,
      }),
    ).toEqual({
      canUseComposer: false,
      composerDisabledReason: "当前任务还没有同步完成。",
      composerDisabledReasonSource: "session-syncing",
      composerSlot: "missing-session",
      messageHistoryMode: "hidden",
      pendingInteractionPlacement: "none",
      showPendingInteraction: false,
      showQueue: false,
    });
  });

  it("promotes pending interactions over the queue and composer", () => {
    expect(
      buildSessionOperationLayout({
        hasCurrentSession: true,
        hasActivePendingInteraction: true,
      }),
    ).toEqual({
      canUseComposer: false,
      composerDisabledReason: "先处理电脑端的待处理请求后才能继续输入。",
      composerDisabledReasonSource: "pending-interaction",
      composerSlot: "pending-interaction",
      messageHistoryMode: "visible",
      pendingInteractionPlacement: "composer",
      showPendingInteraction: true,
      showQueue: false,
    });
  });

  it("keeps the composer usable when the pending request cannot be resolved on mobile", () => {
    // 手机终结不了的卡(plugin_setup 等)只贴在输入框上方:否则用户既处理不了卡
    // 又发不出消息,会话在手机上被锁死。
    expect(
      buildSessionOperationLayout({
        hasCurrentSession: true,
        hasActivePendingInteraction: true,
        pendingInteractionBlocksComposer: false,
      }),
    ).toEqual({
      canUseComposer: true,
      composerDisabledReason: null,
      composerDisabledReasonSource: null,
      composerSlot: "editable",
      messageHistoryMode: "visible",
      pendingInteractionPlacement: "above-composer",
      showPendingInteraction: true,
      showQueue: true,
    });

    // 协作只读会话里,禁发理由仍归只读,但卡照样展示在输入框上方。
    expect(
      buildSessionOperationLayout({
        hasCurrentSession: true,
        hasActivePendingInteraction: true,
        pendingInteractionBlocksComposer: false,
        readOnlyReason: "worker session is read-only on mobile",
      }),
    ).toEqual({
      canUseComposer: false,
      composerDisabledReason: "worker session is read-only on mobile",
      composerDisabledReasonSource: "caller-provided",
      composerSlot: "read-only",
      messageHistoryMode: "visible",
      pendingInteractionPlacement: "above-composer",
      showPendingInteraction: true,
      showQueue: true,
    });
  });

  it("keeps deterministic remote failures visible and prevents send actions", () => {
    expect(
      buildSessionOperationLayout({
        hasCurrentSession: true,
        hasActivePendingInteraction: true,
        remoteUnavailableReason: "这台电脑已撤销手机访问权限。",
      }),
    ).toEqual({
      canUseComposer: false,
      composerDisabledReason: "这台电脑已撤销手机访问权限。",
      composerDisabledReasonSource: "caller-provided",
      composerSlot: "editable",
      messageHistoryMode: "visible",
      pendingInteractionPlacement: "none",
      showPendingInteraction: false,
      showQueue: false,
    });
  });

  it("keeps read-only collaboration sessions inspectable without enabling composer input", () => {
    expect(
      buildSessionOperationLayout({
        hasCurrentSession: true,
        hasActivePendingInteraction: false,
        readOnlyReason: "worker session is read-only on mobile",
      }),
    ).toEqual({
      canUseComposer: false,
      composerDisabledReason: "worker session is read-only on mobile",
      composerDisabledReasonSource: "caller-provided",
      composerSlot: "read-only",
      messageHistoryMode: "visible",
      pendingInteractionPlacement: "none",
      showPendingInteraction: false,
      showQueue: true,
    });
  });

  it("routes the shared model own disabled reasons through the locale catalog", () => {
    // 这两条理由在共享层是中文直出,而手机端会把它读给 composer 与队列行的
    // accessibility hint —— 必须按 locale 翻译,否则读屏在 en / ja / ko 下念混语。
    expect(composerDisabledReasonI18nKey("session-syncing")).toBe(
      "session.screen.composerSessionNotSynced",
    );
    expect(composerDisabledReasonI18nKey("pending-interaction")).toBe(
      "interaction.panel.composerBlockedByPending",
    );
    // 调用方自己传进来的理由已本地化,原样使用。
    expect(composerDisabledReasonI18nKey("caller-provided")).toBeNull();
    expect(composerDisabledReasonI18nKey(null)).toBeNull();

    for (const lang of ["zh-CN", "zh-TW", "en", "ja", "ko"]) {
      const session = JSON.parse(
        readFileSync(
          resolve(process.cwd(), `src/i18n/locales/${lang}/session.json`),
          "utf8",
        ),
      );
      const interaction = JSON.parse(
        readFileSync(
          resolve(process.cwd(), `src/i18n/locales/${lang}/interaction.json`),
          "utf8",
        ),
      );
      expect(
        session.screen?.composerSessionNotSynced,
        `${lang} composerSessionNotSynced`,
      ).toBeTruthy();
      expect(
        interaction.panel?.composerBlockedByPending,
        `${lang} composerBlockedByPending`,
      ).toBeTruthy();
    }

    // 会话页必须消费翻译后的值,不能直接渲染共享层字面量。
    const sessionScreenSource = readFileSync(
      resolve(process.cwd(), "app/sessions/[sessionId].tsx"),
      "utf8",
    );
    expect(sessionScreenSource).toContain("composerDisabledReasonI18nKey(");
    expect(sessionScreenSource).not.toContain(
      "sessionOperationLayout.composerDisabledReason}",
    );
  });

  it("shows queue and composer for normal writable sessions", () => {
    expect(
      buildSessionOperationLayout({
        hasCurrentSession: true,
        hasActivePendingInteraction: false,
      }),
    ).toEqual({
      canUseComposer: true,
      composerDisabledReason: null,
      composerDisabledReasonSource: null,
      composerSlot: "editable",
      messageHistoryMode: "visible",
      pendingInteractionPlacement: "none",
      showPendingInteraction: false,
      showQueue: true,
    });
  });
});
