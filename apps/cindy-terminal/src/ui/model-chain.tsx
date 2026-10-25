import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import {
  serializeModelRoutes,
  type ModelRoute,
} from "@cindy/maker-shared/model-route";
import { resolveRemoteText } from "@cindy/device-link";
import type { TerminalClient } from "../contracts.js";
import {
  modelRouteKey,
  readModelRouteChain,
  readModelRouteChoices,
  type ModelRouteChoice,
} from "../models/routes-client.js";
import { getMessages, type Locale } from "./i18n.js";
import { terminalText } from "./input.js";
import { useInputState } from "./state.js";

const text = (
  fallback: string,
  zh: string,
  tw: string,
  ja: string,
  ko: string,
) => ({ fallback, translations: { "zh-CN": zh, "zh-TW": tw, ja, ko } });
const copy = {
  add: text("Add model", "添加模型", "新增模型", "モデルを追加", "모델 추가"),
  tune: text(
    "Model settings",
    "模型设置",
    "模型設定",
    "モデル設定",
    "모델 설정",
  ),
  remove: text(
    "Remove model",
    "移除模型",
    "移除模型",
    "モデルを削除",
    "모델 제거",
  ),
  up: text("Move up", "上移", "上移", "上へ移動", "위로 이동"),
  down: text("Move down", "下移", "下移", "下へ移動", "아래로 이동"),
  unavailable: text(
    "Unavailable",
    "不可用",
    "無法使用",
    "利用不可",
    "사용 불가",
  ),
  effort: text("Effort", "推理强度", "推理強度", "推論強度", "추론 강도"),
  speed: text("Speed", "速度", "速度", "速度", "속도"),
  automatic: text("Automatic", "自动", "自動", "自動", "자동"),
  standard: text("Standard", "标准", "標準", "標準", "표준"),
  fast: text("Fast", "快速", "快速", "高速", "빠름"),
  ultrafast: text("Ultrafast", "超快", "超快", "超高速", "초고속"),
};
type Stage = "chain" | "route" | "models" | "effort" | "speed";
export function ModelChainEditor({
  client,
  device,
  locale,
  value,
  single,
  onDone,
  onCancel,
}: {
  client: TerminalClient;
  device?: string;
  locale: Locale;
  value: unknown;
  single: boolean;
  onDone(value: string): void;
  onCancel(): void;
}) {
  const t = getMessages(locale),
    txt = (key: keyof typeof copy) => resolveRemoteText(copy[key], locale);
  const { rows, columns } = useWindowSize();
  const [chain, setChain] = useState<ModelRoute[]>([]);
  const [options, setOptions] = useState<ModelRouteChoice[]>([]);
  const [stage, setStage] = useState<Stage>("chain");
  const [slot, setSlot] = useState(0);
  const [draft, setDraft] = useState<ModelRoute>();
  const [selected, setSelected, selectedNow] = useInputState(0);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const [valid, setValid] = useState(false);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    setValid(false);
    setOptions([]);
    void (async () => {
      const parsed = readModelRouteChain(value);
      if (single && parsed.length > 1) throw new Error("INVALID_MODEL_CHAIN");
      if (!active) return;
      setChain(parsed);
      setValid(true);
      const choices = await readModelRouteChoices(client, device);
      if (active) setOptions(choices);
    })()
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error && /^[A-Z_]+$/.test(reason.message)
              ? reason.message
              : "MODEL_CATALOG_UNAVAILABLE",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, device, value, single]);
  function go(next: Stage, index = 0) {
    setStage(next);
    setSelected(index);
    setQuery("");
  }
  function pickModel(index: number) {
    setSlot(index);
    setDraft(chain[index]);
    go("models");
  }
  const option = draft
    ? options.find((option) => option.key === modelRouteKey(draft))
    : undefined;
  const modelChoices = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const entry = (title: string, run: () => void) => ({
    title: terminalText(title),
    run,
  });
  const chainRows = [
    ...chain.map((route, index) => {
      const choice = options.find(
        (option) => option.key === modelRouteKey(route),
      );
      const title = [
        `${index + 1}. ${choice?.label ?? [route.agentDeviceId, route.providerId, route.harness, route.model].filter(Boolean).join(" · ")}`,
        route.effort,
        route.fastMode
          ? txt(route.fastMode === "ultrafast" ? "ultrafast" : "fast")
          : "",
        choice ? "" : txt("unavailable"),
      ]
        .filter(Boolean)
        .join(" · ");
      return entry(title, () => {
        setSlot(index);
        setDraft(route);
        go("route");
      });
    }),
    ...(chain.length < (single ? 1 : 5)
      ? [entry(`+ ${txt("add")}`, () => pickModel(chain.length))]
      : []),
    entry(t.done, () => onDone(serializeModelRoutes(chain))),
  ];
  const routeRows = [
    entry(t.models, () => pickModel(slot)),
    entry(txt("tune"), () => {
      if (option) go("effort");
      else setError("MODEL_ROUTE_UNAVAILABLE");
    }),
    ...(slot > 0
      ? [
          entry(txt("up"), () => {
            const next = [...chain];
            [next[slot - 1], next[slot]] = [next[slot], next[slot - 1]];
            setChain(next);
            go("chain", slot - 1);
          }),
        ]
      : []),
    ...(slot < chain.length - 1
      ? [
          entry(txt("down"), () => {
            const next = [...chain];
            [next[slot + 1], next[slot]] = [next[slot], next[slot + 1]];
            setChain(next);
            go("chain", slot + 1);
          }),
        ]
      : []),
    entry(txt("remove"), () => {
      setChain(chain.filter((_, index) => index !== slot));
      go("chain");
    }),
  ];
  const efforts = ["", ...(option?.efforts ?? [])];
  const speeds: Array<ModelRoute["fastMode"]> = [
    false,
    ...(option?.fast ? [true] : []),
    ...(option?.fast && option.ultrafast ? ["ultrafast" as const] : []),
  ];
  const choices =
    stage === "chain"
      ? chainRows
      : stage === "route"
        ? routeRows
        : stage === "models"
          ? modelChoices.map((choice) =>
              entry(choice.label, () => {
                if (
                  chain.some(
                    (route, index) =>
                      index !== slot && modelRouteKey(route) === choice.key,
                  )
                ) {
                  setError("DUPLICATE_MODEL_ROUTE");
                  return;
                }
                const next =
                  draft && modelRouteKey(draft) === choice.key
                    ? draft
                    : choice.route;
                setDraft(next);
                setError("");
                go(
                  "effort",
                  Math.max(0, ["", ...choice.efforts].indexOf(next.effort)),
                );
              }),
            )
          : stage === "effort"
            ? efforts.map((effort) =>
                entry(effort || txt("automatic"), () => {
                  if (draft) {
                    setDraft({ ...draft, effort });
                    go("speed", Math.max(0, speeds.indexOf(draft.fastMode)));
                  }
                }),
              )
            : speeds.map((speed) =>
                entry(
                  txt(
                    speed === "ultrafast"
                      ? "ultrafast"
                      : speed
                        ? "fast"
                        : "standard",
                  ),
                  () => {
                    if (draft) {
                      const next = [...chain];
                      next[slot] = { ...draft, fastMode: speed };
                      setChain(next);
                      go("chain", slot);
                    }
                  },
                ),
              );
  useInput((input, key) => {
    if (key.eventType === "release" || busy) return;
    if (key.escape) {
      if (query) {
        setQuery("");
        setSelected(0);
      } else if (stage === "chain") onCancel();
      else go("chain", Math.min(slot, chain.length));
      return;
    }
    if (!valid) return;
    if (
      stage === "models" &&
      (key.backspace ||
        (!key.ctrl &&
          !key.meta &&
          !key.tab &&
          !key.return &&
          !key.upArrow &&
          !key.downArrow &&
          input))
    ) {
      setQuery((current) =>
        key.backspace
          ? Array.from(current).slice(0, -1).join("")
          : current + terminalText(input),
      );
      setSelected(0);
      return;
    }
    if (key.upArrow) setSelected((index) => Math.max(0, index - 1));
    if (key.downArrow)
      setSelected((index) => Math.min(choices.length - 1, index + 1));
    if (key.return) choices[selectedNow.current]?.run();
  });
  const limit = Math.max(2, Math.floor((rows - 12) / 2)),
    start = Math.max(
      0,
      Math.min(selected - Math.floor(limit / 2), choices.length - limit),
    );
  const title =
    stage === "effort"
      ? txt("effort")
      : stage === "speed"
        ? txt("speed")
        : t.models;
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {title}
        {busy ? ` · ${t.loading}` : ""}
      </Text>
      {stage === "models" && (
        <Text dimColor>
          {t.search}
          {query ? ` · ${query}` : ""}
        </Text>
      )}
      {!busy &&
        valid &&
        choices.slice(start, start + limit).map((choice, index) => (
          <Text
            key={`${stage}-${start + index}`}
            bold={selected === start + index}
            wrap="truncate-end"
          >
            {selected === start + index ? "› " : "  "}
            {choice.title}
          </Text>
        ))}
      {!busy && valid && choices.length === 0 && (
        <Text dimColor>{t.noModel}</Text>
      )}
      {error && (
        <Text color="red">
          {t.error} · {error}
        </Text>
      )}
      {!busy && stage === "models" && modelChoices[selected] && (
        <Text dimColor>
          {terminalText(modelChoices[selected].label).slice(
            0,
            Math.max(columns * 2, 40),
          )}
        </Text>
      )}
    </Box>
  );
}
