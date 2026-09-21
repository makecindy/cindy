import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { Text, Toggle } from '@expo/ui/swift-ui';
import { disabled } from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import type { ModelOptionsSheetViewProps } from "./ModelOptionsSheetView";
import { ComposerNativeRow } from "./ComposerNativeRow";
import { useDraftModelMemoryVersion } from "./draftModelMemory";
import { useSessionModelMirrorVersion } from "./sessionModelMirror";
import {
  buildRowMetaLine,
  effortLabelFor,
  presentPickerPrice,
  rowEffortOf,
  rowFastOn,
} from "./modelPickerRows";
export function ModelOptionsSheetView(p: ModelOptionsSheetViewProps) {
  const { t } = useTranslation();
  useDraftModelMemoryVersion();
  useSessionModelMirrorVersion();
  const meta = buildRowMetaLine({
    provider: p.provider,
    model: {
      id: p.model.id,
      contextWindow: p.contextWindow,
      supportsFastMode: p.model.supportsFastMode,
    },
  });
  const price = presentPickerPrice({
    pricing: p.pricing ?? null,
    provider: p.provider,
    modelId: p.model.id,
    agentKind: p.agentKind,
  });
  const effort = rowEffortOf({
    model: p.model,
    providerId: p.providerId,
    selected: p.selected,
    liveEffort: p.selectedEffort,
    agentKind: p.agentKind,
    memory: p.modelMemory,
  });
  const fast = rowFastOn({
    model: p.model,
    providerId: p.providerId,
    selected: p.selected,
    liveFastMode: p.selectedFastMode,
    agentKind: p.agentKind,
    fastEditable: p.fastEditable,
    memory: p.modelMemory,
  });
  return (
    <>
      {meta || price ? (
        <Section>
          {meta ? <Text>{meta}</Text> : null}
          {price ? (
            <>
              <Text>
                {[price.title, price.discountLabel].filter(Boolean).join(" · ")}
              </Text>
              <Text>{price.amountsLine}</Text>
            </>
          ) : null}
        </Section>
      ) : null}
      {p.fastEditable ? (
        <Section>
          <Toggle
            label={t("models.options.fastMode")}
            isOn={fast}
            onIsOnChange={(value) => {
              if (p.selected) void p.onChangeSelectedFastMode?.(value);
              else if (p.providerId)
                p.modelMemory?.setFast(
                  p.agentKind,
                  p.providerId,
                  p.model.id,
                  value,
                );
            }}
            modifiers={[disabled(!!p.disabled)]}
            testID={`${p.testID}.fastToggle`}
          />
        </Section>
      ) : null}
      {p.model.efforts.length ? (
        <Section title={t("models.options.reasoningEffort")}>
          {p.model.efforts.map((id) => (
            <ComposerNativeRow
              key={id}
              title={effortLabelFor(p.model, id, p.capabilities)}
              selected={id === effort}
              disabled={p.disabled}
              onPress={() => {
                if (p.selected) p.onChangeSelectedEffort?.(id);
                else if (p.providerId)
                  p.modelMemory?.setEffort(
                    p.agentKind,
                    p.providerId,
                    p.model.id,
                    id,
                  );
              }}
              testID={`${p.testID}.effortOption`}
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}
