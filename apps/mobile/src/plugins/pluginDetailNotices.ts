import type { PluginDetailModel } from "./pluginDetailModel";
/** Status belongs to the smallest surface it blocks; independent scopes can coexist. */
export function pluginDetailNotices(model: PluginDetailModel) {
  const fresh = !["offline", "loadFailed", "loading"].includes(
    model.status ?? "",
  );
  const top = ["offline", "loadFailed", "retired", "approvalRequired"].includes(
    model.status ?? "",
  )
    ? model.status === "approvalRequired" && model.builtin
      ? "builtinRecovery"
      : model.status
    : fresh && model.runtimeIssue === "fused"
      ? "fused"
      : undefined;
  return { top, loading: model.status === "loading" };
}
