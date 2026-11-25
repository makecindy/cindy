import { pluginSourceWarningKey } from '@cindy/maker-shared/mcp-apps';
import type {
  PluginManagementReceipt,
  PluginPermissionItem,
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

/** Same rule as the computer's ghostInstallSourceNoticeKey; shown for new installs only, as on the computer. */
function sourceNotice(consent: Consent, t: Translate): string | undefined {
  if (consent.facts.kind !== "install") return undefined;
  if (consent.origin === "market" && consent.communityMarket === true) return t("plugins.notice.sourceNotice.community");
  if (consent.origin === "custom-market") return t("plugins.notice.sourceNotice.customMarket");
  if (consent.origin === "local-file") return t("plugins.notice.sourceNotice.localFile");
  return undefined;
}

export function pluginConsentPresentation(consent: Consent, t: Translate, deviceName?: string) {
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
  const permissions = (items: PluginPermissionItem[], prefix = "", pinned = true) =>
    items.map((item) => ({
      title:
        (prefix ? t("plugins.management.permissions." + prefix) + " · " : "") +
        t("plugins.management.permissions." + item.labelKey, {
          ...item.labelArgs,
          defaultValue: item.kind,
        }),
      // A pinned item's explanation is shown above the buttons; the row keeps only its title.
      detail: pinned && isPinnedHighRiskPermission(item) ? "" : detailOf(item),
    }));
  // New installs list every declared permission; updates only the added ones (removed ones carry no risk).
  const granted = facts.kind === "install" ? facts.permissions : facts.added;
  const highRiskFirst = (items: PluginPermissionItem[]) =>
    [...items.filter(isPinnedHighRiskPermission), ...items.filter((item) => !isPinnedHighRiskPermission(item))];
  const titleOf = (item: PluginPermissionItem) => t("plugins.management.permissions." + item.labelKey, {
    ...item.labelArgs,
    defaultValue: item.kind,
  });
  const highRisk = granted.filter(isPinnedHighRiskPermission).map((item) => ({ title: titleOf(item), detail: detailOf(item) }));
  return {
    title: facts.name + " · " + facts.version,
    /** New installs say where the plugin goes; updates keep the computer name only. */
    device: deviceName
      ? facts.kind === "install" ? t("plugins.market.installTo", { device: deviceName }) : deviceName
      : undefined,
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
            previous: facts.previousVersion,
            next: facts.version,
          })
        : undefined,
    permissions:
      facts.kind === "install"
        ? permissions(highRiskFirst(facts.permissions))
        : [
            ...permissions(highRiskFirst(facts.added), "added"),
            ...permissions(facts.removed, "removed", false),
          ],
    /** Pinned above the confirm buttons, outside the scroll area, so it is read before allowing. */
    highRisk: highRisk.length ? highRisk : undefined,
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
