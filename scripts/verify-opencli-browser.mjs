// Real Chromium, isolated temporary profile, local fixture only. No real-site writes.
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, openSync } from 'node:fs';
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as httpServer } from "node:http";
import { spawn } from "node:child_process";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "cindy-recipe-verify-"));
process.env.XDT_BROWSER_RUNTIME_DIR = path.join(scratch, "runtime");
const http = httpServer((req, res) => {
  if (req.url === "/api/example") {
    res.setHeader("Content-Type", "application/json");
    res.end('{"items":["captured"]}');
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Recipe fixture</title><input id="name"><input id="file" type="file"><button id="save" onclick="window.clicks=(window.clicks||0)+1">Save</button><article><h1>Recipe article</h1><p>This local article verifies the bundled recipe extraction code without using any real account or publishing content.</p></article>',
    );
  }
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${http.address().port}`;
const chrome = spawn(
  process.env.RECIPE_TEST_CHROME ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${path.join(scratch, "chrome")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  ssr: { noExternal: ["@cindy/browser-control-runtime", "@jackwener/opencli"] },
  logLevel: "error",
});
let page;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = Number(
        (
          await readFile(
            path.join(scratch, "chrome/DevToolsActivePort"),
            "utf8",
          )
        ).split("\n")[0],
      );
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(port, "Isolated Chromium did not start");
  const { createBrowserControlRuntime } = await vite.ssrLoadModule(
    "/packages/browser-control-runtime/src/runtime.ts",
  );
  const { OpenCliPage } = await vite.ssrLoadModule(
    "/packages/lizi-mcps/src/browser/opencli-page.ts",
  );
  const runtime = createBrowserControlRuntime({
    config: {
      browser: {
        enabled: true,
        defaultProfile: "recipe-test",
        attachOnly: true,
        profiles: {
          "recipe-test": {
            cdpUrl: `http://127.0.0.1:${port}`,
            color: "#888888",
            attachOnly: true,
          },
        },
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  });
  page = new OpenCliPage(
    { call: (request) => runtime.call({ ...request, profile: "recipe-test" }) },
    url,
  );
  await page.goto(url);
  // #6822 accepts labels/prefixes; adapter CDP must select the same canonical
  // target before its first command, then keep that scope through disposal.
  const labelled = await runtime.call({ action: 'open', profile: 'recipe-test', url, label: 'recipe-fixture-alias' });
  assert.equal(labelled.ok, true);
  for (const targetId of ['recipe-fixture-alias', labelled.data.targetId.slice(0, 8)]) {
    const aliasPage = new OpenCliPage({ targetId, call: (request) => runtime.call({ ...request, profile: 'recipe-test' }) });
    try {
      await aliasPage.getCookies();
      const document = await aliasPage.cdp('DOM.getDocument');
      assert.ok(document.root.nodeId);
    } finally { await aliasPage.dispose(); }
  }
  console.log(JSON.stringify({ ok: true, checks: ['CDP-label', 'CDP-target-prefix'] }));
  assert.equal(await page.evaluate("document.title"), "Recipe fixture");
  assert.equal(await page.evaluate((a, b) => a + b, 2, 3), 5);
  await page.fillText("#name", "Cindy fixture");
  assert.equal(
    await page.evaluate('document.querySelector("#name").value'),
    "Cindy fixture",
  );
  await page.click("#save");
  assert.equal(await page.evaluate("window.clicks"), 1);
  const { DEFAULT_UPLOAD_DIR } = await vite.ssrLoadModule('/packages/browser-control-runtime/src/_generated/extension/src/browser/paths.ts');
  const { withRecipeHost } = await vite.ssrLoadModule('/packages/opencli-vendor/cindy/host.ts');
  await mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
  const uploadRoot = await mkdtemp(path.join(DEFAULT_UPLOAD_DIR, 'cindy-recipe-verify-'));
  const uploadSource = path.join(scratch, 'fixture.txt');
  await writeFile(uploadSource, 'local upload fixture');
  try {
    await withRecipeHost(undefined, () => page.setFileInput([uploadSource], '#file'), {
      directory: scratch, temporaryRoot: uploadRoot,
      read: readFileSync, open: file => openSync(file, 'r'),
    });
    assert.equal(await page.evaluate('document.querySelector("#file").files[0].name'), 'fixture.txt');
    assert.equal(await page.evaluate('document.querySelector("#file").files[0].text()'), 'local upload fixture');
    assert.equal(await readFile(uploadSource, 'utf8'), 'local upload fixture');
  } finally { await rm(uploadRoot, { recursive: true, force: true }); }
  const document = await page.cdp("DOM.getDocument");
  const element = await page.cdp("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: "#save",
  });
  assert.ok(element.nodeId > 0, "CDP node IDs must survive between commands");
  await page.startNetworkCapture("/api/");
  await page.goto(`${url}/again`);
  await page.evaluate('fetch("/api/example").then(r=>r.json())');
  const captured = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    captured.push(
      ...(await page.readNetworkCapture({ retainIncomplete: true })),
    );
    if (
      captured.some(
        (entry) =>
          entry.captureComplete && entry.responsePreview?.includes("captured"),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    captured.some(
      (entry) =>
        entry.captureComplete && entry.responsePreview?.includes("captured"),
    ),
    "Response capture must survive navigation",
  );
  assert.ok(
    (await page.screenshot()).length > 100,
    "Screenshot must return bytes",
  );
  const { extractArticle } = await vite.ssrLoadModule(
    "/packages/opencli-vendor/src/browser/article-extract.ts",
  );
  const article = await extractArticle(page, { force: true });
  assert.ok(
    article.html.includes("local article"),
    "Readability sources must be bundled",
  );
  const { executeAdapter } = await vite.ssrLoadModule('/packages/opencli-vendor/cindy/index.ts');
  const read = await executeAdapter('web/read', { url, stdout: true, wait: 0, 'download-images': false }, page);
  assert.ok(read[0].markdown.includes('local article'), 'stdout mode must return markdown to the MCP caller');
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "evaluate",
        "typed-arguments",
        "fill",
        "click",
        "staged-file-upload",
        "CDP-session",
        "network-after-navigation",
        "screenshot",
        "article-extraction",
        "web-read-command",
      ],
    }),
  );
  // Opt-in integration tier: read-only requests against public services. This
  // exercises the shipped JSON through runRecipe and the real browser runtime.
  if (process.argv.includes('--public-recipes')) {
    const { loadRecipes } = await vite.ssrLoadModule('/packages/lizi-mcps/src/browser/recipe-loader.ts');
    const { runRecipe } = await vite.ssrLoadModule('/packages/lizi-mcps/src/browser/recipe-runner.ts');
    const recipes = loadRecipes();
    const cases = [
      ['app-store-search', { query: 'notion', country: 'us' }, out => out.results.some(app => /notion/i.test(app.name))],
      ['google-play-search', { query: 'notion', country: 'US' }, out => out.some(app => /notion/i.test(app.name))],
      ['steam-reviews', { appId: '620', language: 'english' }, out => out.reviews.some(review => review.text)],
      ['open-library-search', { query: 'title:the hobbit' }, out => out.books.some(book => /hobbit/i.test(book.title))],
      ['crossref-search', { query: '10.1038/nphys1170' }, out => out.works.some(work => work.doi === '10.1038/nphys1170')],
      ['crossref-search', { query: 'Deep residual learning for image recognition' }, out => out.works.some(work => /deep residual learning/i.test(work.title))],
      ['taptap-game', { appId: '82835' }, out => out.id === '82835' && /星露谷/.test(out.name)],
    ];
    const failures = [];
    for (const [id, inputs, verify] of cases) {
      if (process.env.RECIPE_CHECK_IDS && !process.env.RECIPE_CHECK_IDS.split(',').includes(id)) continue;
      const result = await runRecipe(recipes.get(id), inputs, { call: request => runtime.call({ ...request, profile: 'recipe-test' }) });
      const ok = result.ok && verify(result.output);
      console.log(JSON.stringify({ publicRecipe: id, ok, ...(ok ? {} : { result }) }));
      if (!ok) failures.push(id);
    }
    assert.deepEqual(failures, [], 'Public recipe integration failures');
  }
} finally {
  await page?.dispose();
  chrome.kill();
  await new Promise((resolve) =>
    chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve),
  );
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  await vite.close();
  await rm(scratch, { recursive: true, force: true });
}
