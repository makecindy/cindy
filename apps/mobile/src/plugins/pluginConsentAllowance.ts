import { isPluginMarketSourceIdentity, samePluginMarketSourceIdentity, type ManagedMarketItem, type PluginManagementReceipt,
  type PluginMarketSourceIdentity } from "./pluginManagementTypes";

/**
 * What the phone asked for when it started an operation that may stop at a consent (dispatcher O-4): kept by the
 * controller from the person's choice, and compared with what the consent declares before Allow can be tapped and again
 * right before the answer is written. Null when the phone chose nothing (an Agent task card, a prompt started elsewhere).
 */
export type PluginConsentExpectation =
  | { kind: "install" | "update"; deviceId: string; pluginId: string; ghostId: string; version: string; releaseId: string;
      sourceType: ManagedMarketItem["sourceType"]; source: PluginMarketSourceIdentity | null }
  | { kind: "ui-capability"; deviceId: string; ghostId: string; version: string };

/** What one consent declares, from a confirmation receipt or an Agent task card, and the computer it came from. */
export interface DeclaredPluginConsent {
  deviceId: string;
  ghostId?: string;
  version?: string;
  kind?: "install" | "update";
  purpose?: "task-capability" | "ui-capability";
  /** Absent: an older Host's task card. */
  origin?: "market" | "custom-market" | "local-file" | "forge";
  /** Custom markets: the source it packs from; `sourceMalformed` when one was given but is not a valid identity. */
  source?: PluginMarketSourceIdentity;
  sourceMalformed?: boolean;
  originSourceChanged?: boolean;
}

/**
 * `allow`: Allow may be tapped and written; `sourceSwitch` when it is the Host's source switch (contract V2.4b: shown like
 * a first install, with the switch sentence). Otherwise only Reject (or the computer): `source-unverified` (a custom
 * market not naming a valid source, or an older Host's first-install card), `source-changed` (another source or source
 * type than the one chosen: choose again), `changed` (another plugin, version, kind or computer than the one chosen).
 */
export type PluginConsentAllowance =
  | { allow: true; sourceSwitch: boolean }
  | { allow: false; reason: "source-unverified" | "source-changed" | "changed"; field?: keyof DeclaredPluginConsent | "sourceType" };

const ORIGIN_OF: Record<ManagedMarketItem["sourceType"], DeclaredPluginConsent["origin"]> = {
  server: "market", "git-market": "custom-market", "local-market": "custom-market",
};
const SOURCE_KIND_OF: Partial<Record<ManagedMarketItem["sourceType"], PluginMarketSourceIdentity["kind"]>> = {
  "git-market": "git", "local-market": "local",
};

/**
 * The one decision whether a plugin consent can be allowed on this phone (dispatcher O-4), for every place one is shown:
 * the confirmation sheet's Allow (first display, after a reconnect, after a remount, "View and decide" in the list of
 * checks), the controller right before it writes an Allow, and the Agent task card. Field table:
 * docs/dev-rules/plugin-mobile-implementation.md, "确认能否允许的判据".
 *
 * Declaration rules, with or without an expectation (contract V2.5): a custom-market consent must name a valid source;
 * an older Host's first-install task card (no origin) cannot say where it comes from.
 * With an expectation, every field the consent declares must equal what was chosen: the computer, the plugin (ghostId),
 * the version, the kind (an update may come back as a first install only as the Host's source switch,
 * `originSourceChanged`), the source type (server market ⇔ `market`, a custom market ⇔ `custom-market` with a source of
 * the same kind) and the full source identity (all four keys). The market item id and release id are not declared by a
 * consent; the plugin, version and source stand for them. Only `originSourceChanged` takes the switch flow; any other
 * difference is never allowed here.
 */
export function pluginConsentAllowance(expected: PluginConsentExpectation | null, declared: DeclaredPluginConsent): PluginConsentAllowance {
  const custom = declared.origin === "custom-market";
  if (custom && (!declared.source || declared.sourceMalformed)) return { allow: false, reason: "source-unverified", field: "source" };
  if (!expected) {
    if (declared.kind === "install" && declared.origin === undefined && declared.purpose === undefined)
      return { allow: false, reason: "source-unverified", field: "origin" };
    return { allow: true, sourceSwitch: declared.originSourceChanged === true };
  }
  if (declared.deviceId !== expected.deviceId) return { allow: false, reason: "changed", field: "deviceId" };
  if (declared.ghostId !== expected.ghostId) return { allow: false, reason: "changed", field: "ghostId" };
  if (declared.version !== expected.version) return { allow: false, reason: "changed", field: "version" };
  if (expected.kind === "ui-capability") {
    return declared.purpose === "ui-capability" ? { allow: true, sourceSwitch: false } : { allow: false, reason: "changed", field: "purpose" };
  }
  if (declared.purpose === "ui-capability") return { allow: false, reason: "changed", field: "purpose" };
  const switching = declared.originSourceChanged === true;
  const kindMatches = expected.kind === "install" ? declared.kind === "install" && !switching
    : declared.kind === "update" ? !switching : declared.kind === "install" && switching;
  if (!kindMatches) return { allow: false, reason: "changed", field: "kind" };
  if (declared.origin !== ORIGIN_OF[expected.sourceType]) return { allow: false, reason: "source-changed", field: "sourceType" };
  const sourceKind = SOURCE_KIND_OF[expected.sourceType];
  if (sourceKind) {
    if (!expected.source || expected.source.kind !== sourceKind) return { allow: false, reason: "source-unverified", field: "source" };
    if (declared.source?.kind !== sourceKind) return { allow: false, reason: "source-changed", field: "sourceType" };
    if (!samePluginMarketSourceIdentity(declared.source, expected.source)) return { allow: false, reason: "source-changed", field: "source" };
  }
  return { allow: true, sourceSwitch: switching };
}

/** What a confirmation receipt's consent declares, read from the computer `deviceId`. */
export function declaredPluginConsent(consent: NonNullable<PluginManagementReceipt["consent"]>, deviceId: string): DeclaredPluginConsent {
  return { deviceId, ghostId: consent.facts.ghostId, version: consent.facts.version, kind: consent.facts.kind,
    purpose: consent.purpose, origin: consent.origin, source: consent.originSource,
    originSourceChanged: consent.originSourceChanged === true };
}

/** What an Agent's plugin install task card declares (`cindy.plugin.install`, contract V2.4 item 3), on `deviceId`. */
export function declaredTaskCardConsent(input: unknown, deviceId: string): DeclaredPluginConsent {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const origin = raw.origin === "market" || raw.origin === "custom-market" || raw.origin === "local-file" || raw.origin === "forge"
    ? raw.origin : undefined;
  return { deviceId,
    ghostId: typeof raw.ghost_id === "string" ? raw.ghost_id : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
    kind: raw.operation === "install" || raw.operation === "update" ? raw.operation : undefined,
    origin,
    ...(isPluginMarketSourceIdentity(raw.source) ? { source: raw.source } : raw.source !== undefined ? { sourceMalformed: true } : {}),
    originSourceChanged: raw.originSourceChanged === true };
}
