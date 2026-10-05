import { randomUUID } from 'node:crypto';

import { normalizeAccountRateLimitSnapshot } from '@cindy/maker-core';
import type {
  AccountRateLimitWindow,
  AccountRateLimitResetCredit,
  AccountRateLimitSnapshot,
  AccountRateLimitsResponse,
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
} from '@cindy/maker-core';
import type {
  MobileCodexRateLimitAccount,
  MobileCodexRateLimitResetCredit,
  MobileCodexRateLimitResetResult,
  MobileCodexRateLimitsResult,
} from '@cindy/maker-shared/device-link-contract';

const RESET_OFFER_TTL_MS = 10 * 60 * 1000;
const MAX_RESET_OFFERS = 64;

/** Raw account identity used only to bind one reset offer to the active workspace. */
export interface CodexRateLimitAccountIdentity {
  email: string | null;
  accountId: string | null;
}

/** Host callbacks required by the Codex reset-credit control-plane service. */
export interface CodexRateLimitResetServiceDeps {
  readRateLimits(): Promise<AccountRateLimitsResponse>;
  consumeResetCredit(
    params: ConsumeAccountRateLimitResetCreditParams,
  ): Promise<ConsumeAccountRateLimitResetCreditResponse>;
  readAccountIdentity(): Promise<CodexRateLimitAccountIdentity>;
  recordRateLimitSnapshot(snapshot: unknown): Promise<void>;
  now?: () => number;
  createIdempotencyKey?: () => string;
}

/** Read/consume façade exposed to IPC; one instance owns the bounded offer registry. */
export interface CodexRateLimitResetService {
  read(): Promise<MobileCodexRateLimitsResult>;
  consume(idempotencyKey: string): Promise<MobileCodexRateLimitResetResult>;
}

export type CodexRateLimitResetRejection = 'OFFER_EXPIRED' | 'ACCOUNT_CHANGED';

/** Expected reset rejection that the IPC boundary must expose as a stable precondition error. */
export class CodexRateLimitResetRejectedError extends Error {
  constructor(
    readonly reason: CodexRateLimitResetRejection,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRateLimitResetRejectedError';
  }
}

/** In-memory state for one retryable reset attempt. */
interface ResetOfferEntry {
  account: CodexRateLimitAccountIdentity;
  creditId: string | null;
  creditExpiresAt: number | null;
  validUntil: number;
  /** True once a backend consume may have happened; freezes retry parameters for idempotency. */
  attempted: boolean;
  settled: boolean;
  pending: Promise<MobileCodexRateLimitResetResult> | null;
  result: MobileCodexRateLimitResetResult | null;
}

