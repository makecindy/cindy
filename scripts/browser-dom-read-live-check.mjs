/** Integration tier: real Chrome verifies the read optimization against page
 * prototype overrides, same-origin/cross-origin login frames and the unchanged
 * evaluate guard. Uses only synthetic pages in a disposable browser profile.
 * Run: node --import tsx scripts/browser-dom-read-live-check.mjs */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tempRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "cindy-dom-read-check-"),
);
const evaluateDisabled = process.argv.includes("--evaluate-disabled");
process.env.XDT_BROWSER_RUNTIME_DIR = tempRoot;
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
const close = (server) => new Promise((resolve) => server.close(resolve));
const reserve = net.createServer();
const cdpPort = await listen(reserve);
await close(reserve);
const cross = http.createServer((_req, res) =>
  res.end('<input type="password">'),
);
const crossPort = await listen(cross);
let releaseData;
let dataArrived;
const dataRequested = new Promise((resolve) => {
  dataArrived = resolve;
});
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/data") {
    releaseData = () => res.end("ready");
    dataArrived();
    return;
  }
  if (req.url === "/dynamic")
    return res.end(`<main id="status">loading</main><script>
    fetch('/data').then(r => r.text()).then(text => document.getElementById('status').textContent = text);
  </script>`);
  if (req.url === "/code")
    return res.end('<input autocomplete="one-time-code">');
  res.end(`<main><article><b title="read-title">Read result</b><a href="/next">Link</a></article></main>
    ${req.url === "/password" ? '<input type="password">' : ""}
    ${req.url === "/frames" ? '<iframe src="/code"></iframe>' : ""}
    <iframe src="http://127.0.0.1:${crossPort}/"></iframe>
    <script>
      window.pageHookCalls = 0;
      Document.prototype.querySelector = Document.prototype.querySelectorAll = function () {
        window.pageHookCalls++; throw new Error('page hook must not run during a fixed read');
      };
      Object.defineProperty(Node.prototype, 'textContent', { get() {
        window.pageHookCalls++; return 'page-controlled getter';
      } });
    </script>`);
});
const port = await listen(server);
const base = `http://127.0.0.1:${port}`;
const { createBrowserControlRuntime } =
  await import("../packages/browser-control-runtime/src/runtime.ts");
const { BrowserToolRegistry } =
  await import("../packages/lizi-mcps/src/browser/tool-registry.ts");
const { registerBrowserTools } =
  await import("../packages/lizi-mcps/src/browser/tools.ts");
const { runRecipe } =
  await import("../packages/lizi-mcps/src/browser/recipe-runner.ts");
const { LOGIN_WALL_FN } =
  await import("../packages/browser-control-runtime/src/dom-read.ts");
const { getPageForTargetId, respondToObservedDialogOnPage } =
  await import("../packages/browser-control-runtime/src/_generated/extension/src/browser/pw-session.ts");
