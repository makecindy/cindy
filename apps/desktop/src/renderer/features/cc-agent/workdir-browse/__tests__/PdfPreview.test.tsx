// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/chat/PreviewChrome', () => ({
  PreviewFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PreviewButton: ({
    children,
    onClick,
    label,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    label: string;
  }) => (
    <button aria-label={label} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../UnrenderablePlaceholder', () => ({
  UnrenderablePlaceholder: () => <div data-testid="unrenderable" />,
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
  TextLayer: class {
    render() {
      return Promise.resolve();
    }
    cancel() {}
  },
}));

import * as pdfjs from 'pdfjs-dist';

import {
  getPdfRenderPixelRatio,
  PDF_PREVIEW_MAX_CANVAS_PIXELS,
  PDF_PREVIEW_MAX_DPR,
  PdfPreview,
} from '../PdfPreview';

type FakeObserverEntry = Pick<
  IntersectionObserverEntry,
  'target' | 'isIntersecting' | 'intersectionRatio'
>;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }

  emit(target: Element, isIntersecting: boolean, intersectionRatio = isIntersecting ? 1 : 0) {
    this.callback(
      [
        {
          target,
          isIntersecting,
          intersectionRatio,
        } as FakeObserverEntry as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function installElectronApi() {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    readFileBytes: vi.fn(async () => ({ bytes: new Uint8Array([37, 80, 68, 70]) })),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeIntersectionObserver.instances = [];
});

beforeEach(() => {
  installElectronApi();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
});

describe('getPdfRenderPixelRatio', () => {
  it('caps high-DPI output and always honors the per-page pixel budget', () => {
    expect(getPdfRenderPixelRatio(500, 500, 4)).toBe(PDF_PREVIEW_MAX_DPR);

    const ratio = getPdfRenderPixelRatio(10_000, 10_000, 2);
    expect(ratio).toBeLessThan(1);
    expect(Math.floor(10_000 * ratio) * Math.floor(10_000 * ratio)).toBeLessThanOrEqual(
      PDF_PREVIEW_MAX_CANVAS_PIXELS,
    );
  });

  it('falls back to a sane DPR for invalid devicePixelRatio values', () => {
    expect(getPdfRenderPixelRatio(918, 1188, Number.NaN)).toBe(1);
    expect(getPdfRenderPixelRatio(918, 1188, 0)).toBe(1);
  });

  it.each([
    [1.5, 1_500_000_000],
    [1_500_000_000, 1.5],
    [2.25, 1_620_000_000],
    [1_620_000_000, 2.25],
    [1e200, 1e200],
    [1, 1e308],
    [1e308, 1],
  ])('honors the budget after rounding a %s by %s viewport to integer pixels', (width, height) => {
    const ratio = getPdfRenderPixelRatio(width, height, 2);
    // Match the actual backing-store allocation, including its one-pixel floor.
    const pixels = Math.max(1, Math.floor(width * ratio)) * Math.max(1, Math.floor(height * ratio));
    expect(ratio).toBeGreaterThan(0);
    expect(pixels).toBeGreaterThan(0);
    expect(pixels).toBeLessThanOrEqual(PDF_PREVIEW_MAX_CANVAS_PIXELS);
  });
});

describe('PdfPreview lazy page rendering', () => {
  // Issue #8425, unit: mount the production viewer with a scale-aware PDF fake.
  // Existing tests cover raster lifetime, but not fit modes, resize, or file switches.
  // Minimum regression: narrow a 632px pane to 332px with a 600pt-wide page.
  it('fits lazy placeholders on resize while keeping a manually chosen zoom unchanged', async () => {
    let width = 632;
    let height = 848;
    let resize!: () => void;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => width);
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(() => height);
    const page = {
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        scale,
      })),
      render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    };
    const pdf = {
      numPages: 61,
      getPage: vi.fn(async () => page),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument).mockImplementation(
      () => ({ promise: Promise.resolve(pdf), destroy: vi.fn() }) as never,
    );
    const view = render(
      <PdfPreview workdir="C:/zoom" relPath="lecture.pdf" size={100} mtimeMs={1} />,
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-pdf-page]')).toHaveLength(61),
    );
    expect(view.container.querySelector<HTMLElement>('[data-pdf-page="61"]')!.style.width).toBe(
      '600px',
    );
    width = 332;
    act(() => resize());
    await waitFor(() => expect(view.getByText('50%')).toBeTruthy());
    expect(view.container.querySelector<HTMLElement>('[data-pdf-page="61"]')!.style.width).toBe(
      '300px',
    );
    expect(pdf.getPage).toHaveBeenCalledTimes(1);
    const first = view.container.querySelector<HTMLElement>('[data-pdf-page="1"]')!;
    const observer = FakeIntersectionObserver.instances.find((item) => item.targets.has(first))!;
    await act(async () => observer.emit(first, true));
    expect(page.render).toHaveBeenCalledTimes(1);
    height = 748;
    await act(async () => resize());
    expect(page.render).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: 'attachmentPreview.zoomIn' }));
    await waitFor(() => expect(first.dataset.pdfPagePlaceholder).toBeUndefined());
    const renderCount = page.render.mock.calls.length;
    expect(view.getByText('63%')).toBeTruthy();
    width = 632;
    await act(async () => resize());
    expect(view.getByText('63%')).toBeTruthy();
    height = 448;
    await act(async () => resize());
    expect(page.render).toHaveBeenCalledTimes(renderCount);
    fireEvent.click(view.getByRole('button', { name: 'attachmentPreview.fitPage' }));
    expect(view.getByText('50%')).toBeTruthy();
    height = 248;
    act(() => resize());
    expect(view.getByText('25%')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'attachmentPreview.fitWidth' }));
    expect(view.getByText('100%')).toBeTruthy();
    view.rerender(<PdfPreview workdir="C:/zoom" relPath="other.pdf" size={100} mtimeMs={1} />);
    await waitFor(() => expect(view.getByText('100%')).toBeTruthy());
    widthSpy.mockRestore();
    heightSpy.mockRestore();
  });

  // PR #8448, unit: a deferred landscape neighbor above the reading page
  // replaces a portrait placeholder. Its height change must not move the text.
  it('preserves the reading position when a prefetched page reveals a different paper size', async () => {
    const makePage = (width: number) => ({
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: ({ scale }: { scale: number }) => ({
        width: width * scale,
        height: 800 * scale,
        scale,
      }),
      render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    });
    const portrait = makePage(608);
    const landscape = makePage(1216);
    const pending = makeDeferred<typeof landscape>();
    const pdf = {
      numPages: 3,
      getPage: vi.fn((number: number) =>
        number === 2 ? pending.promise : Promise.resolve(portrait),
      ),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(),
    } as never);
    const view = render(
      <PdfPreview workdir="C:/zoom" relPath="mixed.pdf" size={100} mtimeMs={1} />,
    );
    await waitFor(() => expect(view.container.querySelectorAll('[data-pdf-page]')).toHaveLength(3));
    const nodes = [...view.container.querySelectorAll<HTMLElement>('[data-pdf-page]')];
    const root = nodes[0].parentElement!.parentElement!;
    // jsdom lacks layout: use the rendered paper heights to model the vertical stack.
    nodes.forEach((node, index) =>
      Object.defineProperties(node, {
        offsetHeight: { configurable: true, get: () => Number.parseFloat(node.style.height) },
        offsetTop: {
          configurable: true,
          get: () =>
            24 +
            nodes.slice(0, index).reduce((sum, previous) => sum + previous.offsetHeight + 16, 0),
        },
      }),
    );
    root.scrollTop = nodes[2].offsetTop + 120;
    // CI run 41612221680: placeholders can commit before the observer effect runs.
    // Wait for the prefetch target before exercising the reading-position regression.
    let observer: FakeIntersectionObserver | undefined;
    await waitFor(() => {
      observer = FakeIntersectionObserver.instances.find((item) => item.targets.has(nodes[1]));
      expect(observer).toBeDefined();
    });
    await act(async () => observer!.emit(nodes[1], true));
    const before = root.scrollTop;
    await act(async () => pending.resolve(landscape));
    expect(nodes[1].style.height).toBe('400px');
    expect(root.scrollTop).toBe(before - 400);
    expect(root.scrollTop - nodes[2].offsetTop).toBe(120);
    expect(landscape.render).toHaveBeenCalledTimes(1);
  });

  // PR #8448, unit: fit width can start outside the manual 10–800% range.
  // A wheel operation must never zoom in the opposite direction at either edge.
  it.each([15000, 50])('keeps wheel zoom monotonic for a %spt-wide page', async (width) => {
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: width * scale,
        height: 800 * scale,
        scale,
      }),
    };
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: async () => page, destroy: vi.fn() }),
      destroy: vi.fn(),
    } as never);
    const view = render(
      <PdfPreview workdir="C:/zoom" relPath="extreme.pdf" size={100} mtimeMs={1} />,
    );
    await waitFor(() => expect(view.container.querySelector('[data-pdf-page]')).not.toBeNull());
    const node = view.container.querySelector<HTMLElement>('[data-pdf-page]')!;
    const root = node.parentElement!.parentElement!;
    const fittedWidth = Number.parseFloat(node.style.width);
    fireEvent.wheel(root, { ctrlKey: true, deltaY: 100 });
    expect(Number.parseFloat(node.style.width)).toBeLessThanOrEqual(fittedWidth);
    fireEvent.click(view.getByRole('button', { name: 'attachmentPreview.fitWidth' }));
    fireEvent.wheel(root, { metaKey: true, deltaY: -100 });
    expect(Number.parseFloat(node.style.width)).toBeGreaterThanOrEqual(fittedWidth);
  });

  // Issue #8425, unit: the old toolbar had no page input or wheel shortcut.
  // Exercise user events and their visible page/zoom, including native scroll cancellation.
  it('jumps to bounded page numbers and reserves modified wheel events for PDF zoom', async () => {
    const page = {
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 608 * scale,
        height: 800 * scale,
        scale,
      })),
      render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    };
    const pdf = {
      numPages: 3,
      getPage: vi.fn(async () => page),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(),
    } as never);
    const view = render(
      <PdfPreview workdir="C:/zoom" relPath="navigate.pdf" size={100} mtimeMs={1} />,
    );
    const input = await view.findByRole('textbox', { name: 'attachmentPreview.pageNumber' });
    const pages = [...view.container.querySelectorAll<HTMLElement>('[data-pdf-page]')];
    for (const node of pages) node.scrollIntoView = vi.fn();
    for (const [entered, expected] of [
      ['2', '2'],
      ['999', '3'],
      ['-5', '1'],
      ['invalid', '1'],
    ]) {
      fireEvent.change(input, { target: { value: entered } });
      fireEvent.submit(input.closest('form')!);
      if (entered === 'invalid') fireEvent.blur(input);
      expect((input as HTMLInputElement).value).toBe(expected);
    }
    expect(pages[1].scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    const root = pages[0].parentElement!.parentElement!;
    const ordinary = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    fireEvent(root, ordinary);
    expect(ordinary.defaultPrevented).toBe(false);
    expect(view.getByText('100%')).toBeTruthy();
    for (const modifier of ['ctrlKey', 'metaKey']) {
      fireEvent.click(view.getByRole('button', { name: 'attachmentPreview.fitWidth' }));
      const modified = new WheelEvent('wheel', {
        [modifier]: true,
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(root, modified);
      expect(modified.defaultPrevented).toBe(true);
      expect(view.getByText('110%')).toBeTruthy();
    }
    // In a narrow pane the last page is shorter than the viewport, so scrolling
    // to it stops at the document bottom with part of the previous page visible.
    Object.defineProperties(root, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 800 },
    });
    root.scrollTop = 400;
    fireEvent.scroll(root);
    expect((input as HTMLInputElement).value).toBe('3');
  });

  it('keeps mixed-width pages left-aligned while rendering only nearby pages', async () => {
    const widths = [3000, 918, 3000];
    const pages = widths.map((width) => ({
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: width * scale,
        height: 1188 * scale,
        scale,
      })),
      render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    }));
    const pdf = {
      numPages: pages.length,
      getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(async () => undefined),
    } as never);

    const { container } = render(
      <PdfPreview workdir="C:/work" relPath="mixed.pdf" size={100} mtimeMs={1} />,
    );
    await waitFor(() => expect(container.querySelectorAll('[data-pdf-page]')).toHaveLength(3));
    const pageNodes = [...container.querySelectorAll<HTMLElement>('[data-pdf-page]')];
    // Exercise mixed-width overflow at maximum manual zoom; width fit is covered above.
    for (let i = 0; i < 30; i++)
      fireEvent.click(container.querySelector('[aria-label="attachmentPreview.zoomIn"]')!);
    // jsdom has no layout: lock the cross-axis contract as well as the lazy
    // lifecycle. Centering these children moves narrow placeholders outside
    // the horizontal viewport once a wide page establishes the host width.
    expect(pageNodes[0].parentElement!.classList.contains('items-start')).toBe(true);
    let observer: FakeIntersectionObserver | undefined;
    await waitFor(() => {
      observer = FakeIntersectionObserver.instances.find((candidate) =>
        candidate.targets.has(pageNodes[0]),
      );
      expect(observer).toBeDefined();
    });

    for (let index = 0; index < pages.length; index += 1) {
      await act(async () => {
        if (index > 0) observer!.emit(pageNodes[index - 1], false);
        observer!.emit(pageNodes[index], true);
      });
      await waitFor(() => expect(pageNodes[index].dataset.pdfPagePlaceholder).toBeUndefined());
      expect(pageNodes[index].style.width).toBe(`${widths[index] * 8}px`);
      expect(pdf.getPage).toHaveBeenCalledTimes(index + 2);
      expect(pdf.getPage).toHaveBeenLastCalledWith(index + 1);
      expect(container.querySelectorAll('[data-pdf-page] canvas')).toHaveLength(1);
    }
  });

  it('observes any intersection and restores huge pages after leaving the viewport', async () => {
    const page = {
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 15_000 * scale,
        height: 15_000 * scale,
        scale,
      })),
      render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    };
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async () => page),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(async () => undefined),
    } as never);

    const { container } = render(
      <PdfPreview workdir="C:/work" relPath="huge.pdf" size={100} mtimeMs={1} />,
    );
    await waitFor(() => expect(container.querySelector('[data-pdf-page="1"]')).not.toBeNull());
    const pageNode = container.querySelector<HTMLElement>('[data-pdf-page="1"]')!;
    // Keep the huge-page pixel-budget regression at maximum manual zoom.
    for (let i = 0; i < 30; i++)
      fireEvent.click(container.querySelector('[aria-label="attachmentPreview.zoomIn"]')!);
    let observer: FakeIntersectionObserver | undefined;
    await waitFor(() => {
      observer = FakeIntersectionObserver.instances.find((candidate) =>
        candidate.targets.has(pageNode),
      );
      expect(observer).toBeDefined();
    });
    // jsdom does not calculate intersections. Lock the native observer contract:
    // the visible fraction of a huge page can remain below 1% at every position.
    expect(observer!.options?.threshold).toBe(0);
    expect(observer!.options?.root).toBe(pageNode.parentElement?.parentElement);

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await act(async () => {
        observer!.emit(pageNode, true, 0.0028);
      });
      await waitFor(() => expect(pageNode.hasAttribute('data-pdf-page-placeholder')).toBe(false));
      const canvas = pageNode.querySelector('canvas')!;
      expect(pageNode.style.width).toBe('120000px');
      expect(pageNode.style.height).toBe('120000px');
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(PDF_PREVIEW_MAX_CANVAS_PIXELS);
      expect(canvas.width * canvas.height).toBeGreaterThan(0);
      expect(page.render).toHaveBeenCalledTimes(cycle);

      await act(async () => {
        observer!.emit(pageNode, false);
      });
      expect(pageNode.querySelector('canvas')).toBeNull();
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      expect(pageNode.style.height).toBe('120000px');
      expect(pageNode.dataset.pdfPagePlaceholder).toBe('true');
    }
  });

  it('does not rasterize pages until IntersectionObserver marks them visible', async () => {
    const renderDeferred = makeDeferred<void>();
    const renderTask = { cancel: vi.fn(), promise: renderDeferred.promise };
    const page = {
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(() => ({ width: 918, height: 1188 })),
      render: vi.fn(() => renderTask),
    };
    const pdf = {
      numPages: 2,
      getPage: vi.fn(async () => page),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(async () => undefined),
    } as never);

    const { container } = render(
      <PdfPreview workdir="C:/work" relPath="report.pdf" size={100} mtimeMs={1} />,
    );

    await waitFor(() => expect(container.querySelectorAll('[data-pdf-page]')).toHaveLength(2));
    expect(page.render).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLCanvasElement>('[data-pdf-page="1"] canvas')).toBeNull();

    const firstPage = container.querySelector<HTMLElement>('[data-pdf-page="1"]')!;
    let firstObserver: FakeIntersectionObserver | undefined;
    await waitFor(() => {
      firstObserver = FakeIntersectionObserver.instances.find((observer) =>
        observer.targets.has(firstPage),
      );
      expect(firstObserver).toBeDefined();
    });
    await act(async () => {
      firstObserver!.emit(firstPage, true);
    });
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));

    const secondPage = container.querySelector<HTMLElement>('[data-pdf-page="2"]')!;
    expect(
      FakeIntersectionObserver.instances.find((observer) => observer.targets.has(secondPage)),
    ).toBeDefined();
    expect(container.querySelector<HTMLCanvasElement>('[data-pdf-page="2"] canvas')).toBeNull();
  });

  it('cancels an in-flight RenderTask when a page leaves the viewport', async () => {
    const renderDeferred = makeDeferred<void>();
    const renderTask = { cancel: vi.fn(), promise: renderDeferred.promise };
    const page = {
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(() => ({ width: 918, height: 1188 })),
      render: vi.fn(() => renderTask),
    };
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async () => page),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(async () => undefined),
    } as never);

    const { container } = render(
      <PdfPreview workdir="C:/work" relPath="report.pdf" size={100} mtimeMs={1} />,
    );
    await waitFor(() => expect(container.querySelector('[data-pdf-page="1"]')).not.toBeNull());

    const pageNode = container.querySelector<HTMLElement>('[data-pdf-page="1"]')!;
    let observer: FakeIntersectionObserver | undefined;
    await waitFor(() => {
      observer = FakeIntersectionObserver.instances.find((candidate) =>
        candidate.targets.has(pageNode),
      );
      expect(observer).toBeDefined();
    });
    await act(async () => {
      observer!.emit(pageNode, true);
    });
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));

    await act(async () => {
      observer!.emit(pageNode, false);
    });
    expect(renderTask.cancel).toHaveBeenCalled();
    expect(container.querySelector<HTMLCanvasElement>('[data-pdf-page="1"] canvas')).toBeNull();
  });

  it('ignores queued observer callbacks from a replaced document', async () => {
    const oldPage = {
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(() => ({ width: 918, height: 1188 })),
      render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    };
    const nextPage = {
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(() => ({ width: 918, height: 1188 })),
      render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    };
    const oldPdf = {
      numPages: 1,
      getPage: vi.fn(async () => oldPage),
      destroy: vi.fn(async () => undefined),
    };
    const nextPdf = {
      numPages: 1,
      getPage: vi.fn(async () => nextPage),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument)
      .mockReturnValueOnce({
        promise: Promise.resolve(oldPdf),
        destroy: vi.fn(async () => undefined),
      } as never)
      .mockReturnValueOnce({
        promise: Promise.resolve(nextPdf),
        destroy: vi.fn(async () => undefined),
      } as never);

    const { container, rerender } = render(
      <PdfPreview workdir="C:/work" relPath="old.pdf" size={100} mtimeMs={1} />,
    );
    await waitFor(() => expect(container.querySelector('[data-pdf-page="1"]')).not.toBeNull());
    const oldPageNode = container.querySelector<HTMLElement>('[data-pdf-page="1"]')!;
    let oldObserver: FakeIntersectionObserver | undefined;
    await waitFor(() => {
      oldObserver = FakeIntersectionObserver.instances.find((candidate) =>
        candidate.targets.has(oldPageNode),
      );
      expect(oldObserver).toBeDefined();
    });

    rerender(<PdfPreview workdir="C:/work" relPath="next.pdf" size={100} mtimeMs={2} />);
    await waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const nextPageNode = container.querySelector<HTMLElement>('[data-pdf-page="1"]');
      expect(nextPageNode).not.toBeNull();
      expect(nextPageNode).not.toBe(oldPageNode);
    });
    expect(oldObserver!.disconnected).toBe(true);

    await act(async () => {
      oldObserver!.emit(oldPageNode, true);
    });
    expect(nextPage.render).not.toHaveBeenCalled();
  });

  it('disconnects observation and destroys the document after a page render failure', async () => {
    const renderDeferred = makeDeferred<void>();
    const renderTask = {
      cancel: vi.fn(),
      promise: renderDeferred.promise,
    };
    const page = {
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(() => ({ width: 918, height: 1188 })),
      render: vi.fn(() => renderTask),
    };
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async () => page),
      destroy: vi.fn(async () => undefined),
    };
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(async () => undefined),
    } as never);

    const { container, getByTestId } = render(
      <PdfPreview workdir="C:/work" relPath="broken.pdf" size={100} mtimeMs={1} />,
    );
    await waitFor(() => expect(container.querySelector('[data-pdf-page="1"]')).not.toBeNull());
    const pageNode = container.querySelector<HTMLElement>('[data-pdf-page="1"]')!;
    let observer: FakeIntersectionObserver | undefined;
    await waitFor(() => {
      observer = FakeIntersectionObserver.instances.find((candidate) =>
        candidate.targets.has(pageNode),
      );
      expect(observer).toBeDefined();
    });

    await act(async () => {
      observer!.emit(pageNode, true);
    });
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    await act(async () => {
      renderDeferred.reject(new Error('page render failed'));
    });
    await waitFor(() => expect(getByTestId('unrenderable')).toBeTruthy());
    await waitFor(() => expect(pdf.destroy).toHaveBeenCalled());
    expect(observer!.disconnected).toBe(true);
    expect(renderTask.cancel).toHaveBeenCalled();
  });
});
