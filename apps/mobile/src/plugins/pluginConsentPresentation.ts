import { declaredPluginConsent, pluginConsentAllowance, type PluginConsentAllowance } from "./pluginConsentAllowance";
import { pluginSourceWarningKey } from '@cindy/maker-shared/mcp-apps';
import { formatPluginVersion } from './pluginMarketCatalog';
import {
  samePluginMarketSourceIdentity,
  type PluginManagementReceipt,
  type PluginMarketSourceIdentity,
  type PluginPermissionItem,
} from "./pluginManagementTypes";

type Consent = NonNullable<PluginManagementReceipt["consent"]>;
type Translate = (key: string, args?: Record<string, unknown>) => string;

/**
 * Permissions the phone pins above the confirm buttons, outside the scroll area.
 *
 * Not a phone-side grading: these are the Host permission items the Host itself treats as high risk
 * (stable diff keys from ghostPermissionItems).
 * - `node:execute`: its user-facing detail begins with "High risk: …".
 * - `node:secret:<binding>`: a saved credential handed to the Node program in plain text.
 * - `node:resident`: the Node program keeps running.
 * - `agent:background`: starts Agent turns without a click.
 * - `agent:errand`: hands tasks to an Agent and reads the result.
 * The last four are called high-risk add-ons in the Host's source, and maintainers asked for them here.
 * Keys are the signal: label/detail keys are copy that may be reworded, and `kind` covers lower-risk items too.
 */
export function isPinnedHighRiskPermission(item: Pick<PluginPermissionItem, "key">): boolean {
  return item.key === "node:execute" || item.key.startsWith("node:secret:") || item.key === "node:resident"
    || item.key === "agent:background" || item.key === "agent:errand";
}

/**
 * How a confirmation sheet lays out the identity block at the top of the list (name, target computer, source,
 * repository, source notes) and the high-risk summary, from measured content heights and the available height only
 * (one rule for iOS and Android; maintainer reviews of d81200da and 256d5af5):
 * - Regular, when the identity block in full and the summary's heading with its first two items (all, if fewer) fit:
 *   the summary stays pinned above the buttons and gets what is left after the identity block, up to all its items;
 *   items beyond its height scroll inside it.
 * - Compact, otherwise: one scroll area with the identity block, the whole summary and the full permission list, the
 *   buttons fixed below it. No text area gets a fixed height, so none can be squeezed to nothing.
 * The "keep scrolling" hints never take part: they float over the edge of a scroll area (or are not shown), so
 * whether they show cannot change any height, and the mode cannot flip between frames because of them. The sheet
 * plans again whenever the available height or text size changes (rotation, split screen, system text size).
 * `available`: the sheet's height minus its fixed padding, the summary's padding and gaps, and the buttons.
 */
export const PINNED_HIGH_RISK_MIN_HEIGHT = 44;
/** Wide enough for Allow and Reject side by side at any text size (landscape phones, tablets): both sheets. */
export const CONSENT_SIDE_BY_SIDE_MIN_WIDTH = 560;
export interface ConsentSheetMeasures {
  available: number;
  identity: number;
  heading: number;
  /** Each summary item's height, in order (0 = not measured yet), and the gap between items. */
  lines: number[];
  gap: number;
}
export type ConsentSheetPlan =
  /** `guaranteed`: the height of the heading's first two items (all, if fewer), always shown in full. */
  | { mode: "regular"; summaryLines: number; clipped: boolean; guaranteed: number }
  | { mode: "compact" };
/** Height of the text-free fade over a scroll area's lower edge (both sheets). */
export const CONSENT_FADE_HEIGHT = 24;
/**
 * Whether the pinned summary may show its fade (dispatcher N-3): only over items beyond the two it guarantees, so the
 * fade never dims them; when what shows beyond them is shorter than the fade, the scrollbar alone says there is more.
 */
