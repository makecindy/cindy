import type { BrowserRuntimeConfig } from '@cindy/browser-control-runtime';

/**
 * Managed profile identity. The profile key is the on-disk folder
 * `browser/<key>/user-data`. Chrome's top-right chip follows `displayName` when
 * set, otherwise the key. Isolated and snapshot profiles both pass
 * `displayName: "Cindy"` so the chip never shows the disk identifier. The runtime
 * seeds name + color into Local State / Preferences before launch (decoration
 * re-checks every launch, so an old chip label self-heals on first run).
 * (Same Chrome binary as the user's, so the dock/taskbar icon is unchanged.)
 *
 * ⚠️ 磁盘标识符:这是 2026-07 品牌翻转时钉死的目录名,之后【不要】再跟随
 * @cindy/maker-shared/branding 的 BRAND_NAME 变化——改了会指向新的空 profile
 * 目录,丢失既有登录态/Cookie。老 profile 的接续路径:
 *  - 老 userData(xdt-maker)里的 `browser-runtime/browser/XDMaker` 由 mToc 首登
 *    迁移(legacyUserDataMigration.ts)复制为新 userData 的 `browser/Cindy`;
 *  - 新 userData 里若已有旧名目录(翻转前的 dev 实例),browser.ts module-eval 的
 *    就地改名自愈处理。两处的 'XDMaker'/'Cindy' 字面量与本常量保持一致。
 */
export const MANAGED_PROFILE = 'Cindy';

/**
 * Snapshot profile for consented "use my browser logins". Disk name is pinned
 * like `Cindy` — do not rename, or leftover cookie copies become unreachable
 * and cleanup will miss them. Never overlay onto `MANAGED_PROFILE`. The Chrome
 * chip still shows `MANAGED_PROFILE` via `displayName`; this string is not
 * user-facing.
 */
export const REAL_MANAGED_PROFILE = 'Cindy-real';

/**
 * Fixed brand tint for the managed profile. This intentionally stays on the vivid
 * teal variant instead of the Default Light auto-approval text color. NOTE:
 * Chrome treats this as a *seed* and generates a tonal toolbar theme from it (Material
 * You), so it is NOT painted literally — but a SATURATED hue like this renders as a
 * clean teal, unlike a neutral/near-black seed which Chrome muddies into a grey-blue.
 * (The darker #000050 variant is near-neutral and would muddy, so we use #00D9C5.)
 */
const DEFAULT_PROFILE_COLOR = '#00D9C5';

/**
 * Vendored "managed launch" driver enum value (required by the runtime to mark a
 * profile as launch-and-own vs attach-to-existing). It DOES surface in the
 * `profiles`/`status`/`doctor` diagnostic output, so the runtime scrubs the
 * vendored brand from those success bodies at its boundary (see runtime.ts
 * DIAGNOSTIC_ACTIONS) — the agent never sees the raw "openclaw" string.
 */
const MANAGED_DRIVER = 'openclaw' as const;

/**
 * Managed Chrome CDP port. The runtime only auto-assigns a port to its built-in
 * default profile (keyed by the vendored default name); a custom-named managed
 * profile MUST define its own `cdpPort` or the runtime rejects it with "must define
 * cdpPort or cdpUrl". 18800 is the vendored default CDP port-range start.
 */
export const MANAGED_CDP_PORT = 18800;

/**
 * Default ("managed") config: a single playwright-launched Chrome profile, headed,
 * with a STABLE persistent user-data-dir (logins survive across sessions). This is
 * the product default — a "dedicated persistent login automation browser".
 * (`browser-backend-settings-store` resolves `'external'` as the system default,
 * so this config is what a user who never touched the toggle gets.)
 *
 * SECURITY POSTURE:
 *  - The desktop agent may navigate to every host reachable from this machine,
 *    including private, loopback, link-local and metadata addresses. A browser-
 *    only network restriction is not an agent-wide boundary: terminal tools and
 *    page-context JS do not share this Node guard. This is a deliberate product
 *    policy for browser automation, not the default for other network consumers.
 *  - Navigation protocol validation, Chromium sandboxing and website permissions
 *    remain in force. The dedicated profile and consented login-copy rules stay
 *    independent of network reachability.
 */
export function buildManagedConfig(options?: {
  useRealProfile?: boolean;
  executablePath?: string;
  cdpPort?: number;
}): BrowserRuntimeConfig {
  const useRealProfile = options?.useRealProfile === true;
  const defaultProfile = useRealProfile ? REAL_MANAGED_PROFILE : MANAGED_PROFILE;
  const executablePath = options?.executablePath;
  const cdpPort = options?.cdpPort ?? MANAGED_CDP_PORT;
  return {
    browser: {
      enabled: true,
      defaultProfile,
      headless: false, // headed so the user can see + log into sites
      ...(executablePath ? { executablePath } : {}),
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
      profiles: {
        [defaultProfile]: {
          driver: MANAGED_DRIVER,
          color: DEFAULT_PROFILE_COLOR,
          cdpPort,
          displayName: MANAGED_PROFILE,
          ...(executablePath ? { executablePath } : {}),
        },
      },
    },
  };
}
