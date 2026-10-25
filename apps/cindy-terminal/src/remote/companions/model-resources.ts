import type {
  RemoteActionDescriptor,
  RemoteResource,
  RemoteResourceRegistry,
  RemoteText,
} from "@cindy/device-link";
import { resolveRemoteText } from "@cindy/device-link";
import { companionModelKey, type CompanionModel } from "./models.js";
import type { TerminalCompanionHost } from "./host.js";

const text = (
  en: string,
  zh: string,
  tw: string,
  ja: string,
  ko: string,
): RemoteText => ({
  fallback: en,
  translations: { en, "zh-CN": zh, "zh-TW": tw, ja, ko },
});
export const companionModelsTitle = text(
  "Teammate models",
  "伙伴模型",
  "夥伴模型",
  "チームメイトのモデル",
  "팀원 모델",
);
const defaultsTitle = text(
  "Default models",
  "默认模型",
  "預設模型",
  "既定のモデル",
  "기본 모델",
);
const none = text("None", "不选", "不選", "なし", "없음");
const automatic = text("Automatic", "自动", "自動", "自動", "자동");
const edit = text(
  "Edit model order",
  "编辑模型顺序",
  "編輯模型順序",
  "モデルの順序を編集",
  "모델 순서 편집",
);
const reset = text(
  "Restore defaults",
  "恢复默认",
  "還原預設",
  "既定に戻す",
  "기본값 복원",
);
const following = text(
  "Follow default models",
  "跟随默认模型",
  "跟隨預設模型",
  "既定のモデルを使用",
  "기본 모델 따르기",
);
const effort = text("Effort", "推理强度", "推理強度", "推論強度", "추론 강도");
const speed = text("Speed", "速度", "速度", "速度", "속도");
const standard = text("Standard", "标准", "標準", "標準", "표준");
const fast = text("Fast", "快速", "快速", "高速", "빠름");
const ultrafast = text("Ultrafast", "超快", "超快", "超高速", "초고속");
const unavailable = text(
  "Unavailable",
  "不可用",
  "無法使用",
  "利用不可",
  "사용 불가",
);
const slots = [
  text("Primary model", "首选模型", "首選模型", "優先モデル", "기본 모델"),
  text(
    "Second model",
    "第二模型",
    "第二模型",
    "2 番目のモデル",
    "두 번째 모델",
  ),
  text("Third model", "第三模型", "第三模型", "3 番目のモデル", "세 번째 모델"),
  text(
    "Fourth model",
    "第四模型",
    "第四模型",
    "4 番目のモデル",
    "네 번째 모델",
  ),
  text(
    "Fifth model",
    "第五模型",
    "第五模型",
    "5 番目のモデル",
    "다섯 번째 모델",
  ),
];
export const companionModelsRef = (id = "defaults") => ({
  collectionId: "teammate-models",
  kind: "teammate-models",
  id,
});

