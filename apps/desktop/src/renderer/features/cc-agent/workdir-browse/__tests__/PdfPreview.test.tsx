// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
      [{ target, isIntersecting, intersectionRatio } as FakeObserverEntry as IntersectionObserverEntry],
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
  it('keeps mixed-width pages left-aligned while rendering only nearby pages', async () => {
    const widths = [3000, 918, 3000];
    const pages = widths.map((width) => ({
      getViewport: vi.fn(() => ({ width, height: 1188 })),
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
      expect(pageNodes[index].style.width).toBe(`${widths[index]}px`);
      expect(pdf.getPage).toHaveBeenCalledTimes(index + 1);
      expect(pdf.getPage).toHaveBeenLastCalledWith(index + 1);
      expect(container.querySelectorAll('[data-pdf-page] canvas')).toHaveLength(1);
    }
  });

  it('observes any intersection and restores huge pages after leaving the viewport', async () => {
    const page = {
      getViewport: vi.fn(() => ({ width: 15_000, height: 15_000 })),
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
      expect(pageNode.style.width).toBe('15000px');
      expect(pageNode.style.height).toBe('15000px');
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(PDF_PREVIEW_MAX_CANVAS_PIXELS);
      expect(canvas.width * canvas.height).toBeGreaterThan(0);
      expect(page.render).toHaveBeenCalledTimes(cycle);

      await act(async () => {
        observer!.emit(pageNode, false);
      });
      expect(pageNode.querySelector('canvas')).toBeNull();
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      expect(pageNode.style.height).toBe('15000px');
      expect(pageNode.dataset.pdfPagePlaceholder).toBe('true');
    }
  });

  it('does not rasterize pages until IntersectionObserver marks them visible', async () => {
    const renderDeferred = makeDeferred<void>();
    const renderTask = { cancel: vi.fn(), promise: renderDeferred.promise };
    const page = {
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
      getViewport: vi.fn(() => ({ width: 918, height: 1188 })),
      render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() })),
    };
    const nextPage = {
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
