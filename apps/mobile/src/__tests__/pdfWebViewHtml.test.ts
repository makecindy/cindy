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