const config = {
  browser: {
    enabled: true,
    headless: true,
    evaluateEnabled: !evaluateDisabled,
    defaultProfile: "dom-read-check",
    profiles: { "dom-read-check": { cdpPort, color: "#00D9C5" } },
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  },
};
const runtime = createBrowserControlRuntime({ config, logSink: () => {} });
const registry = new BrowserToolRegistry();
registerBrowserTools(registry, {
  getRuntime: () => runtime,
  supportsSemanticQueries: () => false,
});
let targetId;
const call = async (args) => {
  const response = await registry.call("browser", { targetId, ...args });
  const result = JSON.parse(
    response.content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join(""),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const timeout = globalThis.setTimeout;
let navigationGraceTimers = 0;
globalThis.setTimeout = function (fn, ms, ...args) {
  if (
    ms === 250 &&
    new Error().stack.includes("scheduleDelayedInteractionNavigationGuard")
  )
    navigationGraceTimers++;
  return timeout(fn, ms, ...args);
};
try {
  assert.equal((await runtime.call({ action: "start" })).ok, true);
  const opened = await runtime.call({ action: "open", url: base + "/frames" });
  assert.equal(opened.ok, true);
  targetId = opened.data.targetId;
  if (!evaluateDisabled) {
    await call({ action: "act", request: { kind: "wait", loadState: "load" } });
    const priorTimers = navigationGraceTimers;
    const extracted = await call({
      action: "extract",
      extract: {
        from: "article",
        multiple: true,
        fields: {
          text: "b",
          title: { selector: "b", attr: "title" },
          html: { selector: "b", type: "html" },
          href: { selector: "a", type: "href" },
        },
      },
    });
    assert.deepEqual(extracted.data.result.records, [
      {
        text: "Read result",
        title: "read-title",
        html: "Read result",
        href: base + "/next",
      },
    ]);
    const snapshot = await call({
      action: "snapshot",
      refs: "role",
      selector: "main",
    });
    assert.deepEqual(snapshot.loginWall.fields, ["one-time-code"]);
    assert.equal(
      navigationGraceTimers,
      priorTimers,
      "fixed reads entered the interaction grace window",
    );
    const tampered = await runtime.call({
      action: "act",
      targetId,
      request: {
        kind: "evaluate",
        fn: '() => { window.pageHookCalls++; return "unexpected code"; }',
        domRead: { kind: "login-wall" },
      },
    });
    assert.deepEqual(tampered.data.result, { password: false, code: true });
    const inspected = await call({
      action: "act",
      request: { kind: "evaluate", fn: "() => window.pageHookCalls" },
    });
    assert.equal(inspected.data.result, 0);
    assert.ok(
      navigationGraceTimers > priorTimers,
      "general evaluate lost its navigation guard",
    );
    for (const [page, fields] of [
      ["/password", ["password"]],
      ["/cross-only", undefined],
    ]) {
      await call({ action: "navigate", url: base + page });
      const observed = await call({
        action: "snapshot",
        refs: "role",
        selector: "main",
      });
      assert.deepEqual(observed.loginWall?.fields, fields);
    }
    // Integration regression: a modal appearing during the read must return
    // blockedByDialog, rather than leave a protocol command pending behind it.
    const page = await getPageForTargetId({
      cdpUrl: `http://127.0.0.1:${cdpPort}`,
      targetId,
    });
    const modalContext = page.context();
    const beforeModalSession = modalContext.newCDPSession.bind(modalContext);
    const modalDetaches = [];
    let dialog, alertDone;
    modalContext.newCDPSession = async (...args) => {
      const session = await beforeModalSession(...args),
        send = session.send.bind(session);
      const detach = session.detach.bind(session);
      session.detach = () => {
        const pending = detach();
        modalDetaches.push(pending);
        return pending;
      };
      session.send = async (method, params) => {
        const result = await send(method, params);
        if (method === "Page.getFrameTree" && !dialog) {
          const shown = page.waitForEvent("dialog");
          alertDone = page
            .evaluate(() => alert("read regression"))
            .catch(() => {});
          dialog = await shown;
        }
        return result;
      };
      return session;
    };
    let deadline;
    try {
      const reading = runtime.call({
        action: "act",
        targetId,
        request: {
          kind: "evaluate",
          fn: LOGIN_WALL_FN,
          domRead: { kind: "login-wall" },
          timeoutMs: 500,
        },
      });
      const response = await Promise.race([
        reading,
        new Promise((_, reject) => {
          deadline = timeout(
            () => reject(new Error("DOM read hung behind modal")),
            3000,
          );
        }),
      ]);
      assert.equal(
        response.data?.blockedByDialog,
        true,
        JSON.stringify(response),
      );
    } finally {
      clearTimeout(deadline);
      modalContext.newCDPSession = beforeModalSession;
      if (dialog) await respondToObservedDialogOnPage({ page, accept: false });
      await alertDone;
      await Promise.all(modalDetaches);
    }
    // Same-URL SPA content still requires its business readiness condition.
    await call({ action: "navigate", url: base + "/dynamic" });
    await dataRequested;
    const statusSpec = { fields: { status: "#status" } };
    assert.equal(
      (await call({ action: "extract", extract: statusSpec })).data.result
        .records[0].status,
      "loading",
    );
    releaseData();
    await call({
      action: "act",
      request: {
        kind: "wait",
        fn: "() => document.getElementById('status').textContent === 'ready'",
        timeoutMs: 3000,
      },
    });
    assert.equal(
      (await call({ action: "extract", extract: statusSpec })).data.result
        .records[0].status,
      "ready",
    );
    // PR #7432: use the production recipe runner, checking the unguarded fast
    // path and that adding a guard still enforces identity before reading.
    const recipeRead = (guard) =>
      runRecipe(
        {
          id: "dom-read-check",
          steps: [
            {
              action: "extract",
              extract: statusSpec,
              ...(guard ? { guard } : {}),
              as: "value",
            },
          ],
          output: "{{value}}",
        },
        {},
        { call: (request) => runtime.call({ ...request, targetId }) },
      );
    const beforeRecipeTimers = navigationGraceTimers;
    assert.equal((await recipeRead()).output.records[0].status, "ready");
    assert.equal(navigationGraceTimers, beforeRecipeTimers);
    assert.equal(
      (await recipeRead({ url: base + "/wrong" })).failureKind,
      "guard",
    );
    assert.equal(
      (
        await recipeRead({
          url: base + "/dynamic",
          selector: "#status",
          text: "ready",
        })
      ).output.records[0].status,
      "ready",
    );
    assert.ok(navigationGraceTimers > beforeRecipeTimers);
    await call({ action: "navigate", url: base + "/cross-only" });

    // Count actual sessions and execution contexts on this disposable page.
    const context = page.context();
    const originalSession = context.newCDPSession.bind(context);
    const observer = await originalSession(page);
    const worlds = new Set();
    observer.on("Runtime.executionContextCreated", ({ context }) => {
      if (context.name === "cindy-dom-read") worlds.add(context.id);
    });
    observer.on("Runtime.executionContextDestroyed", ({ executionContextId }) =>
      worlds.delete(executionContextId),
    );
    observer.on("Runtime.executionContextsCleared", () => worlds.clear());
    await observer.send("Runtime.enable");
    let active = 0,
      peak = 0,
      openedSessions = 0,
      replaceAfterRead = false;
    context.newCDPSession = async (...args) => {
      const session = await originalSession(...args);
      active++;
      openedSessions++;
      peak = Math.max(peak, active);
      const detach = session.detach.bind(session),
        send = session.send.bind(session);
      session.detach = async () => {
        try {
          await detach();
        } finally {
          active--;
        }
      };
      session.send = async (method, params) => {
        const result = await send(method, params);
        if (replaceAfterRead && method === "Runtime.evaluate") {
          replaceAfterRead = false;
          await page.reload({ waitUntil: "load" });
        }
        return result;
      };
      return session;
    };
    const resourceSamples = [];
    try {
      // Force a real reload after evaluation but before result validation.
      replaceAfterRead = true;
      const stale = await registry.call("browser", {
        targetId,
        action: "extract",
        extract: { fields: { text: "b" } },
      });
      assert.equal(stale.isError, true);
      assert.match(JSON.stringify(stale), /PAGE_CHANGED/);
      assert.equal(active, 0);
      const sample = async (reads) => {
        await observer.send("HeapProfiler.collectGarbage");
        const heap = await observer.send("Runtime.getHeapUsage");
        resourceSamples.push({
          reads,
          active,
          worlds: worlds.size,
          heapUsed: heap.usedSize,
        });
      };
      for (let i = 0; i < 510; i++) {
        const read = await call({
          action: "extract",
          extract: { fields: { text: "b" } },
        });
        assert.equal(read.data.result.records[0].text, "Read result");
        assert.equal(active, 0, "read left an attached CDP session");
        if (i === 9 || ((i + 1 - 10) % 100 === 0 && i >= 10))
          await sample(i + 1 - 10);
      }
      assert.ok(
        resourceSamples.every(
          (row) => row.worlds === resourceSamples[0].worlds,
        ),
        "isolated contexts accumulated",
      );
      assert.ok(
        resourceSamples.at(-1).heapUsed <
          resourceSamples[0].heapUsed + 2_000_000,
        "retained page heap grew by over 2 MB",
      );
      console.log(
        JSON.stringify({ resourceSamples, openedSessions, peak, active }),
      );
    } finally {
      context.newCDPSession = originalSession;
      await observer.detach();
    }
    console.log(
      JSON.stringify({
        ok: true,
        checks: [
          "text/attribute/html/href extraction",
          "page prototype isolation",
          "same-origin code detection",
          "cross-origin frame exclusion",
          "password detection",
          "no arbitrary fn on read path",
          "general evaluate retains grace",
          "unguarded recipe uses fixed read and guarded recipe preserves identity check",
          "modal read returns blockedByDialog",
          "same-URL delayed content requires business wait",
          "same-URL reload rejects stale result",
          "500 repeated reads release sessions and reuse isolated world",
        ],
        navigationGraceTimers,
      }),
    );
  } else {
    const denied = await runtime.call({
      action: "act",
      targetId,
      request: {
        kind: "evaluate",
        fn: LOGIN_WALL_FN,
        domRead: { kind: "login-wall" },
      },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    console.log(
      JSON.stringify({ ok: true, checks: ["evaluate-disabled gate retained"] }),
    );
  }
} finally {
  globalThis.setTimeout = timeout;
  await runtime.call({ action: "stop" });
  await Promise.all([close(server), close(cross)]);
  await fs.rm(tempRoot, { recursive: true, force: true });
}
