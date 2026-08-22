/**
 * Host-side runtime wrapper that enforces the localhost preview security policy
 * at the network boundary, complementing `mcp-tool-approval-policy.ts` (which
 * decides when to ask the user).
 *
 * Why this wrapper exists
 * -----------------------
 * The vendored browser runtime's SSRF policy allows the `localhost` hostname so
 * an approved developer preview can load. That allowance is hostname-only:
 *
 *  - It applies to every port, so without a host check the agent (or a page it
 *    opened) could reach databases / control planes on loopback.
 *  - It is evaluated per redirect hop, so a *trusted* navigation to a public URL
 *    that 30x-redirects to `localhost` is accepted on the final hop even though
 *    the user only approved the public URL.
 *  - It has no notion of "this tab started on a public page", so an `act`
 *    (click / press Enter / form submit) can navigate a public page into
 *    localhost without any approval.
 *
 * The approval layer cannot see redirect targets or interaction destinations
 * before dispatch, so those three gaps are closed here, after the call:
 *
 *  1. Every localhost final URL must land on an allowed (non-privileged,
 *     non-sensitive) port — see `isAllowedLocalhostPort`.
 *  2. A navigate/open that started on a non-loopback URL and ends on loopback
 *     is treated as an unapproved redirect to localhost and rejected (the user
 *     approved the public URL, not the localhost target).
 *  3. An `act` whose resulting URL is loopback is rejected unless that tab was
 *     already on an approved loopback page (i.e. the user already approved a
 *     `navigate`/`open` to localhost for it).
 *
 * On rejection the tab is closed so the agent cannot subsequently snapshot /
 * scrape the localhost page. The wrapper is intentionally fail-closed: a
 * detected violation always wins, but it never blocks on URLs it cannot parse.
 */
import type {
  BrowserControlRequest,
  BrowserControlResult,
  BrowserControlRuntime,
} from '@cindy/browser-control-runtime';

import {
  inspectLocalhostUrl,
  isLoopbackHostname,
  LocalhostPortBlockedError,
  normalizeLocalhostHostname,
} from './browser-localhost-guard.js';

interface GuardLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface ResultWithUrl {
  url?: unknown;
  targetId?: unknown;
}

function readFinalUrl(result: BrowserControlResult): string | undefined {
  const data = result.data as ResultWithUrl | undefined;
  return data && typeof data.url === 'string' ? data.url : undefined;
}

function readTargetId(
  result: BrowserControlResult,
  request: BrowserControlRequest,
): string | undefined {
  const data = result.data as ResultWithUrl | undefined;
  if (data && typeof data.targetId === 'string' && data.targetId) return data.targetId;
  if (typeof request.targetId === 'string' && request.targetId) return request.targetId;
  return undefined;
}

function requestedNavigationUrl(request: BrowserControlRequest): string | undefined {
  if (request.action === 'open') {
    return typeof request.url === 'string' ? request.url : request.targetUrl;
  }
  if (request.action === 'navigate') return request.url;
  return undefined;
}

function safeHostname(url: string): string {
  try {
    return normalizeLocalhostHostname(new URL(url).hostname);
  } catch {
    return '';
  }
}

function failedResult(action: string, message: string): BrowserControlResult {
  return {
    ok: false,
    action: action as BrowserControlResult['action'],
    errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
    message,
  };
}

/**
 * Wrap a browser runtime so navigation / open / act results are re-checked
 * against the localhost policy. The wrapper only tracks which tabs are
 * currently on an approved loopback page; it never holds page content.
 */