export function consentSummaryFadeAllowed(plan: ConsentSheetPlan): boolean {
  return plan.mode === "regular" && plan.clipped && plan.summaryLines - CONSENT_FADE_HEIGHT >= plan.guaranteed;
}
/**
 * The real-layout check of the regular layout (Android reshoot 2026-11-26), both sheets: the list, as laid out, shows the
 * whole identity block (where it installs, where it comes from) without scrolling, above the fade over its lower edge
 * while it scrolls (`top`: the list's own top padding). Not measured yet (a height of 0) counts as not shown.
 */
export function consentIdentityShown(list: { identity: number; visible: number; content: number; top?: number;
  identityBottom?: number; listBottom?: number }, positions = false): boolean {
  const scrolls = list.content > list.visible + 1;
  const fade = scrolls ? CONSENT_FADE_HEIGHT : 0;
  // iOS (reshoot m2b 2026-11-26): the list's content can start below a top inset (in landscape), so where the block ends
  // is compared with where the list ends, both as laid out, rather than adding heights from the list's top.
  if (positions) return (list.identityBottom ?? 0) > 0 && (list.listBottom ?? 0) > 0 && list.visible > 0
    && list.identityBottom! + fade <= list.listBottom!;
  if (list.identity <= 0 || list.visible <= 0) return false;
  return (list.top ?? 0) + list.identity + fade <= list.visible;
}
/**
 * One consent's sheet as laid out (maintainer review 18:13): every size the decision reads, all reported by that
 * consent's own sheet at this window size and text size (`for`: `consentLayoutKey`); 0 = not reported yet. Another
 * consent, a rotation or another text size starts from nothing.
 */
export interface ConsentSheetSizes {
  for: string | null;
  identity: number; heading: number; actions: number;
  /** Each summary item's height, in order. */
  lines: number[];
  /** The list's visible height and its content height. */
  visible: number; content: number;
  /**
   * iOS: where the identity block and the list end on screen (global, the first report for this key: the sheet's views are
   * new for each key and at rest then, so later scrolling or the sheet moving does not change them); 0 = not reported.
   */
  identityBottom: number; listBottom: number;
}
/** The key a consent sheet's sizes and measured views belong to: this consent, at this window size and text size. */
export function consentLayoutKey(requestId: string | undefined, window: { width: number; height: number; fontScale: number }): string | null {
  return requestId ? `${requestId}|${window.width}x${window.height}@${window.fontScale}` : null;
}
export const emptyConsentSheetSizes = (layoutKey: string | null): ConsentSheetSizes =>
  ({ for: layoutKey, identity: 0, heading: 0, actions: 0, lines: [], visible: 0, content: 0, identityBottom: 0, listBottom: 0 });
/** Every size the regular layout's decision needs has been reported for this consent. */
export function consentSheetMeasured(sizes: ConsentSheetSizes, lineCount: number, positions = false): boolean {
  if (sizes.identity <= 0 || sizes.actions <= 0 || sizes.visible <= 0) return false;
  if (positions && (sizes.identityBottom <= 0 || sizes.listBottom <= 0)) return false;
  if (lineCount === 0) return true;
  return sizes.heading > 0 && Array.from({ length: lineCount }, (_, index) => sizes.lines[index] ?? 0).every((line) => line > 0);
}
/**
 * Whether Allow may answer in the regular layout (maintainer review 18:13): this consent's sizes have all arrived, the
 * plan from them is regular, and the list as laid out shows the whole identity block. Anything short of that (first
 * mount, only some sizes, another consent's sizes) is not regular yet.
 */
