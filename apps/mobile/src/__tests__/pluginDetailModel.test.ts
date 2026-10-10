import { describe, expect, it } from "vitest";
import { pluginDetailModel } from "@/plugins/pluginDetailModel";
import type { PluginUsageSummary, RemoteResource } from "@cindy/device-link";
import type { HostedRemoteCollectionItem } from "@/device-link/remoteResources";
const row = (enabled = true): HostedRemoteCollectionItem => ({
  key: "mac:demo",
  host: { deviceId: "mac", deviceName: "Mac" },
  item: {
    ref: { collectionId: "plugins", kind: "plugin", id: "demo" },
    revision: "1",
    links: [],
    display: { title: "Demo" },
    actions: [
      { id: enabled ? "disable" : "enable", label: "Toggle" },
      { id: "open:panel", label: "Panel" },
      { id: "open:mainView", label: "Page" },
    ],
  },
});
const usage = (
  patch: Partial<PluginUsageSummary> = {},
): PluginUsageSummary => ({
  taskUsable: true,
  hasSettings: false,
  approvalRequired: false,
  builtin: false,
  retired: false,
  setup: { state: "ready", missing: [], expired: [] },
  ...patch,
});
const resource = (value: PluginUsageSummary): RemoteResource => ({
  ...row().item,
  blocks: [
    {
      id: "capabilities",
      primitive: "plugin-capabilities",
      fallbackMarkdown: "",
      data: { usage: value },
    },
  ],
});
describe("minimal plugin detail state", () => {
  it("keeps the switch available to recover a fuse without advertising task usage", () => {
    expect(
      pluginDetailModel(
        row(),
        resource(usage({ runtimeIssue: "fused" })),
        true,
        false,
        false,
      ),
    ).toMatchObject({
      runtimeIssue: "fused",
      canUseTasks: false,
      canToggle: true,
    });
  });
  it("keeps ready tasks usable and collapses panel/mainView into one entry", () => {
    expect(
      pluginDetailModel(row(), resource(usage()), true, false, false),
    ).toMatchObject({
      canUseTasks: true,
      canToggle: true,
      status: undefined,
      mainSurface: "panel",
      hasSettings: false,
    });
  });
  it("preserves legacy Host usage without inventing configured status", () => {
    const m = pluginDetailModel(
      row(),
      { ...row().item, blocks: [] },
      true,
      false,
      false,
    );
    expect(m.canUseTasks).toBe(true);
    expect(m.missing).toEqual([]);
    expect(m.status).toBeUndefined();
  });
  it.each([
    [false, false, false, "offline", "connect"],
    [true, true, false, "loading", undefined],
    [true, false, true, "loadFailed", "retry"],
  ] as const)(
    "blocks usage for transport/read status",
    (online, loading, failed, status, action) => {
      const m = pluginDetailModel(
        row(),
        resource(usage()),
        online,
        loading,
        failed,
      );
      expect(m).toMatchObject({
        status,
        statusAction: action,
        canUseTasks: false,
        canToggle: false,
      });
    },
  );
  it("keeps stop and missing approval distinct, and does not offer an invalid enable", () => {
    expect(
      pluginDetailModel(row(false), resource(usage()), true, false, false),
    ).toMatchObject({
      status: "disabled",
      statusAction: "enable",
      canToggle: true,
      canUseTasks: false,
    });
    expect(
      pluginDetailModel(
        row(false),
        resource(usage({ approvalRequired: true })),
        true,
        false,
        false,
      ),
    ).toMatchObject({
      status: "approvalRequired",
      statusAction: undefined,
      canToggle: false,
    });
    expect(
      pluginDetailModel(
        row(false),
        resource(usage({ retired: true })),
        true,
        false,
        false,
      ),
    ).toMatchObject({
      status: "retired",
      canToggle: false,
    });
  });
  it("uses Host missing/expired facts and moves completion into settings", () => {
    expect(
      pluginDetailModel(
        row(),
        resource(
          usage({
            setup: {
              state: "required",
              missing: ["API key"],
              expired: ["Account"],
            },
          }),
        ),
        true,
        false,
        false,
      ),
    ).toMatchObject({
      status: "setupRequired",
      statusAction: "settings",
      hasSettings: true,
      canUseTasks: false,
      missing: ["API key"],
      expired: ["Account"],
    });
  });
  it("never treats an unknown assessment as ready", () => {
    expect(
      pluginDetailModel(
        row(),
        resource(
          usage({ setup: { state: "unknown", missing: [], expired: [] } }),
        ),
        true,
        false,
        false,
      ),
    ).toMatchObject({
      status: "setupUnknown",
      statusAction: "retry",
      canUseTasks: false,
    });
  });
  it("does not advertise tasks for page-only plugins or confuse a crash with disabled", () => {
    expect(
      pluginDetailModel(
        row(),
        resource(usage({ taskUsable: false })),
        true,
        false,
        false,
      ),
    ).toMatchObject({
      taskUsable: false,
      canUseTasks: false,
      mainSurface: "panel",
    });
    expect(
      pluginDetailModel(
        row(),
        resource(usage({ runtimeIssue: "crashed" })),
        true,
        false,
        false,
      ),
    ).toMatchObject({
      status: undefined,
      runtimeIssue: "crashed",
      canUseTasks: true,
    });
  });
});
it("treats malformed new-host facts as unknown rather than legacy readiness", () => {
  const broken = resource(usage());
  (broken.blocks![0].data as any).usage.taskUsable = "yes";
  expect(pluginDetailModel(row(), broken, true, false, false)).toMatchObject({
    status: "setupUnknown",
    canUseTasks: false,
  });
});

