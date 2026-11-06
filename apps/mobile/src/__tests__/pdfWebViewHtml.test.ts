// #8356 r4436061999. Execute the production WebView document in a VM and observe
// page dimensions. Existing route/source tests never run the reader script.
// Unit tier: injected PDF engine, no native WebView/network/canvas startup.
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { buildPdfWebViewHtml } from "@/session/pdfWebViewHtml";

vi.mock("@/session/documentPreviewAssets.generated", () => ({
  MOBILE_PDF_JS: "",
  MOBILE_PDF_CSS: "",
  MOBILE_PDF_BINARY_ASSETS: {},
}));

it.each([
  [390, 640],
  [760, 240],
])(
  "fits a portrait PDF within %s × %s and restores fit after zoom",
  async (width, height) => {
    const elements: Array<{
      style: Record<string, string>;
      dataset: Record<string, unknown>;
      replaceChildren: () => void;
    }> = [];
    const listeners = new Map<string, () => void>();
    const context = createContext({
      innerWidth: width,
      innerHeight: height,
      atob: () => "",
      window: {
        document: {
          createElement: () => {
            const el = { style: {}, dataset: {}, replaceChildren: () => {} };
            elements.push(el);
            return el;
          },
        },
      },
      document: { getElementById: () => ({ append: () => {} }) },
      addEventListener: (name: string, callback: () => void) =>
        listeners.set(name, callback),
      IntersectionObserver: class {
        observe() {}
        disconnect() {}
      },
      pdfjsLib: {
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              getViewport: () => ({ width: 612, height: 792 }),
            }),
          }),
        }),
      },
    });
    const html = buildPdfWebViewHtml("", {
      surface: "#fff",
      textPrimary: "#000",
    });
    const script = html.slice(
      html.indexOf("<script>") + 8,
      html.lastIndexOf("</script>"),
    );
    runInContext(script, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const page = elements[0];
    const bounds = () => ({
      width: parseFloat(page.style.width),
      height: parseFloat(page.style.height),
    });
    const fit = bounds();
    expect(fit.width).toBeLessThanOrEqual(width - 24);
    expect(fit.height).toBeLessThanOrEqual(height - 24);
    expect(fit.width / fit.height).toBeCloseTo(612 / 792);
    await context.window.__cindyPdfCommand({ type: "zoom", value: 2 });
    expect(bounds().height).toBeCloseTo(fit.height * 2);
    await context.window.__cindyPdfCommand({ type: "zoom", value: 1 });
    expect(bounds()).toEqual(fit);
    context.innerHeight = 200;
    listeners.get("resize")!();
    expect(bounds().height).toBeLessThanOrEqual(176);
  },
);

// 手机去掉缩放按钮后,缩放只靠阅读器自己的手势:松手后按新倍率重新排版(而非 WebView
// 把已画好的 canvas 拉大发糊),双击在适应与放大之间切换。
it("zooms by pinch and double tap, re-laying out pages at the new scale", async () => {
  const elements: Array<{ style: Record<string, string>; dataset: Record<string, unknown>; replaceChildren: () => void; getBoundingClientRect: () => DOMRect }> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const pagesStyle: Record<string, string> = {};
  const scrollBy = vi.fn();
  const context = createContext({
    innerWidth: 390,
    innerHeight: 640,
    scrollX: 0,
    scrollY: 0,
    scrollBy,
    Date,
    atob: () => "",
    window: {
      document: {
        createElement: () => {
          const el = {
            style: {} as Record<string, string>,
            dataset: {},
            replaceChildren: () => {},
            getBoundingClientRect: () => {
              const width = parseFloat(el.style.width);
              const height = parseFloat(el.style.height);
              return { left: 12, top: 12, width, height, bottom: 12 + height } as DOMRect;
            },
          };
          elements.push(el);
          return el;
        },
      },
    },
    document: { getElementById: () => ({ append: () => {}, style: pagesStyle }) },
    addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
    pdfjsLib: {
      getDocument: () => ({
        promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }) }),
      }),
    },
  });
  const html = buildPdfWebViewHtml("", { surface: "#fff", textPrimary: "#000" });
  runInContext(html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>")), context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const height = () => parseFloat(elements[0].style.height);
  const fit = height();
  const touch = (name: string, points: Array<[number, number]>) =>
    listeners.get(name)!({ touches: points.map(([clientX, clientY]) => ({ clientX, clientY })), preventDefault: () => {} });

  touch("touchstart", [[150, 200], [250, 200]]);
  touch("touchmove", [[100, 200], [300, 200]]);
  expect(pagesStyle.transform).toBe("translate(0px,0px) scale(2)");
  expect(height()).toBe(fit); // 捏合中只做预览缩放,不重排。
  touch("touchend", [[100, 200]]);
  expect(pagesStyle.transform).toBe("");
  expect(height()).toBeCloseTo(fit * 2);
  expect(scrollBy).toHaveBeenCalled(); // 手指下的内容留在原处。

  // 双指边捏合边平移:预览跟着两指中点走,松手后以最后的中点为锚点补滚动。
  scrollBy.mockClear();
  touch("touchstart", [[150, 200], [250, 200]]);
  touch("touchmove", [[150, 260], [250, 260]]);
  expect(pagesStyle.transform).toBe("translate(0px,60px) scale(1)");
  touch("touchend", [[150, 260]]);
  expect(scrollBy).toHaveBeenCalledWith(-0, -60); // 倍率没变:不重排,只按两指移动的距离补滚动。

  // 双击回到适应,再双击放大。
  for (let i = 0; i < 2; i++) {
    touch("touchstart", [[200, 300]]);
    touch("touchend", []);
  }
  expect(height()).toBeCloseTo(fit);
  for (let i = 0; i < 2; i++) {
    touch("touchstart", [[200, 300]]);
    touch("touchend", []);
  }
  expect(height()).toBeCloseTo(fit * 2.5);
});
