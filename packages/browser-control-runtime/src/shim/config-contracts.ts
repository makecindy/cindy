/**
 * Shim: openclaw/plugin-sdk/config-contracts.
 *
 * BrowserConfig / BrowserProfileConfig are ported from upstream
 * `config/types.browser.ts` (self-contained type-only). `displayName` is a
 * host-only extension: the map key stays the on-disk folder. OpenClawConfig is
 * the app root config in upstream; the browser core only ever reads its
 * `browser` slice, so we model it as a minimal envelope carrying that slice.
 */
export type { BrowserConfig, BrowserProfileConfig } from './_local/config-types-browser.js';
import type { BrowserConfig } from './_local/config-types-browser.js';

/** Gateway auth/tailscale slice consumed by control-auth. */
export type GatewayAuthConfig = {
  token?: string;
  password?: string;
  mode?: 'none' | 'token' | 'password' | 'trusted-proxy';
  [key: string]: unknown;
};
export type GatewayConfigSlice = {
  port?: number;
  auth?: GatewayAuthConfig;
  tailscale?: { mode?: string; [key: string]: unknown };
  [key: string]: unknown;
};

/** Minimal root-config envelope: the slices the browser core reads. */
export type OpenClawConfig = {
  browser?: BrowserConfig;
  gateway?: GatewayConfigSlice;
  plugins?: Record<string, unknown>;
  [key: string]: unknown;
};
