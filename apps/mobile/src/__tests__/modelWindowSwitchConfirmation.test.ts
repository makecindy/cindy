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
      confirmMobileModelWindowSwitch(199_999, 200_000, null, showAlert),
    ).resolves.toBe(true);
    await expect(
      confirmMobileModelWindowSwitch(300_000, undefined, "ssh-host", showAlert),
    ).resolves.toBe(true);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it("blocks overflow switches on cancel or dismiss", async () => {
    const cancel = vi.fn((_title, _message, buttons) =>
      buttons?.[0]?.onPress?.(),
    );
    await expect(
      confirmMobileModelWindowSwitch(300_000, 272_000, null, cancel),
    ).resolves.toBe(false);

    const dismiss = vi.fn((_title, _message, _buttons, options) =>
      options?.onDismiss?.(),
    );
    await expect(
      confirmMobileModelWindowSwitch(300_000, 272_000, null, dismiss),
    ).resolves.toBe(false);
  });

  it("allows overflow rebuild only after explicit confirmation", async () => {
    const showAlert = vi.fn((_title, _message, buttons) =>
      buttons?.[1]?.onPress?.(),
    );

    await expect(
      confirmMobileModelWindowSwitch(300_000, 272_000, null, showAlert),
    ).resolves.toBe(true);
    expect(showAlert.mock.calls[0]?.[0]).toBe("这个模型装不下当前对话");
    expect(showAlert.mock.calls[0]?.[1]).toContain("300K");
    expect(showAlert.mock.calls[0]?.[1]).toContain("272K");
    expect(showAlert.mock.calls[0]?.[1]).toContain("110%");
  });

  it("blocks pressured SSH switches without offering a continue action", async () => {
    const showAlert = vi.fn((_title, _message, buttons) =>
      buttons?.[0]?.onPress?.(),
    );

    await expect(
      confirmMobileModelWindowSwitch(180_000, 200_000, "ssh-host", showAlert),
    ).resolves.toBe(false);
    expect(showAlert.mock.calls[0]?.[0]).toBe("当前远程任务无法安全切换模型");
    expect(showAlert.mock.calls[0]?.[1]).toContain("无法安全切换");
    expect(showAlert.mock.calls[0]?.[2]).toHaveLength(1);

    const lowPressureAlert = vi.fn();
    await expect(
      confirmMobileModelWindowSwitch(
        179_999,
        200_000,
        "ssh-host",
        lowPressureAlert,
      ),
    ).resolves.toBe(true);
    expect(lowPressureAlert).not.toHaveBeenCalled();
  });
});