export function createLocalhostGuardedRuntime(
  inner: BrowserControlRuntime,
  logger: GuardLogger,
): BrowserControlRuntime {
  // Tabs whose current top-level URL is loopback (reached via an approved
  // navigate/open). Acts on these tabs may stay on / move among localhost URLs;
  // acts on public tabs may not.
  const loopbackTabs = new Set<string>();
  // Tabs whose violating tab-close attempt failed (CDP hiccup, browser gone,
  // etc). They may still be on a sensitive localhost page — block all
  // further reads on them until the surface is cleared another way.
  const blockedTargets = new Set<string>();

  const rememberTab = (targetId: string | undefined, url: string | undefined): void => {
    if (!targetId) return;
    if (url && isLoopbackHostname(safeHostname(url))) {
      loopbackTabs.add(targetId);
    } else {
      loopbackTabs.delete(targetId);
    }
  };

  const closeTab = async (targetId: string | undefined): Promise<void> => {
    if (!targetId) return;
    let closedOk = true;
    try {
      const closeResult = await inner.call({ action: 'close', targetId });
      // `close` can fail softly (e.g. CDP hiccup) with { ok: false } — that
      // is NOT an exception and would otherwise leave the violating tab loaded
      // while the guard drops its tracking. Treat any non-ok result as a
      // failed close and park the target id so subsequent snapshot/scrape
      // reads are still blocked (PR #2445 Codex P1).
      if (closeResult && closeResult.ok === false) closedOk = false;
    } catch (err) {
      closedOk = false;
      logger.warn('localhost guard: failed to close violating tab', {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    loopbackTabs.delete(targetId);
    if (!closedOk) {
      // Park the target id: any further read on this tab stays blocked until
      // the user closes the surface another way (restart, manual close).
      blockedTargets.add(targetId);
      logger.warn('localhost guard: close failed — keeping read block on target', {
        targetId,
      });
    }
  };

  const call = async (request: BrowserControlRequest): Promise<BrowserControlResult> => {
    const reqTid =
      typeof request.targetId === 'string' && request.targetId !== ''
        ? request.targetId
        : undefined;
    // A close retry on a parked target must run BEFORE the generic block so a
    // transient CDP failure can be cleared by an immediate retry; otherwise the
    // block below also intercepted close and left the target permanently parked
    // with no way to recover except restart (PR #2445 Codex P2).
    if (request.action === 'close' && reqTid && blockedTargets.has(reqTid)) {
      const retry = await inner.call(request);
      if (retry.ok !== false) blockedTargets.delete(reqTid);
      return retry;
    }
    // A previously parked target (close of a violating tab failed and the tab
    // is still loaded) stays blocked for every other action: the wrapper never
    // observed the page being torn down, so any further snapshot/scrape on it
    // would leak localhost content (PR #2445 Codex P1).
    if (reqTid && blockedTargets.has(reqTid)) {
      logger.warn('localhost guard: blocked read on a target whose close failed', {
        action: request.action,
        targetId: reqTid,
      });
      return failedResult(
        request.action,
        `Blocked: target ${reqTid} could not be closed after a localhost-policy ` +
          'violation; no further reads are permitted on it until the surface is cleared.',
      );
    }

    // Pre-dispatch rejection for direct navigations/opens to a sensitive
    // loopback port. The post-result check below closes the tab after the fact,
    // but by then Chromium has already issued the request and a state-changing
    // or blind request may have produced side effects on a local control plane.
    // When the URL is known up front, block it before inner.call so no request
    // is sent at all (PR #2445 Codex/Greptile P1). Redirects and interaction-
    // triggered navigations still go through the post-result guard below because
    // their final destination is not knowable before dispatch.
    const requested = requestedNavigationUrl(request);
    if (requested) {
      const pre = inspectLocalhostUrl(requested);
      if (pre.isLoopback && !pre.allowed) {
        logger.warn('localhost guard: blocked direct navigation to sensitive loopback port before dispatch', {
          action: request.action,
          url: requested,
          port: pre.port,
        });
        return failedResult(
          request.action,
          new LocalhostPortBlockedError(requested, pre.port).message,
        );
      }
    }

    const result = await inner.call(request);

    if (request.action === 'close') {
      const tid = typeof request.targetId === 'string' ? request.targetId : undefined;
      if (tid) loopbackTabs.delete(tid);
      return result;
    }

    if (request.action !== 'navigate' && request.action !== 'open' && request.action !== 'act') {
      return result;
    }
    if (!result.ok) return result;

    const finalUrl = readFinalUrl(result);
    const targetId = readTargetId(result, request);
    if (!finalUrl) return result;

    const inspection = inspectLocalhostUrl(finalUrl);

    if (inspection.isLoopback) {
      // (1) Port restriction: sensitive / privileged ports are denied outright,
      //     regardless of per-call approval. The user cannot make an informed
      //     decision to reach a database/control plane through the preview
      //     browser, and the hostname-only SSRF allowance would otherwise expose
      //     every local service.
      if (!inspection.allowed) {
        logger.warn('localhost guard: blocked navigation to sensitive loopback port', {
          action: request.action,
          url: finalUrl,
          port: inspection.port,
        });
        await closeTab(targetId);
        return failedResult(
          request.action,
          new LocalhostPortBlockedError(finalUrl, inspection.port).message,
        );
      }

      if (request.action === 'act') {
        // (3) Interaction-triggered navigation into localhost from a public page.
        //     Acts never carry a URL target, so they were not approved as
        //     localhost navigations; reject unless the tab was already on an
        //     approved loopback page.
        if (targetId && loopbackTabs.has(targetId)) {
          rememberTab(targetId, finalUrl);
          return result;
        }
        logger.warn('localhost guard: blocked interaction-triggered navigation to loopback', {
          action: request.action,
          url: finalUrl,
        });
        await closeTab(targetId);
        return failedResult(
          request.action,
          `Blocked: this interaction navigated to ${finalUrl} (localhost) without an explicit ` +
            'navigation approval. Use the browser navigate/open tool with a localhost URL to ' +
            'request access, then interact on that page.',
        );
      }

      // navigate / open to a loopback final URL.
      const requested = requestedNavigationUrl(request);
      const requestedHost = requested ? safeHostname(requested) : '';
      // (2) Public → localhost redirect: the user approved the *public* URL but
      //     the final hop landed on loopback. The hostname-only SSRF allowance
      //     would accept this, so the host must reject it. A genuinely approved
      //     localhost navigation has a loopback requested host.
      if (!isLoopbackHostname(requestedHost)) {
        logger.warn('localhost guard: blocked public-to-loopback redirect', {
          action: request.action,
          requested: requested ?? null,
          finalUrl,
        });
        await closeTab(targetId);
        return failedResult(
          request.action,
          `Blocked: navigation to ${requested ?? 'the requested URL'} redirected to ` +
            `${finalUrl} (localhost). Reaching localhost requires an explicit localhost ` +
            'navigation approval; redirecting from a public URL is not allowed.',
        );
      }

      rememberTab(targetId, finalUrl);
      return result;
    }

    // Final URL is not loopback — update the tab mark and allow.
    rememberTab(targetId, finalUrl);
    return result;
  };

  return { call };
}
