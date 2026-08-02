import { describe, expect, it } from "vitest";

import { canAutoApproveContactsMcpTool } from "../contacts/approval.js";

const callTool = (name: string, args: Record<string, unknown> = {}) => ({
  toolParams: { name, args },
});

describe("cindy_contacts Codex approval policy", () => {
  it("auto-approves discovery, reads, and ordinary local writes", () => {
    expect(
      canAutoApproveContactsMcpTool({ toolName: "list_tools", toolParams: {} }),
    ).toBe(true);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_search", { query: "Carol" }),
      ),
    ).toBe(true);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_create", {
          kind: "person",
          display_name: "Carol",
        }),
      ),
    ).toBe(true);
  });

  it.each([
    "contacts_delete",
    "contacts_merge",
    "contacts_remove_identity",
    "contacts_remove_relation",
    "contacts_delete_group",
  ])("requires per-call approval for destructive tool %s", (name) => {
    expect(canAutoApproveContactsMcpTool(callTool(name))).toBe(false);
  });

  it("set_group_members: 纯 add 自动放行, 含 remove(批量解除成员)逐次确认", () => {
    // 回归: 曾整体在 auto-approve 名单里, remove 一次最多解除 200 条成员关系
    // 却不弹确认, 与其它 remove_* 的逐次确认口径不一致
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_set_group_members", { group_id: "g1", add: ["c1", "c2"] }),
      ),
    ).toBe(true);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_set_group_members", { group_id: "g1", remove: ["c1"] }),
      ),
    ).toBe(false);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_set_group_members", { group_id: "g1", add: ["c1"], remove: ["c2"] }),
      ),
    ).toBe(false);
    // 空 remove 数组等价于没传; 畸形 remove(非数组)fail-closed
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_set_group_members", { group_id: "g1", add: ["c1"], remove: [] }),
      ),
    ).toBe(true);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_set_group_members", { group_id: "g1", remove: "c1" }),
      ),
    ).toBe(false);
  });

  it("prompts for every import invocation — dry runs still read external data", () => {
    // 回归: dry_run 曾豁免 import 审批, 但 dry run 仍会读系统通讯录 / 任意
    // vCard 路径并返回样本姓名, 自动会话不该未经确认扫描外部数据
    for (const name of ["contacts_import_system", "contacts_import_vcf"]) {
      expect(
        canAutoApproveContactsMcpTool(callTool(name, { dry_run: true })),
      ).toBe(false);
      expect(
        canAutoApproveContactsMcpTool(callTool(name, { dry_run: false })),
      ).toBe(false);
      expect(canAutoApproveContactsMcpTool(callTool(name))).toBe(false);
    }
  });

  it("only auto-approves system-export dry run (plan built from local DB only)", () => {
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_export_system", { dry_run: true }),
      ),
    ).toBe(true);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_export_system", { dry_run: false }),
      ),
    ).toBe(false);
    expect(
      canAutoApproveContactsMcpTool(callTool("contacts_export_system")),
    ).toBe(false);
  });

  it("pending anchor discovery/plan auto-approve, confirmed recovery requires approval", () => {
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_list_pending_system_anchors"),
      ),
    ).toBe(true);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_recover_pending_system_anchor", {
          pending_id: "p1",
          target_id: "c1",
        }),
      ),
    ).toBe(true);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_recover_pending_system_anchor", {
          pending_id: "p1",
          target_id: "c1",
          confirm: true,
        }),
      ),
    ).toBe(false);
  });

  it("requires approval for every vCard file write, including overwrite", () => {
    expect(canAutoApproveContactsMcpTool(callTool("contacts_export_vcf"))).toBe(
      true,
    );
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_export_vcf", {
          path: "/tmp/contacts.vcf",
        }),
      ),
    ).toBe(false);
    expect(
      canAutoApproveContactsMcpTool(
        callTool("contacts_export_vcf", {
          path: "/tmp/contacts.vcf",
          overwrite: true,
        }),
      ),
    ).toBe(false);
  });

  it("fails closed for missing, malformed, or unknown approval metadata", () => {
    expect(canAutoApproveContactsMcpTool({})).toBe(false);
    expect(
      canAutoApproveContactsMcpTool({
        toolName: "call_tool",
        toolParams: null,
      }),
    ).toBe(false);
    expect(
      canAutoApproveContactsMcpTool({
        toolName: "unexpected_entry",
        toolParams: { name: "contacts_search", args: {} },
      }),
    ).toBe(false);
    expect(
      canAutoApproveContactsMcpTool({
        toolName: "call_tool",
        toolParams: { name: "contacts_search", args: "not-an-object" },
      }),
    ).toBe(false);
    expect(
      canAutoApproveContactsMcpTool(callTool("contacts_future_dangerous_tool")),
    ).toBe(false);
  });
});
