import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

import { i18n } from "@/i18n";
import { confirmMobileModelWindowSwitch } from "@/session/modelWindowSwitchConfirmation";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("confirmMobileModelWindowSwitch", () => {
  it("keeps unknown and below-capacity model switches unchanged", async () => {
    const showAlert = vi.fn();

    await expect(
      confirmMobileModelWindowSwitch(199_999, 200_000, showAlert),
    ).resolves.toBe(true);
    await expect(
      confirmMobileModelWindowSwitch(300_000, undefined, showAlert),
    ).resolves.toBe(true);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it("blocks overflow switches on cancel or dismiss", async () => {
    const cancel = vi.fn((_title, _message, buttons) =>
      buttons?.[0]?.onPress?.(),
    );
    await expect(
      confirmMobileModelWindowSwitch(300_000, 272_000, cancel),
    ).resolves.toBe(false);

    const dismiss = vi.fn((_title, _message, _buttons, options) =>
      options?.onDismiss?.(),
    );
    await expect(
      confirmMobileModelWindowSwitch(300_000, 272_000, dismiss),
    ).resolves.toBe(false);
  });

  it("allows overflow rebuild only after explicit confirmation", async () => {
    const showAlert = vi.fn((_title, _message, buttons) =>
      buttons?.[1]?.onPress?.(),
    );

    await expect(
      confirmMobileModelWindowSwitch(300_000, 272_000, showAlert),
    ).resolves.toBe(true);
    expect(showAlert.mock.calls[0]?.[0]).toBe("这个模型装不下当前对话");
    expect(showAlert.mock.calls[0]?.[1]).toContain("300K");
    expect(showAlert.mock.calls[0]?.[1]).toContain("272K");
    expect(showAlert.mock.calls[0]?.[1]).toContain("110%");
  });
});
