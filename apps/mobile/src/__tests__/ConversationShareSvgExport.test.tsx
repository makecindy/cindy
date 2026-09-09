// @vitest-environment jsdom
import Module, { createRequire } from "node:module";
import { act, createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ConversationShareSvgHandle } from "@/session/ConversationShareSvg";
import type { ConversationShareMessage } from "@/session/conversationShareWebViewHtml";
import { lightColors, darkColors } from "@/theme/tokens";

const native = vi.hoisted(() => ({
  os: "ios",
  nextId: 0,
  svgLoads: new Map<number, () => void>(),
  imageLoads: new Map<string, () => void>(),
  imageErrors: new Map<string, () => void>(),
  barrier: undefined as (() => void) | undefined,
  queryCache: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("@/theme", () => ({ typeScale: { body: 15 } }));
vi.mock("react-native", async () => {
  const { createElement, useLayoutEffect } = await import("react");
  const uri = (source: string | { uri: string }) =>
    typeof source === "string" ? source : source.uri;
  const Image = Object.assign(
    ({
      source,
      onLoad,
      onError,
    }: {
      source: string | { uri: string };
      onLoad: () => void;
      onError: () => void;
    }) => {
      native.imageLoads.set(uri(source), onLoad);
      native.imageErrors.set(uri(source), onError);
      return createElement("span", { "data-probe": uri(source) });
    },
    {
      resolveAssetSource: (source: string | { uri: string }) => ({
        uri: uri(source),
        width: 100,
        height: 20,
      }),
      queryCache: native.queryCache,
    },
  );
  return {
    Image,
    Platform: {
      get OS() {
        return native.os;
      },
    },
    StyleSheet: { create: (s: unknown) => s },
    View: ({
      children,
      onLayout,
    }: {
      children?: import("react").ReactNode;
      onLayout?: () => void;
    }) => {
      useLayoutEffect(() => {
        if (!onLayout) return;
        native.barrier = onLayout;
        return () => {
          native.barrier = undefined;
        };
      }, [onLayout]);
      return createElement(
        "div",
        { "data-barrier": onLayout ? "true" : undefined },
        children,
      );
    },
  };
});
vi.mock("react-native-svg", async () => {
  const { createElement, forwardRef, useImperativeHandle, useState } =
    await import("react");
  const element = ({ children }: { children?: import("react").ReactNode }) =>
    createElement("span", null, children);
  return {
    default: forwardRef(
      ({ children }: { children?: import("react").ReactNode }, ref) => {
        useImperativeHandle(ref, () => ({ toDataURL: native.capture }), []);
        return createElement("section", { "data-svg": "true" }, children);
      },
    ),
    ClipPath: element,
    Defs: element,
    Rect: element,
    Text: element,
    TSpan: element,
    Image: ({
      href,
      onLoad,
    }: {
      href: string | { uri: string };
      onLoad: () => void;
    }) => {
      const [id] = useState(() => ++native.nextId);
      native.svgLoads.set(id, onLoad);
      return createElement("span", {
        "data-svg-image": id,
        "data-uri": typeof href === "string" ? href : href.uri,
      });
    },
  };
});

let ConversationShareSvg: typeof import("@/session/ConversationShareSvg").ConversationShareSvg;
const require = createRequire(import.meta.url);
const oldJpg = require.extensions[".jpg"];
const oldPng = require.extensions[".png"];
const nodeModule = Module as unknown as {
  _resolveFilename(request: string, ...args: unknown[]): string;
};
const resolveFilename = nodeModule._resolveFilename;
beforeAll(async () => {
  // Metro's static require assets are opaque identifiers; native decoding is
  // driven explicitly below. Do not replace the component or layout builder.
  require.extensions[".jpg"] = require.extensions[".png"] = (module, file) => {
    module.exports = file;
  };
  // Metro also resolves an unsuffixed asset to its checked-in density variant.
  nodeModule._resolveFilename = function (request, ...args) {
    return resolveFilename.call(
      this,
      request.replace(
        /^(\.\.\/\.\.\/assets\/login\/login-wordmark(?:-dark)?)\.png$/,
        "$1@2x.png",
      ),
      ...args,
    );
  };
  ({ ConversationShareSvg } = await import("@/session/ConversationShareSvg"));
});
afterAll(() => {
  nodeModule._resolveFilename = resolveFilename;
  if (oldJpg) require.extensions[".jpg"] = oldJpg;
  else delete require.extensions[".jpg"];
  if (oldPng) require.extensions[".png"] = oldPng;
  else delete require.extensions[".png"];
});

const good = "data:image/png;base64,Z29vZA==";
const bad = "data:image/png;base64,YmFk";
const message: ConversationShareMessage = {
  clientId: "m",
  kind: "assistant",
  attachments: [
    { kind: "image", uri: "cindy-media://bad", name: "broken attachment" },
  ],
  body: "before ![broken inline](cindy-media://bad) middle ![good](cindy-media://good) after ![repeat](cindy-media://good)",
  images: new Map([
    ["cindy-media://good", { uri: good, width: 40, height: 20 }],
    ["cindy-media://bad", { uri: bad, width: 40, height: 20 }],
  ]),
};
let root: Root;
let host: HTMLDivElement;
let ref: ReturnType<typeof createRef<ConversationShareSvgHandle>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  native.os = "ios";
  native.svgLoads.clear();
  native.imageLoads.clear();
  native.imageErrors.clear();
  native.capture
    .mockReset()
    .mockImplementation((done: (s: string) => void) => done("png"));
  native.queryCache
    .mockReset()
    .mockImplementation(async (uris: string[]) =>
      Object.fromEntries(uris.map((uri) => [uri, "memory"])),
    );
  native.barrier = undefined;
  host = document.createElement("div");
  root = createRoot(host);
  ref = createRef();
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
function render(width = 390, dark = false) {
  const colors = dark ? darkColors : lightColors;
  root.render(
    <StrictMode>
      <ConversationShareSvg
        ref={ref}
        messages={[message]}
        allShareableIds={["m"]}
        colors={{
          ...colors,
          dark,
          background: colors.surface,
          codeSurface: colors.chatCodeSurface,
          inlineCode: colors.chatInlineCodeText,
          syntax: {
            comment: colors.syntaxComment,
            function: colors.syntaxFunction,
            keyword: colors.syntaxKeyword,
            number: colors.syntaxNumber,
            property: colors.syntaxProperty,
            string: colors.syntaxString,
          },
        }}
        width={width}
      />
    </StrictMode>,
  );
}
function svgNodes(uri?: string) {
  return Array.from(
    host.querySelectorAll<HTMLElement>("[data-svg-image]"),
  ).filter((node) => !uri || node.dataset.uri === uri);
}
function loadSvgExcept(excluded?: string) {
  for (const node of svgNodes())
    if (node.dataset.uri !== excluded)
      native.svgLoads.get(Number(node.dataset.svgImage))!();
}
async function start() {
  let result!: Promise<string>;
  await act(async () => {
    result = ref.current!.exportPng();
  });
  return { result };
}

describe("SVG export lifecycle", () => {
  it.each([false, true])(
    "waits for each cold iOS occurrence, then captures once after native layout (dark=%s)",
    async (dark) => {
      await act(async () => render(390, dark));
      const { result } = await start();
      const last = svgNodes(good).at(-1)!;
      await act(async () => {
        for (const node of svgNodes())
          if (node !== last)
            native.svgLoads.get(Number(node.dataset.svgImage))!();
      });
      expect(native.barrier).toBeUndefined();
      await act(async () =>
        native.svgLoads.get(Number(last.dataset.svgImage))!(),
      );
      expect(native.capture).not.toHaveBeenCalled();
      await act(async () => {
        native.barrier!();
        native.barrier!();
      });
      await expect(result).resolves.toBe("png");
      expect(native.capture).toHaveBeenCalledTimes(1);
      expect(svgNodes(good)).toHaveLength(2);
      expect(svgNodes(bad)).toHaveLength(2);
    },
  );

  it("freezes timeout fallback before capture, preserving normal occurrences and ignoring late loads", async () => {
    await act(async () => render());
    const goodNodes = svgNodes(good);
    const lateLoads = svgNodes(bad).map((node) =>
      native.svgLoads.get(Number(node.dataset.svgImage))!,
    );
    const { result } = await start();
    await act(async () => loadSvgExcept(bad));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(native.capture).not.toHaveBeenCalled();
    expect(svgNodes(bad)).toHaveLength(0);
    expect(svgNodes(good)).toEqual(goodNodes);
    expect(host.textContent).toContain("broken attachment");
    expect(host.textContent).toContain("broken inline");
    expect(host.textContent).not.toContain("cindy-media://bad");
    await act(async () => {
      lateLoads.forEach((load) => load());
      render(420);
    });
    expect(svgNodes(bad)).toHaveLength(0);
    expect(svgNodes(good)).toEqual(goodNodes);
    await act(async () => native.barrier!());
    await expect(result).resolves.toBe("png");
  });

  it.each(["error", "disk", "empty-cache", "query-error"])(
    "handles Android cache hits with no SVG event and %s for a damaged image",
    async (failure) => {
      native.os = "android";
      native.queryCache.mockImplementation(async ([uri]: string[]) => {
        if (uri === bad && failure === "query-error")
          throw new Error("cache unavailable");
        if (uri === bad && failure === "empty-cache") return {};
        return { [uri!]: uri === bad ? "disk" : "memory" };
      });
      await act(async () => render());
      const { result } = await start();
      await act(async () => {
        for (const [uri, load] of native.imageLoads) {
          if (uri === bad && failure === "error")
            native.imageErrors.get(uri)!();
          else load();
        }
      });
      expect(svgNodes(good)).toHaveLength(2);
      expect(svgNodes(bad)).toHaveLength(0);
      expect(host.textContent).toContain("broken inline");
      // Bundled resource names are not queryable via Android's URI-only cache API.
      expect(
        native.queryCache.mock.calls.every(([uris]) =>
          uris[0].startsWith("data:"),
        ),
      ).toBe(true);
      expect(native.capture).not.toHaveBeenCalled();
      await act(async () => native.barrier!());
      await expect(result).resolves.toBe("png");
    },
  );

  it("rejects a missing footer within the deadline instead of capturing an incomplete footer", async () => {
    await act(async () => render());
    const { result } = await start();
    const rejected = expect(result).rejects.toThrow("footer is unavailable");
    await act(async () => {
      for (const node of [...svgNodes(good), ...svgNodes(bad)])
        native.svgLoads.get(Number(node.dataset.svgImage))!();
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await rejected;
    expect(native.capture).not.toHaveBeenCalled();
  });

  it.each(["decoding", "layout", "capturing"])(
    "cancels on unmount during %s and ignores late native events",
    async (stage) => {
      native.capture.mockImplementation(() => {});
      await act(async () => render());
      const { result } = await start();
      const rejected = expect(result).rejects.toThrow("cancelled");
      if (stage !== "decoding") await act(async () => loadSvgExcept());
      const lateLayout = native.barrier;
      if (stage === "capturing") await act(async () => native.barrier!());
      const lateCapture = native.capture.mock.calls[0]?.[0];
      await act(async () => root.render(null));
      await rejected;
      await act(async () => {
        native.svgLoads.forEach((load) => load());
        lateLayout?.();
        lateCapture?.("late png");
      });
      expect(native.capture).toHaveBeenCalledTimes(
        stage === "capturing" ? 1 : 0,
      );
    },
  );

  it.each(["throw", "empty", "no-callback", "no-layout"])(
    "bounds capture failure: %s",
    async (failure) => {
      native.capture.mockImplementation((done: (s: string) => void) => {
        if (failure === "throw") throw new Error("capture failed");
        if (failure === "empty") done("");
      });
      await act(async () => render());
      const { result } = await start();
      const rejected = expect(result).rejects.toThrow(
        failure === "throw"
          ? "capture failed"
          : failure === "empty"
            ? "empty"
            : "timed out",
      );
      await act(async () => loadSvgExcept());
      if (failure !== "no-layout") await act(async () => native.barrier!());
      await act(async () => vi.advanceTimersByTimeAsync(20_000));
      await rejected;
    },
  );
});
