import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { Text } from '@expo/ui/swift-ui';
import { useTranslation } from "react-i18next";
import type { MobileModelPickerListProps } from "./MobileModelPickerList";
import { ComposerNativeRow } from "./ComposerNativeRow";
import { useDraftModelMemoryVersion } from "./draftModelMemory";
import { useSessionModelMirrorVersion } from "./sessionModelMirror";
import {
  budgetDisabledHint,
  budgetRowDisabled,
  effortLabelFor,
  rowEffortOf,
  rowFastEditable,
  rowFastOn,
} from "./modelPickerRows";
import type { ProviderModelRow } from "./providerModelSections";

export function MobileModelPickerList(p: MobileModelPickerListProps) {
  const { t } = useTranslation();
  useDraftModelMemoryVersion();
  useSessionModelMirrorVersion();
  const groups = new Map<string, ProviderModelRow[]>();
  for (const row of p.providerRows) {
    const rows = groups.get(row.provider.id) ?? [];
    rows.push(row);
    groups.set(row.provider.id, rows);
  }
  if (groups.size)
    return (
      <>
        {[...groups].map(([id, rows]) => {
          const provider = rows[0].provider;
          const identity =
            provider.openAiAccount?.identity?.trim() ||
            provider.subscriptionAccount?.identity?.trim();
          return (
            <Section
              key={id}
              title={[provider.name, identity && !provider.name.includes(identity) ? identity : null].filter(Boolean).join(" · ")}
            >
              {rows.map((row) => {
                const selected =
                  row.model.id === p.activeModelId && id === p.activeSourceId;
                const blocked = budgetRowDisabled(
                  row.model.id,
                  p.apiKeyStatus ?? "unknown",
                );
                const fastEditable =
                  !!p.agentKind &&
                  rowFastEditable({
                    provider,
                    modelId: row.model.id,
                    agentKind: p.agentKind,
                    hasFastModeCap: p.capabilities?.hasFastMode === true,
                  });
                const effort = p.agentKind
                  ? rowEffortOf({
                      model: row.model,
                      providerId: id,
                      selected,
                      liveEffort: p.selectedEffort ?? "",
                      agentKind: p.agentKind,
                      memory: p.modelMemory,
                    })
                  : null;
                const fast =
                  !!p.agentKind &&
                  rowFastOn({
                    model: row.model,
                    providerId: id,
                    selected,
                    liveFastMode: p.selectedFastMode ?? false,
                    agentKind: p.agentKind,
                    fastEditable,
                    memory: p.modelMemory,
                  });
                const options =
                  !!p.agentKind &&
                  !!p.onOpenOptions &&
                  !blocked &&
                  (row.model.efforts.length > 0 || fastEditable) &&
                  (selected || !!p.modelMemory);
                const meta = [
                  provider.access?.kind === "subscription"
                    ? t("models.picker.subscriptionBadge")
                    : null,
                  effort
                    ? effortLabelFor(row.model, effort, p.capabilities ?? null)
                    : null,
                  fast ? t("models.options.fastMode") : null,
                  blocked ? budgetDisabledHint() : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <ComposerNativeRow
                    key={row.model.id}
                    title={row.model.displayName}
                    subtitle={meta}
                    selected={selected}
                    disabled={p.disabled || blocked}
                    onPress={() => p.onSelectProviderRow(row)}
                    onOptions={
                      options
                        ? () =>
                            p.onOpenOptions?.({
                              providerId: id,
                              modelId: row.model.id,
                            })
                        : undefined
                    }
                    optionsLabel={t("models.picker.configureAccessibility", {
                      model: row.model.displayName,
                    })}
                    testID={p.testID}
                  />
                );
              })}
            </Section>
          );
        })}
      </>
    );
  if (p.flatOptions.length)
    return (
      <Section>
        {p.flatOptions.map((model) => {
          const selected = model.id === p.activeModelId;
          const fastEditable =
            !!p.agentKind &&
            p.capabilities?.hasFastMode === true &&
            model.supportsFastMode === true;
          const effort = p.agentKind
            ? rowEffortOf({
                model,
                providerId: null,
                selected,
                liveEffort: p.selectedEffort ?? "",
                agentKind: p.agentKind,
              })
            : null;
          const options =
            !!p.agentKind &&
            selected &&
            !!p.onOpenOptions &&
            (model.efforts.length > 0 || fastEditable);
          return (
            <ComposerNativeRow
              key={model.id}
              title={model.label}
              subtitle={[
                effort
                  ? effortLabelFor(model, effort, p.capabilities ?? null)
                  : null,
                fastEditable && selected && p.selectedFastMode
                  ? t("models.options.fastMode")
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              selected={selected}
              disabled={p.disabled}
              onPress={() => p.onSelectFlatModel(model)}
              onOptions={
                options
                  ? () =>
                      p.onOpenOptions?.({ providerId: null, modelId: model.id })
                  : undefined
              }
              optionsLabel={t("models.picker.configureAccessibility", {
                model: model.label,
              })}
              testID={p.testID}
            />
          );
        })}
      </Section>
    );
  return (
    <Section>
      <Text>
        {p.loading
          ? (p.loadingHint ?? t("models.picker.loadingDefault"))
          : (p.emptyHint ?? t("models.picker.emptyDefault"))}
      </Text>
    </Section>
  );
}
