import { readFile, writeFile } from "node:fs/promises";
import { recipeOutputPath, stageRecipeUploadFiles } from '@jackwener/opencli/cindy/host';
import {
  CDPBasePage,
  buildEvaluateExpression,
  waitForDomStableJs,
  executeAdapter,
  loadAdapter,
  type BrowserCookie,
  type BrowserEvaluateFunction,
  type ScreenshotOptions,
  type RecipeSecrets,
  type RecipeFiles,
} from "@jackwener/opencli/cindy";
import type {
  BrowserControlRequest,
  BrowserControlResult,
} from "@cindy/browser-control-runtime";
import { isHttpUrl } from "./url-guard.js";

interface PageDeps {
  call(request: BrowserControlRequest): Promise<BrowserControlResult>;
  targetId?: string;
  recipeSecrets?: RecipeSecrets;
  recipeFiles?: () => Promise<RecipeFiles>;
  onExecutionStart?: () => void;
}

/** All browser operations go through the caller's guarded, session-scoped runtime. */
export class OpenCliPage extends CDPBasePage {
  private targetId?: string;
  private readonly sessions = new Map<string, string>();
  constructor(
    private readonly deps: PageDeps,
    private readonly home?: string,
    private readonly windowMode?: 'foreground' | 'background',
  ) {
    super();
    this.targetId = deps.targetId;
  }

  private async request(
    request: BrowserControlRequest,
    adoptTarget = true,
  ): Promise<Record<string, unknown>> {
    const result = await this.deps.call({
      ...request,
      ...(request.action === 'open' && this.windowMode === 'foreground' ? { background: false } : {}),
      ...((request.targetId ?? this.targetId) ? { targetId: request.targetId ?? this.targetId } : {}),
    });
    if (!result.ok)
      throw new Error(result.message ?? `Browser ${request.action} failed`);
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (data.barrier)
      throw new Error(
        `Browser interaction requires attention: ${JSON.stringify(data.barrier)}`,
      );
    const target = data.targetId ?? data.tabId;
    if (adoptTarget && typeof target === "string") this.targetId = target;
    // Embedded opens are always background; focus explicitly on both backends.
    // One navigation boundary covers goto, lazy target creation and newTab.
    if (this.windowMode === 'foreground' && (request.action === 'open' || request.action === 'navigate')) {
      if (!this.targetId) throw new Error('Browser did not return a targetId');
      await this.request({ action: 'focus' }, false);
    }
    return data;
  }

  private async ensureTarget(): Promise<void> {
    if (this.targetId) return;
    if (!this.home || !isHttpUrl(this.home))
      throw new Error("This adapter requires a browser targetId");
    await this.request({ action: "open", url: this.home });
    if (!this.targetId) throw new Error("Browser did not return a targetId");
  }

  async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void> {
    if (!isHttpUrl(url))
      throw new Error("Recipe navigation requires an http(s) URL");
    if (!this.targetId) await this.request({ action: "open", url });
    else await this.request({ action: "navigate", url });
    this._lastUrl = url;
    if (options?.waitUntil !== 'none') {
      const maxMs = options?.settleMs ?? 1000;
      if (maxMs > 0) await this.evaluate(waitForDomStableJs(maxMs, Math.min(500, maxMs)));
    }
  }

  async evaluate<T = unknown>(js: string): Promise<T>;
  async evaluate<Args extends unknown[], T>(
    fn: BrowserEvaluateFunction<Args, T>,
    ...args: Args
  ): Promise<Awaited<T>>;
  async evaluate(
    input: string | BrowserEvaluateFunction<unknown[], unknown>,
    ...args: unknown[]
  ): Promise<unknown> {
    await this.ensureTarget();
    const expression = buildEvaluateExpression(input, args);
    const data = await this.request({
      action: "act",
      request: {
        kind: "evaluate",
        fn: `() => { return (0, eval)(${JSON.stringify(expression)}); }`,
      },
    });
    return data.result;
  }

  async evaluateOnce<T = unknown>(js: string): Promise<T> {
    return this.evaluate<T>(js);
  }

  /** Adapter compatibility name for the existing guarded CDP input path. */
  async insertText(text: string): Promise<void> {
    await this.nativeType(text);
  }

  async cdp(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    await this.ensureTarget();
    let sessionId = this.sessions.get(this.targetId!);
    if (!sessionId) {
      const opened = await this.request({
        action: "recipeCommand",
        recipeCommand: { method: "Cindy.begin" },
      });
      if (typeof opened.sessionId !== "string")
        throw new Error("Browser did not return a recipe session");
      sessionId = opened.sessionId;
      this.sessions.set(this.targetId!, sessionId);
    }
    return this.request({
      action: "recipeCommand",
      recipeCommand: { method, params, sessionId },
    });
  }

  async dispose(): Promise<void> {
    for (const [targetId, sessionId] of this.sessions) {
      await this.deps
        .call({
          action: "recipeCommand",
          targetId,
          recipeCommand: { method: "Cindy.end", sessionId },
        })
        .catch(() => {});
    }
    this.sessions.clear();
  }

