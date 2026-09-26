/**
 * 预设推荐模型的单一清单 → 各引擎清单。
 *
 * 目录源数据只在预设顶层写一份 `models`（数组顺序即推荐顺序），加载时展开进每个
 * `runtimes[agent].models`：`engines` 限定可用引擎，`engineOverrides[agent]` 覆盖该引擎
 * 的专属字段（如 Pi 的推理档位）。展开后删除顶层 `models`，下游与服务端下发的旧格式
 * 形状一致。顶层没有 `models` 的旧格式原样返回。纯函数，只处理形状，校验仍由
 * `sanitizePresets` 负责。
 */
import type { AgentKind } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const AGENT_KINDS: readonly AgentKind[] = ["claude-code", "codex", "pi"];

function isAgentKind(value: unknown): value is AgentKind {
  return (
    typeof value === "string" &&
    (AGENT_KINDS as readonly string[]).includes(value)
  );
}

function isDeclared(agent: unknown, declaredRuntimes: readonly string[]) {
  return isAgentKind(agent) && declaredRuntimes.includes(agent);
}

/**
 * 引擎限定字段是否畸形。不变量：`engines` 的每一项与 `engineOverrides` 的每个键都必须是
 * 本预设已声明的 runtime（`engines` 非空）——否则模型会被静默抹掉，或专属覆盖被静默忽略。
 */
function hasMalformedEngineFields(
  model: unknown,
  declaredRuntimes: readonly string[],
): boolean {
  if (!isPlainObject(model)) return false;
  const { engines, engineOverrides } = model;
  if (
    engines !== undefined &&
    (!Array.isArray(engines) ||
      engines.length === 0 ||
      !engines.every((agent) => isDeclared(agent, declaredRuntimes)))
  ) {
    return true;
  }
  return (
    engineOverrides !== undefined &&
    (!isPlainObject(engineOverrides) ||
      !Object.entries(engineOverrides).every(
        ([agent, override]) =>
          isDeclared(agent, declaredRuntimes) && isPlainObject(override),
      ))
  );
}

export function expandPresetModels<T>(preset: T): T {
  if (!preset || typeof preset !== "object" || Array.isArray(preset))
    return preset;
  const source = preset as Record<string, unknown>;
  if (!Array.isArray(source.models)) return preset;
  const models = source.models as unknown[];
  const runtimes =
    source.runtimes &&
    typeof source.runtimes === "object" &&
    !Array.isArray(source.runtimes)
      ? (source.runtimes as Record<string, unknown>)
      : {};
  // 引擎限定字段畸形时不展开，保留顶层 `models`，由 `sanitizePresets` 整条拒绝。
  const declaredRuntimes = Object.keys(runtimes);
  if (models.some((model) => hasMalformedEngineFields(model, declaredRuntimes)))
    return preset;
  const expanded = Object.fromEntries(
    Object.entries(runtimes).map(([agent, runtime]) => {
      if (!runtime || typeof runtime !== "object" || Array.isArray(runtime))
        return [agent, runtime];
      const list = models.flatMap((model) => {
        // 坏条目原样交给校验层拒绝，不在这里静默丢弃。
        if (!model || typeof model !== "object" || Array.isArray(model))
          return [model];
        const { engines, engineOverrides, ...shared } = model as Record<
          string,
          unknown
        >;
        if (Array.isArray(engines) && !engines.includes(agent)) return [];
        const override =
          engineOverrides &&
          typeof engineOverrides === "object" &&
          !Array.isArray(engineOverrides)
            ? (engineOverrides as Record<string, unknown>)[agent]
            : undefined;
        return [
          {
            ...shared,
            ...(override &&
            typeof override === "object" &&
            !Array.isArray(override)
              ? override
              : {}),
          },
        ];
      });
      return [agent, { ...runtime, models: list }];
    }),
  );
  const { models: _models, ...rest } = source;
  return { ...rest, runtimes: expanded } as T;
}