/** Forms use the shared remote resource protocol, including on a headless host. */
export function registerCompanionModelResources(
  registry: RemoteResourceRegistry,
  host: TerminalCompanionHost,
) {
  const settings = host.modelSettings;
  async function state(id: string) {
    const defaults = await settings.state();
    const profile = id === "defaults" ? null : await host.profiles.get(id);
    if (id !== "defaults" && !profile) throw new Error("COMPANION_NOT_FOUND");
    const configured = profile?.models ?? defaults.configured;
    return {
      profile,
      configured,
      effective: configured.length ? configured : defaults.effective,
      revision: profile
        ? `${profile.version}-${defaults.revision}`
        : defaults.revision,
      defaultsRevision: defaults.revision,
    };
  }
  async function resource(
    id: string,
    locale?: string,
  ): Promise<RemoteResource> {
    const current = await state(id);
    const options = await settings.choices(current.effective);
    const actionId = `edit:${current.revision}`;
    const actions: RemoteActionDescriptor[] = [
      {
        id: actionId,
        label: edit,
        fields: slots.map((label, index) => ({
          id: `model${index + 1}`,
          kind: "select",
          label,
          options: [
            { value: "", label: none },
            ...options.map((option) => ({
              value: option.id,
              label: option.label,
            })),
          ],
        })),
      },
      {
        id: `reset:${current.revision}`,
        label: current.profile ? following : reset,
      },
    ];
    const blocks: RemoteResource["blocks"] = [
      {
        id: "chain",
        primitive: "text",
        fallbackMarkdown: current.effective
          .map((choice, index) => {
            const option = options.find(
              (option) => option.id === companionModelKey(choice),
            );
            return `${index + 1}. ${option?.label ?? choice.model}${choice.effort ? ` · ${choice.effort}` : ""}${choice.fastMode ? ` · ${resolveRemoteText(choice.fastMode === "ultrafast" ? ultrafast : fast, locale)}` : ""}${option?.available ? "" : ` · ${resolveRemoteText(unavailable, locale)}`}`;
          })
          .join("\n"),
      },
      {
        id: "settings",
        primitive: "form",
        fallbackMarkdown: "",
        data: {
          actionId,
          values: Object.fromEntries(
            slots.map((_, index) => [
              `model${index + 1}`,
              current.effective[index]
                ? companionModelKey(current.effective[index])
                : "",
            ]),
          ),
        },
      },
    ];
    current.effective.forEach((choice, index) => {
      const option = options.find(
        (option) => option.id === companionModelKey(choice),
      );
      const tuneId = `tune-${index}:${current.revision}`;
      actions.push({
        id: tuneId,
        label: slots[index],
        ...(!option?.available
          ? { disabled: true, disabledReason: unavailable }
          : {}),
        fields: [
          {
            id: "effort",
            label: effort,
            kind: "select",
            options: [
              { value: "", label: automatic },
              ...(option?.efforts ?? []).map((value) => ({
                value,
                label: value,
              })),
            ],
          },
          {
            id: "speed",
            label: speed,
            kind: "select",
            options: [
              { value: "standard", label: standard },
              ...(option?.fast ? [{ value: "fast", label: fast }] : []),
              ...(option?.fast && option.ultrafast
                ? [{ value: "ultrafast", label: ultrafast }]
                : []),
            ],
          },
        ],
      });
      blocks.push({
        id: `tune-${index}`,
        primitive: "form",
        fallbackMarkdown: "",
        data: {
          actionId: tuneId,
          values: {
            effort: choice.effort ?? "",
            speed:
              choice.fastMode === true
                ? "fast"
                : choice.fastMode === "ultrafast"
                  ? "ultrafast"
                  : "standard",
          },
        },
      });
    });
    return {
      ref: companionModelsRef(id),
      revision: current.revision,
      display: {
        title: current.profile?.name ?? defaultsTitle,
        ...(!current.configured.length
          ? { subtitle: current.profile ? following : automatic }
          : {}),
      },
      links: [],
      actions,
      blocks,
    };
  }
  registry.register({
    collection: {
      id: "teammate-models",
      resourceKind: "teammate-models",
      title: companionModelsTitle,
      placement: "settings",
    },
    list: async () => {
      const rows = [
        { id: "defaults", name: defaultsTitle },
        ...(await host.profiles.list()).map((profile) => ({
          id: profile.id,
          name: profile.name,
        })),
      ];
      return {
        collectionId: "teammate-models",
        revision: String(settings.revision()),
        items: rows.map((row) => ({
          ref: companionModelsRef(row.id),
          revision: "",
          display: { title: row.name },
          links: [],
          actions: [],
        })),
      };
    },
    get: (_context, request) => resource(request.ref.id, request.client.locale),
    invoke: async (context, request) => {
      context.assertCurrent?.();
      if (!request.resourceRef) throw new Error("RESOURCE_NOT_FOUND");
      const id = request.resourceRef.id,
        current = await state(id);
      const [operation, revision] = request.actionId.split(":");
      if (revision !== current.revision)
        throw new Error("COMPANION_MODEL_SETTINGS_CHANGED");
      let chain: CompanionModel[];
      const input = request.input ?? {};
      if (operation === "reset") chain = [];
      else if (operation === "edit") {
        if (Object.keys(input).some((key) => !/^model[1-5]$/.test(key)))
          throw new Error("INVALID_MODEL_CHAIN");
        const options = await settings.choices(current.effective);
        chain = slots.flatMap((_, index) => {
          const value = input[`model${index + 1}`];
          if (value === undefined || value === "") return [];
          const option = options.find((option) => option.id === value);
          if (!option) throw new Error("MODEL_ROUTE_UNAVAILABLE");
          return [
            current.effective.find(
              (choice) => companionModelKey(choice) === value,
            ) ?? option.choice,
          ];
        });
      } else if (/^tune-[0-4]$/.test(operation)) {
        const index = Number(operation.slice(5));
        if (
          !current.effective[index] ||
          Object.keys(input).some(
            (key) => key !== "effort" && key !== "speed",
          ) ||
          typeof input.effort !== "string" ||
          !["standard", "fast", "ultrafast"].includes(String(input.speed))
        )
          throw new Error("INVALID_MODEL_SELECTION");
        chain = structuredClone(current.effective);
        chain[index] = {
          ...chain[index],
          effort: (input.effort || undefined) as CompanionModel["effort"],
          fastMode:
            input.speed === "ultrafast" ? "ultrafast" : input.speed === "fast",
        };
      } else throw new Error("INVALID_ACTION");
      context.assertCurrent?.();
      if (current.profile) {
        if ((await settings.state()).revision !== current.defaultsRevision)
          throw new Error("COMPANION_MODEL_SETTINGS_CHANGED");
        await host.change(
          id,
          { models: chain },
          current.profile.version,
          context.assertCurrent,
        );
      } else
        await settings.saveDefaults(
          chain,
          context.assertCurrent,
          current.defaultsRevision,
        );
      return {
        effects: [{ kind: "refresh-resource", ref: companionModelsRef(id) }],
      };
    },
  });
}
