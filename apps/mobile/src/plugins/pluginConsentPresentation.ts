import type {
  PluginManagementReceipt,
  PluginPermissionItem,
} from "./pluginManagementTypes";
export function pluginConsentPresentation(
  consent: NonNullable<PluginManagementReceipt["consent"]>,
  t: (key: string, args?: Record<string, unknown>) => string,
) {
  const facts = consent.facts;
  const permissions = (items: PluginPermissionItem[], prefix = "") =>
    items.map((item) => ({
      title:
        (prefix ? t("plugins.management.permissions." + prefix) + " · " : "") +
        t("plugins.management.permissions." + item.labelKey, {
          ...item.labelArgs,
          defaultValue: item.kind,
        }),
      detail: [
        item.detailKey
          ? t("plugins.management.permissions." + item.detailKey, {
              ...item.detailArgs,
              defaultValue: "",
            })
          : "",
        item.detail,
      ]
        .filter(Boolean)
        .join("\n\n"),
    }));
  return {
    title: facts.name + " · " + facts.version,
    identity: facts.ghostId,
    trust: consent.trust ? t("plugins.management.trust." + consent.trust) : undefined,
    origin: [
      t("plugins.notice.consentOrigin." + consent.origin),
      consent.originLabel,
      t("plugins.notice.initiator." + consent.initiator),
      consent.purpose === "ui-capability" ? t("plugins.uiApproval.purpose")
        : consent.purpose === "task-capability" ? t("plugins.notice.taskCapability") : "",
    ]
      .filter(Boolean)
      .join(" · "),
    version:
      facts.kind === "update"
        ? t("plugins.management.versionChange", {
            previous: facts.previousVersion,
            next: facts.version,
          })
        : undefined,
    permissions:
      facts.kind === "install"
        ? permissions(facts.permissions)
        : [
            ...permissions(facts.added, "added"),
            ...permissions(facts.removed, "removed"),
          ],
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
