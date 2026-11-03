import {
  PLUGIN_COLLECTION,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
  type RemoteCollectionItem,
  type PluginUsageSummary,
  type PluginConfigurationItem,
} from "@cindy/device-link";
export function pluginVisualDemosEnabled() {
  return (
    typeof __DEV__ !== "undefined" &&
    __DEV__ &&
    (process.env.EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK === "1" ||
      process.env.EXPO_PUBLIC_CINDY_PLUGIN_DEMOS === "1")
  );
}
export interface PluginVisualScenario {
  id: string;
  name: string;
  label: string;
  description: string;
  usage?: PluginUsageSummary;
  taskPreferences?: boolean;
  surface?: "panel" | "settings";
  state?: "offline" | "loading" | "loadFailed";
  disabled?: boolean;
}
const field = (
  id: string,
  label: string,
  kind: PluginConfigurationItem["kind"],
  state: PluginConfigurationItem["state"],
  extra: Partial<PluginConfigurationItem> = {},
): PluginConfigurationItem => ({ id, label, kind, state, ...extra });
const key = (
  state: PluginConfigurationItem["state"],
  id = "secret:api_key",
  label = "API key",
) =>
  field(id, label, "secret", state, {
    hint: "Create an API key in the service console.",
  });
const account = (
  state: PluginConfigurationItem["state"],
  count = 0,
  expiredCount = 0,
) =>
  field("secret:account", "Google account", "oauth", state, {
    count,
    expiredCount,
  });
const connection = (state: PluginConfigurationItem["state"], count = 0) =>
  field("connection:instances", "GitLab instances", "connection", state, {
    count,
  });
