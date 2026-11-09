// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramDocumentPreview } from "@/session/DiagramDocumentPreview";

// 测试价值：真实组件的格式切换、source/主题更新及失败重试。
// Bug：Mermaid 也同步扫描约 3.8 MB draw.io 脚本并构造无用 HTML。
// 现有 mermaidWebView.test.ts 仅测生成器，其他预览测试 mock 掉本组件；
// 本文件需要 jsdom 挂载并保留 Hooks 生命周期，因此单独使用 unit 组件测试。
// 最小失败输入：一个 .mmd 文件；仅改名为 .drawio 还可捕获遗漏 memo 依赖。
// 实测耗时：单文件 vitest run 墙钟 0.99 秒（2026-11-04）。
const state = vi.hoisted(() => ({
  mode: "light",
  surface: "white",
  readDrawio: vi.fn(),
  zoomable: undefined as boolean | undefined,
  webview: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
    createElement("button", { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("@/theme", () => ({
  spacing: { lg: 24 },
  textStyles: { body: {} },
  useTheme: () => ({ mode: state.mode, colors: { surface: state.surface } }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/session/mermaidWebView", () => ({
  MermaidDiagramWebView: ({ source, zoomable }: { source: string; zoomable?: boolean }) => {
    state.zoomable = zoomable;
    return createElement("pre", { "data-testid": "mermaid" }, source);
  },
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: unknown) => {
    state.webview(props);
    return createElement("div", { "data-testid": "drawio" });
  },
}));
vi.mock("@/session/documentPreviewAssets.generated", () => ({
  get MOBILE_DRAWIO_JS() {
    state.readDrawio();
    // Substitute only the renderer distribution; run the production HTML's
    // inline setup scripts below and inspect the actual renderer input.
    return "var GraphViewer = { createViewerForElement: function(el) { el.textContent = JSON.parse(el.getAttribute('data-mxgraph')).xml; } };";
  },
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.mode = "light";
  state.surface = "white";
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

function render(name: string, source: string) {
  act(() => root.render(<DiagramDocumentPreview name={name} source={source} />));
}

function previewDocument() {
  const { source } = state.webview.mock.lastCall![0];
  const doc = new DOMParser().parseFromString(source.html, "text/html");
  const postMessage = vi.fn();
  runInNewContext(
    Array.from(doc.scripts, (script) => script.textContent).join("\n"),
    { document: doc, window: { ReactNativeWebView: { postMessage } } },
  );
  expect(postMessage).not.toHaveBeenCalled();
  const diagram = doc.getElementById("diagram")!;
  return { doc, diagram, options: JSON.parse(diagram.getAttribute("data-mxgraph")!) };
}

describe("DiagramDocumentPreview", () => {
  it("renders and updates Mermaid without reading the draw.io script, zooming by pinch only", () => {
    render("flow.mmd", "graph TD\nA --> B");
    expect(host.querySelector("pre")?.textContent).toBe("graph TD\nA --> B");
    render("flow.mmd", "graph TD\nB --> C");
    state.mode = "dark";
    state.surface = "black";
    render("flow.mmd", "graph TD\nB --> C");
    expect(host.querySelector("pre")?.textContent).toBe("graph TD\nB --> C");
    expect(state.readDrawio).not.toHaveBeenCalled();
    expect(state.webview).not.toHaveBeenCalled();
    // 手机缩放靠捏合:图本身可缩放,不再摆放大 / 缩小 / 适应按钮。
    expect(state.zoomable).toBe(true);
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("constructs draw.io on a format-only change and updates source and theme", () => {
    const source = '<mxGraphModel label="</script><img src=x>" />';
    render("flow.mmd", source);
    render("flow.drawio", source);
    let preview = previewDocument();
    expect(preview.diagram.textContent).toBe(source);
    expect(preview.doc.querySelector("img")).toBeNull();
    expect(preview.options["dark-mode"]).toBe("0");

    const next = "<mxGraphModel><root /></mxGraphModel>";
    render("flow.drawio", next);
    expect(previewDocument().diagram.textContent).toBe(next);
    state.mode = "dark";
    render("flow.drawio", next);
    expect(previewDocument().options["dark-mode"]).toBe("1");
    state.surface = "black";
    render("flow.drawio", next);
    preview = previewDocument();
    expect(preview.doc.querySelector("style")?.textContent).toContain("background:black");

    state.readDrawio.mockClear();
    render("flow.mmd", next);
    expect(host.querySelector("pre")?.textContent).toBe(next);
    expect(host.querySelector('[data-testid="drawio"]')).toBeNull();
    expect(state.readDrawio).not.toHaveBeenCalled();
  });

  it("retains draw.io failure/retry and rejects external navigation", () => {
    render("flow.drawio", "<mxGraphModel />");
    const props = state.webview.mock.lastCall![0];
    expect(props.onShouldStartLoadWithRequest({ url: "about:blank" })).toBe(true);
    expect(props.onShouldStartLoadWithRequest({ url: "https://example.com" })).toBe(false);
    act(() => props.onMessage({ nativeEvent: { data: "error" } }));
    expect(host.textContent).toContain("files.preview.readFailed");
    expect(host.querySelector('[data-testid="drawio"]')).toBeNull();
    act(() => host.querySelector("button")!.click());
    expect(host.querySelector('[data-testid="drawio"]')).not.toBeNull();
    expect(previewDocument().diagram.textContent).toBe("<mxGraphModel />");
  });
});
