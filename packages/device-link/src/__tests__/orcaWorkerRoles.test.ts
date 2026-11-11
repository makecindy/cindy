// 协议契约(unit)：协同角色清单的远程读写。真相在被控端，手机与远程控制的电脑只读写这一份。
// 依据：2026-11-10 用户裁决「记忆全部以被控端为准」。此前没有这组通道，也就没有覆盖。
// 最小失败输入：通道未登记、清单里混入未知字段或越界内容、不认识的操作。
import { expect, it } from "vitest";
import {
  ORCA_WORKER_ROLES_APPLY,
  ORCA_WORKER_ROLES_GET,
  ORCA_WORKER_ROLE_TASK_MAX_LENGTH,
  ORCA_WORKER_ROLES_MAX,
  parseOrcaWorkerRoles,
  parseOrcaWorkerRolesMutation,
} from "../index";
import { REMOTE_INVOKE_ALLOWLIST } from "../allowlist";

const model = {
  agent: "codex",
  agentDeviceId: null,
  model: "gpt-5.5",
  effort: "high",
  fast: false,
  providerId: "openai",
};

it("lets same-account controllers read and change the host's worker roles", () => {
  expect(REMOTE_INVOKE_ALLOWLIST.has(ORCA_WORKER_ROLES_GET)).toBe(true);
  expect(REMOTE_INVOKE_ALLOWLIST.has(ORCA_WORKER_ROLES_APPLY)).toBe(true);
});

it("keeps only known fields and treats unusable remembered values as not remembered", () => {
  expect(
    parseOrcaWorkerRoles({
      roles: [
        { role: " reviewer ", task: "Check the diff", permission: "auto", model, secret: "x" },
        { role: "researcher", task: "  ", permission: "root" },
        { role: "tester", task: "x".repeat(ORCA_WORKER_ROLE_TASK_MAX_LENGTH + 1) },
      ],
      extra: true,
    }),
  ).toEqual({
    roles: [
      { role: "reviewer", task: "Check the diff", permission: "auto", model },
      { role: "researcher" },
      { role: "tester" },
    ],
  });
});

it("rejects lists it cannot represent faithfully", () => {
  expect(() => parseOrcaWorkerRoles(null)).toThrow();
  expect(() => parseOrcaWorkerRoles({ roles: [{ role: "" }] })).toThrow();
  expect(() => parseOrcaWorkerRoles({ roles: [{ role: "x".repeat(33) }] })).toThrow();
  expect(() => parseOrcaWorkerRoles({ roles: [{ role: "a" }, { role: "a" }] })).toThrow("Duplicate");
  expect(() =>
    parseOrcaWorkerRoles({
      roles: Array.from({ length: ORCA_WORKER_ROLES_MAX + 1 }, (_, index) => ({ role: `r${index}` })),
    }),
  ).toThrow();
  expect(() => parseOrcaWorkerRoles({ roles: [{ role: "a", model: { ...model, agent: "gemini" } }] })).toThrow();
});

it("accepts only the two operations a controller may perform", () => {
  expect(parseOrcaWorkerRolesMutation({ kind: "forget", role: "researcher", task: "ignored" })).toEqual({
    kind: "forget",
    role: "researcher",
  });
  expect(parseOrcaWorkerRolesMutation({ kind: "remember", role: "researcher", task: "Read", model })).toEqual({
    kind: "remember",
    role: "researcher",
    task: "Read",
    model,
  });
  expect(() => parseOrcaWorkerRolesMutation({ kind: "replace", roles: [] })).toThrow();
  expect(() => parseOrcaWorkerRolesMutation({ kind: "forget" })).toThrow();
});

// 同一裁决的延伸(2026-11-10)：不分角色的「上次选择」也只存在被控端，随清单读回、随创建写回。
// 最小失败输入：读回的「上次选择」残缺(不能因此丢掉角色清单)；写入的选择残缺(不能写半截)。
const agentModel = { model: "gpt-5.5", effort: "high", fast: false, providerId: null };
const defaults = {
  agent: "codex",
  permission: "bypassPermissions",
  agents: { codex: agentModel, "claude-code": { ...agentModel, model: "claude-opus-4-7" }, pi: { ...agentModel, model: "pi-model" } },
  model,
};

it("returns the host's last-used choice with the roles, and drops it alone when it is malformed", () => {
  expect(parseOrcaWorkerRoles({ roles: [{ role: "tester" }], defaults: { ...defaults, extra: 1 } })).toEqual({
    roles: [{ role: "tester" }],
    defaults,
  });
  const { pi: _pi, ...missingAgent } = defaults.agents;
  for (const broken of [
    { ...defaults, agent: "gemini" },
    { ...defaults, permission: "root" },
    { ...defaults, agents: missingAgent },
    "codex",
  ]) {
    expect(parseOrcaWorkerRoles({ roles: [{ role: "tester" }], defaults: broken })).toEqual({ roles: [{ role: "tester" }] });
  }
});

it("carries the submitted choice on remember and refuses a choice it cannot read", () => {
  const remember = { kind: "remember", role: "tester", permission: "auto" };
  expect(
    parseOrcaWorkerRolesMutation({ ...remember, choice: { agent: "codex", agentModel, route: null, extra: 1 } }),
  ).toEqual({ ...remember, choice: { agent: "codex", agentModel, route: null } });
  // route 缺省与 null 含义不同：缺省 = 不动之前记的路线，null = 清掉。
  expect(parseOrcaWorkerRolesMutation({ ...remember, choice: { agent: "pi", route: model } })).toEqual({
    ...remember,
    choice: { agent: "pi", route: model },
  });
  expect(() => parseOrcaWorkerRolesMutation({ ...remember, choice: { agent: "gemini" } })).toThrow();
  expect(() => parseOrcaWorkerRolesMutation({ ...remember, choice: { agent: "codex", agentModel: { model: "" } } })).toThrow();
});
