/** Full Electron client acceptance. Uses only this checkout's protected launcher,
 * a private HOME/profile and its own CDP port. Never connects to a user's app. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const require = createRequire(
  new URL("../../../desktop/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
export const desktopProfile = () =>
  path.join(
    process.env.HOME,
    "Library",
    "Application Support",
    "CindyGlobal-dev2-host-handoff",
  );
const packagedInput = process.env.CINDY_TEST_DESKTOP_APP;
let packagedBinary, packagedChild;
let port;
let attachmentNumber = 0;
const env = (config) => {
  const result = {
    ...process.env,
    CINDY_HOST_API: config.baseUrl,
    CINDY_HOST_INSTANCE: config.instanceId,
    XDT_CDP_PORT: String(port),
    CINDY_PERSONAL_MONITOR_DIR: undefined,
    CINDY_PERSONAL_GENERATION: undefined,
  };
  for (const key of [
    "XDT_USER_DATA_DIR",
    "XDT_USER_DATA_DIR_EPOCH",
    "XDT_ISOLATED",
    "XDT_ISOLATED_NAME",
    "XDT_OFFICIAL_SHARED_PROFILE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
  ])
    delete result[key];
  return result;
};
async function run(config, extra) {
  if (packagedInput) {
    if (extra.includes('--kill-only')) {
      if (packagedChild && packagedChild.exitCode === null && packagedChild.signalCode === null) {
        const exited = new Promise(resolve => packagedChild.once('exit', resolve));
        packagedChild.kill('SIGTERM'); await exited;
      }
      return;
    }
    if (!packagedBinary) {
      assert.ok(path.isAbsolute(packagedInput));
      const target = path.join(process.env.HOME, 'Applications', 'Cindy Handoff Test.app');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(packagedInput, target, { recursive: true, verbatimSymlinks: true });
      execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier app.cindy.handoff.acceptance', path.join(target, 'Contents/Info.plist')]);
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'pipe' });
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { stdio: 'pipe' });
      packagedBinary = path.join(target, 'Contents/MacOS/Cindy');
    }
    packagedChild = spawn(packagedBinary, [
      `--user-data-dir=${desktopProfile()}`, '--no-protocol-registration',
      // Fresh synthetic profile only. Never prompt for or read the user's login keychain.
      '--use-mock-keychain',
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    ], { env: env(config), stdio: ['ignore', 'pipe', 'pipe'] });
    packagedChild.stdout.on('data', b => process.stdout.write(b));
    packagedChild.stderr.on('data', b => process.stdout.write(b));
    for (let i = 0; i < 600; i++) {
      assert.equal(packagedChild.exitCode, null, 'Packaged client exited before CDP readiness');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) return;
      } catch { /* wait for this private app */ }
      await delay(100);
    }
    throw Error('Packaged client did not expose its private inspection endpoint');
  }
  const child = spawn(
    process.execPath,
    [
      "scripts/restart-desktop-remote.mjs",
      "--region=global",
      "--isolated=host-handoff",
      ...extra,
    ],
    { cwd: repo, env: env(config), stdio: ["inherit", "pipe", "pipe"] },
  );
  let output = "";
  // --reuse-terminal deliberately keeps the runner alive after the verdict.
  // Wait for readiness, not runner exit; its lifetime belongs to the test UI.
  const code = await new Promise((resolve, reject) => {
    const read = (b) => {
      output += b;
      process.stdout.write(b);
      if (
        extra.includes("--wait-ready") &&
        /DESKTOP_DEV_VERDICT=ready\n/.test(output)
      )
        resolve(0);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(code, 0, output.slice(-3000));
  if (extra.includes("--wait-ready"))
    assert.match(output, /DESKTOP_DEV_VERDICT=ready/);
}
export async function stopDesktop(config) {
  await run(config, ["--kill-only"]);
}
export async function attachDesktop(config) {
  assert.equal(
    process.platform,
    "darwin",
    "This acceptance driver currently targets macOS",
  );
  if (!port) {
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
    await new Promise((r) => server.close(r));
  }
  await fs.mkdir(desktopProfile(), { recursive: true });
  await fs.writeFile(
    path.join(desktopProfile(), "host-api-token"),
    config.token,
    { mode: 0o600 },
  );
  try {
    await run(config, ["--wait-ready", "--reuse-terminal", "--isolated-auth"]);
  } catch (error) {
    // Synthetic profile only. Keep the actual failed surface, without changing
    // the launcher's verdict or reloading it into a falsely passing state.
    let diagnostic;
    try {
      diagnostic = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      for (const page of diagnostic.contexts().flatMap(context => context.pages())) {
        if (!/^http:\/\/localhost:\d+\//.test(page.url()) || new URL(page.url()).search) continue;
        console.error('FAILED_DESKTOP_SURFACE', page.url(), (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 4000));
        if (process.env.CINDY_TEST_ARTIFACT_DIR) {
          await fs.mkdir(process.env.CINDY_TEST_ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.CINDY_TEST_ARTIFACT_DIR, 'desktop-failed.png'), timeout: 5000 });
        }
      }
    } catch { /* Keep the original startup failure. */ }
    finally { await diagnostic?.close(); }
    throw error;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let i = 0; i < 600 && !page; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find(
        (p) =>
          (packagedInput ? p.url().startsWith('file:') && p.url().includes('main_window/index.html')
            : /^http:\/\/localhost:\d+\//.test(p.url())) && new URL(p.url()).search === "",
      );
    if (!page) await delay(100);
  }
  assert.ok(page, `Real main window must exist; observed targets: ${browser.contexts().flatMap(c => c.pages()).map(p => p.url()).join(', ')}`);
  await page.waitForFunction(
    () => !!window.electronAPI?.maker?.onEvent,
    {},
    { timeout: 30000 },
  );
  // Startup's main-process receipt precedes the renderer's minimum splash
  // duration/fade. Text behind that cover is still Playwright-visible.
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-splash-active'), {}, { timeout: 30_000 });
  await page.getByTestId('splash-root').waitFor({ state: 'hidden', timeout: 30_000 });
  await page
    .getByText("Handoff acceptance", { exact: true })
    .first()
    .click({ timeout: 30_000 });
  await page
    .getByText("History before replacement", { exact: true })
    .last()
    .waitFor({ state: "visible" });
  await page.getByText('Handoff acceptance', { exact: true }).first().click({ trial: true, timeout: 30_000 });
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /登录已过期|Your session has expired/i,
  );
  if (process.env.CINDY_TEST_ARTIFACT_DIR) {
    await fs.mkdir(process.env.CINDY_TEST_ARTIFACT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(
        process.env.CINDY_TEST_ARTIFACT_DIR,
        `desktop-${++attachmentNumber}.png`,
      ),
    });
  }
  await page.evaluate(() => {
    window.__handoffEvents = [];
    window.electronAPI.maker.onEvent((payload) =>
      window.__handoffEvents.push({ type: "event", payload }),
    );
  });
  const cdp = await browser.newBrowserCDPSession();
  const info = await cdp.send("SystemInfo.getProcessInfo");
  const pid = info.processInfo.find((p) => p.type === "browser")?.id;
  assert.ok(Number.isSafeInteger(pid));
  const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  assert.ok(
    packagedInput ? command.includes(packagedBinary) && pid === packagedChild.pid : command.includes(path.join(repo, "node_modules/electron/")),
    "Never stop an unverified desktop",
  );
  console.log(`FULL_DESKTOP_ATTACHED pid=${pid}`);
  let exited;
  return {
    page,
    async captureCompleted() {
      await page.getByText('synthetic complete', { exact: false }).last().waitFor({ state: 'visible', timeout: 30_000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (process.env.CINDY_TEST_ARTIFACT_DIR) await page.screenshot({
        path: path.join(process.env.CINDY_TEST_ARTIFACT_DIR, 'completed.png'), animations: 'disabled',
      });
    },
    child: {
      pid,
      kill() {
        exited = (async () => {
          await browser.close();
          process.kill(pid, "SIGTERM");
          for (let i = 0; i < 200; i++) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              if (e.code === "ESRCH") return;
              throw e;
            }
            await delay(100);
          }
          throw Error("Test desktop did not exit");
        })();
      },
    },
    get exited() {
      return exited;
    },
    async snapshot() {
      return page.evaluate(async () => ({
        history: await window.electronAPI.localDb.messages.list("native-xd-0", {
          limit: 20,
        }),
        queue:
          await window.electronAPI.maker.input.getProjection("queued-task"),
      }));
    },
    async wait(predicate) {
      for (let i = 0; i < 300; i++) {
        const found = (await page.evaluate(() => window.__handoffEvents)).find(
          predicate,
        );
        if (found) return found;
        await delay(100);
      }
      throw Error("Desktop did not receive task completion");
    },
    async request(route, body) {
      return page.evaluate(
        async ({ route, body }) => {
          try {
            let result;
            if (route === "/api/interactions/pending")
              result = await window.electronAPI.maker.getPendingInteractions(
                body.sessionId,
              );
            else if (route === "/api/interactions/respond")
              result = await window.electronAPI.maker.resolveInteraction(
                body.requestId,
                body.decision,
              );
            else if (route === "/api/input/enqueue")
              result = await window.electronAPI.maker.input.enqueue(
                body.sessionId,
                body.item,
              );
            else throw Error("Unknown test request");
            return { result };
          } catch (error) {
            return { error: error.message };
          }
        },
        { route, body },
      );
    },
  };
}