const ready = (
  items: PluginConfigurationItem[] = [],
  patch: Partial<PluginUsageSummary> = {},
): PluginUsageSummary => ({
  taskUsable: true,
  hasSettings: items.length > 0,
  approvalRequired: false,
  builtin: false,
  retired: false,
  setup: { state: "ready", missing: [], expired: [] },
  configuration: { items, alternatives: [] },
  ...patch,
});
const required = (
  items: PluginConfigurationItem[],
  alternatives: string[][] = [],
): PluginUsageSummary => ({
  ...ready(items),
  setup: {
    state: "required",
    missing: items.filter((i) => i.state === "missing").map((i) => i.label),
    expired: items.filter((i) => i.state === "expired").map((i) => i.label),
  },
  configuration: { items, alternatives },
});
const search = (configured: boolean) => {
  const items = [
    key(configured ? "configured" : "missing", "secret:brave", "Brave API key"),
    key("missing", "secret:tavily", "Tavily API key"),
  ];
  return {
    ...(configured ? ready(items) : required(items)),
    configuration: { items, alternatives: [["secret:brave", "secret:tavily"]] },
  };
};
// Fictional values matching the Host shape. Production configuration never comes from this fixture.
export const pluginVisualScenarios: PluginVisualScenario[] = [
  {
    id: "0",
    name: "Demo Art",
    label: "Ready · no configuration",
    description:
      "Create images in a task. This demo needs no account or API key.",
    usage: ready(),
  },
  {
    id: "1",
    name: "Demo Calendar",
    label: "Missing API key",
    description: "Look up calendar events with a service API key.",
    usage: required([key("missing")]),
  },
  {
    id: "2",
    name: "Demo Documents",
    label: "Custom parameter · computer editor",
    description: "Index documents from a configured workspace.",
    usage: ready([
      field("kv:workspace", "Workspace", "parameter", "configured"),
    ]),
  },
  {
    id: "3",
    name: "Demo Mail",
    label: "Account expired",
    description:
      "Read mail from your connected account. Reconnect when authorization expires.",
    usage: required([account("expired", 0, 1)]),
  },
  {
    id: "4",
    name: "Demo Notes",
    label: "Disabled · saved configuration retained",
    description: "Disabling retains the saved key.",
    disabled: true,
    usage: ready([key("configured")]),
  },
  {
    id: "5",
    name: "Demo Planner",
    label: "Page only · no task buttons",
    description:
      "Open the planner page. This plugin does not contribute task tools.",
    surface: "panel",
    usage: ready([], { taskUsable: false }),
  },
  {
    id: "6",
    name: "Demo Reading",
    label: "API key saved",
    description: "Search a reading library with a securely saved API key.",
    usage: ready([key("configured")]),
  },
  {
    id: "7",
    name: "Demo Research",
    label: "Configuration status unknown",
    description:
      "The computer could not confirm configuration. Refresh before use.",
    usage: ready([key("unknown")], {
      setup: { state: "unknown", missing: [], expired: [] },
    }),
  },
  {
    id: "8",
    name: "Demo Tasks",
    label: "Task model and permissions",
    description:
      "Create tasks with plugin-specific model and permission preferences.",
    taskPreferences: true,
    usage: ready([], { hasSettings: true }),
  },
  {
    id: "9",
    name: "Demo Translation",
    label: "Host-managed configuration",
    description: "Use the identity managed by the execution computer.",
    usage: ready([
      field("secret:identity", "Organization identity", "managed", "managed"),
    ]),
  },
  {
    id: "10",
    name: "Demo Travel",
    label: "Approval record invalid",
    description:
      "Restore the installed plugin approval on the computer before use.",
    disabled: true,
    usage: ready([], { approvalRequired: true }),
  },
  {
    id: "11",
    name: "Demo Weather",
    label: "Multiple configuration kinds",
    description:
      "A plugin can combine a key, an account and custom parameters.",
    usage: ready([
      key("configured"),
      account("configured", 1),
      field("kv:language", "Output language", "parameter", "configured"),
    ]),
  },
  {
    id: "12",
    name: "Demo Calendar Accounts",
    label: "Connected and expired accounts",
    description:
      "Connected accounts remain usable while another account needs reconnection.",
    usage: ready([account("configured", 2, 1)]),
  },
  {
    id: "13",
    name: "Demo GitLab",
    label: "Multiple connections saved",
    description:
      "Connect to multiple GitLab instances on the execution computer.",
    usage: ready([connection("configured", 2)]),
  },
  {
    id: "14",
    name: "Demo GitLab Setup",
    label: "Connection missing",
    description: "Add a GitLab instance and its token before use.",
    usage: required([connection("missing")]),
  },
  {
    id: "15",
    name: "Demo Web Search",
    label: "Any-of · one alternative configured",
    description:
      "Either search provider is sufficient. The unused key is optional.",
    usage: search(true),
  },
  {
    id: "16",
    name: "Demo Search Setup",
    label: "Any-of · neither configured",
    description: "Configure either search provider to start using the plugin.",
    usage: search(false),
  },
  {
    id: "17",
    name: "Demo Retired Plugin",
    label: "Retired plugin",
    description:
      "Review this retired plugin and its replacement on the computer.",
    usage: ready([], { retired: true }),
  },
  {
    id: "18",
    name: "Demo Built-in Recovery",
    label: "Built-in approval recovery",
    description: "Restart the computer app to restore this built-in plugin.",
    disabled: true,
    usage: ready([], { approvalRequired: true, builtin: true }),
  },
  {
    id: "19",
    name: "Demo Runtime Crash",
    label: "Runtime crashed",
    description:
      "The plugin stopped unexpectedly. The next use is checked by Host.",
    usage: ready([], { runtimeIssue: "crashed" }),
  },
  {
    id: "20",
    name: "Demo Runtime Fuse",
    label: "Runtime fused",
    description: "The computer paused the runtime after repeated failures.",
    usage: ready([], { runtimeIssue: "fused" }),
  },
  {
    id: "21",
    name: "Demo Loading",
    label: "Loading detail",
    description: "Wait while the computer reads this plugin detail.",
    state: "loading",
    usage: ready(),
  },
  {
    id: "22",
    name: "Demo Read Failure",
    label: "Detail read failed · retry",
    description: "Retry reads again; it does not replay a configuration write.",
    state: "loadFailed",
    usage: ready(),
  },
  {
    id: "23",
    name: "Demo Offline",
    label: "Computer offline",
    description:
      "Connect the execution computer before reading or changing the plugin.",
    state: "offline",
    usage: ready(),
  },
  {
    id: "24",
    name: "Demo Older Host",
    label: "Older Host · no status projection",
    description:
      "Older computers preserve task entry without inventing configuration status.",
  },
  {
    id: "25",
    name: "Demo Custom Settings",
    label: "Author-defined mobile editor",
    description:
      "Plugins may supply their own editor for custom non-secret preferences.",
    surface: "settings",
    usage: ready([
      field("kv:language", "Output language", "parameter", "configured"),
      field("kv:format", "Output format", "parameter", "configured"),
    ]),
  },
  {
    id: "26",
    name: "Demo Optional Key",
    label: "Optional key · not a use requirement",
    description:
      "This key is optional. Its missing state must not block task use.",
    usage: ready([key("missing")]),
  },
  {
    id: "27",
    name: "Demo OAuth Setup",
    label: "Account not connected",
    description: "Connect a Google account before using calendar tools.",
    usage: required([account("missing")]),
  },
];
export function pluginVisualScenario(
  deviceId: string | undefined,
  id: string | undefined,
) {
  if (!pluginVisualDemosEnabled() || deviceId !== "cindy-visual-mock-mac")
    return;
  const scenario = pluginVisualScenarios.find((item) => item.id === id);
  return scenario?.state === "loadFailed" && (reads.get(scenario.id) ?? 0) > 1
    ? { ...scenario, state: undefined }
    : scenario;
}
export function pluginVisualPreview(
  value: unknown,
): { id: string; settings: boolean } | undefined {
  if (!pluginVisualDemosEnabled() || typeof value !== "string") return;
  const parts = value.split("-");
  if (
    parts.length > 2 ||
    (parts.length === 2 && parts[1] !== "settings") ||
    !/^[0-9]{1,2}$/.test(parts[0])
  )
    return;
  const id = String(Number(parts[0]));
  if (!pluginVisualScenarios.some((item) => item.id === id)) return;
  return { id, settings: parts.length === 2 };
}
const enabled = new Map(
  pluginVisualScenarios.map((item) => [item.id, !item.disabled]),
);
const preferences = new Map<string, Record<string, unknown>>();
const reads = new Map<string, number>();
function item(id: string): RemoteCollectionItem {
  const scenario = pluginVisualScenarios.find((item) => item.id === id);
  if (!scenario) throw new Error("UNKNOWN_DEMO_PLUGIN");
  const active = enabled.get(id) === true;
  return {
    ref: { collectionId: PLUGIN_COLLECTION, kind: "plugin", id },
    revision: String(active),
    links: [],
    display: {
      title: scenario.name,
      subtitle: scenario.description,
      ...(active && Number(id) < 2
        ? {
            badges: [
              { accessibilityLabel: "Unread", tone: "positive" as const },
            ],
            preview: "A new demo result is ready to view.",
          }
        : {}),
    },
    actions: [
      ...(scenario.surface
        ? [{ id: "open:" + scenario.surface, label: "Open", disabled: !active }]
        : []),
      {
        id: active ? "disable" : "enable",
        label: active ? "Disable" : "Enable",
        ...(scenario.usage?.approvalRequired || scenario.usage?.retired
          ? { disabled: true }
          : {}),
      },
    ],
  };
}
const demoPageBase64 =
  "PCFkb2N0eXBlIGh0bWw+PGh0bWw+PGhlYWQ+PHN0eWxlPmJvZHl7Zm9udDoxN3B4IC1hcHBsZS1zeXN0ZW0sc3lzdGVtLXVpO2NvbG9yOnZhcigtLXRleHQtcHJpbWFyeSk7YmFja2dyb3VuZDp2YXIoLS1zdXJmYWNlKTtwYWRkaW5nOjI0cHh9aDF7Zm9udC1zaXplOjIycHh9cHtjb2xvcjp2YXIoLS10ZXh0LXNlY29uZGFyeSk7bGluZS1oZWlnaHQ6MS41fWxhYmVse2Rpc3BsYXk6YmxvY2s7bWFyZ2luOjI0cHggMCA4cHh9c2VsZWN0LGJ1dHRvbnt3aWR0aDoxMDAlO21pbi1oZWlnaHQ6NDhweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Ym9yZGVyLXJhZGl1czoxMnB4O2JhY2tncm91bmQ6dmFyKC0tc3VyZmFjZS1lbGV2YXRlZCk7Y29sb3I6dmFyKC0tdGV4dC1wcmltYXJ5KTtwYWRkaW5nOjEycHh9YnV0dG9ue21hcmdpbi10b3A6MjRweH08L3N0eWxlPjwvaGVhZD48Ym9keT48aDE+Q3VzdG9tIHByZWZlcmVuY2VzPC9oMT48cD5EZW1vIGRhdGEuIFRoZXNlIGZpZWxkcyBhcmUgZGVmaW5lZCBieSB0aGUgcGx1Z2luLCBqdXN0IGFzIG9uIHRoZSBjb21wdXRlci48L3A+PGxhYmVsIGZvcj0ibGFuZ3VhZ2UiPk91dHB1dCBsYW5ndWFnZTwvbGFiZWw+PHNlbGVjdCBpZD0ibGFuZ3VhZ2UiPjxvcHRpb24gdmFsdWU9ImVuIj5FbmdsaXNoPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iemgiPkNoaW5lc2U8L29wdGlvbj48b3B0aW9uIHZhbHVlPSJqYSI+SmFwYW5lc2U8L29wdGlvbj48L3NlbGVjdD48bGFiZWwgZm9yPSJmb3JtYXQiPk91dHB1dCBmb3JtYXQ8L2xhYmVsPjxzZWxlY3QgaWQ9ImZvcm1hdCI+PG9wdGlvbiB2YWx1ZT0iYnJpZWYiPkJyaWVmPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iZGV0YWlsZWQiPkRldGFpbGVkPC9vcHRpb24+PC9zZWxlY3Q+PGJ1dHRvbiBpZD0ic2F2ZSI+U2F2ZSBkZW1vIHByZWZlcmVuY2VzPC9idXR0b24+PHAgaWQ9InJlY2VpcHQiPjwvcD48c2NyaXB0PmZldGNoKCcva3YnKS50aGVuKHI9PnIuanNvbigpKS50aGVuKHY9Pntkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbGFuZ3VhZ2UnKS52YWx1ZT12Lmxhbmd1YWdlO2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmb3JtYXQnKS52YWx1ZT12LmZvcm1hdH0pO2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzYXZlJykub25jbGljaz1hc3luYygpPT57YXdhaXQgZmV0Y2goJy9rdicse21ldGhvZDonUFVUJyxib2R5OkpTT04uc3RyaW5naWZ5KHtsYW5ndWFnZTpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbGFuZ3VhZ2UnKS52YWx1ZSxmb3JtYXQ6ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Zvcm1hdCcpLnZhbHVlfSl9KTtkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVjZWlwdCcpLnRleHRDb250ZW50PSdTYXZlZCBpbiB0aGlzIGRlbW8gb25seSd9Ozwvc2NyaXB0PjwvYm9keT48L2h0bWw+";
