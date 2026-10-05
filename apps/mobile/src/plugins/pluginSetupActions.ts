import {
  parsePluginOauthAction,
  parsePluginSecretPresentation,
  parsePluginConnectionPresentation,
  type PluginOauthAction,
  type PluginSecretPresentation,
  type PluginConnectionPresentation,
} from "@cindy/device-link";
export interface MobilePluginSetupAction {
  action: PluginOauthAction;
  ghostId: string;
  stepId: string;
  title: string;
  kind: "oauth" | "secret" | "connection";
  secret?: PluginSecretPresentation;
  connection?: PluginConnectionPresentation;
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
/** Only projected eligible pending Host steps. The encrypted offer must match what the native form shows. */
export function mobilePluginSetupActions(
  raw: unknown,
): MobilePluginSetupAction[] {
  const r = record(raw),
    ghost = record(r.ghost);
  if (
    r.kind !== "plugin_setup" ||
    r.terminal ||
    typeof ghost.id !== "string" ||
    typeof ghost.name !== "string" ||
    !Array.isArray(r.steps)
  )
    return [];
  return r.steps.flatMap<MobilePluginSetupAction>((step, index) => {
    const s = record(step),
      a = record(s.action);
    const action = parsePluginOauthAction({
      requestId: r.requestId,
      expectedRevision: r.revision,
      actionId: a.id,
    });
    if (
      !action ||
      !["pending", "failed"].includes(s.phase as string) ||
      typeof s.title !== "string" ||
      typeof s.description !== "string"
    )
      return [];
    const base = {
      action,
      ghostId: ghost.id as string,
      title: s.title,
      stepId:
        typeof s.id === "string" && s.id.trim() ? s.id.trim() : `step-${index}`,
    };
    try {
      if (a.kind === "oauth_connect" && r.remoteOauth === true)
        return [{ ...base, kind: "oauth" as const }];
      if (a.kind === "inline_form" && r.remoteSecret === true) {
        const fields = record(a.form).fields;
        if (!Array.isArray(fields) || fields.length !== 1) return [];
        const field = record(fields[0]);
        const secret = parsePluginSecretPresentation({
          ghostName: ghost.name,
          title: s.title,
          description: s.description,
          intro: r.intro ?? "",
          fieldLabel: field.label,
          fieldDescription: field.description ?? "",
          maxLength: field.maxLength,
        });
        return [{ ...base, kind: "secret" as const, secret }];
      }
      if (
        a.kind === "manage_connection" &&
        r.remoteConnection === true &&
        action.actionId.startsWith("manage_connection:connection:")
      ) {
        const connection = parsePluginConnectionPresentation({
          ghostName: ghost.name,
          title: s.title,
          description: s.description,
          intro: r.intro ?? "",
          connectionKey: action.actionId.slice(
            "manage_connection:connection:".length,
          ),
        });
        return [{ ...base, kind: "connection" as const, connection }];
      }
    } catch {
      /* Invalid/unsupported steps retain the existing computer entry. */
    }
    return [];
  });
}