  async getCookies(
    options: { domain?: string; url?: string } = {},
  ): Promise<BrowserCookie[]> {
    const response = await this.cdp(
      options.url ? "Network.getCookies" : "Storage.getCookies",
      options.url ? { urls: [options.url] } : {},
    );
    const cookies = (response as { cookies?: BrowserCookie[] }).cookies;
    if (!Array.isArray(cookies))
      throw new Error("Browser returned malformed cookies");
    const domain = options.domain?.replace(/^\./, "");
    return domain
      ? cookies.filter((cookie) => {
          const host = cookie.domain.replace(/^\./, "");
          return (
            host === domain ||
            host.endsWith(`.${domain}`) ||
            domain.endsWith(`.${host}`)
          );
        })
      : cookies;
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
    await this.ensureTarget();
    const data = await this.request({
      action: "screenshot",
      type: options.format,
      fullPage: options.fullPage,
    });
    const file = data.path;
    const encoded =
      typeof data.data === "string"
        ? data.data
        : typeof data.base64 === "string"
          ? data.base64
          : typeof file === "string"
            ? (await readFile(file)).toString("base64")
            : undefined;
    if (!encoded) throw new Error("Browser screenshot did not return an image");
    if (options.path)
      await writeFile(recipeOutputPath(options.path), Buffer.from(encoded, "base64"));
    return encoded;
  }

  async tabs(): Promise<
    Array<{ page: string; url?: string; active: boolean }>
  > {
    const data = await this.request({ action: "tabs" }, false);
    const tabs = [];
    for (const tab of (data.tabs ?? []) as Array<{ targetId: string; url?: string }>) {
      // Binding is not visibility. Probe without adopting another target;
      // a tab that disappeared during enumeration is not known to be visible.
      const visibility = await this.request({
        action: 'act', targetId: tab.targetId,
        request: { kind: 'evaluate', fn: "() => document.visibilityState === 'visible'" },
      }, false).catch(() => ({ result: false }));
      tabs.push({ page: tab.targetId, url: tab.url, active: visibility.result === true });
    }
    return tabs;
  }

  async selectTab(target: number | string): Promise<void> {
    const tabs = await this.tabs();
    const tab =
      typeof target === "number"
        ? tabs[target]
        : tabs.find((item) => item.page === target);
    if (!tab) throw new Error(`Browser tab not found: ${target}`);
    await this.request({ action: 'focus', targetId: tab.page }, false);
    this.targetId = tab.page;
    this._lastUrl = tab.url ?? null;
  }

  getActivePage(): string | undefined {
    return this.targetId;
  }
  setActivePage(target?: string): void {
    this.targetId = target;
    this._lastUrl = null;
  }
  async getCurrentUrl(): Promise<string | null> {
    return this.evaluate<string>("location.href");
  }
  async newTab(url = this.home): Promise<string | undefined> {
    if (!url || !isHttpUrl(url))
      throw new Error("newTab requires an http(s) URL");
    await this.request({ action: "open", url });
    return this.targetId;
  }
  async closeTab(target?: number | string): Promise<void> {
    let closing = this.targetId;
    if (target !== undefined) {
      const tabs = await this.tabs();
      closing = typeof target === 'number' ? tabs[target]?.page : tabs.find(tab => tab.page === target)?.page;
      if (!closing) throw new Error(`Browser tab not found: ${target}`);
    }
    if (closing) {
      const sessionId = this.sessions.get(closing);
      if (sessionId) {
        await this.request({
          action: "recipeCommand",
          targetId: closing,
          recipeCommand: { method: "Cindy.end", sessionId },
        }, false);
        this.sessions.delete(closing);
      }
      await this.request({ action: "close", targetId: closing }, false);
    }
    if (closing === this.targetId) {
      this.targetId = undefined;
      this._lastUrl = null;
    }
  }
  // Window reset is optional. Omit it so adapters use their existing cleanup
  // fallback rather than treating a no-op as a successful browser reset.

  async setFileInput(
    files: string[],
    selector = "input[type=file]",
  ): Promise<void> {
    const paths = stageRecipeUploadFiles(files);
    await this.ensureTarget();
    await this.request({ action: "upload", paths, element: selector });
  }

  async startNetworkCapture(pattern = ""): Promise<boolean> {
    await this.cdp("Cindy.captureStart", { pattern });
    return true;
  }
  async readNetworkCapture(
    options: { retainIncomplete?: boolean } = {},
  ): Promise<unknown[]> {
    const result = (await this.cdp("Cindy.captureRead", options)) as {
      entries: unknown[];
    };
    return result.entries;
  }
  async consoleMessages(level = "info"): Promise<unknown[]> {
    await this.ensureTarget();
    const data = await this.request({ action: "console", level });
    return (data.messages ?? []) as unknown[];
  }
}

export async function runOpenCliAdapter(
  id: string,
  inputs: Record<string, unknown>,
  deps: PageDeps,
): Promise<unknown> {
  const command = await loadAdapter(id);
  const page = new OpenCliPage(
    deps,
    command.domain ? `https://${command.domain}` : undefined,
    command.defaultWindowMode,
  );
  try {
    const files = await deps.recipeFiles?.();
    return await executeAdapter(id, inputs, page, deps.recipeSecrets, deps.onExecutionStart, files);
  } finally {
    await page.dispose();
  }
}
