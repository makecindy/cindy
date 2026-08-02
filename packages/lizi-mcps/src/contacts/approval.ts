/**
 * Codex ask-mode approval policy for the progressive cindy_contacts MCP surface.
 *
 * Codex only sees the outer `list_tools` / `call_tool` tools. Its approval
 * metadata carries the outer arguments, so this classifier unwraps
 * `call_tool({ name, args })` and only auto-approves known low-risk actions.
 * Unknown or malformed input is deliberately fail-closed: a newly added
 * contacts tool cannot silently inherit the server-level trust allowlist.
 */

export interface ContactsMcpApprovalContext {
  /** Optional top-level name; Codex 0.142.5/0.144.1 generated approvals omit it. */
  toolName?: string;
  /** Top-level MCP tool arguments from Codex `_meta.tool_params`. */
  toolParams?: unknown;
}

const AUTO_APPROVE_INNER_TOOLS = new Set([
  "contacts_resolve",
  "contacts_search",
  "contacts_get",
  "contacts_list",
  "contacts_list_groups",
  "contacts_stats",
  "contacts_create",
  "contacts_update",
  "contacts_add_identity",
  "contacts_append_event",
  "contacts_add_relation",
  "contacts_find_duplicates",
  "contacts_list_pending_system_anchors",
  "contacts_create_group",
  "contacts_update_group",
]);

const ALWAYS_CONFIRM_INNER_TOOLS = new Set([
  "contacts_delete",
  "contacts_merge",
  "contacts_remove_identity",
  "contacts_remove_relation",
  "contacts_delete_group",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Return true only when an cindy_contacts MCP call is safe to auto-approve.
 * False means the existing Codex PermissionPrompt must handle this invocation.
 */
export function canAutoApproveContactsMcpTool(
  context: ContactsMcpApprovalContext,
): boolean {
  if (context.toolName === "list_tools") return true;
  if (context.toolName && context.toolName !== "call_tool") return false;

  // Codex 0.144 includes the complete outer arguments in tool_params but does
  // not always include tool_name. list_tools is annotated read-only and skips
  // approval upstream; any elicitation with the strict {name,args} shape is
  // therefore the contacts call_tool entry. An unexpected shape fails closed.
  const outer = asRecord(context.toolParams);
  const innerName = typeof outer?.name === "string" ? outer.name : null;
  const innerArgs = asRecord(outer?.args);
  if (!innerName || !innerArgs) return false;

  if (AUTO_APPROVE_INNER_TOOLS.has(innerName)) return true;
  if (ALWAYS_CONFIRM_INNER_TOOLS.has(innerName)) return false;

  switch (innerName) {
    // 分组成员调整拆开看: add 是低风险归组; remove 是批量解除成员关系(单次
    // 最多 200 条), 与其它 remove_* 一样逐次确认。remove 形状异常也 fail-closed。
    case "contacts_set_group_members": {
      const remove = innerArgs.remove;
      return remove === undefined || (Array.isArray(remove) && remove.length === 0);
    }
    // Import dry runs are non-mutating but still read data outside the contacts
    // DB boundary (the macOS address book / an arbitrary absolute vCard path)
    // and return counts plus sample names. Enabling Smart Contacts only grants
    // access to the local contacts DB, so external reads prompt on every call,
    // dry_run or not.
    case "contacts_import_system":
    case "contacts_import_vcf":
      return false;
    // Export dry run builds its create/update plan from the local contacts DB
    // only (no system read, no file write) — plan/statistics stay auto.
    case "contacts_export_system":
      return innerArgs.dry_run === true;
    case "contacts_recover_pending_system_anchor":
      // 未确认调用只生成 source→target 审阅计划；confirm:true 会移动/丢弃本机
      // 系统锚点，必须再经过宿主权限确认。
      return innerArgs.confirm !== true;
    case "contacts_export_vcf":
      // No path returns vCard text. Any path writes outside the Codex sandbox;
      // overwrite=true is destructive, while a new path is still an external
      // side effect, so both require per-call confirmation.
      return innerArgs.path === undefined;
    default:
      return false;
  }
}
