// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerAttachmentCollapsedBadge,
  ComposerAttachmentTray,
} from "@/session/ComposerAttachmentTray";
import { i18n } from "@/i18n";
import { useComposerImageExpansion } from "@/session/useComposerImageExpansion";
import { useComposerPendingImagePreview } from "@/session/useComposerPendingImagePreview";
import type { RemoteSerializedAttachment } from "@/session/types";
import type { PendingLocalAttachmentUpload } from "@/session/mobileLocalAttachmentUpload";

const theme = vi.hoisted(() => ({
  mode: "light",
  files: null as Set<string> | null,
  mounts: 0,
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : style && typeof style === "object"
        ? (style as Record<string, unknown>)
        : {};
  const view =
    (tag: string) =>
    ({
      children,
      style,
      testID,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
      onPress?: () => void;
      disabled?: boolean;
    }) =>
      createElement(
        tag,
        {
          "data-testid": testID,
          onClick: onPress,
          disabled,
          "data-color": flatten(
            typeof style === "function" ? style({ pressed: false }) : style,
          ).color,
        },
        children,
      );
  return {
    View: view("div"),
    Pressable: view("button"),
    Text: view("span"),
    ActivityIndicator: ({ color }: { color: string }) =>
      createElement("i", { "data-testid": "spinner", "data-color": color }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  };
});
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).Text,
}));
vi.mock("@/components/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("@/session/ImageLightbox", async () => {
  const { useEffect } = await import("react");
  return {
    ImageLightbox: ({
      images,
      onClose,
    }: {
      images: { url: string }[];
      onClose(): void;
    }) => {
      useEffect(() => {
        theme.mounts += 1;
      }, []);
      return (
        <button data-testid="lightbox" onClick={onClose}>
          {theme.files && !theme.files.has(images[0].url)
            ? "missing"
            : images[0].url}
        </button>
      );
    },
  };
});
vi.mock("lucide-react-native", async () => {
  const { createElement } = await import("react");
  const icon =
    (name: string) =>
    ({ color }: { color: string }) =>
      createElement("i", { "data-testid": name, "data-color": color });
  return { Pen: icon("pen"), RefreshCw: icon("retry-icon"), X: icon("x") };
});
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  const colors = () =>
    theme.mode === "light" ? tokens.lightColors : tokens.darkColors;
  return {
    ...tokens,
    useTheme: () => ({ colors: colors(), mode: theme.mode }),
    useThemedStyles: (make: (value: typeof tokens.lightColors) => unknown) =>
      make(colors()),
  };
});

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  theme.files = null;
  theme.mounts = 0;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage("zh-CN");
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
});

const pending = (
  localId: string,
  failed?: boolean,
): PendingLocalAttachmentUpload => ({
  localId,
  kind: "image",
  previewUri: `file:///${localId}.jpg`,
  name: `${localId}.jpg`,
  size: 1,
  failed,
});
const attachment = (id: string): RemoteSerializedAttachment => ({
  id,
  name: `${id}.jpg`,
  path: `/tmp/${id}.jpg`,
  ext: "jpg",
  size: 1,
  category: "image",
  mimeType: "image/jpeg",
});
const colorOf = (selector: string) =>
  host.querySelector(selector)?.getAttribute("data-color");

