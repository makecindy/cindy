import type { SsrFPolicy } from "../_generated/extension/src/infra/net/ssrf.js";
import type { BrowserNavigationPolicyOptions } from "../_generated/extension/src/browser/navigation-guard.js";
import {
  assertPageNavigationCompletedSafely,
  createObservedDialogAbortSignalForPage,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
} from "../_generated/extension/src/browser/pw-session.js";
import { withPageScopedCdpClient } from "../_generated/extension/src/browser/pw-session.page-cdp.js";
import { normalizeTimeoutMs } from "../_generated/extension/src/browser/pw-tools-core.shared.js";
import { buildDomReadSource } from "../dom-read.js";

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Fixed DOM queries run in an isolated world: page-overridden getters and
 * querySelector cannot turn a read into an interaction. Never accepts JS source
 * or grants cross-origin access. Navigation policy is checked before and after. */
export async function readBrowserDom(opts: {
  cdpUrl: string;
  targetId: string;
  spec: unknown;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<
  | { url: string; value: unknown }
  | { blockedByDialog: true; browserState: unknown }
> {
  const source = buildDomReadSource(opts.spec);
  opts.signal?.throwIfAborted();
  // The time limit covers finding the page too: that lookup talks to every tab
  // and must not leave the read without a deadline.
  const deadline = new AbortController();
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs, 20000);
  const timer = setTimeout(
    () => deadline.abort(new Error("DOM read timed out")),
    timeoutMs,
  );
  let page: Awaited<ReturnType<typeof getPageForTargetId>>;
  try {
    page = await raceAbort(
      getPageForTargetId(opts),
      opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal,
    );
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  const dialog = createObservedDialogAbortSignalForPage({
    page,
    parentSignal: opts.signal,
  });
  const signal = AbortSignal.any([dialog.signal, deadline.signal]);
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Also bound protocol commands that Chrome queues behind a modal or busy page.
  const bounded = <T>(pending: Promise<T>) => Promise.race([pending, aborted]);
  const validatePage = () =>
    assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
    });
  try {
    signal.throwIfAborted();
    await bounded(validatePage());
    // A modal can also delay CDP detach. Return its actionable state promptly;
    // the scoped helper still completes cleanup when Chrome resumes commands.
    const observed = await bounded(
      withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        page,
        fn: async (rawSend) => {
          const send = (method: string, params?: Record<string, unknown>) => {
            signal.throwIfAborted();
            return bounded(rawSend(method, params));
          };
          const tree = (await send("Page.getFrameTree")) as {
            frameTree: { frame: { id: string; loaderId: string } };
          };
          const world = (await send("Page.createIsolatedWorld", {
            frameId: tree.frameTree.frame.id,
            worldName: "cindy-dom-read",
          })) as { executionContextId: number };
          signal.throwIfAborted();
          const result = (await send("Runtime.evaluate", {
            contextId: world.executionContextId,
            expression: `(() => ({ url: location.href, value: (${source})() }))()`,
            returnByValue: true,
            timeout: timeoutMs,
          })) as {
            exceptionDetails?: unknown;
            result: { value?: { url: string; value: unknown } };
          };
          if (result.exceptionDetails || !result.result.value)
            throw new Error("DOM read failed; observe the page again.");
          await bounded(validatePage());
          const current = (await send("Page.getFrameTree")) as typeof tree;
          if (
            current.frameTree.frame.id !== tree.frameTree.frame.id ||
            current.frameTree.frame.loaderId !== tree.frameTree.frame.loaderId
          ) {
            throw new Error(
              "PAGE_CHANGED: the document changed during the DOM read.",
            );
          }
          return result.result.value;
        },
      }),
    );
    signal.throwIfAborted();
    if (page.url() !== observed.url)
      throw new Error("PAGE_CHANGED: the page navigated during the DOM read.");
    return observed;
  } catch (error) {
    if (isBrowserObservedDialogBlockedError(error)) {
      return { blockedByDialog: true, browserState: error.browserState };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort!);
    dialog.cleanup();
  }
}
