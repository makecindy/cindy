#!/usr/bin/env node
/**
 * Deterministic multi-source vendoring sync for the neutral browser-control runtime.
 *
 * Sources (all version-pinned in browser-runtime.lock.json):
 *   1. extensions/browser/src/**          (GitHub tarball @ commit)  -> _generated/extension/
 *   2. packages/net-policy/src/**         (GitHub tarball, unpublished pkg) -> _generated/packages/net-policy/
 *   3. packages/normalization-core/src/** (GitHub tarball, unpublished pkg) -> _generated/packages/normalization-core/
 *   4. SSRF/security leaf closure under src/infra/** + src/security/** + src/config/zod-schema.* (tarball)
 *                                          -> _generated/leaf/
 *   5. @openclaw/fs-safe@<ver> npm dist    (NOT in repo; published) -> _generated/vendor/fs-safe/
 *
 * Import rewriting (mechanical, deterministic):
 *   - `openclaw/plugin-sdk/<x>`         -> ../shim/<x>.js              (hand-written shim)
 *   - `@openclaw/net-policy[/x]`        -> _generated/packages/net-policy/...
 *   - `@openclaw/normalization-core/x`  -> _generated/packages/normalization-core/x.js
 *   - `@openclaw/fs-safe[/x]`           -> _generated/vendor/fs-safe/dist/...
 *   - bare `from "../../config/zod-schema.proxy.js"` etc inside leaf closure stay relative
 *     because the leaf closure preserves the upstream src/ subtree shape under _generated/leaf/src/.
 *
 * _generated/ is GENERATED — do not edit. Edit src/shim/* or this script.
 *
 * Neutrality: upstream project name appears only here + in upstream/ metadata.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePosixShell } from '../lib/posix-shell.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const pkgRoot = path.join(repoRoot, 'packages/browser-control-runtime');
const lockPath = path.join(pkgRoot, 'upstream/browser-runtime.lock.json');
const manifestPath = path.join(pkgRoot, 'upstream/vendor-manifest.txt');
const genRoot = path.join(pkgRoot, 'src/_generated');
const shimDir = path.join(pkgRoot, 'src/shim');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => {
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(v, null, 2)}\n`);
  fs.renameSync(`${f}.tmp`, f);
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function parseGithubRepo(url) {
  const m = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Unsupported repo URL: ${url}`);
  return `${m[1]}/${m[2]}`;
}
function resolveRef(repoSlug, ref) {
  return execFileSync('gh', ['api', `repos/${repoSlug}/commits/${ref}`, '--jq', '.sha'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}
/** Whether the `tar` on PATH is GNU tar (msys/GNU accept `--wildcards`;
 * bsdtar/libarchive — the Windows/macOS system default — rejects it). */