describe("composer attachment tray overlay foreground", () => {
  // PR #6291: production expansion hook, with a button representing the card's
  // collapse gesture. Existing tray tests do not exercise new-task expansion.
  it("opens for new images but respects collapse through paste and upload completion", () => {
    function Composer({
      uploaded,
      uploading,
      placeholders,
      revision,
    }: {
      uploaded: number;
      uploading: number;
      placeholders: number;
      revision: number;
    }) {
      const expansion = useComposerImageExpansion(
        uploaded + uploading + placeholders,
        revision,
      );
      return (
        <button onClick={expansion.collapse}>
          {expansion.active ? "expanded" : "collapsed"}
        </button>
      );
    }
    const render = (
      uploaded: number,
      uploading: number,
      placeholders = 0,
      revision = 1,
    ) =>
      act(() =>
        root.render(
          <Composer
            uploaded={uploaded}
            uploading={uploading}
            placeholders={placeholders}
            revision={revision}
          />,
        ),
      );
    render(0, 0);
    expect(host.textContent).toBe("collapsed");
    render(0, 1);
    expect(host.textContent).toBe("expanded");
    act(() => host.querySelector("button")!.click());
    render(1, 1); // delivered/pending overlap
    expect(host.textContent).toBe("collapsed");
    render(1, 0);
    expect(host.textContent).toBe("collapsed");
    render(1, 0, 1, 2); // paste another image
    expect(host.textContent).toBe("expanded");
    act(() => host.querySelector("button")!.click());
    render(1, 1, 0, 2); // placeholder becomes a pending upload, no new selection
    expect(host.textContent).toBe("collapsed");
    render(0, 0);
    render(1, 0); // restored image draft
    expect(host.textContent).toBe("expanded");
  });

  // 用户反馈：在途图片只能看缩略图。既有颜色测试不覆盖点击；unit 层用一张
  // 上传中图片验证真实托盘打开本地预览，并在上传完成后仍保持查看器。
  it("switches an open preview to the durable URI when the temporary file is deleted", () => {
    theme.files = new Set(["file:///uploading.jpg"]);
    function Composer({
      uploading,
      delivered,
      showTray,
      pendingUri,
    }: {
      uploading: boolean;
      delivered: boolean;
      showTray: boolean;
      pendingUri: string;
    }) {
      const props = {
        attachments: delivered ? [attachment("done")] : [],
        previews: { done: "file:///durable.jpg" },
        pendingUploads: uploading
          ? [{ ...pending("uploading"), previewUri: pendingUri }]
          : [],
        getUploadedAttachmentId: (id: string) =>
          delivered && id === "uploading" ? "done" : undefined,
      };
      const preview = useComposerPendingImagePreview(props);
      return (
        <>
          {showTray && (
            <ComposerAttachmentTray
              {...props}
              onPreviewPending={preview.open}
              onRemove={() => {}}
              onPreview={() => {}}
              testIDPrefix="t"
            />
          )}
          {preview.host}
        </>
      );
    }
    const render = (
      uploading: boolean,
      delivered = false,
      showTray = true,
      pendingUri = "file:///uploading.jpg",
    ) =>
      act(() =>
        root.render(
          <Composer
            uploading={uploading}
            delivered={delivered}
            showTray={showTray}
            pendingUri={pendingUri}
          />,
        ),
      );
    render(true);
    const preview = host.querySelector<HTMLButtonElement>(
      '[data-testid="t.attachmentPendingPreviewButton"]',
    );
    expect(preview).not.toBeNull();
    act(() => preview!.click());
    expect(host.querySelector('[data-testid="lightbox"]')?.textContent).toBe(
      "file:///uploading.jpg",
    );
    render(true, false, false); // Keyboard blur unmounts the attachment tray.
    expect(host.querySelector('[data-testid="lightbox"]')?.textContent).toBe(
      "file:///uploading.jpg",
    );
    // The same open viewer upgrades from the picker thumbnail before PUT finishes.
    theme.files.add("file:///original.jpg");
    render(true, false, false, "file:///original.jpg");
    expect(host.querySelector('[data-testid="lightbox"]')?.textContent).toBe(
      "file:///original.jpg",
    );
    expect(theme.mounts).toBe(1);
    theme.files.delete("file:///original.jpg");
    theme.files.delete("file:///uploading.jpg");
    theme.files.add("file:///durable.jpg");
    // onUploaded publishes the delivered attachment before the controller removes pending.
    render(true, true, false);
    expect(host.querySelector('[data-testid="lightbox"]')?.textContent).toBe(
      "file:///durable.jpg",
    );
    render(false, true, false);
    expect(host.querySelector('[data-testid="lightbox"]')?.textContent).toBe(
      "file:///durable.jpg",
    );
    expect(theme.mounts).toBe(1); // No native modal dismissal/presentation race.
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[data-testid="lightbox"]')!
        .click(),
    );
    expect(host.querySelector('[data-testid="lightbox"]')).toBeNull();
  });

  it("keeps unresolved images disabled and retry/cancel separate from preview", () => {
    const retry = vi.fn();
    const cancel = vi.fn();
    act(() =>
      root.render(
        <ComposerAttachmentTray
          attachments={[]}
          previews={{}}
          onRemove={() => {}}
          onPreview={() => {}}
          onPreviewPending={() => {}}
          pendingUploads={[
            { ...pending("unresolved"), previewUri: "" },
            pending("failed", true),
          ]}
          onRetryPending={retry}
          onRemovePending={cancel}
          testIDPrefix="t"
        />,
      ),
    );
    const preview = host.querySelector<HTMLButtonElement>(
      '[data-testid="t.attachmentPendingPreviewButton"]',
    )!;
    expect(preview.disabled).toBe(true);
    act(() => preview.click());
    act(() =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="t.attachmentPendingRetryButton"]',
        )!
        .click(),
    );
    act(() =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="t.attachmentPendingRemoveButton"]',
        )!
        .click(),
    );
    expect(retry).toHaveBeenCalledWith("failed");
    expect(cancel).toHaveBeenCalledWith("unresolved");
    expect(host.querySelector('[data-testid="lightbox"]')).toBeNull();
  });

  // 遮罩 scrim 两种模式都是深色:前景必须恒白,不能跟着主题反相成近黑。
  it.each(["light", "dark"])(
    "keeps spinner, retry and +N readable on the dark scrim in %s mode",
    async (mode) => {
      theme.mode = mode;
      const { darkColors, lightColors } = await import("@/theme/tokens");
      const colors = mode === "light" ? lightColors : darkColors;
      act(() =>
        root.render(
          <>
            <ComposerAttachmentTray
              attachments={[]}
              previews={{}}
              onRemove={() => {}}
              onPreview={() => {}}
              onPreviewPending={() => {}}
              pendingUploads={[pending("uploading"), pending("failed", true)]}
              testIDPrefix="t"
            />
            <ComposerAttachmentCollapsedBadge
              attachments={[attachment("a"), attachment("b")]}
              previews={{ a: "file:///a.jpg" }}
              onPress={() => {}}
            />
          </>,
        ),
      );
      expect(colorOf('[data-testid="spinner"]')).toBe(colors.swipeActionText);
      expect(colorOf('[data-testid="retry-icon"]')).toBe(
        colors.swipeActionText,
      );
      const retryText = [...host.querySelectorAll("span")].find(
        (node) => node.textContent === i18n.t("composer.attachments.retry"),
      );
      expect(retryText?.getAttribute("data-color")).toBe(
        colors.swipeActionText,
      );
      const plusN = [...host.querySelectorAll("span")].find(
        (node) => node.textContent === "+1",
      );
      expect(plusN?.getAttribute("data-color")).toBe(colors.swipeActionText);
      expect(colors.swipeActionText).not.toBe(darkColors.ctaText);
    },
  );
});