const demoPageSize = 1410;
let customPreferences = { language: "en", format: "brief" };
export function pluginVisualFixture(channel: string, args: unknown[]): unknown {
  const request = args[0] as
    | {
        collectionId?: string;
        ref?: { collectionId: string; id: string };
        resourceRef?: { collectionId: string; id: string };
        actionId?: string;
        input?: Record<string, unknown>;
      }
    | undefined;
  if (
    channel === REMOTE_RESOURCE_LIST_CHANNEL &&
    request?.collectionId === PLUGIN_COLLECTION
  )
    return {
      collectionId: PLUGIN_COLLECTION,
      revision: [...enabled.values()].join(),
      items: pluginVisualScenarios.map((scenario) => item(scenario.id)),
    };
  if (
    channel === REMOTE_RESOURCE_GET_CHANNEL &&
    request?.ref?.collectionId === PLUGIN_COLLECTION
  ) {
    reads.set(request.ref.id, (reads.get(request.ref.id) ?? 0) + 1);
    const current = item(request.ref.id),
      scenario = pluginVisualScenarios.find(
        (item) => item.id === request.ref!.id,
      )!;
    // The ready demo also exercises wrapping and the two-row disclosure.
    const tools =
      scenario.usage?.taskUsable === false
        ? []
        : (scenario.id === "0"
            ? [
                "demo_generate_image",
                "demo_edit_image",
                "demo_remove_background",
                "demo_upscale_image",
                "demo_generate_video",
                "demo_animate_image",
              ]
            : ["demo_tool"]
          ).map((name) => ({ name, description: "Example capability" }));
    return {
      ...current,
      blocks: [
        {
          id: "capabilities",
          primitive: "plugin-capabilities",
          fallbackMarkdown: "",
          data: {
            tools,
            tasks: scenario.taskPreferences === true,
            ...(scenario.usage ? { usage: scenario.usage } : {}),
          },
        },
      ],
    };
  }
  if (
    channel === REMOTE_RESOURCE_INVOKE_CHANNEL &&
    request?.resourceRef?.collectionId === PLUGIN_COLLECTION
  ) {
    const id = request.resourceRef.id,
      current = item(id);
    const scenario = pluginVisualScenarios.find(
      (scenario) => scenario.id === id,
    )!;
    if (
      request.actionId === "open:panel" ||
      request.actionId === "open:settings"
    ) {
      if (!scenario.surface || !enabled.get(id))
        throw new Error("DEMO_ACTION_DISABLED");
      return {
        effects: [],
        result: {
          pageId: "demo-" + id,
          pluginId: id,
          title: scenario.name,
          surface: scenario.surface,
          entry: "demo.html",
          channels: [],
          files: [{ path: "demo.html", mime: "text/html", size: demoPageSize }],
        },
      };
    }
    if (request.actionId === "asset")
      return {
        effects: [],
        result: { mime: "text/html", base64: demoPageBase64 },
      };
    if (request.actionId === "poll")
      return {
        effects: [],
        result: { events: [], confirms: [], notifications: [] },
      };
    if (["cover", "suspend", "close", "seen"].includes(request.actionId ?? ""))
      return { effects: [] };
    if (request.actionId === "fetch") {
      if (request.input?.path !== "/kv")
        throw new Error("UNSUPPORTED_DEMO_PLUGIN_ACTION");
      if (
        request.input.method === "PUT" &&
        typeof request.input.body === "string"
      ) {
        const value = JSON.parse(request.input.body);
        if (
          ["en", "zh", "ja"].includes(value.language) &&
          ["brief", "detailed"].includes(value.format)
        )
          customPreferences = {
            language: value.language,
            format: value.format,
          };
      }
      return {
        effects: [],
        result: {
          status: 200,
          mime: "application/json",
          base64: btoa(JSON.stringify(customPreferences)),
        },
      };
    }
    if (
      request.actionId === "task-settings:get" ||
      request.actionId === "task-settings:set"
    ) {
      if (request.actionId === "task-settings:set") {
        const previous = preferences.get(id) ?? {},
          patch = request.input ?? {};
        preferences.set(id, {
          ...previous,
          ...(patch.model && typeof patch.model === "object"
            ? patch.model
            : {}),
          ...(patch.permissionMode !== undefined
            ? { permissionMode: patch.permissionMode ?? undefined }
            : {}),
        });
      }
      return {
        effects: [],
        result: {
          revision: "demo-prefs",
          config: preferences.get(id) ?? {},
          permissionModes: ["ask", "auto"],
          defaultPermissionMode: "ask",
        },
      };
    }
    if (request.actionId !== "enable" && request.actionId !== "disable")
      throw new Error("UNSUPPORTED_DEMO_PLUGIN_ACTION");
    if (
      current.actions?.find((action) => action.id === request.actionId)
        ?.disabled
    )
      throw new Error("DEMO_ACTION_DISABLED");
    enabled.set(id, request.actionId === "enable");
    return {
      effects: [
        { kind: "refresh-collection", collectionId: PLUGIN_COLLECTION },
      ],
    };
  }
  return undefined;
}
