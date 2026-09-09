import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIosActionSheetSpec,
  resolveIosActionSheetResult,
} from "@/platform/chrome/actionMenuModel";

const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, "\n");

describe("iOS chrome action menu model", () => {
  it("pins cancel last, drops disabled items, and marks the destructive index", () => {
    const spec = buildIosActionSheetSpec({
      cancelLabel: "取消",
      items: [
        { key: "rename", label: "重命名" },
        { key: "rewind", label: "回到此处", disabled: true },
        { key: "delete", label: "删除", destructive: true },
      ],
      title: "更多",
    });

    expect(spec.options).toEqual(["重命名", "删除", "取消"]);
    expect(spec.cancelButtonIndex).toBe(2);
    expect(spec.destructiveButtonIndex).toBe(1);
    expect(spec.enabledKeys).toEqual(["rename", "delete"]);
    expect(spec.title).toBe("更多");
  });

  it("resolves cancel, action, and out-of-range taps", () => {
    const spec = buildIosActionSheetSpec({
      cancelLabel: "Cancel",
      items: [
        { key: "copy", label: "Copy" },
        { key: "delete", label: "Delete", destructive: true },
      ],
    });

    expect(resolveIosActionSheetResult(spec, 0)).toEqual({
      kind: "action",
      key: "copy",
    });
    expect(resolveIosActionSheetResult(spec, 1)).toEqual({
      kind: "action",
      key: "delete",
    });
    expect(resolveIosActionSheetResult(spec, 2)).toEqual({ kind: "cancel" });
    expect(resolveIosActionSheetResult(spec, -1)).toEqual({ kind: "cancel" });
    expect(resolveIosActionSheetResult(spec, 9)).toEqual({ kind: "cancel" });
  });
});