export function consentRegularConfirmed(sizes: ConsentSheetSizes, sheet: { lineCount: number; available: (actions: number) => number; gap: number;
  top?: number; positions?: boolean }): boolean {
  if (!consentSheetMeasured(sizes, sheet.lineCount, sheet.positions)) return false;
  const plan = planConsentSheet({ available: sheet.available(sizes.actions), identity: sizes.identity, heading: sizes.heading,
    lines: Array.from({ length: sheet.lineCount }, (_, index) => sizes.lines[index] ?? 0), gap: sheet.gap });
  return plan.mode === "regular" && consentIdentityShown({ ...sizes, top: sheet.top }, sheet.positions);
}
export function planConsentSheet(sheet: ConsentSheetMeasures): ConsentSheetPlan {
  if (sheet.lines.length === 0) return { mode: "regular", summaryLines: 0, clipped: false, guaranteed: 0 };
  const available = Math.max(0, Math.floor(sheet.available));
  const measured = sheet.identity > 0 && sheet.heading > 0 && sheet.lines.every((line) => line > 0);
  if (!measured) {
    // First frame, before anything is measured: a conservative share of the sheet, or one scroll area when even that
    // would not hold one line.
    const share = Math.floor(available * 0.25);
    return share >= PINNED_HIGH_RISK_MIN_HEIGHT && share + PINNED_HIGH_RISK_MIN_HEIGHT <= available
      ? { mode: "regular", summaryLines: share, clipped: false, guaranteed: share } : { mode: "compact" };
  }
  const itemsHeight = (count: number) => sheet.lines.slice(0, count).reduce((sum, line) => sum + line, 0)
    + Math.max(0, Math.min(count, sheet.lines.length) - 1) * sheet.gap;
  const full = Math.ceil(itemsHeight(sheet.lines.length));
  const floor = Math.ceil(itemsHeight(Math.min(2, sheet.lines.length)));
  const room = available - Math.ceil(sheet.heading) - Math.ceil(sheet.identity);
  if (room >= full) return { mode: "regular", summaryLines: full, clipped: false, guaranteed: floor };
  // A summary that does not show in full keeps the regular layout only when, below its two guaranteed items, enough of
  // the next one shows for the fade to be drawn over it (dispatcher P-3: at XXXL a third item showing 1 pt looked like the
  // end of the list); otherwise everything goes into one scroll area.
  if (room < floor + sheet.gap + CONSENT_FADE_HEIGHT) return { mode: "compact" };
  return { mode: "regular", summaryLines: Math.floor(room), clipped: true, guaranteed: floor };
}

/** Fixed order of the pinned classes, whatever order the package declares them in. */
const HIGH_RISK_CLASS_ORDER = ["node:execute", "node:secret", "node:resident", "agent:background", "agent:errand"];

/** Same wording as the computer's install dialog (ghostInstallConsentSourceLabel). */
function sourceLabel(consent: Consent, t: Translate): string {
  const origin =
    consent.origin === "market"
      ? t("plugins.notice.consentSource.market")
      : consent.origin === "custom-market"
        ? consent.originLabel
          ? t("plugins.notice.consentSource.customMarket", { name: consent.originLabel })
          : t("plugins.notice.consentSource.customMarketUnnamed")
        : consent.origin === "local-file"
          ? t("plugins.notice.consentSource.localFile")
          : t("plugins.notice.consentSource.forge");
  return consent.initiator === "agent"
    ? t("plugins.notice.consentSource.initiatedByAgent", { origin })
    : origin;
}

/** Custom markets: the repository this install packs from, as the Host generated it (same wording as the computer). */
function repositoryLine(consent: Consent, t: Translate): string | undefined {
  if (consent.origin !== "custom-market") return undefined;
  const source = consent.originSource;
  // No source identity (older Host, or a Git market not refreshed since the Host was updated): neither an install
  // nor an update can be allowed here (see allowBlocked); the line says how to continue on the computer.
  if (!source) return t(consent.facts.kind === "install"
    ? "plugins.notice.consentSource.repositoryMissingInstall"
    : "plugins.notice.consentSource.repositoryMissingUpdate");
  if (source.kind === "local") return t("plugins.notice.consentSource.localFolder");
  return source.ref
    ? t("plugins.notice.consentSource.repositoryRef", { repository: source.repository, ref: source.ref })
    : t("plugins.notice.consentSource.repository", { repository: source.repository });
}

/**
 * Same rule as the computer's ghostInstallSourceChangedNoticeKey (contract V2.4b): a confirmation whose source changed
 * (`originSourceChanged`, confirmed like a first install with the new source's full permissions) says that the old
 * accounts and data are kept apart. A custom market also asks to check the repository shown; a replacement with the
 * plugin market's version uses the sentence without a repository; other origins say nothing.
 */
