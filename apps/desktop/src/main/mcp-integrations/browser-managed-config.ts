import type { BrowserRuntimeConfig } from '@cindy/browser-control-runtime';

/**
 * Managed profile identity. The profile key doubles as (a) the Chrome profile
 * display name rendered in the launched browser's top-right profile button and (b)
 * the user-data-dir folder name — so it's branded "Cindy" to make the automation
 * browser obviously distinct from the user's everyday Chrome at a glance. The runtime
 * seeds the name + color into the profile's Local State / Preferences before launch
 * (decoration re-checks the desired name every launch, so a profile dir carried over
 * with an old display name self-heals to "Cindy" on first run).
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
const MANAGED_CDP_PORT = 18800;

/**
 * Default ("managed") config: a single playwright-launched Chrome profile, headed,
 * with a STABLE persistent user-data-dir (logins survive across sessions). This is
 * the product default — a "dedicated persistent login automation browser".
 * (`browser-backend-settings-store` resolves `'external'` as the system default,
 * so this config is what a user who never touched the toggle gets.)
 *
 * SECURITY POSTURE:
 *  - Only the fake-IP ranges used by system proxies are exempted from the SSRF
 *    guard. This prevents Surge/Clash/sing-box DNS answers (198.18.0.0/15 or
 *    IPv6 ULA) from making ordinary public sites look like SSRF attempts while
 *    localhost, RFC1918, metadata, link-local, and other special-use addresses
 *    remain blocked.
 *  - Page-context `evaluate` (and recipe `evaluate` steps) run author/agent JS in
 *    Chromium, whose network stack is NOT subject to the Node SSRF guard — a
 *    same-origin `fetch` there can reach any host the browser can. This residual
 *    surface is accepted as inherent to browser automation (it's the same
 *    capability the `act:evaluate` tool already exposes), not a regression.
 */
export function buildManagedConfig(): BrowserRuntimeConfig {
  return {
    browser: {
      enabled: true,
      defaultProfile: MANAGED_PROFILE,
      headless: false, // headed so the user can see + log into sites
      ssrfPolicy: {
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      },
      profiles: {
        [MANAGED_PROFILE]: {
          driver: MANAGED_DRIVER,
          color: DEFAULT_PROFILE_COLOR,
          cdpPort: MANAGED_CDP_PORT,
        },
      },
    },
  };
}
