import type {
  RemoteResourceRegistry,
  RemoteResource,
  RemoteLocalizedText,
  RemoteActionField,
} from "@cindy/device-link";
import { installedGhostStoragePart } from "@cindy/plugin-runtime/shared/pluginIdentity";
import {
  ghostInstallApprovalToken,
  ghostPermissionItems,
  type GhostPermissionItem,
  type InstalledGhost,
} from "@cindy/plugin-runtime/shared/ghost";
import type { TerminalPlugins } from "./host.js";
import permissions from "./permissions.json";
import type { TerminalPluginPages } from "./pages.js";
import type { TerminalPluginSessions } from "./sessions.js";
import translations from "./translations.json";
import { hasPluginTaskApproval } from '@cindy/plugin-runtime/taskCapability';

const copy = {
  plugins: ["Plugins", "插件", "外掛", "プラグイン", "플러그인"],
  install: [
    "Install package",
    "安装插件包",
    "安裝外掛套件",
    "パッケージをインストール",
    "패키지 설치",
  ],
  file: [
    "Package path (.cindy)",
    "插件包路径（.cindy）",
    "外掛套件路徑（.cindy）",
    "パッケージのパス（.cindy）",
    "패키지 경로(.cindy)",
  ],
  confirm: [
    "Install with these permissions?",
    "允许以上权限并安装？",
    "允許以上權限並安裝？",
    "これらの権限でインストールしますか？",
    "이 권한으로 설치할까요?",
  ],
  proceed: [
    "Confirm installation",
    "确认安装",
    "確認安裝",
    "インストールを確認",
    "설치 확인",
  ],
  cancel: ["Cancel", "取消", "取消", "キャンセル", "취소"],
  enabled: ["Enabled", "已启用", "已啟用", "有効", "활성화됨"],
  disabled: ["Disabled", "已停用", "已停用", "無効", "비활성화됨"],
  enable: ["Enable", "启用", "啟用", "有効にする", "활성화"],
  disable: ["Disable", "停用", "停用", "無効にする", "비활성화"],
  remove: ["Uninstall", "卸载", "解除安裝", "アンインストール", "제거"],
  removeConfirm: [
    "Uninstall this plugin?",
    "卸载此插件？",
    "解除安裝此外掛？",
    "このプラグインを削除しますか？",
    "이 플러그인을 제거할까요?",
  ],
  credentials: ["Credentials", "凭证", "憑證", "認証情報", "인증 정보"],
  key: ["Credential", "凭证", "憑證", "認証情報", "인증 정보"],
  value: ["New value", "新值", "新值", "新しい値", "새 값"],
  model: ["Model", "模型", "模型", "モデル", "모델"],
  tuning: [
    "Model options",
    "模型选项",
    "模型選項",
    "モデルのオプション",
    "모델 옵션",
  ],
  effort: [
    "Reasoning effort",
    "思考强度",
    "思考強度",
    "推論の強度",
    "추론 강도",
  ],
  fast: ["Fast mode", "快速模式", "快速模式", "高速モード", "빠른 모드"],
  on: ["On", "开启", "開啟", "オン", "켜기"],
  off: ["Off", "关闭", "關閉", "オフ", "끄기"],
  automatic: ["Automatic", "自动", "自動", "自動", "자동"],
  next: ["Next", "下一页", "下一頁", "次へ", "다음"],
  back: ["Back", "返回", "返回", "戻る", "뒤로"],
} as const;
const label = (key: keyof typeof copy): RemoteLocalizedText => {
  const [fallback, cn, tw, ja, ko] = copy[key];
  return {
    fallback,
    translations: { en: fallback, "zh-CN": cn, "zh-TW": tw, ja, ko },
  };
};
const ref = (id: string) => ({ collectionId: "plugins", kind: "plugin", id });
const backgroundRef = (id: string, page = 0) =>
  ref(
    `background:${Buffer.from(JSON.stringify([id, page])).toString("base64url")}`,
  );