/** Keep only the minimum account identity needed for a user-verifiable mobile label. */
function displayAccount(
  identity: CodexRateLimitAccountIdentity,
  planType: string | null,
): MobileCodexRateLimitAccount {
  return {
    email: maskEmail(identity.email),
    accountId: maskAccountId(identity.accountId),
    planType,
  };
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${email.slice(at)}`;
}

function maskAccountId(accountId: string | null): string | null {
  if (!accountId) return null;
  return `…${accountId.slice(-6)}`;
}

function canBindResetOffer(identity: CodexRateLimitAccountIdentity): boolean {
  // Both labels are required: the same email can belong to multiple ChatGPT workspaces.
  return Boolean(identity.email && identity.accountId);
}

function sameAccount(
  expected: CodexRateLimitAccountIdentity,
  current: CodexRateLimitAccountIdentity,
): boolean {
  return expected.email === current.email && expected.accountId === current.accountId;
}

function normalizeAvailableCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

function availableResetCredits(
  response: AccountRateLimitsResponse,
): AccountRateLimitResetCredit[] | null {
  const credits = response.rateLimitResetCredits?.credits;
  if (credits === null || credits === undefined) return null;
  return credits.map((credit) => ({ ...credit }));
}

function displayResetCredits(
  credits: readonly AccountRateLimitResetCredit[] | null,
): MobileCodexRateLimitResetCredit[] | null {
  if (!credits) return null;
  return credits.map((credit) => ({
    status: credit.status,
    resetType: credit.resetType,
    grantedAt: credit.grantedAt,
    expiresAt: credit.expiresAt,
    title: credit.title,
    description: credit.description,
  }));
}

function displayRateLimitSnapshot(
  snapshot: AccountRateLimitSnapshot,
): MobileCodexRateLimitsResult['rateLimits'] {
  return {
    limitId: snapshot.limitId,
    limitName: snapshot.limitName,
    primary: displayRateLimitWindow(snapshot.primary),
    secondary: displayRateLimitWindow(snapshot.secondary),
    planType: snapshot.planType,
    rateLimitReachedType: snapshot.rateLimitReachedType,
  };
}

function displayRateLimitWindow(
  window: AccountRateLimitWindow | null | undefined,
): MobileCodexRateLimitsResult['rateLimits']['primary'] {
  if (!window) return window;
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes ?? window.windowDurationMins ?? null,
    resetsAt: window.resetsAt,
  };
}

function displayRateLimitsById(
  snapshots: AccountRateLimitsResponse['rateLimitsByLimitId'],
): MobileCodexRateLimitsResult['rateLimitsByLimitId'] {
  if (!snapshots) return null;
  return Object.fromEntries(
    Object.entries(snapshots).map(([id, snapshot]) => [id, displayRateLimitSnapshot(snapshot)]),
  );
}

function selectEarliestExpiringCredit(
  credits: readonly AccountRateLimitResetCredit[] | null,
): AccountRateLimitResetCredit | null {
  if (!credits) return null;
  return credits
    .filter((credit) => (
      credit.status === 'available'
      && credit.resetType === 'codexRateLimits'
      && typeof credit.id === 'string'
      && credit.id.trim().length > 0
    ))
    .sort((a, b) => {
      const aExpiry = a.expiresAt ?? Number.POSITIVE_INFINITY;
      const bExpiry = b.expiresAt ?? Number.POSITIVE_INFINITY;
      if (aExpiry !== bExpiry) return aExpiry - bExpiry;
      return a.grantedAt - b.grantedAt;
    })[0] ?? null;
}

/**
 * Build the desktop-owned reset control plane.
 *
 * Mobile never chooses a credit directly. A read creates a short-lived, account-bound UUID;
 * retries reuse that UUID, and completed outcomes stay cached until the offer expires.
 */
export function createCodexRateLimitResetService(
  deps: CodexRateLimitResetServiceDeps,
): CodexRateLimitResetService {
  const now = deps.now ?? Date.now;
  const createIdempotencyKey = deps.createIdempotencyKey ?? randomUUID;
  const offers = new Map<string, ResetOfferEntry>();

  const pruneOffers = (): void => {
    const current = now();
    for (const [key, offer] of offers) {
      if (!offer.pending && offer.validUntil <= current) offers.delete(key);
    }
    for (const [key, offer] of offers) {
      if (offers.size < MAX_RESET_OFFERS) break;
      // Keep both an in-flight redemption and its cached terminal result addressable
      // for the full TTL. The registry may temporarily exceed the soft limit when every
      // retained offer is still required for an idempotent retry.
      if (offer.pending || offer.attempted || offer.result) continue;
      offers.delete(key);
    }
  };

  const read = async (): Promise<MobileCodexRateLimitsResult> => {
    pruneOffers();
    // Auth may be replaced while app-server is answering. Bracket the RPC with identity
    // reads so an old-account snapshot can never be labelled or offered as the new account.
    const identityBeforeRead = await deps.readAccountIdentity();
    const response = await deps.readRateLimits();
    const identity = await deps.readAccountIdentity();
    if (!sameAccount(identityBeforeRead, identity)) {
      throw new CodexRateLimitResetRejectedError(
        'ACCOUNT_CHANGED',
        'Codex account changed while reading rate limits; retry after the account settles',
      );
    }
    const accountId = identity.accountId;
    const normalizedRateLimits = normalizeAccountRateLimitSnapshot(response.rateLimits);
    const mobileRateLimits = displayRateLimitSnapshot(normalizedRateLimits);
    // The persisted broadcaster merges absent fields with the previous snapshot. Never feed
    // it an unbound app-server read, or a workspace switch can inherit the old account id.
    if (accountId) {
      await deps.recordRateLimitSnapshot({
        ...normalizedRateLimits,
        source: 'codex-app-server',
        updatedAt: now(),
        accountId,
      });
    }

    const availableCount = normalizeAvailableCount(
      response.rateLimitResetCredits?.availableCount ?? 0,
    );
    const credits = availableResetCredits(response);
    const selectedCredit = selectEarliestExpiringCredit(credits);
    let resetOffer: MobileCodexRateLimitsResult['resetOffer'] = null;
    // Detailed rows must contain an eligible Codex credit. Count-only responses may still
    // mint an offer because app-server officially supports backend credit selection.
    const hasEligibleCredit = credits === null || selectedCredit !== null;
    let existing = [...offers.entries()].find(([, offer]) => (
      !offer.settled && sameAccount(offer.account, identity)
    ));
    if (existing && (existing[1].pending || existing[1].attempted)) {
      // A backend consume may already have happened. Return the frozen offer even when the
      // refreshed count/credit rows changed, so Mobile can safely recover an ambiguous result.
      resetOffer = {
        idempotencyKey: existing[0],
        expiresAt: existing[1].creditExpiresAt,
        validUntil: existing[1].validUntil,
      };
    } else if (availableCount > 0 && hasEligibleCredit && canBindResetOffer(identity)) {
      const selectedCreditId = selectedCredit?.id ?? null;
      const selectedCreditExpiresAt = selectedCredit?.expiresAt ?? null;
      // Before any consume starts, a fresh authoritative read may replace a stale detailed
      // credit (expired/redeemed elsewhere). Once a consume is pending or ambiguous, freeze
      // both the backend idempotency key and credit parameters until the offer TTL ends.
      if (existing && !existing[1].pending && !existing[1].attempted
        && (existing[1].creditId !== selectedCreditId
          || existing[1].creditExpiresAt !== selectedCreditExpiresAt)) {
        offers.delete(existing[0]);
        existing = undefined;
      }
      const idempotencyKey = existing?.[0] ?? createIdempotencyKey();
      const entry = existing?.[1] ?? {
        account: identity,
        creditId: selectedCreditId,
        creditExpiresAt: selectedCreditExpiresAt,
        validUntil: now() + RESET_OFFER_TTL_MS,
        attempted: false,
        settled: false,
        pending: null,
        result: null,
      };
      if (!existing) offers.set(idempotencyKey, entry);
      resetOffer = {
        idempotencyKey,
        expiresAt: entry.creditExpiresAt,
        validUntil: entry.validUntil,
      };
    } else if (existing) {
      // No consume started and the authoritative read no longer offers this credit.
      offers.delete(existing[0]);
    }

    return {
      account: displayAccount(identity, response.rateLimits.planType ?? null),
      rateLimits: mobileRateLimits,
      rateLimitsByLimitId: displayRateLimitsById(response.rateLimitsByLimitId),
      rateLimitResetCredits: response.rateLimitResetCredits
        ? { availableCount, credits: displayResetCredits(credits) }
        : null,
      resetOffer,
    };
  };

  const consume = async (idempotencyKey: string): Promise<MobileCodexRateLimitResetResult> => {
    pruneOffers();
    const offer = offers.get(idempotencyKey);
    if (!offer) {
      throw new CodexRateLimitResetRejectedError(
        'OFFER_EXPIRED',
        'Codex reset offer expired; refresh usage before retrying',
      );
    }
    if (offer.result) {
      const currentAccount = await deps.readAccountIdentity();
      if (!sameAccount(offer.account, currentAccount)) {
        throw new CodexRateLimitResetRejectedError(
          'ACCOUNT_CHANGED',
          'Codex account changed; refresh usage before reading the reset result',
        );
      }
      return offer.result;
    }
    if (offer.pending) return await offer.pending;

    const run = (async (): Promise<MobileCodexRateLimitResetResult> => {
      // Identity verification belongs inside the shared promise. Otherwise two clicks can
      // both pass the preflight await before offer.pending is installed and redeem twice.
      const currentAccount = await deps.readAccountIdentity();
      if (!sameAccount(offer.account, currentAccount)) {
        throw new CodexRateLimitResetRejectedError(
          'ACCOUNT_CHANGED',
          'Codex account changed; refresh usage before resetting',
        );
      }
      // From this point a transport failure is ambiguous: the backend may have consumed the
      // credit. Every later read/retry must keep this exact key + credit selection.
      offer.attempted = true;
      const response = await deps.consumeResetCredit({
        idempotencyKey,
        ...(offer.creditId ? { creditId: offer.creditId } : {}),
      });
      // Mark the attempt settled before refreshing. That refresh may expose another
      // available credit and must receive a fresh idempotency key, while concurrent
      // retries of this attempt still join offer.pending until the final result is ready.
      offer.settled = true;
      let accountAfterConsume: CodexRateLimitAccountIdentity;
      try {
        accountAfterConsume = await deps.readAccountIdentity();
      } catch {
        offers.delete(idempotencyKey);
        throw new CodexRateLimitResetRejectedError(
          'ACCOUNT_CHANGED',
          'Could not verify the Codex account after resetting; refresh usage before continuing',
        );
      }
      if (!sameAccount(offer.account, accountAfterConsume)) {
        // Never let this key run again after a terminal backend response under an account
        // transition. Mobile must refresh and obtain an offer bound to the current workspace.
        offers.delete(idempotencyKey);
        throw new CodexRateLimitResetRejectedError(
          'ACCOUNT_CHANGED',
          'Codex account changed while resetting; refresh usage before continuing',
        );
      }
      let rateLimits: MobileCodexRateLimitsResult | null = null;
      try {
        rateLimits = await read();
      } catch {
        // The reset outcome is authoritative. A failed refresh must not turn a completed
        // redemption into an ambiguous retry with a different idempotency key.
      }
      const result = { outcome: response.outcome, rateLimits };
      offer.result = result;
      return result;
    })();
    offer.pending = run;
    try {
      return await run;
    } finally {
      offer.pending = null;
    }
  };

  return { read, consume };
}