describe("iOS chrome presenters stay on the system menu path", () => {
  it("opens session / message / chip / language menus through showActionMenu", () => {
    const sessionActions = readTextLf(
      resolve(process.cwd(), "src/session/useSessionListActions.ts"),
      "utf8",
    );
    const messageRenderer = readTextLf(
      resolve(process.cwd(), "src/session/MessageRenderer.tsx"),
      "utf8",
    );
    const sessionScreen = readTextLf(
      resolve(process.cwd(), "app/sessions/[sessionId].tsx"),
      "utf8",
    );
    const settings = readTextLf(
      resolve(process.cwd(), "app/settings.tsx"),
      "utf8",
    );
    const home = readTextLf(
      resolve(process.cwd(), "app/devices/index.tsx"),
      "utf8",
    );
    const pullDown = readTextLf(
      resolve(process.cwd(), "src/platform/chrome/NativePullDownMenu.tsx"),
      "utf8",
    );

    expect(sessionActions).toContain("setActionSheetSession(session)");
    expect(sessionActions).not.toContain("showActionMenu({");
    expect(sessionActions).toContain("action === 'rename' || action === 'delete'");
    expect(sessionActions).not.toContain("Platform.OS !== 'ios'");
    const expoSheet = readTextLf(
      resolve(process.cwd(), "src/session/SessionOptionsExpoSheet.tsx"),
      "utf8",
    );
    expect(expoSheet).toMatch(/from ['"]@expo\/ui['"]/);
    expect(expoSheet).toContain("<BottomSheet");
    expect(expoSheet).toContain("<List>");
    expect(expoSheet).toContain("<ListItem");
    expect(expoSheet).toContain("onClosed?.()");
    expect(expoSheet).not.toContain("snapPoints");
    expect(home).toContain("<SessionOptionsPresenter");
    const actionMenu = readTextLf(
      resolve(process.cwd(), "src/platform/chrome/showActionMenu.ts"),
      "utf8",
    );
    expect(actionMenu).toContain("showIosBottomActionSheet");
    expect(actionMenu).toMatch(/from ['"]xdt-ios-action-sheet['"]/);
    expect(messageRenderer).toContain("<NativePullDownMenu");
    expect(sessionScreen).toContain("usesSystemActionMenu()");
    expect(settings).toContain("<NativePullDownMenu");
    expect(home).toContain("<NativePullDownMenu");
    expect(home).toContain('testID="devices.title"');
    expect(home).toContain("<HomeNativeStackHeader");
    expect(home).toContain("filterActions={searchFilterMenu.filterActions}");
    const searchBar = readTextLf(
      resolve(process.cwd(), "src/session/HomeSearchBar.tsx"),
      "utf8",
    );
    expect(searchBar).toContain("<NativePullDownMenu");
    expect(pullDown).toContain("MenuView");
    expect(pullDown).toContain("usesNativePullDownMenu");
    const simpleHeader = readTextLf(
      resolve(process.cwd(), "src/platform/chrome/SimpleStackHeader.tsx"),
      "utf8",
    );
    const iosTitle = simpleHeader.slice(
      simpleHeader.indexOf("headerTitle: () =>"),
      simpleHeader.indexOf("headerLeft"),
    );
    expect(iosTitle).toContain("{title}");
    expect(iosTitle).not.toContain("eyebrow");
    expect(iosTitle).not.toContain("subtitle");
    expect(simpleHeader).toContain("eyebrow={eyebrow}");
    expect(simpleHeader).toContain("subtitle={subtitle}");
  });

  it("keeps Android fallback sheets and Maestro header anchors", () => {
    const sessionSheet = readTextLf(
      resolve(process.cwd(), "src/session/SessionActionSheet.tsx"),
      "utf8",
    );
    const messageSheet = readTextLf(
      resolve(process.cwd(), "src/session/MessageActionSheet.tsx"),
      "utf8",
    );
    const chipSheet = readTextLf(
      resolve(process.cwd(), "src/session/ChatFileChipMenuSheet.tsx"),
      "utf8",
    );
    const settings = readTextLf(
      resolve(process.cwd(), "app/settings.tsx"),
      "utf8",
    );
    const accountDeletion = readTextLf(
      resolve(process.cwd(), "app/account-deletion.tsx"),
      "utf8",
    );
    const automations = readTextLf(
      resolve(process.cwd(), "app/automations/[deviceId].tsx"),
      "utf8",
    );
    const deviceDetail = readTextLf(
      resolve(process.cwd(), "app/devices/[deviceId].tsx"),
      "utf8",
    );

    expect(sessionSheet).toContain('testID="home.sessionActions"');
    expect(messageSheet).toContain("<SheetModal");
    expect(chipSheet).toContain('testID="session.chipMenu"');
    expect(settings).toContain('backTestID="settings.backButton"');
    expect(settings).toContain('titleTestID="settings.title"');
    expect(settings).toContain("<SimpleStackHeader");
    expect(settings).not.toContain("ScreenHeader");
    expect(settings).toContain('backTestID="settings.voiceDictionary.backButton"');
    expect(settings).toContain('backTestID="settings.renameSelfDevice.backButton"');
    expect(accountDeletion).toContain("<SimpleStackHeader");
    expect(accountDeletion).toContain(
      'backTestID="accountDeletion.backButton"',
    );
    expect(automations).toContain("<SimpleStackHeader");
    expect(automations).toContain('backTestID="automations.backButton"');
    expect(deviceDetail).toContain("<SimpleStackHeader");
    expect(deviceDetail).toContain('backTestID="deviceDetail.backButton"');
    expect(deviceDetail).toContain("<SessionOptionsPresenter");
    const nativeSwitch = readTextLf(
      resolve(process.cwd(), "src/platform/chrome/NativeSwitch.tsx"),
      "utf8",
    );
    expect(nativeSwitch).toContain("accessibilityLabel?: string");
    expect(nativeSwitch).toContain("onAccessibilityTap");
    expect(nativeSwitch).toContain("usesExpoNativeSwitch");
    expect(nativeSwitch).toContain(
      'Platform.OS === "ios" || Platform.OS === "android"',
    );
    expect(nativeSwitch).toContain("Switch as RNSwitch");
    expect(nativeSwitch).toContain("if (!usesExpoNativeSwitch())");
    expect(settings).toContain(
      "accessibilityLabel={t('settings.notifications.taskDone')}",
    );
    expect(settings).toContain(
      "accessibilityLabel={t('settings.betaChannel.title')}",
    );
    expect(settings).toContain(
      "accessibilityLabel={t('settings.legal.analytics')}",
    );
  });
});