let gnuTarChecked = false;
let gnuTar = false;
function isGnuTar() {
  if (!gnuTarChecked) {
    gnuTarChecked = true;
    try {
      // Probe tar in the SAME environment that will execute it: on win32 the
      // Node process PATH may resolve `tar` to System32\bsdtar while the Git
      // sh resolves GNU tar — probing through the resolved sh keeps
      // detection and execution consistent (Greptile P1 + codex-connector
      // P1, round 4).
      const sh = resolvePosixShell('sh');
      if (!sh) throw new Error('no sh resolved');
      gnuTar = /GNU tar/i.test(
        execFileSync(sh, ['-c', 'tar --version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
    } catch {
      gnuTar = false;
    }
  }
  return gnuTar;
}
function shHide(cmd) {
  // Windows (msys) compatibility ONLY. On win32, msys GNU tar treats `C:\`
  // drive letters as remote hosts and does not glob by default, so quoted
  // Windows paths are converted to /c/... and tar gets --wildcards. On POSIX
  // (incl. macOS BSD/libarchive tar) the command runs UNCHANGED — no
  // GNU-only flags are injected, so other platforms keep upstream behavior.
  // Locate a real sh up front: on win32 the PATH may only contain Git\cmd
  // (without Git\bin), so a bare `sh` would ENOENT — the repo resolver finds
  // the Git-bundled sh.exe in standard install locations (codex-connector
  // P1, round 3). Non-win32 callers keep using their normal PATH ('sh').
  const sh = resolvePosixShell('sh');
  if (!sh) {
    throw new Error(
      'sync: could not locate a usable sh (Git for Windows not detected). ' +
        'Install Git for Windows and retry.',
    );
  }
  if (process.platform !== 'win32') {
    execFileSync(sh, ['-c', cmd], { stdio: ['ignore', 'ignore', 'inherit'] });
    return;
  }
  // Inject --wildcards ONLY when the resolved tar is actually GNU tar: on
  // win32 the PATH may resolve to the system bsdtar, which treats unsupported
  // options as fatal errors (Greptile P1 round 1). bsdtar matches extraction
  // paths as shell-style patterns natively, so no flag is needed there.
  const wildcards = isGnuTar() ? ' --wildcards' : '';
  const toMsys = (p) =>
    p
      // Collapse JSON-escaped double backslashes FIRST: converting each `\\`
      // separately would emit doubled separators like /c//Users//foo
      // (Copilot P1, round 2).
      .replace(/\\\\/g, '\\')
      .replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`)
      .replace(/\\/g, '/');
  const posix = cmd
    .replace(/"((?:[A-Za-z]:)?[^"]*)"/g, (m, p) => JSON.stringify(toMsys(p)))
    .replace(/(^|\s)tar(\s)/g, `$1tar${wildcards}$2`);
  execFileSync(sh, ['-c', posix], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/**
 * Preflight: the sync pulls upstream via `gh api` (tarball + commit resolve), so
 * a missing / unauthenticated gh CLI must fail loudly up front rather than mid-run.
 */
function ghPreflight() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    throw new Error(
      'gh CLI is required and must be authenticated (this script uses `gh api`). ' +
        'Install it from https://cli.github.com/ and run `gh auth login`, then retry.',
    );
  }
}

/** Resolve a relative import inside a temp src tree to a .ts file path. */
function tryTs(p) {
  if (/\.js$/.test(p)) p = p.replace(/\.js$/, '.ts');
  if (!/\.ts$/.test(p) && fs.existsSync(`${p}.ts`)) return `${p}.ts`;
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  const idx = `${p.replace(/\.ts$/, '')}/index.ts`;
  if (fs.existsSync(idx)) return idx;
  return null;
}

/**
 * Compute the transitive closure of SSRF/security leaf files, seeded from the
 * files the browser core imports out of src/infra/** + src/security/**.
 * Maps @openclaw/net-policy + normalization-core onto their tarball src.
 * Returns repo-relative paths under src/ (the leaf subtree we vendor verbatim).
 */
function computeLeafClosure(repoTmp) {
  const SEEDS = [
    'src/infra/net/ssrf.ts',
    'src/infra/net/hostname.ts',
    'src/infra/net/proxy-env.ts',
    'src/security/external-content.ts',
    'src/security/secret-equal.ts',
  ];
  const PKG_SRC = {
    '@openclaw/net-policy': path.join(repoTmp, 'packages/net-policy/src'),
    '@openclaw/normalization-core': path.join(repoTmp, 'packages/normalization-core/src'),
  };
  const visited = new Set();
  const reFrom = /(?:import|export)\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g;
  const reDyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  function resolve(file, spec) {
    for (const [name, dir] of Object.entries(PKG_SRC)) {
      if (spec === name) return tryTs(path.join(dir, 'index'));
      if (spec.startsWith(`${name}/`)) return tryTs(path.join(dir, spec.slice(name.length + 1)));
    }
    if (spec.startsWith('.')) return tryTs(path.resolve(path.dirname(file), spec));
    return null; // node:, undici, ipaddr.js, zod, openclaw/plugin-sdk -> external/shim, not vendored as leaf
  }
  function walk(file) {
    if (!file || visited.has(file) || /\.test\.ts$/.test(file)) return;
    visited.add(file);
    const src = fs.readFileSync(file, 'utf8');
    let m;
    for (const re of [reFrom, reDyn]) {
      re.lastIndex = 0;
      while ((m = re.exec(src))) {
        const r = resolve(file, m[1]);
        if (r) walk(r);
      }
    }
  }
  for (const s of SEEDS) walk(path.join(repoTmp, s));
  // Normalize separators: on win32 path.relative emits '\', and the 'src/'
  // prefix filter below is POSIX-separator based.
  return [...visited].map((f) => path.relative(repoTmp, f).split(path.sep).join('/')).sort();
}

/** Rewrite all bare/aliased imports for a generated file at `genRelFromGenRoot`. */
function rewriteImports(source, genAbsFile) {
  const fileDir = path.dirname(genAbsFile);
  const rel = (toAbs) => {
    let r = path.relative(fileDir, toAbs);
    if (!r.startsWith('.')) r = `./${r}`;
    return r.split(path.sep).join('/');
  };
  return source.replace(
    /(['"])(openclaw\/plugin-sdk\/[^'"]+|@openclaw\/(?:net-policy|normalization-core|fs-safe)(?:\/[^'"]+)?)\1/g,
    (_full, q, spec) => {
      if (spec.startsWith('openclaw/plugin-sdk/')) {
        const sub = spec.slice('openclaw/plugin-sdk/'.length);
        return `${q}${rel(path.join(shimDir, `${sub}.js`))}${q}`;
      }
      if (spec === '@openclaw/net-policy' || spec.startsWith('@openclaw/net-policy/')) {
        const sub = spec === '@openclaw/net-policy' ? 'index' : spec.slice('@openclaw/net-policy/'.length);
        return `${q}${rel(path.join(genRoot, 'packages/net-policy', `${sub}.js`))}${q}`;
      }
      if (spec.startsWith('@openclaw/normalization-core/')) {
        const sub = spec.slice('@openclaw/normalization-core/'.length);
        return `${q}${rel(path.join(genRoot, 'packages/normalization-core', `${sub}.js`))}${q}`;
      }
      if (spec === '@openclaw/normalization-core') {
        return `${q}${rel(path.join(genRoot, 'packages/normalization-core/index.js'))}${q}`;
      }
      if (spec === '@openclaw/fs-safe' || spec.startsWith('@openclaw/fs-safe/')) {
        const sub = spec === '@openclaw/fs-safe' ? 'index' : spec.slice('@openclaw/fs-safe/'.length);
        return `${q}${rel(path.join(genRoot, 'vendor/fs-safe/dist', `${sub}.js`))}${q}`;
      }
      return _full;
    },
  );
}

function header(srcLabel) {
  return (
    '/* eslint-disable */\n' +
    '// @generated by scripts/browser-runtime/sync.mjs — DO NOT EDIT.\n' +
    `// upstream: ${srcLabel}\n`
  );
}

/**
 * LOCAL PATCHES — durable edits to vendored upstream sources, re-applied on every
 * sync so they survive the wipe-and-replace pipeline (editing _generated/ by hand
 * does NOT survive). Keyed by the _generated-relative path. Patches use literal
 * replacements or a bounded transform made only from exact-count replacements;
 * missing/duplicate anchors throw so upstream refactors surface loudly instead of
 * silently dropping a patch. Keep these minimal and prefer src/shim/* for anything
 * that can live at the adapter boundary.
 */
const LOCAL_PATCHES = {
  'extension/src/browser/navigation-guard.ts': [
    {
      desc: 'allow explicit browser proxies only for public hostnames named in the strict hostname allowlist',
      find: `  // Browser proxy routing hides the final connect target from this process.
  // Only block when the browser profile is known to be proxy-routed; Gateway
  // provider proxy env alone is not proof of browser page proxy behavior.
  if (
    opts.browserProxyMode === "explicit-browser-proxy" &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed",
    );
  }`,
      replace: `  // An explicit browser proxy resolves and connects outside this process, so
  // local DNS pinning alone cannot prove the final connect target. Keep proxy
  // navigation fail-closed unless the caller supplied a narrow public-hostname
  // allowlist for this launch. The normal policy resolver below still rejects
  // blocked names and private/special-use DNS answers for every permitted host.
  if (
    opts.browserProxyMode === "explicit-browser-proxy" &&
    parsed.protocol !== "https:"
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: proxied browser navigation requires HTTPS",
    );
  }
  const proxyHostnameAllowlist = (opts.ssrfPolicy?.hostnameAllowlist ?? [])
    .map((pattern) => normalizeHostname(pattern))
    .filter(Boolean);
  if (
    opts.browserProxyMode === "explicit-browser-proxy" &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) &&
    (proxyHostnameAllowlist.length === 0 ||
      !matchesHostnameAllowlist(normalizeHostname(parsed.hostname), proxyHostnameAllowlist))
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: proxied browser navigation requires an explicit public-hostname allowlist",
    );
  }`,
    },
  ],
  'extension/src/browser/routes/agent.act.ts': [
    {
      desc: 'carry the effective browser proxy mode through interaction navigation guards',
      transform: (source) => applyExactReplacements(source, [
        [
          `  readBody,
  requirePwAi,
  resolveTargetIdFromBody,`,
          `  browserNavigationPolicyForProfile,
  readBody,
  requirePwAi,
  resolveTargetIdFromBody,`,
        ],
        [
          `  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  listTabs: () => Promise<Array<{ targetId: string; url: string }>>;`,
          `  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  listTabs: () => Promise<Array<{ targetId: string; url: string }>>;`,
        ],
        [
          `  const ssrfPolicyOpts = withBrowserNavigationPolicy(params.ssrfPolicy);`,
          `  const ssrfPolicyOpts = withBrowserNavigationPolicy(params.ssrfPolicy, {
    browserProxyMode: params.browserProxyMode,
  });`,
        ],
        [
          `  if (!ssrfPolicyOpts.ssrfPolicy) {
    return;
  }`,
          `  if (!ssrfPolicyOpts.ssrfPolicy && !ssrfPolicyOpts.browserProxyMode) {
    return;
  }`,
        ],
        [
          `          const evaluateEnabled = ctx.state().resolved.evaluateEnabled;
          const ssrfPolicy = ctx.state().resolved.ssrfPolicy;
          const isExistingSession = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
          const hasNavigationResultPolicy = Boolean(
            withBrowserNavigationPolicy(ssrfPolicy).ssrfPolicy,
          );`,
          `          const evaluateEnabled = ctx.state().resolved.evaluateEnabled;
          const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
          const ssrfPolicy = navigationPolicy.ssrfPolicy;
          const isExistingSession = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
          const hasNavigationResultPolicy = Boolean(
            navigationPolicy.ssrfPolicy || navigationPolicy.browserProxyMode,
          );`,
        ],
        [
          `              targetId: tab.targetId,
              ssrfPolicy,
              listTabs: () => profileCtx.listTabs(),`,
          `              targetId: tab.targetId,
              ssrfPolicy,
              browserProxyMode: navigationPolicy.browserProxyMode,
              listTabs: () => profileCtx.listTabs(),`,
        ],
        [
          `            evaluateEnabled,
            ssrfPolicy,
            signal: req.signal,`,
          `            evaluateEnabled,
            ssrfPolicy,
            browserProxyMode: navigationPolicy.browserProxyMode,
            signal: req.signal,`,
        ],
      ]),
    },
  ],
  'extension/src/browser/routes/agent.act.hooks.ts': [
    {
      desc: 'apply the effective browser proxy mode to file-chooser click navigation',
      transform: (source) => applyExactReplacements(source, [
        [
          `  readBody,
  requirePwAi,
  resolveTargetIdFromBody,`,
          `  browserNavigationPolicyForProfile,
  readBody,
  requirePwAi,
  resolveTargetIdFromBody,`,
        ],
        [
          `                cdpUrl,
                targetId: tab.targetId,
                ssrfPolicy: ctx.state().resolved.ssrfPolicy,
                ref,`,
          `                cdpUrl,
                targetId: tab.targetId,
                ...browserNavigationPolicyForProfile(ctx, profileCtx),
                ref,`,
        ],
      ]),
    },
    {
      desc: 'apply the effective browser proxy mode to direct input file uploads',
      transform: (source) => applyExactReplacements(source, [
        [
          `            await pw.setInputFilesViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              inputRef,
              element,
              paths: resolvedPaths,
            });`,
          `            await pw.setInputFilesViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ...browserNavigationPolicyForProfile(ctx, profileCtx),
              inputRef,
              element,
              paths: resolvedPaths,
            });`,
        ],
      ]),
    },
  ],
  'extension/src/browser/pw-tools-core.interactions.ts': [
    {
      desc: 'propagate proxy mode through Playwright interaction navigation checks',
      transform: (source) => applyExactReplacements(source, [
        [
          `  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,`,
          `  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,`,
        ],
        [
          `  frameUrl: string,
  ssrfPolicy?: SsrFPolicy,
): Promise<void> {`,
          `  frameUrl: string,
  ssrfPolicy?: SsrFPolicy,
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"],
): Promise<void> {`,
        ],
        [
          `  if (!ssrfPolicy || (!frameUrl.startsWith("http://") && !frameUrl.startsWith("https://"))) {`,
          `  if (
    (!ssrfPolicy && !browserProxyMode) ||
    (!frameUrl.startsWith("http://") && !frameUrl.startsWith("https://"))
  ) {`,
        ],
        [
          `    ...withBrowserNavigationPolicy(ssrfPolicy),`,
          `    ...withBrowserNavigationPolicy(ssrfPolicy, { browserProxyMode }),`,
        ],
        [
          `  ssrfPolicy?: SsrFPolicy;
  targetId?: string;`,
          `  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  targetId?: string;`,
          3,
        ],
        [
          `  if (!opts.ssrfPolicy) {`,
          `  if (!opts.ssrfPolicy && !opts.browserProxyMode) {`,
          2,
        ],
        [
          `await assertSubframeNavigationAllowed(frameUrl, opts.ssrfPolicy);`,
          `await assertSubframeNavigationAllowed(
        frameUrl,
        opts.ssrfPolicy,
        opts.browserProxyMode,
      );`,
          2,
        ],
        [
          `
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,`,
          `
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,`,
          8,
        ],
        [
          `
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,`,
          `
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: opts.targetId,`,
          7,
        ],
        [
          `
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,`,
          `
    ssrfPolicy: opts.ssrfPolicy,
    browserProxyMode: opts.browserProxyMode,
    targetId: opts.targetId,`,
        ],
        [
          `
            ssrfPolicy: opts.ssrfPolicy,
            targetId: opts.targetId,`,
          `
            ssrfPolicy: opts.ssrfPolicy,
            browserProxyMode: opts.browserProxyMode,
            targetId: opts.targetId,`,
        ],
        [
          `
          ssrfPolicy: opts.ssrfPolicy,
          targetId: opts.targetId,`,
          `
          ssrfPolicy: opts.ssrfPolicy,
          browserProxyMode: opts.browserProxyMode,
          targetId: opts.targetId,`,
        ],
        [
          `  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;`,
          `  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;`,
          7,
        ],
        [
          `  ssrfPolicy?: SsrFPolicy;
  fn: string;`,
          `  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  fn: string;`,
        ],
        [
          `  ssrfPolicy?: SsrFPolicy;
  depth?: number;`,
          `  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  depth?: number;`,
        ],
        [
          `    if (opts.ssrfPolicy) {
      await assertPageNavigationCompletedSafely({`,
          `    if (opts.ssrfPolicy || opts.browserProxyMode) {
      await assertPageNavigationCompletedSafely({`,
        ],
        [
          `  evaluateEnabled?: boolean,
  ssrfPolicy?: SsrFPolicy,
  depth = 0,`,
          `  evaluateEnabled?: boolean,
  ssrfPolicy?: SsrFPolicy,
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"],
  depth = 0,`,
        ],
        [
          `
        ssrfPolicy,
        signal,`,
          `
        ssrfPolicy,
        browserProxyMode,
        signal,`,
          6,
        ],
        [
          `        ssrfPolicy,
        fn: action.fn,`,
          `        ssrfPolicy,
        browserProxyMode,
        fn: action.fn,`,
        ],
        [
          `        ssrfPolicy,
        actions: action.actions,`,
          `        ssrfPolicy,
        browserProxyMode,
        actions: action.actions,`,
        ],
        [
          `        ssrfPolicy: opts.ssrfPolicy,
        actions: opts.action.actions,`,
          `        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        actions: opts.action.actions,`,
        ],
        [
          `      opts.evaluateEnabled,
      opts.ssrfPolicy,
      0,`,
          `      opts.evaluateEnabled,
      opts.ssrfPolicy,
      opts.browserProxyMode,
      0,`,
        ],
        [
          `        opts.evaluateEnabled,
        opts.ssrfPolicy,
        depth,`,
          `        opts.evaluateEnabled,
        opts.ssrfPolicy,
        opts.browserProxyMode,
        depth,`,
        ],
      ]),
    },
    {
      desc: 'guard direct input file uploads with the proxy navigation policy',
      transform: (source) => applyExactReplacements(source, [
        [
          `  inputRef?: string;
  element?: string;
  paths: string[];
}): Promise<void> {`,
          `  inputRef?: string;
  element?: string;
  paths: string[];
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
}): Promise<void> {`,
        ],
        // input/change handlers can assign location after files are set; run
        // both the file assignment and the event dispatch inside the guard.
        [
          `  try {
    await locator.setInputFiles(resolvedPaths);
  } catch (err) {
    throw toFriendlyInteractionError(err, inputRef || element);
  }
  try {
    const handle = await locator.elementHandle();
    if (handle) {
      await handle.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  } catch {
    // Best-effort for sites that don't react to setInputFiles alone.
  }
}`,
          `  const previousUrl = page.url();
  await assertInteractionNavigationCompletedSafely({
    action: async () => {
      try {
        await locator.setInputFiles(resolvedPaths);
      } catch (err) {
        throw toFriendlyInteractionError(err, inputRef || element);
      }
      try {
        const handle = await locator.elementHandle();
        if (handle) {
          await handle.evaluate((el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
        }
      } catch {
        // Best-effort for sites that don't react to setInputFiles alone.
      }
    },
    cdpUrl: opts.cdpUrl,
    page,
    previousUrl,
    ssrfPolicy: opts.ssrfPolicy,
    browserProxyMode: opts.browserProxyMode,
    targetId: opts.targetId,
  });
}`,
        ],
      ]),
    },
    {
      desc: 'guard hover/drag/scrollIntoView/wait interactions with the same proxy navigation policy',
      transform: (source) => applyExactReplacements(source, [
        // hover + scrollIntoView share this options signature.
        [
          `  ref?: string;
  selector?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {`,
          `  ref?: string;
  selector?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {`,
          2,
        ],
        [
          `  endRef?: string;
  endSelector?: string;
  timeoutMs?: number;
  signal?: AbortSignal;`,
          `  endRef?: string;
  endSelector?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;`,
        ],
        [
          `  fn?: string;
  timeoutMs?: number;
  signal?: AbortSignal;`,
          `  fn?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;`,
        ],
        // hover: mouseover handlers can assign location; run the interaction
        // navigation guard like click/press instead of skipping it.
        [
          `  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitActionWithAbort(
      locator.hover({
        timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
      }),
      abortPromise,
      reconcileRemoteDialog,
    );
  } catch (err) {`,
          `  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await awaitActionWithAbort(
          locator.hover({
            timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          }),
          abortPromise,
          reconcileRemoteDialog,
        );
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {`,
        ],
        // drag: dragstart/drop handlers can assign location.
        [
          `  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitActionWithAbort(
      startLocator.dragTo(endLocator, {
        timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
      }),
      abortPromise,
      reconcileRemoteDialog,
    );
  } catch (err) {`,
          `  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await awaitActionWithAbort(
          startLocator.dragTo(endLocator, {
            timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          }),
          abortPromise,
          reconcileRemoteDialog,
        );
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {`,
        ],
        // scrollIntoView: scroll handlers can assign location.
        [
          `  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitActionWithAbort(
      locator.scrollIntoViewIfNeeded({ timeout }),
      abortPromise,
      reconcileRemoteDialog,
    );
  } catch (err) {`,
          `  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await awaitActionWithAbort(
          locator.scrollIntoViewIfNeeded({ timeout }),
          abortPromise,
          reconcileRemoteDialog,
        );
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {`,
        ],
        // wait: wait.fn and observed load states can land on a new location.
        [
          `  try {
    if (typeof opts.timeMs === "number" && Number.isFinite(opts.timeMs)) {`,
          `  const previousUrl = page.url();
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
    if (typeof opts.timeMs === "number" && Number.isFinite(opts.timeMs)) {`,
        ],
        [
          `        await waitForStep(page.waitForFunction(fn, { timeout }));
      }
    }
  } finally {
    cleanup();
  }
}`,
          `        await waitForStep(page.waitForFunction(fn, { timeout }));
      }
    }
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } finally {
    cleanup();
  }
}`,
        ],
        // Popups: window.open / target=_blank tabs opened by a guarded
        // interaction bypass the per-page framenavigated listener; collect
        // them from the context and validate/quarantine before returning.
        [
          `  const navPage = opts.page as unknown as NavigationObservablePage;
  let navigatedDuringAction = false;
  const subframeNavigationsDuringAction: string[] = [];`,
          `  const navPage = opts.page as unknown as NavigationObservablePage;
  const pageContext = (
    opts.page as unknown as {
      context?: () => { on?: (event: string, listener: (page: Page) => void) => void; off?: (event: string, listener: (page: Page) => void) => void; close?: () => Promise<void>; browser?: () => { close?: () => Promise<void> } | undefined };
    }
  ).context?.();
  const popupsDuringAction: Page[] = [];
  const onContextPage = (newPage: Page) => {
    popupsDuringAction.push(newPage);
  };
  if (pageContext && typeof pageContext.on === "function") {
    pageContext.on("page", onContextPage);
  }
  let navigatedDuringAction = false;
  const subframeNavigationsDuringAction: string[] = [];`,
        ],
        [
          `  markObservedDialogsHandledRemotelyForPage,
  refLocator,`,
          `  markObservedDialogsHandledRemotelyForPage,
  quarantineTargetWithoutClosing,
  refLocator,`,
        ],
        [
          `  assertPageNavigationCompletedSafely,
  createObservedDialogAbortSignalForPage,`,
          `  assertPageNavigationCompletedSafely,
  closeBlockedNavigationTarget,
  createObservedDialogAbortSignalForPage,`,
        ],
        [
          `const INTERACTION_NAVIGATION_GRACE_MS = 250;`,
          `const INTERACTION_NAVIGATION_GRACE_MS = 250;

// Bounds for draining the popup chain after an interaction. The queue is
// adversarial — validating a popup can append another — so it needs a ceiling
// on both count and wall-clock, or a page that opens one popup per grace
// window keeps the action (and every serialized call behind it) alive forever.
const POPUP_CHAIN_MAX_VALIDATIONS = 32;
const POPUP_CHAIN_DRAIN_BUDGET_MS = 5_000;
// Quarantining the overflow needs its own bounds: an unresponsive close() must
// not keep the action pending any more than an endless popup chain may.
const POPUP_CHAIN_MAX_CLOSES = 256;
const POPUP_CHAIN_CLOSE_BUDGET_MS = 2_000;

// The one message the host matches on to distrust the whole route
// (\`mentionsUntornDownBrowser\` in external-chrome-backend.ts). Every path that
// fails to contain a page must report exactly this, or the host keeps serving
// a route whose pages are still live.
const UNTORN_DOWN_BROWSER_MESSAGE =
  "Navigation blocked: popup chain exceeded the validation budget and the browser could not be torn down; unvalidated pages may still be live";`,
        ],
        // Capture (do not propagate) a main-navigation policy deny so the
        // popup pass below still runs: an interaction can both navigate the
        // main frame somewhere denied AND open a tab, and the popup must be
        // validated/quarantined rather than left live. Precedence is resolved
        // at the end. This also guarantees the context listener is detached on
        // every path.
        [
          `  if (navigationObserved) {
    await assertPageNavigationCompletedSafely({`,
          `  let navigationError: unknown;
  try {
  if (navigationObserved) {
    await assertPageNavigationCompletedSafely({`,
        ],
        [
          `  if (subframeError) {
    throw toLintErrorObject(subframeError, "Non-Error thrown");
  }

  if (actionError) {
    throw toLintErrorObject(actionError, "Non-Error thrown");
  }
  return result as T;
}`,
          `  } catch (err) {
    navigationError = err;
  }
  // NOTE: the context listener stays attached across popup validation below —
  // a popup can open a further popup inside its own grace window, and
  // detaching here would leave that second-generation tab uncollected and
  // unvalidated (in direct mode nothing else would catch it).
  let popupError: unknown;
  // Shared last-resort teardown for pages we could not contain individually.
  // Returns true only when something verifiably shut them down. Both the
  // per-popup close failure and the overflow path escalate through this, so a
  // stuck page has exactly one ladder: context close, then browser close.
  const tearDownUncontainedPages = async (deadline?: Promise<void>): Promise<boolean> => {
    const closeContext = (
      pageContext as unknown as { close?: () => Promise<void> } | undefined
    )?.close;
    if (typeof closeContext === "function") {
      const contextClosed = await Promise.race([
        Promise.resolve()
          .then(() => closeContext.call(pageContext))
          .then(
            () => true,
            () => false,
          ),
        // A caller that already burned its budget passes no deadline: racing a
        // fired one would resolve instantly and prove nothing.
        deadline
          ? deadline.then(() => false)
          : new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => resolve(false), POPUP_CHAIN_CLOSE_BUDGET_MS);
              (timer as unknown as { unref?: () => void }).unref?.();
            }),
      ]);
      if (contextClosed) return true;
    }
    // The context would not close (rejected, or still not settled at the
    // deadline), so live pages that were never validated survive and the
    // listener is about to detach. Every per-page and per-context remedy has
    // now failed, so try the browser. Give this its own budget.
    const browserOf = (
      pageContext as unknown as { browser?: () => { close?: () => Promise<void> } | undefined }
        | undefined
    )?.browser;
    const browser = typeof browserOf === "function" ? browserOf.call(pageContext) : undefined;
    if (!browser || typeof browser.close !== "function") return false;
    return await Promise.race([
      Promise.resolve()
        .then(() => browser.close?.())
        .then(
          () => true,
          () => false,
        ),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), POPUP_CHAIN_CLOSE_BUDGET_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  };
  try {
    // Drain the chain rather than a snapshot: validating a popup can append
    // more entries to popupsDuringAction, so index forward as it grows.
    //
    // BOUNDED, because the queue is adversarial: each iteration awaits a
    // ~250ms grace window, so a page that opens one popup per window appends
    // at least as fast as this drains and the loop never empties. That would
    // hang the action forever — and the backend serializes every browser call,
    // so a later stop (and dispose at quit) would queue behind it indefinitely.
    // On overrun, stop validating and CLOSE the remainder: leaving them live
    // would be the unvalidated-tab bug this drain exists to prevent.
    const drainDeadline = Date.now() + POPUP_CHAIN_DRAIN_BUDGET_MS;
    let popupIndex = 0;
    for (
      ;
      popupIndex < popupsDuringAction.length
      && popupIndex < POPUP_CHAIN_MAX_VALIDATIONS
      && Date.now() < drainDeadline;
      popupIndex += 1
    ) {
      const popupPage = popupsDuringAction[popupIndex]!;
      // Per popup, not around the loop: a denial on the first popup must not
      // leave later ones unvalidated and selectable on a denied URL. Keep the
      // first error and keep going.
      try {
        // A popup starts at about:blank; reuse the delayed-navigation observer
        // so a still-loading popup gets the same grace window before
        // validation, and a policy deny quarantines/closes the popup target
        // like any other block.
        const observedPopup = await observeDelayedInteractionNavigation(
          popupPage as unknown as NavigationObservablePage,
          "about:blank",
        );
        await assertObservedDelayedNavigations({
          cdpUrl: opts.cdpUrl,
          page: popupPage,
          ssrfPolicy: opts.ssrfPolicy,
          browserProxyMode: opts.browserProxyMode,
          observed: observedPopup,
        });
      } catch (err) {
        if (popupError === undefined) popupError = err;
        // Fail closed on the rejected popup itself. A policy deny above only
        // quarantines — assertPageNavigationCompletedSafely never closes; that
        // step belongs to callers that own the navigation lifecycle — and this
        // popup was created BY the action, not by the user, so it is ours to
        // tear down. Left open, the denied page keeps executing after the
        // context listener detaches (in direct mode no lifetime request gate
        // remains to catch it).
        //
        // Bounded, because close() can hang forever on an adversarial page.
        // But a timeout is NOT success: the page is still live and scriptable.
        // Escalate exactly like the overflow path — context, then browser —
        // and if none of that works, report the untorn-down browser so the
        // host distrusts the route instead of returning an ordinary denial.
        const popupClosed = await Promise.race([
          closeBlockedNavigationTarget({
            cdpUrl: opts.cdpUrl,
            page: popupPage as Page,
          }).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), POPUP_CHAIN_CLOSE_BUDGET_MS);
            (timer as unknown as { unref?: () => void }).unref?.();
          }),
        ]);
        if (!popupClosed && !(await tearDownUncontainedPages())) {
          popupError = new Error(UNTORN_DOWN_BROWSER_MESSAGE);
          break;
        }
      }
    }
    if (popupIndex < popupsDuringAction.length) {
      // Quarantine must be bounded too, for the same reason the drain above is:
      // a burst of popups, or one unresponsive close(), would otherwise keep
      // this action — and the serialized stop/quit cleanup behind it — pending
      // indefinitely. Close concurrently under a single deadline rather than
      // serially awaiting each one, and re-read the queue (not a snapshot) so
      // popups appended while these closes run are quarantined too.
      const closeDeadline = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POPUP_CHAIN_CLOSE_BUDGET_MS);
        // Do not hold the process open on this timer.
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      const closing: Array<Promise<void>> = [];
      let deadlineReached = false;
      void closeDeadline.then(() => { deadlineReached = true; });
      // Outer loop so newly-arrived popups are picked up: the inner loop never
      // awaits, so on its own it drains the queue as it stands and returns
      // before the event loop can deliver another page event. Yielding
      // between sweeps is what actually lets the queue grow and be re-read;
      // without it a popup created during cleanup would be left live,
      // unvalidated and unquarantined once the listener detaches.
      while (
        !deadlineReached
        && popupIndex < popupsDuringAction.length
        && closing.length < POPUP_CHAIN_MAX_CLOSES
      ) {
        for (
          ;
          popupIndex < popupsDuringAction.length
          && closing.length < POPUP_CHAIN_MAX_CLOSES;
          popupIndex += 1
        ) {
          const unvalidated = popupsDuringAction[popupIndex]!;
          // Quarantine BEFORE closing, and do not make it conditional on the
          // close succeeding: close() can hang forever on an adversarial page,
          // and when the deadline below fires we would otherwise leave a live,
          // never-validated popup selectable — in direct mode there is no
          // lifetime CDP request gate to catch it afterwards. Marking is
          // synchronous bookkeeping, so it completes regardless.
          closing.push(
            quarantineTargetWithoutClosing({
              cdpUrl: opts.cdpUrl,
              page: unvalidated as Page,
            })
              .catch(() => undefined)
              .then(() => (unvalidated as { close?: () => Promise<void> }).close?.())
              .then(
                () => undefined,
                () => undefined,
              ),
          );
        }
        // Hand control back so pending page events can enqueue, then re-check.
        // Racing the deadline keeps this bounded even against a page that
        // appends a new popup on every turn.
        await Promise.race([
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 0);
            (timer as unknown as { unref?: () => void }).unref?.();
          }),
          closeDeadline,
        ]);
      }
      // Never await a popup's close() unbounded: a hung page must not outrank
      // returning from the interaction.
      //
      // Track whether they actually finished. popupIndex only records that a
      // close was ISSUED, and quarantine is bookkeeping that never closes a
      // page (see quarantineTargetWithoutClosing), so a fully-drained queue
      // whose closes all hang would otherwise look fully handled while every
      // one of those popups is still live and scriptable.
      const allClosesSettled = await Promise.race([
        Promise.all(closing).then(() => true),
        closeDeadline.then(() => false),
      ]);
      // If the bounds cut us off with popups still unaccounted for, they were
      // neither validated nor quarantined and the listener is about to detach —
      // in direct mode nothing else would ever check them. Per-page cleanup has
      // already failed to keep up here, so fail closed on the whole context
      // rather than leaving live, never-validated pages behind.
      if (popupIndex < popupsDuringAction.length || !allClosesSettled) {
        // Nothing reachable from this process can shut the browser down, and a
        // resolved close() would only prove the call returned, not that the
        // process exited. Say so explicitly rather than reporting a generic
        // policy denial: the host owns process teardown and must treat this
        // route as untrusted until it verifies an exit itself.
        if (!(await tearDownUncontainedPages(closeDeadline))) {
          popupError = new Error(UNTORN_DOWN_BROWSER_MESSAGE);
        }
      }
      if (popupError === undefined) {
        popupError = new Error(
          "Navigation blocked: popup chain exceeded the validation budget; remaining popups were closed",
        );
      }
    }
  } finally {
    // Always detach: a throw here would otherwise leak the listener, retaining
    // every tab opened afterwards for the life of the context.
    if (pageContext && typeof pageContext.off === "function") {
      pageContext.off("page", onContextPage);
    }
  }

  // A containment failure outranks EVERYTHING. Ordinary denials describe a
  // request that was refused — the safe outcome. This one says pages we never
  // validated are still live and could not be torn down, and it is the only
  // signal the host uses to distrust the route. If a denied main-frame
  // navigation happened in the same interaction (easy for an adversarial page
  // to arrange), reporting that instead would leave the route usable while
  // those pages keep running.
  if (popupError && /could not be torn down/.test(String((popupError as Error)?.message ?? ""))) {
    throw toLintErrorObject(popupError, "Non-Error thrown");
  }

  // Otherwise policy denials outrank the action's own error, and the main-frame
  // denial outranks subframe/popup denials, so the caller sees the navigation it
  // asked for being refused. All were still evaluated above.
  if (navigationError) {
    throw toLintErrorObject(navigationError, "Non-Error thrown");
  }

  if (subframeError) {
    throw toLintErrorObject(subframeError, "Non-Error thrown");
  }

  if (popupError) {
    throw toLintErrorObject(popupError, "Non-Error thrown");
  }

  if (actionError) {
    throw toLintErrorObject(actionError, "Non-Error thrown");
  }
  return result as T;
}`,
        ],
        // resize: page resize handlers can assign location; run the viewport
        // change inside the same guard at the dispatch (the implementation
        // lives in pw-tools-core.snapshot.ts, which cannot reach this
        // file-private guard).
        [
          `    case "resize":
      await resizeViewportViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        width: action.width,
        height: action.height,
      });
      break;`,
          `    case "resize": {
      const resizePage = await getPageForTargetId({ cdpUrl, targetId: effectiveTargetId });
      ensurePageState(resizePage);
      const resizePreviousUrl = resizePage.url();
      await assertInteractionNavigationCompletedSafely({
        action: async () => {
          await resizeViewportViaPlaywright({
            cdpUrl,
            targetId: effectiveTargetId,
            width: action.width,
            height: action.height,
          });
        },
        cdpUrl,
        page: resizePage,
        previousUrl: resizePreviousUrl,
        ssrfPolicy,
        browserProxyMode,
        targetId: effectiveTargetId,
      });
      break;
    }`,
        ],
        // act dispatch: pass the policy into the four newly guarded branches.
        [
          `    case "hover":
      await hoverViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        signal,
      });`,
          `    case "hover":
      await hoverViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
        browserProxyMode,
        signal,
      });`,
        ],
        [
          `    case "scrollIntoView":
      await scrollIntoViewViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        signal,
      });`,
          `    case "scrollIntoView":
      await scrollIntoViewViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
        browserProxyMode,
        signal,
      });`,
        ],
        [
          `    case "drag":
      await dragViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        startRef: action.startRef,
        startSelector: action.startSelector,
        endRef: action.endRef,
        endSelector: action.endSelector,
        timeoutMs: action.timeoutMs,
        signal,
      });`,
          `    case "drag":
      await dragViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        startRef: action.startRef,
        startSelector: action.startSelector,
        endRef: action.endRef,
        endSelector: action.endSelector,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
        browserProxyMode,
        signal,
      });`,
        ],
        [
          `        loadState: action.loadState,
        fn: action.fn,
        timeoutMs: action.timeoutMs,
        signal,
      });`,
          `        loadState: action.loadState,
        fn: action.fn,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
        browserProxyMode,
        signal,
      });`,
        ],
      ]),
    },
  ],
  'extension/src/browser/pw-session.ts': [
    {
      desc: 'export a non-blocking quarantine so the popup-overflow path can mark a target unusable without awaiting close() (a hung page must not keep the interaction pending)',
      find: `// Quarantine and close a tab that OpenClaw itself navigated to a blocked URL.`,
      replace: `/**
 * Mark a target unusable WITHOUT closing it.
 *
 * closeBlockedNavigationTarget awaits page.close(), which an adversarial or
 * hung page can stall indefinitely. Quarantine is the part that must not
 * depend on the page cooperating: marking is synchronous bookkeeping, so a
 * target can be made unselectable even when its close never returns.
 */
export async function quarantineTargetWithoutClosing(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
}): Promise<void> {
  await quarantineBlockedTarget(opts);
}

// Quarantine and close a tab that OpenClaw itself navigated to a blocked URL.`,
    },
  ],
  'extension/src/browser/ssrf-policy-helpers.ts': [
    {
      desc: 'one-off hostname grants must also pass a strict hostnameAllowlist (else the loopback CDP endpoint is blocked by proxyAllowedHostnames and every proxied navigation fails)',
      find: `export function withAllowedHostname(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): SsrFPolicy {
  return {
    ...ssrfPolicy,
    allowedHostnames: uniqueStrings([...(ssrfPolicy?.allowedHostnames ?? []), hostname]),
  };
}`,
      replace: `export function withAllowedHostname(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): SsrFPolicy {
  return {
    ...ssrfPolicy,
    allowedHostnames: uniqueStrings([...(ssrfPolicy?.allowedHostnames ?? []), hostname]),
    // A one-off grant must grant through BOTH policy fields: exact-host trust
    // (allowedHostnames) and, when a strict hostnameAllowlist is active, the
    // allowlist match itself. Otherwise a per-start proxyAllowedHostnames
    // blocks the browser's own loopback CDP endpoint, and every proxied
    // navigation fails before it starts. An absent/empty allowlist stays
    // empty: it means "no allowlist", not "allow only this host".
    ...(ssrfPolicy?.hostnameAllowlist?.length
      ? { hostnameAllowlist: uniqueStrings([...ssrfPolicy.hostnameAllowlist, hostname]) }
      : {}),
  };
}`,
    },
  ],
  'extension/src/browser/chrome.ts': [
    {
      desc: 'expose managed-profile PID lookup so the host can confirm process exit from the OS, not from CDP endpoint silence (a stalled Chrome stops answering while still alive)',
      find: `function clearChromeSingletonArtifacts(userDataDir: string) {`,
      replace: `/**
 * PID of the live Chrome owning this managed profile, or null if none.
 *
 * Reads the profile's SingletonLock and confirms the process actually exists,
 * so callers can distinguish "the process is gone" from "the CDP endpoint went
 * quiet" — a busy or stalled Chrome produces the latter while still running.
 */
export function readManagedProfileOwnerPid(userDataDir: string): number | null {
  return readCurrentHostSingletonPid(userDataDir);
}

/**
 * Whether this exact PID holds the CDP port.
 *
 * Positive identity, unlike the lock alone: the lock records a PID that the OS
 * may since have recycled, so anything destructive must confirm the process it
 * is about to signal is really the browser. Returns false on platforms with no
 * probe (Windows), which keeps callers fail-safe rather than fail-destructive.
 */
export function managedProfilePidOwnsCdpPort(pid: number, cdpPort: number): boolean {
  return pidListensOnPort(pid, cdpPort);
}

/**
 * Whether this PID is a Chrome launched for exactly this profile and port.
 *
 * Identity from the process itself, not inferred from what it happens to hold:
 * holding a port proves only that something is listening, and a port freed by
 * an exited Chrome can be taken over by anything. Required before anything
 * destructive — the command line must carry both our --user-data-dir and our
 * --remote-debugging-port. Returns false wherever the command line cannot be
 * read, so callers fail safe rather than fail destructive.
 */
export function pidIsManagedChromeForProfile(params: {
  pid: number;
  cdpPort: number;
  userDataDir: string;
}): boolean {
  if (!processExists(params.pid)) return false;
  const command = readManagedProcessCommandLine(params.pid);
  if (!command) return false;
  return (
    managedCommandHasExactArg(command, \`--remote-debugging-port=\${params.cdpPort}\`) &&
    managedCommandHasExactArg(command, \`--user-data-dir=\${params.userDataDir}\`)
  );
}

/**
 * Exact-argument match for a process command line.
 *
 * NOT processCommandHasArg: that falls back to \`text.includes\` when argv is
 * unavailable, which it always is on Darwin (ps yields a flat string). A
 * substring test accepts \`--user-data-dir=<dir>-backup\` for \`<dir>\`, and this
 * result gates SIGTERM/SIGKILL — so an unrelated Chrome could be killed. Where
 * argv exists the element comparison is already exact; otherwise require a
 * whitespace or quote delimiter on both sides.
 */
function managedCommandHasExactArg(
  command: { argv: string[] | null; text: string },
  expected: string,
): boolean {
  if (command.argv) {
    return command.argv.includes(expected);
  }
  let offset = command.text.indexOf(expected);
  while (offset >= 0) {
    const before = offset === 0 ? "" : command.text[offset - 1];
    const after = command.text[offset + expected.length] ?? "";
    if ((!before || /[\\s"']/.test(before)) && (!after || /[\\s"']/.test(after))) return true;
    offset = command.text.indexOf(expected, offset + 1);
  }
  return false;
}

function clearChromeSingletonArtifacts(userDataDir: string) {`,
    },
    {
      desc: 'decorate Chrome chip with host displayName so Cindy-real stays disk-only',
      find: `  fs.mkdirSync(userDataDir, { recursive: true });
  await ensureOutputDirectory(DEFAULT_DOWNLOAD_DIR);

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
    DEFAULT_DOWNLOAD_DIR,
  );`,
      replace: `  fs.mkdirSync(userDataDir, { recursive: true });
  await ensureOutputDirectory(DEFAULT_DOWNLOAD_DIR);

  // LOCAL PATCH (Cindy, via sync.mjs): Chrome chip follows host displayName
  // when set so the disk key (Cindy-real) never leaks into the profile button.
  const chipName =
    normalizeOptionalString(resolved.profiles[profile.name]?.displayName) ?? profile.name;

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    chipName,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
    DEFAULT_DOWNLOAD_DIR,
  );`,
    },
    {
      desc: 'pass chipName into decorateOpenClawProfile instead of the disk key',
      find: `      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
        downloadDir: DEFAULT_DOWNLOAD_DIR,
      });`,
      replace: `      decorateOpenClawProfile(userDataDir, {
        name: chipName,
        color: profile.color,
        downloadDir: DEFAULT_DOWNLOAD_DIR,
      });`,
    },
  ],
  'extension/src/browser/chrome.executables.ts': [
    {
      desc: 'detect macOS Google Chrome Beta after stable Chromium-family browsers',
      find: `    {
      kind: "chromium",
      path: path.join(os.homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
    },
    {
      kind: "canary",`,
      replace: `    {
      kind: "chromium",
      path: path.join(os.homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
    },
    {
      kind: "chrome",
      path: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    },
    {
      kind: "chrome",
      path: path.join(
        os.homedir(),
        "Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      ),
    },
    {
      kind: "canary",`,
    },
    {
      desc: 'classify macOS Google Chrome Beta within the Chrome-only fallback',
      find: `function findGoogleChromeExecutableMac(): BrowserExecutable | null {
  return findFirstChromeExecutable([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    path.join(
      os.homedir(),
      "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ),
  ]);
}`,
      replace: `function findGoogleChromeExecutableMac(): BrowserExecutable | null {
  return findFirstExecutable([
    {
      kind: "chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    {
      kind: "chrome",
      path: path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    },
    {
      kind: "chrome",
      path: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    },
    {
      kind: "chrome",
      path: path.join(
        os.homedir(),
        "Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      ),
    },
    {
      kind: "canary",
      path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    },
    {
      kind: "canary",
      path: path.join(
        os.homedir(),
        "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ),
    },
  ]);
}`,
    },
  ],
  'extension/src/browser/config.ts': [
    {
      desc: 'preserve narrow fake-IP SSRF allowances from the host config without enabling general private-network access',
      find: `function resolveBrowserSsrFPolicy(cfg: BrowserConfig | undefined): SsrFPolicy | undefined {
  const rawPolicy = cfg?.ssrfPolicy as BrowserSsrFPolicyCompat | undefined;
  const allowPrivateNetwork = rawPolicy?.allowPrivateNetwork;
  const dangerouslyAllowPrivateNetwork = rawPolicy?.dangerouslyAllowPrivateNetwork;
  const allowedHostnames = normalizeStringList(rawPolicy?.allowedHostnames);
  const hostnameAllowlist = normalizeStringList(rawPolicy?.hostnameAllowlist);
  const hasExplicitPrivateSetting =
    allowPrivateNetwork !== undefined || dangerouslyAllowPrivateNetwork !== undefined;
  const resolvedAllowPrivateNetwork =
    dangerouslyAllowPrivateNetwork === true || allowPrivateNetwork === true;

  if (
    !resolvedAllowPrivateNetwork &&
    !hasExplicitPrivateSetting &&
    !allowedHostnames &&
    !hostnameAllowlist
  ) {
    // Keep the default policy object present so CDP guards still enforce
    // fail-closed private-network checks on unconfigured installs.
    return {};
  }

  return {
    ...(resolvedAllowPrivateNetwork ||
    dangerouslyAllowPrivateNetwork === false ||
    allowPrivateNetwork === false
      ? { dangerouslyAllowPrivateNetwork: resolvedAllowPrivateNetwork }
      : {}),
    ...(allowedHostnames ? { allowedHostnames } : {}),
    ...(hostnameAllowlist ? { hostnameAllowlist } : {}),
  };
}`,
      replace: `function resolveBrowserSsrFPolicy(cfg: BrowserConfig | undefined): SsrFPolicy | undefined {
  const rawPolicy = cfg?.ssrfPolicy as BrowserSsrFPolicyCompat | undefined;
  const allowPrivateNetwork = rawPolicy?.allowPrivateNetwork;
  const dangerouslyAllowPrivateNetwork = rawPolicy?.dangerouslyAllowPrivateNetwork;
  // LOCAL PATCH (Cindy, via sync.mjs): upstream's config resolver currently
  // drops the narrow fake-IP allowances even though the SSRF layer supports
  // them. Preserve explicit booleans so hosts can allow only proxy fake-IP
  // ranges without disabling protection for metadata, link-local, or RFC1918.
  const allowRfc2544BenchmarkRange = rawPolicy?.allowRfc2544BenchmarkRange;
  const allowIpv6UniqueLocalRange = rawPolicy?.allowIpv6UniqueLocalRange;
  const allowedHostnames = normalizeStringList(rawPolicy?.allowedHostnames);
  const hostnameAllowlist = normalizeStringList(rawPolicy?.hostnameAllowlist);
  const hasExplicitPrivateSetting =
    allowPrivateNetwork !== undefined || dangerouslyAllowPrivateNetwork !== undefined;
  const hasExplicitFakeIpSetting =
    allowRfc2544BenchmarkRange !== undefined || allowIpv6UniqueLocalRange !== undefined;
  const resolvedAllowPrivateNetwork =
    dangerouslyAllowPrivateNetwork === true || allowPrivateNetwork === true;

  if (
    !resolvedAllowPrivateNetwork &&
    !hasExplicitPrivateSetting &&
    !hasExplicitFakeIpSetting &&
    !allowedHostnames &&
    !hostnameAllowlist
  ) {
    // Keep the default policy object present so CDP guards still enforce
    // fail-closed private-network checks on unconfigured installs.
    return {};
  }

  return {
    ...(resolvedAllowPrivateNetwork ||
    dangerouslyAllowPrivateNetwork === false ||
    allowPrivateNetwork === false
      ? { dangerouslyAllowPrivateNetwork: resolvedAllowPrivateNetwork }
      : {}),
    ...(allowRfc2544BenchmarkRange !== undefined ? { allowRfc2544BenchmarkRange } : {}),
    ...(allowIpv6UniqueLocalRange !== undefined ? { allowIpv6UniqueLocalRange } : {}),
    ...(allowedHostnames ? { allowedHostnames } : {}),
    ...(hostnameAllowlist ? { hostnameAllowlist } : {}),
  };
}`,
    },
    {
      desc: 'skip upstream auto-injected "openclaw"/"user" profiles when the host provides its own (avoids CDP port 18800 collision with the managed profile + never drives the user\'s Chrome)',
      find:
        '  let profiles = ensureDefaultUserBrowserProfile(\n' +
        '    ensureDefaultProfile(\n' +
        '      cfg?.profiles,\n' +
        '      defaultColor,\n' +
        '      legacyCdpPort,\n' +
        '      cdpPortRangeStart,\n' +
        '      legacyCdpUrl,\n' +
        '    ),\n' +
        '  );',
      replace:
        '  // LOCAL PATCH (xdt-maker, via sync.mjs): when the host supplies explicit\n' +
        '  // profiles, resolve ONLY those — do not auto-inject the upstream default\n' +
        '  // "openclaw" profile (shares CDP port 18800 with the managed profile →\n' +
        '  // launch collision) nor the "user" attach-to-existing profile (we never\n' +
        '  // drive the user\'s own Chrome). Falls back to upstream behavior otherwise.\n' +
        '  let profiles =\n' +
        '    cfg?.profiles && Object.keys(cfg.profiles).length > 0\n' +
        '      ? { ...cfg.profiles }\n' +
        '      : ensureDefaultUserBrowserProfile(\n' +
        '          ensureDefaultProfile(\n' +
        '            cfg?.profiles,\n' +
        '            defaultColor,\n' +
        '            legacyCdpPort,\n' +
        '            cdpPortRangeStart,\n' +
        '            legacyCdpUrl,\n' +
        '          ),\n' +
        '        );',
    },
  ],
};

function applyExactReplacements(source, replacements) {
  let patched = source;
  for (const [find, replace, expectedCount = 1] of replacements) {
    const actualCount = patched.split(find).length - 1;
    if (actualCount !== expectedCount) {
      throw new Error(
        `LOCAL_PATCH exact replacement count mismatch (expected ${expectedCount}, found ${actualCount}). ` +
          'Upstream likely refactored the patched region — update LOCAL_PATCHES in sync.mjs.',
      );
    }
    patched = expectedCount === 1 ? patched.replace(find, replace) : patched.split(find).join(replace);
  }
  return patched;
}

/**
 * Apply any LOCAL_PATCHES registered for `relDest` to upstream `raw`. Throws if a
 * patch anchor is gone (upstream drift). Returns the patched source + the applied
 * patch descriptors (recorded into the lock for provenance).
 */
function applyLocalPatches(relDest, raw) {
  const patches = LOCAL_PATCHES[relDest];
  if (!patches) return { patched: raw, applied: [] };
  let patched = raw;
  const applied = [];
  for (const { desc, find, replace, transform } of patches) {
    if (transform) {
      patched = transform(patched);
      applied.push({ file: relDest, desc });
      continue;
    }
    if (!patched.includes(find)) {
      throw new Error(
        `LOCAL_PATCH anchor not found in ${relDest}: "${desc}". ` +
          'Upstream likely refactored the patched region — update LOCAL_PATCHES in sync.mjs.',
      );
    }
    patched = patched.replace(find, replace);
    applied.push({ file: relDest, desc });
  }
  return { patched, applied };
}

function writeGen(relDest, raw, srcLabel, hashes, appliedPatches) {
  // Normalize to POSIX separators: LOCAL_PATCHES keys and the lock's patch
  // records use '/', but path.join on win32 emits '\' — without this the
  // patches silently never match on Windows.
  relDest = relDest.replace(/\\/g, '/');
  const { patched, applied } = applyLocalPatches(relDest, raw);
  if (appliedPatches) appliedPatches.push(...applied);
  const dest = path.join(genRoot, relDest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, header(srcLabel) + rewriteImports(patched, dest));
  // Hash the PATCHED source so the lock's contentHash reflects local patches —
  // `--check` re-fetches upstream, re-applies patches, and must match.
  hashes[relDest] = sha256(Buffer.from(patched));
}

function main() {
  const checkMode = process.argv.includes('--check');
  ghPreflight();
  const lock = readJson(lockPath);
  const repoSlug = parseGithubRepo(lock.source.repo);
  const refArg = process.argv.find((a) => a.startsWith('--ref='));
  const ref = refArg ? refArg.slice('--ref='.length) : (lock.source.commit ?? 'main');
  // Require an explicit pinned version — never fall back to a hardcoded default.
  // A soft default would silently vendor an unpinned npm release (supply-chain
  // risk) if the lock ever omitted it.
  const fsSafeVer = lock.fsSafe?.version;
  if (!fsSafeVer || typeof fsSafeVer !== 'string') {
    throw new Error(
      'browser-runtime.lock.json: `fsSafe.version` is required (no implicit default) — ' +
        'set it explicitly to pin the vendored @openclaw/fs-safe version.',
    );
  }

  const commit = resolveRef(repoSlug, ref);
  const manifest = fs
    .readFileSync(manifestPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  console.log(`[browser-runtime] ${repoSlug}@${ref} -> ${commit}`);
  console.log(`[browser-runtime] core manifest: ${manifest.length} files; fs-safe ${fsSafeVer}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-sync-'));
  const tar = path.join(tmp, 'oc.tar.gz');
  console.log('[browser-runtime] downloading repo tarball...');
  shHide(`gh api repos/${repoSlug}/tarball/${commit} > ${JSON.stringify(tar)}`);
  // extract extensions/browser + the two workspace pkgs + the src/ leaf areas
  shHide(
    `tar -xzf ${JSON.stringify(tar)} -C ${JSON.stringify(tmp)} --strip-components=1 ` +
      `'*/extensions/browser' '*/packages/net-policy/src' '*/packages/normalization-core/src' '*/src/infra' '*/src/security' '*/src/config'`,
  );
  const repoTmp = tmp; // strip-components=1 lands repo content directly under tmp
  const upstreamBrowser = path.join(repoTmp, 'extensions/browser');
  // Assert every expected top-level source area actually extracted. A `tar` glob
  // whose upstream path was moved/renamed extracts NOTHING silently — without this
  // a partial/empty leaf closure could still "succeed" and quietly change
  // counts/contentHash. Fail loudly + point at the fix, mirroring the same intent
  // as the per-file `manifest file missing` guard below.
  const EXPECTED_DIRS = [
    'extensions/browser',
    'packages/net-policy/src',
    'packages/normalization-core/src',
    'src/infra',
    'src/security',
    'src/config',
  ];
  for (const d of EXPECTED_DIRS) {
    if (!fs.existsSync(path.join(repoTmp, d))) {
      throw new Error(
        `extraction failed: "${d}" missing from the upstream tarball — the upstream path likely ` +
          'moved/renamed. Update the tar glob (and manifest/seeds) in sync.mjs before re-vendoring.',
      );
    }
  }

  // wipe & regenerate
  fs.rmSync(genRoot, { recursive: true, force: true });
  fs.mkdirSync(genRoot, { recursive: true });
  const hashes = {};
  const appliedPatches = [];

  // 1. browser core (133)
  for (const rel of manifest) {
    const srcFile = path.join(upstreamBrowser, rel);
    if (!fs.existsSync(srcFile)) throw new Error(`manifest file missing: ${rel}`);
    writeGen(path.join('extension', rel), fs.readFileSync(srcFile, 'utf8'), `extensions/browser/${rel}`, hashes, appliedPatches);
  }

  // 2+3. vendored workspace packages (verbatim subtree)
  let packagesCount = 0;
  for (const [pkg, srcDir] of [
    ['net-policy', path.join(repoTmp, 'packages/net-policy/src')],
    ['normalization-core', path.join(repoTmp, 'packages/normalization-core/src')],
  ]) {
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('fixtures'));
    for (const f of files) {
      writeGen(path.join('packages', pkg, f), fs.readFileSync(path.join(srcDir, f), 'utf8'), `packages/${pkg}/src/${f}`, hashes, appliedPatches);
      packagesCount++;
    }
  }

  // 4. SSRF/security leaf closure (preserve src/ subtree shape under leaf/)
  const leaf = computeLeafClosure(repoTmp).filter((p) => p.startsWith('src/'));
  for (const rel of leaf) {
    writeGen(path.join('leaf', rel), fs.readFileSync(path.join(repoTmp, rel), 'utf8'), rel, hashes, appliedPatches);
  }

  // Every registered patch must have actually applied (a typo'd relDest key would
  // otherwise silently never run); assert the applied set covers LOCAL_PATCHES.
  const expectedPatchCount = Object.values(LOCAL_PATCHES).reduce((n, arr) => n + arr.length, 0);
  if (appliedPatches.length !== expectedPatchCount) {
    throw new Error(
      `LOCAL_PATCHES: expected ${expectedPatchCount} patch(es) to apply but ${appliedPatches.length} did — ` +
        'a patch key likely does not match any vendored file path.',
    );
  }

  // 5. fs-safe dist from npm (zero-dep ESM, vendored as a unit)
  console.log('[browser-runtime] packing @openclaw/fs-safe from npm...');
  const fsTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fssafe-'));
  shHide(`cd ${JSON.stringify(fsTmp)} && npm pack @openclaw/fs-safe@${fsSafeVer} >/dev/null 2>&1 && tar -xzf *.tgz`);
  const distSrc = path.join(fsTmp, 'package/dist');
  let fsSafeCount = 0;
  for (const f of fs.readdirSync(distSrc)) {
    // vendor .js + .d.ts (skip maps to keep tree lean)
    if (f.endsWith('.js') || f.endsWith('.d.ts')) {
      const raw = fs.readFileSync(path.join(distSrc, f), 'utf8');
      const dest = path.join(genRoot, 'vendor/fs-safe/dist', f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, raw); // fs-safe is self-contained; no rewrite needed
      hashes[`vendor/fs-safe/dist/${f}`] = sha256(Buffer.from(raw));
      fsSafeCount++;
    }
  }
  fs.copyFileSync(path.join(fsTmp, 'package/LICENSE'), path.join(genRoot, 'vendor/fs-safe/LICENSE'));

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fsTmp, { recursive: true, force: true });

  // lock
  const counts = {
    core: manifest.length,
    packages: packagesCount,
    leaf: leaf.length,
    fsSafe: fsSafeCount,
  };
  // true total across every vendored source (was previously the misleading core-only count)
  const fileCount = counts.core + counts.packages + counts.leaf + counts.fsSafe;
  const contentHash = sha256(Buffer.from(JSON.stringify(hashes)));

  console.log(
    `[browser-runtime] generated: core=${counts.core} packages=${counts.packages} leaf=${counts.leaf} fs-safe=${counts.fsSafe} (total=${fileCount})`,
  );
  console.log(`[browser-runtime] contentHash=${contentHash.slice(0, 12)}`);

  if (checkMode) {
    // Drift detection: recompute exactly like a normal run, but compare against the
    // committed lock instead of writing. Exit non-zero on any contentHash/counts diff.
    const drift = [];
    if (lock.contentHash !== contentHash) {
      drift.push(`contentHash: committed=${lock.contentHash} recomputed=${contentHash}`);
    }
    const committedCounts = lock.counts ?? {};
    for (const key of Object.keys(counts)) {
      if (committedCounts[key] !== counts[key]) {
        drift.push(`counts.${key}: committed=${committedCounts[key]} recomputed=${counts[key]}`);
      }
    }
    if (drift.length > 0) {
      console.error('[browser-runtime] LOCK DRIFT detected vs upstream/browser-runtime.lock.json:');
      for (const d of drift) console.error(`  - ${d}`);
      console.error('[browser-runtime] run `node scripts/browser-runtime/sync.mjs` to regenerate the lock.');
      process.exit(1);
    }
    console.log('[browser-runtime] lock is up to date (contentHash + counts match).');
    return;
  }

  lock.source.commit = commit;
  lock.generated = true;
  lock.fsSafe = { package: '@openclaw/fs-safe', version: fsSafeVer };
  lock.fileCount = fileCount;
  lock.counts = counts;
  lock.patches = appliedPatches;
  lock.contentHash = contentHash;
  writeJson(lockPath, lock);

  console.log('[browser-runtime] next: typecheck to surface remaining shim gaps (src/shim/*).');
}

main();