function sourceChangedNotice(consent: Consent, t: Translate): string | undefined {
  if (consent.originSourceChanged !== true) return undefined;
  if (consent.origin === "market") return t("plugins.notice.consentSource.marketSourceChanged");
  // Only a consent that shows a repository asks to trust "the repository shown above" (#12731 e2fbe72a): a local
  // folder, or a source the phone cannot name, uses the sentence without it.
  if (consent.origin === "custom-market") return t(consent.originSource?.kind === "git"
    ? "plugins.notice.consentSource.originSourceChanged" : "plugins.notice.consentSource.sourceChangedIsolated");
  return undefined;
}

/** Same rule as the computer's ghostInstallSourceNoticeKey; shown for new installs only, as on the computer. */
function sourceNotice(consent: Consent, t: Translate): string | undefined {
  if (consent.facts.kind !== "install") return undefined;
  if (consent.origin === "market" && consent.communityMarket === true) return t("plugins.notice.sourceNotice.community");
  if (consent.origin === "custom-market") return t("plugins.notice.sourceNotice.customMarket");
  if (consent.origin === "local-file") return t("plugins.notice.sourceNotice.localFile");
  return undefined;
}

/**
 * `allowance`: whether this consent can be allowed here (`pluginConsentAllowance`, the controller's
 * `consentAllowance()`: what the person chose against what the consent declares). Without one, only the declaration
 * rules apply (nobody chose it on the phone).
 */
