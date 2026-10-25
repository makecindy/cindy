/**
 * filePathPolicy.ts
 * ---------------------------------------------------------------------------
 * Shared filesystem path-access policy for the desktop main process.
 *
 * Two layers, one model:
 *   1. System blocklist — the original file-attachment / open-external policy
 *      (`read-file-for-attachment`, `peek-file-header`, `text-file:read-preview`,
 *      `shell:open-path`, `shell:open-external`). Blocks OS system directories
 *      an attachment pipeline has no reason to touch. Relocated verbatim from
 *      bootstrap-electron.ts so it can be reused without an import cycle.
 *   2. Sensitive-media blocklist — a SUPERSET of (1) used by the auto-loaded
 *      `xdt-file://` media protocol (localFileProtocol.ts). It additionally
 *      denies credential / secret / browser-profile directories, because that
 *      protocol resolves `<img src>` / fetch requests from rendered agent /
 *      user content WITHOUT a user gesture — a stricter surface than the
 *      user-initiated attachment IPCs.
 *
 * Why the media protocol needs a *deny-list* rather than an *allow-list*:
 *   Legitimate `xdt-file://` paths span effectively the whole filesystem —
 *   theme logos (arbitrary user paths), agent-cited / `Read` files (any
 *   absolute path, other volumes), user-pasted image paths, chat attachments
 *   previewed from their ORIGINAL location (~/Downloads, ~/Desktop), and local
 *   session output served straight from the (any-drive) working dir. A
 *   positive allow-list of "userData + workingDir" would 403 all of those, so
 *   we instead shrink the "arbitrary local file read" surface by excluding the
 *   dir families that are never a legitimate media source.
 *
 * Deliberately NOT blocked (would break real loads):
 *   - bare `/var`  → macOS `app.getPath('temp')` is `/var/folders/…` (temp
 *     attachment scratch); only `/var/log` `/var/root` `/var/db` are blocked.
 *   - all of `~/.config` → Linux `app.getPath('userData')` is `~/.config/<app>`;
 *     only credential subdirs (`gcloud`, `gh`) are blocked.
 *   - `~/Library/Application Support` wholesale → macOS userData lives there;
 *     only browser-profile subdirs are blocked.
 *
 * Pure module: no Electron import. `platform` / `homeDir` / `env` /
 * `realpathSync` are injectable so the containment logic is unit-testable on
 * any runner (Windows path semantics are exercised via `path.win32` when
 * `platform === 'win32'`, independent of the host OS).
 */

import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Platform-correct path helpers (default to the host so production behaves
 *  exactly like the previous global-`path` usage). */
function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Windows system dirs, built from %SystemRoot% / %ProgramFiles% /
 * %ProgramFiles(x86)% / %ProgramData% so D-drive or relocated installs are
 * covered. Defaults match the canonical C-drive paths so the list is never
 * empty even when env vars are stripped. De-duplicated case-insensitively
 * (32-bit Windows collapses ProgramFiles and ProgramFiles(x86)).
 */