function backgroundAddress(id: string): [string, number] {
  try {
    if (id.length > 1024) throw new Error();
    const value: unknown = JSON.parse(
      Buffer.from(id.slice("background:".length), "base64url").toString(),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      !value[0] ||
      value[0].length > 256 ||
      !Number.isSafeInteger(value[1]) ||
      value[1] < 0
    )
      throw new Error();
    return value as [string, number];
  } catch {
    throw new Error("INVALID_RESOURCE");
  }
}
const backgroundLabel = (name: string): RemoteLocalizedText => {
  const key = `settings.ghosts.backgroundTasks.${name}`;
  return {
    fallback: (translations.en as Record<string, string>)[key] ?? name,
    translations: Object.fromEntries(
      Object.entries(translations).map(([locale, values]) => [
        locale,
        (values as Record<string, string>)[key] ?? name,
      ]),
    ),
  };
};
const taskPermissionLabel = (key: string): RemoteLocalizedText => ({
  fallback:
    (translations.en as Record<string, string>)[
      `terminal.plugin.permission.${key}`
    ] ?? key,
  translations: Object.fromEntries(
    Object.entries(translations).map(([locale, values]) => [
      locale,
      (values as Record<string, string>)[`terminal.plugin.permission.${key}`] ??
        key,
    ]),
  ),
});
const effortLabel = (key:string):RemoteLocalizedText => ({
  fallback:(translations.en as Record<string,string>)[`effortLevels.${key}`]??key,
  translations:Object.fromEntries(Object.entries(translations).map(([locale,values])=>[locale,(values as Record<string,string>)[`effortLevels.${key}`]??key])),
});
function permissionText(items: GhostPermissionItem[], locale = "en") {
  const dictionary =
    (permissions as Record<string, Record<string, string>>)[locale] ??
    permissions.en;
  const format = (key: string, args: Record<string, string> = {}) =>
    (
      dictionary[key] ??
      (permissions.en as Record<string, string>)[key] ??
      key
    ).replace(/\{\{(\w+)\}\}/g, (_match, name) => args[name] ?? "");
  return items
    .map((item) =>
      [
        format(item.labelKey, item.labelArgs),
        item.detailKey ? format(item.detailKey, item.detailArgs) : "",
        item.detail ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}
function secretFields(ghost: InstalledGhost) {
  const keys = new Map<string, string>();
  for (const secret of ghost.manifest.network?.secrets ?? [])
    if (["user", "gh-cli"].includes(secret.source ?? "user"))
      keys.set(secret.key, secret.label);
  for (const binding of ghost.manifest.node?.secretBindings ?? [])
    if (!binding.oauthSecret) keys.set(binding.key, binding.label);
  return [...keys].map(([key, label]) => ({
    value: Buffer.from(
      JSON.stringify([key, ghostInstallApprovalToken(ghost.approval)]),
    ).toString("base64url"),
    label,
  }));
}

export function registerPluginResources(
  registry: RemoteResourceRegistry,
  host: TerminalPlugins,
  pages?: TerminalPluginPages,
  sessions?: TerminalPluginSessions,
) {
  const installed = (
    ghost: InstalledGhost,
    locale?: string,
  ): RemoteResource => {
    const id = installedGhostStoragePart(ghost),
      secrets = secretFields(ghost);
    return {
      ref: ref(id),
      revision: host.version(),
      display: { title: ghost.manifest.name, subtitle: ghost.manifest.version },
      links: [],
      blocks: [
        {
          id: "permissions",
          primitive: "text",
          fallbackMarkdown: permissionText(
            ghostPermissionItems(ghost.manifest),
            locale,
          ),
        },
      ],
      actions: [
        ...(ghost.enabled && ghost.approval.state === 'approved' && ghost.manifest.agent?.tasks
          ? (['tasks','targets'] as const).filter(capability => capability === 'tasks' ? !ghost.taskCapabilityApproved
            : hasPluginTaskApproval(ghost) && ghost.manifest.agent?.targets && !ghost.targetCapabilityApproved).map(capability => {
            const items = ghostPermissionItems(ghost.manifest).filter(item => item.key === `agent:${capability}`);
            const text: RemoteLocalizedText = { fallback: permissionText(items, 'en'), translations: Object.fromEntries(Object.keys(permissions).map(locale => [locale, permissionText(items, locale)])) };
            const key = capability === 'tasks' ? 'agentTasks' : 'agentTargets';
            const title: RemoteLocalizedText = { fallback: permissions.en[key], translations: Object.fromEntries(Object.entries(permissions).map(([locale, values]) => [locale, values[key]])) };
            return { id: `approve-capability:${capability}:${ghost.approval.state === 'approved' ? ghost.approval.revision : ''}`,
              label: title, confirmation: { title, body: text } };
          }) : []),
        {
          id: ghost.enabled ? "disable" : "enable",
          label: label(ghost.enabled ? "disable" : "enable"),
        },
        ...(secrets.length
          ? [
              {
                id: "credentials",
                label: label("credentials"),
                fields: [
                  {
                    id: "key",
                    kind: "select",
                    label: label("key"),
                    required: true,
                    options: secrets,
                  },
                  { id: "value", kind: "secret", label: label("value") },
                ],
              },
            ]
          : []),
        {
          id: "remove",
          label: label("remove"),
          tone: "destructive",
          confirmation: { title: label("removeConfirm") },
        },
      ],
    };
  };
  const prepared = (
    id: string,
    controller: string,
    locale?: string,
  ): RemoteResource => {
    const pending = host.pendingInstall(id, controller),
      facts = pending.facts;
    return {
      ref: ref(`install:${id}`),
      revision: pending.inspected.packageSha256,
      display: { title: facts.name, subtitle: facts.version },
      links: [],
      blocks: [
        {
          id: "permissions",
          primitive: "text",
          fallbackMarkdown: permissionText(
            ghostPermissionItems(pending.inspected.manifest),
            locale,
          ),
        },
      ],
      actions: [
        {
          id: "confirm-install",
          label: label("proceed"),
          confirmation: { title: label("confirm") },
        },
        { id: "cancel-install", label: label("cancel") },
      ],
    };
  };
  registry.register({
    collection: {
      id: "plugins",
      resourceKind: "plugin",
      title: label("plugins"),
      placement: "settings",
      actions: [
        ...(pages?.provider.collection.actions ?? []),
        {
          id: "install",
          label: label("install"),
          fields: [
            { id: "file", kind: "text", label: label("file"), required: true },
          ],
        },
      ],
    },
    list: async (context, request) => {
      const offset = request.cursor === undefined ? 0 : Number(request.cursor),
        limit = Math.min(request.limit ?? 100, 200);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      )
        throw new Error("INVALID_CURSOR");
      const query = request.query?.toLowerCase();
      const items = [
        ...(await host.list()).map((ghost) =>
          installed(ghost, request.client.locale),
        ),
        ...host
          .pendingFor(context.controllerDeviceId)
          .map((p) =>
            prepared(p.id, context.controllerDeviceId, request.client.locale),
          ),
      ].filter(
        (item) =>
          !query ||
          `${item.display.title} ${item.display.subtitle}`
            .toLowerCase()
            .includes(query),
      );
      return {
        collectionId: "plugins",
        revision: host.version(),
        items: items.slice(offset, offset + limit),
        ...(offset + limit < items.length
          ? { nextCursor: String(offset + limit) }
          : {}),
      };
    },
    get: async (context, request) => {
      if (request.ref.id.startsWith("install:"))
        return prepared(
          request.ref.id.slice(8),
          context.controllerDeviceId,
          request.client.locale,
        );
      if (request.ref.id.startsWith("background:")) {
        if (!sessions) throw new Error("PLUGIN_TASKS_UNAVAILABLE");
        const [id, page] = backgroundAddress(request.ref.id),
          all = await sessions.background(id);
        context.assertCurrent?.();
        const items = all.slice(page * 50, (page + 1) * 50),
          ghost = host.installed(id);
        if (!ghost) throw new Error("PLUGIN_NOT_FOUND");
        return {
          ref: request.ref,
          revision: JSON.stringify(items),
          display: {
            title: backgroundLabel("title"),
            subtitle: ghost.manifest.name,
          },
          links: [
            ...items.map((item) => ({
              rel: `task:${item.taskId}`,
              label: item.title,
              target: { kind: "session" as const, sessionId: item.taskId },
            })),
            ...(page
              ? [
                  {
                    rel: "previous",
                    label: label("back"),
                    target: {
                      kind: "resource" as const,
                      ref: backgroundRef(id, page - 1),
                    },
                  },
                ]
              : []),
            ...((page + 1) * 50 < all.length
              ? [
                  {
                    rel: "next",
                    label: label("next"),
                    target: {
                      kind: "resource" as const,
                      ref: backgroundRef(id, page + 1),
                    },
                  },
                ]
              : []),
            {
              rel: "plugin",
              label: ghost.manifest.name,
              target: { kind: "resource" as const, ref: ref(id) },
            },
          ],
          blocks: items.length
            ? []
            : [
                {
                  id: "empty",
                  primitive: "text",
                  fallbackMarkdown:
                    backgroundLabel("empty").translations?.[
                      request.client.locale ?? "en"
                    ] ?? backgroundLabel("empty").fallback,
                },
              ],
          actions: items.length
            ? [
                {
                  id: "reveal-background",
                  label: backgroundLabel("reveal"),
                  fields: [
                    {
                      id: "taskId",
                      kind: "select",
                      label: backgroundLabel("title"),
                      required: true,
                      options: items.map((item) => ({
                        value: item.taskId,
                        label: item.title,
                      })),
                    },
                  ],
                },
              ]
            : [],
        };
      }
      const ghost = await host.get(request.ref.id),
        resource = installed(ghost, request.client.locale);
      if (sessions && ghost.manifest.agent?.tasks)
        resource.links.push({
          rel: "background-tasks",
          label: backgroundLabel("title"),
          target: { kind: "resource", ref: backgroundRef(request.ref.id) },
        });
      if (host.models && ghost.manifest.agent?.tasks) {
        const config = await host.models.config(request.ref.id);
        context.assertCurrent?.();
        const permissionMode = config.permissionMode ?? "ask";
        resource.actions?.push({
          id: "task-permission",
          label: taskPermissionLabel("title"),
          fields: [
            {
              id: "permissionMode",
              kind: "select",
              required: true,
              label: taskPermissionLabel("title"),
              options: ["ask", "plan", "acceptEdits", "auto"].map((value) => ({
                value,
                label: taskPermissionLabel(value),
              })),
            },
          ],
        });
        resource.blocks?.push({
          id: "task-permission",
          primitive: "form",
          fallbackMarkdown:
            taskPermissionLabel(permissionMode).translations?.[
              request.client.locale ?? "en"
            ] ?? taskPermissionLabel(permissionMode).fallback,
          data: { actionId: "task-permission", values: { permissionMode } },
        });
      }
      if (
        host.models &&
        (ghost.manifest.agent?.tasks ||
          ghost.manifest.cindy?.text?.includes("oneshot"))
      ) {
        const state = await host.models.state(request.ref.id);
        context.assertCurrent?.();
        const selected = state.options.find(
          (option) => option.id === state.selected,
        );
        if (
          ghost.manifest.agent?.tasks &&
          selected &&
          "efforts" in selected &&
          (selected.efforts.length || selected.supportsFastMode)
        ) {
          const settings = await host.taskSettings(
            request.ref.id,
            ghostInstallApprovalToken(ghost.approval),
          );
          context.assertCurrent?.();
          const fields: RemoteActionField[] = [];
          if (selected.efforts.length)
            fields.push({
              id: "effort",
              kind: "select",
              label: label("effort"),
              options: [
                { value: "", label: label("automatic") },
                ...selected.efforts.map((value) => ({ value, label: effortLabel(value) })),
              ],
            });
          if (selected.supportsFastMode)
            fields.push({
              id: "fastMode",
              kind: "select",
              label: label("fast"),
              options: [
                { value: "false", label: label("off") },
                { value: "true", label: label("on") },
                ...(selected.supportsUltrafastMode
                  ? [{ value: "ultrafast", label: "Ultra Fast" }]
                  : []),
              ],
            });
          resource.actions?.push({
            id: "task-tuning",
            label: label("tuning"),
            fields,
          });
          resource.blocks?.push({
            id: "task-tuning",
            primitive: "form",
            fallbackMarkdown: "",
            data: {
              actionId: "task-tuning",
              values: {
                expectedRevision: settings.revision,
                effort: settings.config.effort ?? "",
                fastMode: String(settings.config.fastMode ?? false),
              },
            },
          });
        }
        const options = state.options.map((option) => ({
          value: option.id,
          label: option.label,
        }));
        if (
          state.selected &&
          !options.some((option) => option.value === state.selected)
        )
          options.unshift({
            value: state.selected,
            label: [
              state.config.providerId,
              state.config.agentKind,
              state.config.model,
            ]
              .filter(Boolean)
              .join(" / "),
          });
        resource.actions?.push({
          id: "model",
          label: label("model"),
          fields: [
            {
              id: "model",
              kind: "select",
              label: label("model"),
              options: [{ value: "", label: label("automatic") }, ...options],
            },
          ],
        });
        resource.blocks?.push({
          id: "model",
          primitive: "form",
          fallbackMarkdown: state.selected
            ? (options.find((option) => option.value === state.selected)
                ?.label ??
              state.config.model ??
              "")
            : (label("automatic").translations?.[
                request.client.locale ?? "en"
              ] ?? label("automatic").fallback),
          data: { actionId: "model", values: { model: state.selected ?? "" } },
        });
      }
      if (!pages) return resource;
      const shared = await pages.provider.get!(context, request);
      return {
        ...shared,
        display: {
          ...shared.display,
          status: {
            label: label(ghost.enabled ? "enabled" : "disabled"),
            tone: "neutral",
          },
        },
        links: [...resource.links, ...shared.links],
        actions: [
          ...(resource.actions ?? []),
          ...(shared.actions?.filter((action) =>
            action.id.startsWith("open:"),
          ) ?? []),
        ],
        blocks: [...(shared.blocks ?? []), ...(resource.blocks ?? [])],
      };
    },
    invoke: async (context, request) => {
      context.assertCurrent?.();
      if (pages && request.actionId.startsWith("management:"))
        return pages.provider.invoke!(context, request);
      const id = request.resourceRef?.id;
      if (request.actionId === "install") {
        const file = request.input?.file;
        if (typeof file !== "string")
          throw new Error("PLUGIN_PACKAGE_PATH_REQUIRED");
        const prepared = await host.prepareInstall(
          file,
          context.controllerDeviceId,
        );
        context.assertCurrent?.();
        return {
          effects: [
            {
              kind: "navigate",
              target: { kind: "resource", ref: ref(`install:${prepared.id}`) },
            },
          ],
        };
      }
      if (!id) throw new Error("PLUGIN_ID_REQUIRED");
      if (id.startsWith("background:")) {
        if (
          !sessions ||
          request.actionId !== "reveal-background" ||
          typeof request.input?.taskId !== "string"
        )
          throw new Error("INVALID_ACTION");
        const [plugin] = backgroundAddress(id);
        await sessions.revealBackground(plugin, request.input.taskId, () =>
          context.assertCurrent?.(),
        );
        return { effects: [{ kind: "refresh-resource", ref: ref(id) }] };
      }
      if (id.startsWith("install:")) {
        if (request.actionId === "confirm-install")
          await host.confirmInstall(
            id.slice(8),
            context.controllerDeviceId,
            context.assertCurrent,
          );
        else if (request.actionId === "cancel-install")
          host.cancelInstall(id.slice(8), context.controllerDeviceId);
        else throw new Error("INVALID_ACTION");
      } else if (request.actionId.startsWith('approve-capability:')) {
        const [, capability, revision, extra] = request.actionId.split(':');
        if (!['tasks','targets'].includes(capability) || !revision || extra) throw new Error('INVALID_ACTION');
        await host.approveTaskCapability(id, revision, capability as 'tasks' | 'targets', () => context.assertCurrent?.());
      } else if (["enable", "disable"].includes(request.actionId))
        await host.setEnabled(id, request.actionId === "enable");
      else if (request.actionId === "remove") await host.uninstall(id);
      else if (request.actionId === "task-tuning") {
        const ghost = await host.get(id),
          revision = ghostInstallApprovalToken(ghost.approval);
        const settings = await host.taskSettings(id, revision);
        if (settings.revision !== request.input?.expectedRevision)
          throw new Error("PLUGIN_SETTINGS_CHANGED");
        const { agentKind, providerId, model } = settings.config;
        const effort = request.input?.effort,
          fast = request.input?.fastMode;
        if (
          typeof effort !== "string" ||
          !["false", "true", "ultrafast"].includes(String(fast))
        )
          throw new Error("PLUGIN_SETTINGS_INVALID");
        await host.taskSettings(
          id,
          revision,
          {
            expectedRevision: settings.revision,
            model: {
              agentKind,
              providerId,
              model,
              ...(effort ? { effort } : {}),
              fastMode: fast === "ultrafast" ? "ultrafast" : fast === "true",
            },
          },
          context.assertCurrent,
        );
      } else if (request.actionId === "task-permission")
        await host.setTaskPermission(
          id,
          request.input?.permissionMode,
          context.assertCurrent,
        );
      else if (request.actionId === "model" && host.models) {
        await host.setModel(
          id,
          request.input?.model === "" ? null : request.input?.model,
          context.assertCurrent,
        );
      } else if (request.actionId === "credentials") {
        throw new Error("PROTECTED_INPUT_REQUIRED");
      } else if (pages) return pages.provider.invoke!(context, request);
      else throw new Error("INVALID_ACTION");
      return {
        effects: [
          { kind: "refresh-collection", collectionId: "plugins" },
          ...([
            "model",
            "task-permission",
            "task-tuning",
            "enable",
            "disable",
          ].includes(request.actionId)
            ? [{ kind: "refresh-resource" as const, ref: ref(id) }]
            : []),
        ],
      };
    },
  });
}