export function pluginConsentPresentation(consent: Consent, t: Translate, deviceName?: string,
  allowance: PluginConsentAllowance = pluginConsentAllowance(null, declaredPluginConsent(consent, ""))) {
  const sourceChanged = !allowance.allow && allowance.reason === "source-changed";
  const facts = consent.facts;
  const detailOf = (item: PluginPermissionItem) =>
    [
      item.detailKey
        ? t("plugins.management.permissions." + item.detailKey, {
            ...item.detailArgs,
            defaultValue: "",
          })
        : "",
      item.detail,
    ]
      .filter(Boolean)
      .join("\n\n");
  const permissions = (items: PluginPermissionItem[], prefix = "") =>
    items.map((item) => ({
      title:
        (prefix ? t("plugins.management.permissions." + prefix) + " · " : "") +
        t("plugins.management.permissions." + item.labelKey, {
          ...item.labelArgs,
          defaultValue: item.kind,
        }),
      // Full explanation stays in the scrolled list (credential names and every allowed method included).
      detail: detailOf(item),
    }));
  // New installs list every declared permission; updates only the added ones (removed ones carry no risk).
  const granted = facts.kind === "install" ? facts.permissions : facts.added;
  const highRiskFirst = (items: PluginPermissionItem[]) =>
    [...items.filter(isPinnedHighRiskPermission), ...items.filter((item) => !isPinnedHighRiskPermission(item))];
  const titleOf = (item: PluginPermissionItem) => t("plugins.management.permissions." + item.labelKey, {
    ...item.labelArgs,
    defaultValue: item.kind,
  });
  // Pinned above the buttons: one short fixed line per high-risk class, in a fixed class order, so its height stays
  // bounded however many bindings or methods a package declares and however long their names are. Credential
  // bindings use a fixed line (one, or a count); the full list is in the scrolled permissions.
  const classOf = (item: PluginPermissionItem) => item.key.startsWith("node:secret:") ? "node:secret" : item.key;
  const pinned = granted.filter(isPinnedHighRiskPermission)
    .sort((a, b) => HIGH_RISK_CLASS_ORDER.indexOf(classOf(a)) - HIGH_RISK_CLASS_ORDER.indexOf(classOf(b)));
  const secretCount = pinned.filter((item) => item.key.startsWith("node:secret:")).length;
  const highRiskLines: string[] = [];
  const seenClasses = new Set<string>();
  for (const item of pinned) {
    const highRiskClass = item.key.startsWith("node:secret:") ? "node:secret" : item.key;
    if (seenClasses.has(highRiskClass)) continue;
    seenClasses.add(highRiskClass);
    // Credential bindings never interpolate the package-declared name here (up to 64 characters, may contain
    // line breaks): a long name could push "to the local Node program" past the two-line cap. The name and the
    // allowed methods stay in the scrolled list.
    highRiskLines.push(highRiskClass !== "node:secret" ? titleOf(item)
      : secretCount > 1 ? t("plugins.management.permissions.nodeSecretCount", { count: secretCount })
        : t("plugins.management.permissions.nodeSecretOne"));
  }
  return {
    title: facts.name + " · " + formatPluginVersion(facts.version),
    /**
     * New installs say where the plugin goes; updates keep the computer name only. A source switch updates the plugin
     * already there (confirmed like a first install), so it keeps the computer name too.
     */
    device: deviceName
      ? facts.kind === "install" && consent.originSourceChanged !== true ? t("plugins.market.installTo", { device: deviceName }) : deviceName
      : undefined,
    /** Shown right under the source line so it stays in view with the pinned summary at the medium detent. */
    repository: repositoryLine(consent, t),
    /**
     * Same sentence as the computer's dialog: this custom-market update comes from another source than the installed one.
     * A source switch is confirmed like a first install (contract V2.4b: full permissions, `facts.kind === "install"`).
     */
    originSourceChanged: sourceChangedNotice(consent, t),
    /**
     * The consent names another source or source type than the one chosen (it changed after the last check), or another
     * plugin, version, kind or computer: choose again, or continue on the computer.
     */
    sourceChanged: sourceChanged ? t("plugins.notice.consentSource.sourceChanged")
      : !allowance.allow && allowance.reason === "changed" ? t("plugins.notice.consentSource.consentChanged") : undefined,
    /**
     * Not allowed here (`pluginConsentAllowance`): a custom market that names no valid source (the phone cannot show
     * what would be allowed), or anything else than what was chosen. Allow stays unavailable; Reject stays available.
     */
    allowBlocked: !allowance.allow,
    identity: facts.ghostId,
    trust: pluginSourceWarningKey(consent.installationSource) ? t(pluginSourceWarningKey(consent.installationSource)!) : undefined,
    origin: [
      sourceLabel(consent, t),
      consent.purpose === "ui-capability" ? t("plugins.uiApproval.purpose")
        : consent.purpose === "task-capability" ? t("plugins.notice.taskCapability") : "",
    ]
      .filter(Boolean)
      .join(" · "),
    sourceNotice: sourceNotice(consent, t),
    version:
      facts.kind === "update"
        ? t("plugins.management.versionChange", {
            previous: formatPluginVersion(facts.previousVersion),
            next: formatPluginVersion(facts.version),
          })
        // A source switch replaces the installed plugin with this version (dispatcher J-4): say which one.
        : consent.originSourceChanged === true ? t("plugins.management.switchVersion", { version: formatPluginVersion(facts.version) })
        : undefined,
    permissions:
      facts.kind === "install"
        ? permissions(highRiskFirst(facts.permissions))
        : [
            ...permissions(highRiskFirst(facts.added), "added"),
            ...permissions(facts.removed, "removed"),
          ],
    /** Pinned above the confirm buttons, outside the scroll area, so it is read before allowing (at most five lines). */
    // The heading says how many classes follow (it wraps rather than truncates; the lines may scroll).
    highRisk: highRiskLines.length ? { title: t("plugins.management.highRiskTitleCount", { title: t("plugins.management.highRiskTitle"),
      count: highRiskLines.length }), lines: highRiskLines } : undefined,
    unchanged:
      facts.kind === "update"
        ? t("plugins.management.permissions.unchanged", {
            count: facts.unchangedCount,
          })
        : undefined,
    oauth:
      facts.kind === "update" && facts.builtinOauthClientChanged
        ? t("plugins.management.oauthChanged")
        : undefined,
  };
}