export function buildWin32SystemBlocklist(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    env.SystemRoot ?? 'C:\\Windows',
    env.ProgramFiles ?? 'C:\\Program Files',
    env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    env.ProgramData ?? 'C:\\ProgramData',
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export interface SystemBlocklistOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** The original system-directory blocklist shared by file-attachment IPCs. */
export function buildSystemPathBlocklist(opts: SystemBlocklistOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  return platform === 'win32'
    ? buildWin32SystemBlocklist(opts.env)
    : ['/etc', '/proc', '/sys', '/dev', '/root', '/var/log'];
}

/**
 * True when `filePath` is allowed (NOT inside any blocklist root). Absolute
 * paths only; `..` segments and mixed slashes are collapsed via resolve, and
 * comparison is case-insensitive on win32. A trailing separator is required on
 * the candidate so `C:\Windows123` is NOT treated as inside `C:\Windows`
 * (prefix-boundary safety, e.g. `/data/foobar` vs `/data/foo`).
 *
 * Relocated from bootstrap-electron.ts `isPathAllowed`, generalized to accept
 * the blocklist + platform as parameters so both policy layers share it and it
 * is testable off the host OS. With `platform === process.platform` (the
 * default) it is byte-for-byte the original behavior.
 */
/**
 * Strip Windows extended-length / device-namespace prefixes so
 * `\\?\C:\Windows`, `\\.\C:\Windows` and `\\?\UNC\server\share` canonicalize
 * to the same form the blocklist roots use (`C:\Windows`, `\\server\share`).
 * Without this, a caller can prefix `\\?\` to bypass every `C:\Windows`-style
 * entry. No-op on non-`\\?\`/`\\.\` paths and on POSIX.
 */
function stripWinNamespace(input: string): string {
  if (input.startsWith('\\\\?\\') || input.startsWith('\\\\.\\')) {
    const rest = input.slice(4);
    // `\\?\UNC\server\share` → `\\server\share`
    if (/^UNC\\/i.test(rest)) return '\\\\' + rest.slice(4);
    return rest;
  }
  return input;
}

export function isPathAllowedAgainst(
  filePath: string,
  blocklist: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = pathFor(platform);
  const isWin = platform === 'win32';
  if (!filePath) return false;
  const canonicalInput = isWin ? stripWinNamespace(filePath) : filePath;
  if (!p.isAbsolute(canonicalInput)) return false;
  let resolved: string;
  try {
    resolved = p.resolve(p.normalize(canonicalInput));
  } catch {
    return false;
  }
  // Trim any trailing separator: p.resolve appends one to a UNC share root
  // (`\\server\share` → `\\server\share\`), which would otherwise make
  // `blockedKey + sep` a double separator that never prefix-matches.
  const trimSep = (s: string): string =>
    s.length > 1 && s.endsWith(p.sep) ? s.slice(0, -1) : s;
  const target = trimSep(isWin ? resolved.toLowerCase() : resolved);
  for (const blocked of blocklist) {
    const normBlocked = p.resolve(isWin ? stripWinNamespace(blocked) : blocked);
    const blockedKey = trimSep(isWin ? normBlocked.toLowerCase() : normBlocked);
    if (target === blockedKey) return false;
    if (target.startsWith(blockedKey + p.sep)) return false;
  }
  return true;
}

/** Credential dot-dirs blocked on every platform (relative to home). */
const CREDENTIAL_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure'] as const;

/**
 * Credential FILES relative to $HOME, blocked on every platform. Added as exact
 * entries (isPathAllowedAgainst matches exact equality) so only the file is
 * denied — never a whole dir that also holds non-secret bulk (e.g. `~/.cargo`
 * bin/cache, `~/.m2` repository), which blocking wholesale would over-restrict.
 * Covers mainstream dev-tooling credential files:
 *   - registry / VCS auth: .npmrc, .netrc, .git-credentials, .pypirc
 *   - package managers: ~/.cargo/credentials(.toml), ~/.m2/settings(-security).xml
 * Each element is a path-segment array joined onto $HOME.
 */
const CREDENTIAL_HOME_FILES: readonly (readonly string[])[] = [
  ['.npmrc'],
  ['.netrc'],
  ['.git-credentials'],
  ['.pypirc'],
  ['.cargo', 'credentials.toml'],
  ['.cargo', 'credentials'], // pre-1.39 cargo used the extension-less name
  ['.m2', 'settings.xml'],
  ['.m2', 'settings-security.xml'],
  ['.config', 'containers', 'auth.json'], // podman/skopeo registry creds (default)
];

export interface SensitiveMediaBlocklistOptions extends SystemBlocklistOptions {
  /** Defaults to os.homedir(). */
  homeDir?: string;
  /**
   * Resolve symlinks for existing roots so a realpath'd target still matches
   * across firmlinks (`/etc`→`/private/etc`, macOS `/Users` firmlink). Roots
   * that don't exist keep only their resolved form. Defaults to
   * fs.realpathSync.native; injected in tests.
   */
  realpathSync?: (p: string) => string;
}

/**
 * Sensitive-media blocklist = system blocklist ∪ credential / secret /
 * browser-profile directories. Returned entries are resolved absolute paths;
 * where a root exists and is symlinked, BOTH the resolved and realpath'd forms
 * are included so a realpath'd target matches regardless of firmlink/`/private`
 * prefixing.
 */
export function buildSensitiveMediaBlocklist(
  opts: SensitiveMediaBlocklistOptions = {},
): string[] {
  const platform = opts.platform ?? process.platform;
  const home = opts.homeDir ?? os.homedir();
  const p = pathFor(platform);
  const realpathSync =
    opts.realpathSync ?? ((target: string) => fsSync.realpathSync.native(target));

  const raw: string[] = [...buildSystemPathBlocklist({ platform, env: opts.env })];
  const pushHome = (...segs: string[]) => {
    if (home) raw.push(p.join(home, ...segs));
  };

  for (const dir of CREDENTIAL_HOME_DIRS) pushHome(dir);
  for (const segs of CREDENTIAL_HOME_FILES) pushHome(...segs);

  // Directory-valued env redirects honored by the credential CLIs themselves
  // (cross-platform, take precedence over the defaults below): when set, the
  // real credential root lives wherever they point, so deny that dir verbatim.
  const envAll = opts.env ?? process.env;
  for (const redirect of [
    'CLOUDSDK_CONFIG', // gcloud
    'GH_CONFIG_DIR', // GitHub CLI
    'GNUPGHOME', // gnupg
    'DOCKER_CONFIG', // docker (config.json holds registry auth)
    'AZURE_CONFIG_DIR', // azure CLI
  ] as const) {
    if (envAll[redirect]) raw.push(envAll[redirect] as string);
  }
  // File-valued credential overrides: push the EXACT file path (not its parent
  // dir — the parent may be an arbitrary user folder like ~/Downloads).
  // isPathAllowedAgainst already denies exact-equality matches, so an exact
  // entry blocks just that file. KUBECONFIG is a delimiter-separated list
  // (`:` on POSIX, `;` on Windows) of config files.
  for (const fileEnv of [
    'AWS_SHARED_CREDENTIALS_FILE', // aws credentials
    'AWS_CONFIG_FILE', // aws config
    'AWS_WEB_IDENTITY_TOKEN_FILE', // aws workload-identity OIDC token file
    'GOOGLE_APPLICATION_CREDENTIALS', // GCP ADC service-account key
    'AZURE_FEDERATED_TOKEN_FILE', // azure workload-identity projected token
    // npm user config override (holds registry tokens). npm interprets
    // `npm_config_*` case-insensitively and the lowercase form wins inside npm
    // scripts (docs: config#environment-variables), so cover both on POSIX
    // (Windows env is already case-insensitive).
    'NPM_CONFIG_USERCONFIG',
    'npm_config_userconfig',
    'REGISTRY_AUTH_FILE', // podman/skopeo registry auth override
  ] as const) {
    if (envAll[fileEnv]) raw.push(envAll[fileEnv] as string);
  }
  if (envAll.KUBECONFIG) {
    for (const kc of (envAll.KUBECONFIG as string).split(p.delimiter)) {
      if (kc) raw.push(kc);
    }
  }
  // Cargo credentials live under $CARGO_HOME (default ~/.cargo, covered via
  // CREDENTIAL_HOME_FILES); when CARGO_HOME is redirected, block the exact
  // credential files under it too.
  if (envAll.CARGO_HOME) {
    raw.push(p.join(envAll.CARGO_HOME as string, 'credentials.toml'));
    raw.push(p.join(envAll.CARGO_HOME as string, 'credentials'));
  }
  // Podman/containers registry auth.json: Linux runtime default lives under
  // $XDG_RUNTIME_DIR/containers; the $XDG_CONFIG_HOME variant covers a
  // redirected config home (the ~/.config default is in CREDENTIAL_HOME_FILES).
  if (envAll.XDG_RUNTIME_DIR) raw.push(p.join(envAll.XDG_RUNTIME_DIR, 'containers', 'auth.json'));
  if (envAll.XDG_CONFIG_HOME) raw.push(p.join(envAll.XDG_CONFIG_HOME, 'containers', 'auth.json'));

  if (platform === 'win32') {
    // 浏览器 profile 根应从 %LOCALAPPDATA% / %APPDATA% 派生:AppData 被重定向
    // (企业漫游 / 改盘)的机器上真实 profile 目录不在 os.homedir()\AppData 下,
    // 只按 home 拼会指错目录、把真 profile 漏出黑名单。env 缺失时才回落 home 相对。
    const winEnv = opts.env ?? process.env;
    const pushLocalAppData = (...segs: string[]) => {
      const base = winEnv.LOCALAPPDATA;
      if (base) raw.push(p.join(base, ...segs));
      else pushHome('AppData', 'Local', ...segs);
    };
    const pushRoamingAppData = (...segs: string[]) => {
      const base = winEnv.APPDATA;
      if (base) raw.push(p.join(base, ...segs));
      else pushHome('AppData', 'Roaming', ...segs);
    };
    // Chromium's Windows profile roots all live at
    // %LOCALAPPDATA%\<Vendor>\<Product>\User Data; enumerate every channel
    // (stable + Beta/Dev/SxS[=Canary]/for Testing) + plain Chromium so a
    // non-stable install's profile is not left readable.
    pushLocalAppData('Chromium', 'User Data');
    for (const chan of ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS', 'Chrome for Testing']) {
      pushLocalAppData('Google', chan, 'User Data');
    }
    for (const chan of ['Edge', 'Edge Beta', 'Edge Dev', 'Edge SxS']) {
      pushLocalAppData('Microsoft', chan, 'User Data');
    }
    // Other mainstream Chromium browsers keep the same <Vendor>\<Product>\User Data
    // layout under %LOCALAPPDATA%. Brave documents %LOCALAPPDATA%\BraveSoftware\
    // Brave-Browser\User Data; Opera/Vivaldi similarly.
    pushLocalAppData('BraveSoftware', 'Brave-Browser', 'User Data');
    pushLocalAppData('BraveSoftware', 'Brave-Browser-Beta', 'User Data');
    pushLocalAppData('Vivaldi', 'User Data');
    pushRoamingAppData('Opera Software', 'Opera Stable');
    pushRoamingAppData('Opera Software', 'Opera GX Stable');
    pushRoamingAppData('Mozilla', 'Firefox');
    // Windows defaults for the redirectable credential CLIs (documented at
    // %APPDATA%\gcloud and %APPDATA%\GitHub CLI; the env redirects above win
    // when set).
    pushRoamingAppData('gcloud');
    pushRoamingAppData('GitHub CLI');
    // OS credential stores / DPAPI: Credential Locker (Credentials), DPAPI
    // master keys (Protect) and Vault live under both Roaming and Local
    // %AppData%\Microsoft (MITRE Credential Locker). Block all roots.
    for (const store of ['Credentials', 'Protect', 'Vault']) {
      pushRoamingAppData('Microsoft', store);
      pushLocalAppData('Microsoft', store);
    }
  } else {
    // OS internals not already in the system list (which is temp-safe: no bare
    // `/var`, since macOS temp is `/var/folders/…`).
    raw.push('/var/root', '/var/db');
    // credential + browser-profile subdirs under the XDG config dir (can't block
    // the whole dir: Linux userData is $XDG_CONFIG_HOME/<app>, default ~/.config).
    // Derive the base from $XDG_CONFIG_HOME so a redirected config home still
    // resolves to the real profile roots.
    const posixEnv = opts.env ?? process.env;
    const configBase = posixEnv.XDG_CONFIG_HOME || (home ? p.join(home, '.config') : undefined);
    const pushConfig = (...segs: string[]) => {
      if (configBase) raw.push(p.join(configBase, ...segs));
    };
    // gh honors $XDG_CONFIG_HOME; gcloud does NOT (its only override is
    // $CLOUDSDK_CONFIG, handled above) and stays at ~/.config/gcloud even
    // when XDG is redirected — keep the home-anchored default covered in
    // addition to the XDG-derived form (harmless duplicate when XDG unset).
    pushConfig('gcloud');
    pushHome('.config', 'gcloud');
    pushConfig('gh');
    if (platform === 'darwin') {
      pushHome('Library', 'Keychains');
      pushHome('Library', 'Cookies');
      // Safari (default macOS browser) keeps history/bookmarks under
      // ~/Library/Safari and sandboxed data under ~/Library/Containers/
      // com.apple.Safari; the rest of ~/Library stays allowed.
      pushHome('Library', 'Safari');
      pushHome('Library', 'Containers', 'com.apple.Safari');
      // Browser profiles live in sibling roots under ~/Library/Application
      // Support; the rest of Application Support stays allowed (macOS userData
      // lives there), so every browser channel that stores a profile must be
      // listed explicitly — stable + channel builds (Beta/Dev/Canary) + plain
      // Chromium each use their own root.
      for (const rel of [
        ['Google', 'Chrome'],
        ['Google', 'Chrome Beta'],
        ['Google', 'Chrome Dev'],
        ['Google', 'Chrome Canary'],
        ['Google', 'Chrome for Testing'],
        ['Chromium'],
        ['Firefox'],
        ['Microsoft Edge'],
        ['Microsoft Edge Beta'],
        ['Microsoft Edge Dev'],
        ['Microsoft Edge Canary'],
        // Other mainstream Chromium browsers, documented profile roots under
        // ~/Library/Application Support.
        ['BraveSoftware', 'Brave-Browser'],
        ['BraveSoftware', 'Brave-Browser-Beta'],
        ['com.operasoftware.Opera'],
        ['com.operasoftware.OperaGX'],
        ['Vivaldi'],
      ]) {
        pushHome('Library', 'Application Support', ...rel);
      }
      raw.push('/Library/Keychains');
    } else {
      pushHome('.mozilla'); // linux Firefox
      // GNOME/libsecret desktop keyrings (login.keyring / *.keyring): the
      // rest of ~/.local/share stays allowed, so block only the keyring dirs.
      pushHome('.local', 'share', 'keyrings');
      pushHome('.gnome2', 'keyrings'); // legacy gnome-keyring location
      // Chrome/Chromium user-data root varies by channel AND by config prefix:
      // Chromium honors $CHROME_CONFIG_HOME as an alternate prefix (falling back
      // to $XDG_CONFIG_HOME, then ~/.config). Cover every base Cindy can
      // observe so a profile under any of them is denied.
      const chromeBases = new Set<string>();
      if (posixEnv.CHROME_CONFIG_HOME) chromeBases.add(posixEnv.CHROME_CONFIG_HOME);
      if (configBase) chromeBases.add(configBase);
      for (const base of chromeBases) {
        for (const chan of [
          'google-chrome',
          'google-chrome-beta',
          'google-chrome-unstable',
          'google-chrome-canary',
          'google-chrome-for-testing',
          'chromium',
          // Edge on Linux ships stable/beta/dev channels (no canary) and keeps
          // its profile roots under the same config bases as Chrome.
          'microsoft-edge',
          'microsoft-edge-beta',
          'microsoft-edge-dev',
          // Other mainstream Chromium browsers, documented Linux config roots.
          'BraveSoftware/Brave-Browser',
          'BraveSoftware/Brave-Browser-Beta',
          'vivaldi',
          'opera',
          'opera-beta',
        ]) {
          raw.push(p.join(base, chan));
        }
      }
      // $CHROME_USER_DATA_DIR sets the full profile root directly (no channel
      // suffix), so push it verbatim rather than deriving channel sub-paths.
      if (posixEnv.CHROME_USER_DATA_DIR) raw.push(posixEnv.CHROME_USER_DATA_DIR);
      // Sandboxed (Flatpak / Snap) installs of the same browsers keep their
      // profiles under per-app roots, not the native locations above. Deny the
      // whole per-app dir (profile layout differs per packaging); the rest of
      // ~/.var/app and ~/snap stays allowed.
      for (const flatpakId of [
        'org.mozilla.firefox',
        'org.chromium.Chromium',
        'com.google.Chrome',
        'com.microsoft.Edge',
        'com.brave.Browser',
        'com.opera.Opera',
        'com.vivaldi.Vivaldi',
      ]) {
        pushHome('.var', 'app', flatpakId);
      }
      for (const snapName of ['firefox', 'chromium', 'brave', 'opera', 'vivaldi']) {
        pushHome('snap', snapName);
      }
    }
  }

  const out = new Set<string>();
  for (const r of raw) {
    const resolved = p.resolve(r);
    out.add(resolved);
    try {
      const real = realpathSync(resolved);
      if (real) out.add(real);
    } catch {
      // Root does not exist (yet). If an ancestor (e.g. a symlinked home on a
      // data volume) resolves elsewhere, a file created inside this root later
      // realpath's to that other prefix and would slip past the literal entry —
      // so also block the root mapped through its nearest existing ancestor.
      const variant = realpathViaNearestAncestor(resolved, p, realpathSync);
      if (variant) out.add(variant);
    }
  }
  return [...out];
}

// Lazy singleton of buildSensitiveMediaBlocklist(): the set is stable for the
// app lifetime and building it touches disk (realpath for firmlink coverage).
// Shared by every consumer that serves/exports arbitrary local paths
// (xdt-file protocol handler, device-link media fetch) so they enforce one
// identical boundary.
let cachedSensitiveMediaBlocklist: readonly string[] | null = null;
export function getSensitiveMediaBlocklist(): readonly string[] {
  return (cachedSensitiveMediaBlocklist ??= buildSensitiveMediaBlocklist());
}

/**
 * Map a non-existent path through the realpath of its nearest existing
 * ancestor: walk up until realpathSync succeeds, then re-append the missing
 * tail. Returns null when nothing up the chain exists or the mapping is the
 * identity (no symlinked ancestor → the literal entry already covers it).
 */
function realpathViaNearestAncestor(
  resolved: string,
  p: typeof path.posix,
  realpathSync: (target: string) => string,
): string | null {
  let ancestor = p.dirname(resolved);
  const tail: string[] = [p.basename(resolved)];
  while (true) {
    try {
      const realAncestor = realpathSync(ancestor);
      const variant = p.join(realAncestor, ...tail);
      return variant === resolved ? null : variant;
    } catch {
      const parent = p.dirname(ancestor);
      if (parent === ancestor) return null; // hit the fs root: nothing exists
      tail.unshift(p.basename(ancestor));
      ancestor = parent;
    }
  }
}