describe("real plugin information", () => {
  it("reads full tools, permission summaries and existing metadata blocks", () => {
    const detail: RemoteResource = {
      ...row().item,
      blocks: [
        {
          id: "about",
          primitive: "markdown",
          fallbackMarkdown: "Full introduction",
        },
        { id: "version", primitive: "status", fallbackMarkdown: "2.3.0" },
        {
          id: "capabilities",
          primitive: "plugin-capabilities",
          fallbackMarkdown: "",
          data: {
            tools: [
              { name: "calendar_events", description: "Read calendar events" },
            ],
            permissions: [
              {
                title: "Connect to calendar.example",
                description: "Calendar access",
              },
            ],
          },
        },
      ],
    };
    expect(pluginDetailModel(row(), detail, true, false, false)).toMatchObject({
      description: "Full introduction",
      version: "2.3.0",
      tools: [{ name: "calendar_events", description: "Read calendar events" }],
      permissions: [
        {
          title: "Connect to calendar.example",
          description: "Calendar access",
        },
      ],
    });
  });
  it("distinguishes old Host and malformed data from explicit empty declarations", () => {
    const withFacts = (data: unknown) => ({
      ...row().item,
      blocks: [
        {
          id: "capabilities",
          primitive: "plugin-capabilities",
          fallbackMarkdown: "",
          data,
        },
      ],
    });
    const empty = pluginDetailModel(
      row(),
      withFacts({ tools: [], permissions: [] }),
      true,
      false,
      false,
    );
    expect(empty.tools).toEqual([]);
    expect(empty.permissions).toEqual([]);
    for (const data of [
      {},
      {
        tools: [{ description: "missing name" }],
        permissions: [{ title: 123 }],
      },
      null,
    ]) {
      const model = pluginDetailModel(
        row(),
        withFacts(data),
        true,
        false,
        false,
      );
      expect(model.tools).toBeUndefined();
      expect(model.permissions).toBeUndefined();
    }
  });
});

it("reads complete PC metadata only when the Host actually supplies it", () => {
  const details = [
    { key: "author", title: "Author", value: "Cindy" },
    {
      key: "trust",
      title: "Source & signature",
      value: "Unverified / unsigned",
    },
    {
      key: "location",
      title: "Install location",
      value: "/plugin-install/calendar",
    },
  ];
  const model = pluginDetailModel(
    row(),
    {
      ...row().item,
      blocks: [
        {
          id: "capabilities",
          primitive: "plugin-capabilities",
          fallbackMarkdown: "",
          data: { details },
        },
      ],
    },
    true,
    false,
    false,
  );
  expect(model.details).toEqual(details);
  expect(
    pluginDetailModel(row(), undefined, true, false, false).details,
  ).toBeUndefined();
  expect(
    pluginDetailModel(
      row(),
      {
        ...row().item,
        blocks: [
          {
            id: "capabilities",
            primitive: "plugin-capabilities",
            fallbackMarkdown: "",
            data: {
              details: [{ key: "trust", title: "Source", value: false }],
            },
          },
        ],
      },
      true,
      false,
      false,
    ).details,
  ).toBeUndefined();
});
