/**
 * Magpie upstream quota wire contract, shared by the reader (main) and tests.
 *
 * Pure: types and validation only, no I/O and no imports from main. Magpie is a local
 * gateway; `GET <origin>/v1/magpie/quotas` returns every upstream account it serves in
 * one envelope. Cindy never persists or displays the upstream `user` (email) or `error`
 * strings — account ids are hashed and errors surface only as status codes.
 */

/** One quota window as Magpie reports it. `used`/`remaining` are percentages. */
export interface MagpieQuotaWindowRaw {
  name?: unknown;
  used?: unknown;
  remaining?: unknown;
  /** ISO timestamp with offset. */
  resetsAt?: unknown;
  /** Upstream's own amount text, e.g. "318.78 / 500"; detail facts only. */
  display?: unknown;
  amount?: unknown;
  limit?: unknown;
  unit?: unknown;
  unlimited?: unknown;
  /** Marks a model-family (pool) window rather than an account-wide limit. */
  pool?: unknown;
}

/** One upstream account as Magpie reports it. No stable id exists; Cindy derives one. */
export interface MagpieQuotaAccountRaw {
  provider?: unknown;
  name?: unknown;
  kind?: unknown;
  plan?: unknown;
  /** Upstream account email; never stored, never displayed, only hashed into the id. */
  user?: unknown;
  alias?: unknown;
  from?: unknown;
  balance?: unknown;
  until?: unknown;
  /** Present when the upstream account failed to read (e.g. signed out). */
  error?: unknown;
  asOf?: unknown;
  readAt?: unknown;
  lastServedAt?: unknown;
  windows?: unknown;
}

export type MagpieQuotaEnvelope =
  | { ok: true; accounts: MagpieQuotaAccountRaw[] }
  | { ok: false; reason: 'malformed' };

/**
 * Validates the `{object:"list", data:[…]}` envelope. `malformed` means the origin is
 * not a Magpie gateway (the caller memoizes that).
 */
export function parseMagpieQuotaEnvelope(json: unknown): MagpieQuotaEnvelope {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'malformed' };
  const envelope = json as Record<string, unknown>;
  if (envelope.object !== 'list' || !Array.isArray(envelope.data)) return { ok: false, reason: 'malformed' };
  const accounts = envelope.data.filter(
    (entry): entry is MagpieQuotaAccountRaw => !!entry && typeof entry === 'object' && !Array.isArray(entry),
  );
  return { ok: true, accounts };
}

/** A window mapped to the menu bar's window shape (structurally a `MenubarWindowInput`). */
export interface MagpieQuotaWindow {
  /** 'named' keeps Magpie's label verbatim ("Credits", model-family names). */
  kind: 'session' | 'week' | 'named' | 'scoped';
  label: string | null;
  /** Upstream amount text for the detail facts; never rendered as a Cindy number. */
  display: string | null;
  /** 0...100 used. */
  usedPercent: number;
  resetsAtMs: number | null;
  windowMinutes: number;
}

export type MagpieQuotaAccountStatus = 'ok' | 'needs-sign-in' | 'no-windows';

/** One mapped Magpie account, ready to become a menu bar source (logo added there). */
export interface MagpieQuotaAccount {
  kind: 'magpie';
  /** `magpie:${providerId}:${hash}`; stable across reads and list reorders. */
  id: string;
  /** Cindy provider id of the Magpie connection; the detail action target. */
  providerId: string;
  /** Upstream provider slug verbatim ("claude", "qwenwork"); drives the brand and logo. */
  provider: string;
  /** Account display name; masked by settings.privacy like a handle. */
  name: string;
  plan: string | null;
  windows: MagpieQuotaWindow[];
  /** Accounts with no windows: the upstream `balance` verbatim, for detail facts only. */
  balanceText: string | null;
  status: MagpieQuotaAccountStatus;
  /** max(asOf, readAt) when Magpie reported either. */
  observedAtMs: number | null;
  /** Last good read when the gateway is unreachable now. */
  staleAtMs: number | null;
}
