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
 * does NOT survive). Keyed by the _generated-relative path. Each patch is a literal
 * find/replace against the UPSTREAM source; a missing `find` anchor throws so an
 * upstream refactor surfaces loudly instead of silently dropping the patch (same
 * fail-loud philosophy as the manifest assertions). Keep these minimal and prefer
 * src/shim/* for anything that can live at the adapter boundary.
 */
const LOCAL_PATCHES = {
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
  'extension/src/browser/chrome.ts': [
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
};

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
  for (const { desc, find, replace } of patches) {
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
