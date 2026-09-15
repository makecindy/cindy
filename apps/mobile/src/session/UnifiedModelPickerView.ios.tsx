import {
  Button,
  HStack,
  Picker,
  ProgressView,
  RNHostView,
  VStack,
  Text,
  TextField,
  Toggle,
  useNativeState,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  frame,
  pickerStyle,
  progressViewStyle,
  tint,
  tag,
  padding,
  autocorrectionDisabled,
  textInputAutocapitalization,
  lineLimit,
} from "@expo/ui/swift-ui/modifiers";
import {
  Check,
  SlidersHorizontal,
  Star,
  Zap,
  Search,
  X,
  LayoutGrid,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { iconSize, useTheme } from "@/theme";
import { MobileAgentMark } from "@/components/MobileAgentMark";
import { ComposerSheet } from "./ComposerSheet";
import { ComposerNativeSection as Section } from "./ComposerNativeSection";
import { ComposerNativeRow } from "./ComposerNativeRow";
import { MobileModelIconMark, MobileProviderMark } from "./MobileProviderMark";
import { mobileAgentLabel } from "./sessionAgentSwitch";
import type { UnifiedMobilePickerViewProps } from "./UnifiedModelPickerSheet";

function NativeMark({ children }: { children: ReactNode }) {
  return (
    <RNHostView matchContents>
      <View
        pointerEvents="none"
        style={{
          width: 24,
          height: 24,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </View>
    </RNHostView>
  );
}

export function UnifiedModelPickerView(p: UnifiedMobilePickerViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [page, setPage] = useState<"sources" | "harness" | null>(null);
  useEffect(() => {
    setPage(null);
  }, [p.visible, p.options?.row.key]);
  const mark = (Icon: typeof Star, filled = false) => (
    <NativeMark>
      <Icon
        size={iconSize.action}
        color={colors.textSecondary}
        fill={filled ? colors.textSecondary : "none"}
      />
    </NativeMark>
  );
  const search = useNativeState(p.query);
  useEffect(() => {
    if (search.get() !== p.query) search.set(p.query);
  }, [p.query, search]);
  const options = p.options;
  const config = options?.row.config;
  const level = (id: string) =>
    t(`models.options.effortLevels.${id}`, { defaultValue: id });
  return (
    <ComposerSheet
      nativeContent
      visible={p.visible}
      onClose={p.onClose}
      onBack={page ? () => setPage(null) : p.onBack}
      backLabel={t("models.picker.backToModels")}
      title={
        page === "sources"
          ? t("models.unified.source")
          : page === "harness"
            ? t("models.unified.harness")
            : p.title
      }
      testID={p.testID}
      nativeHeader={
        !options && !page ? (
          <HStack
            spacing={12}
            modifiers={[padding({ horizontal: 20, bottom: 4 })]}
          >
            {mark(Search)}
            <TextField
              text={search}
              onTextChange={p.onQuery}
              placeholder={t("models.picker.searchPlaceholder")}
              modifiers={[
                frame({ maxWidth: Infinity, minHeight: 44 }),
                autocorrectionDisabled(),
                textInputAutocapitalization("never"),
              ]}
              testID={`${p.testID}.search`}
            />
            {p.query ? (
              <Button
                onPress={() => p.onQuery("")}
                modifiers={[
                  buttonStyle("plain"),
                  accessibilityLabel(t("devices.detail.search.clearA11y")),
                ]}
              >
                <HStack modifiers={[frame({ width: 44, height: 44 })]}>
                  {mark(X)}
                </HStack>
              </Button>
            ) : null}
            <Button
              onPress={() => setPage("sources")}
              modifiers={[
                buttonStyle("plain"),
                frame({ maxWidth: 120, minHeight: 44 }),
                accessibilityLabel(t("models.unified.source")),
              ]}
              testID={`${p.testID}.filter`}
            >
              <HStack>
                {p.filter === "favorites" ? (
                  mark(Star, true)
                ) : p.filter === "all" ? (
                  mark(LayoutGrid)
                ) : (
                  <NativeMark>
                    <MobileProviderMark
                      {...p.filters.find((item) => item.id === p.filter)
                        ?.providerMark}
                      name={
                        p.filters.find((item) => item.id === p.filter)
                          ?.providerMark?.name ?? ""
                      }
                    />
                  </NativeMark>
                )}
                <Text modifiers={[lineLimit(1)]}>
                  {p.filters.find((item) => item.id === p.filter)?.label}
                </Text>
              </HStack>
            </Button>
          </HStack>
        ) : undefined
      }
    >
      {p.error ? (
        <Section>
          <Text modifiers={[foregroundStyle(colors.errorText)]}>{p.error}</Text>
        </Section>
      ) : null}
      {page === "sources" ? (
        <Section>
          {p.filters.map((item) => (
            <ComposerNativeRow
              key={item.id}
              title={item.label}
              subtitle={item.quota?.label}
              testID={`${p.testID}.source.${item.id}`}
              selected={p.filter === item.id}
              selectionIcon={mark(Check)}
              leading={
                item.providerMark ? (
                  <VStack spacing={2}>
                    <NativeMark>
                      <MobileProviderMark {...item.providerMark} />
                    </NativeMark>
                    {item.quota ? (
                      <ProgressView
                        value={item.quota.remaining / 100}
                        modifiers={[
                          progressViewStyle("linear"),
                          frame({ width: 24 }),
                          tint(colors.textSecondary),
                          accessibilityLabel(item.quota.label),
                        ]}
                        testID={`${p.testID}.source.${item.id}.quota`}
                      />
                    ) : null}
                  </VStack>
                ) : (
                  mark(
                    item.id === "favorites" ? Star : LayoutGrid,
                    item.id === "favorites" && p.filter === "favorites",
                  )
                )
              }
              onPress={() => {
                p.onFilter(item.id);
                setPage(null);
              }}
            />
          ))}
        </Section>
      ) : page === "harness" && options && config ? (
        <Section>
          {options.agents.map((agent) => (
            <ComposerNativeRow
              key={agent}
              title={mobileAgentLabel(agent)}
              leading={
                <NativeMark>
                  <MobileAgentMark
                    agentKind={agent}
                    color={colors.textSecondary}
                  />
                </NativeMark>
              }
              selected={config.agent === agent}
              selectionIcon={mark(Check)}
              disabled={p.busy}
              onPress={() => {
                const cap = options.row.entry.capabilities[agent];
                if (!cap) return;
                options.onChange({
                  ...config,
                  agent,
                  modelId: cap.wireModelId,
                  effort: cap.defaultEffort ?? cap.efforts[0] ?? "",
                  fast: false,
                });
                setPage(null);
              }}
            />
          ))}
        </Section>
      ) : options && config ? (
        <>
          <Section>
            <Text
              modifiers={[
                foregroundStyle(colors.textSecondary),
                font({ textStyle: "footnote" }),
              ]}
            >
              {options.context}
            </Text>
          </Section>
          <Section>
            <ComposerNativeRow
              title={t("models.unified.harness")}
              subtitle={mobileAgentLabel(config.agent)}
              leading={
                <NativeMark>
                  <MobileAgentMark
                    agentKind={config.agent}
                    color={colors.textSecondary}
                  />
                </NativeMark>
              }
              onPress={() => setPage("harness")}
              disabled={p.busy}
              testID={`${p.testID}.harness`}
            />
            {options.row.entry.capabilities[config.agent]?.efforts.length ? (
              <Picker
                label={t("models.options.reasoningEffort")}
                selection={config.effort}
                onSelectionChange={(effort: string) =>
                  options.onChange({ ...config, effort })
                }
                modifiers={[pickerStyle("menu"), disabled(p.busy)]}
                testID={`${p.testID}.effort`}
              >
                {options.row.entry.capabilities[config.agent]!.efforts.map(
                  (effort) => (
                    <Text key={effort} modifiers={[tag(effort)]}>
                      {level(effort)}
                    </Text>
                  ),
                )}
              </Picker>
            ) : null}
            {options.fastCapable ? (
              <HStack>
                {mark(Zap, true)}
                <Toggle
                  label={t("models.options.fastMode")}
                  isOn={config.fast}
                  onIsOnChange={(fast) => options.onChange({ ...config, fast })}
                  modifiers={[disabled(p.busy)]}
                  testID={`${p.testID}.fast`}
                />
              </HStack>
            ) : null}
          </Section>
          {options.price ? (
            <Section>
              <Text
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {options.price}
              </Text>
            </Section>
          ) : null}
          <Section>
            <ComposerNativeRow
              title={t(
                options.row.favorite
                  ? "models.unified.removeFavorite"
                  : "models.unified.addFavorite",
              )}
              leading={mark(Star, !!options.row.favorite)}
              disabled={p.busy}
              onPress={options.onFavorite}
              testID={`${p.testID}.favorite`}
            />
            {!options.row.favorite ? (
              <ComposerNativeRow
                title={t("models.unified.restoreRecommended")}
                disabled={p.busy}
                onPress={options.onReset}
                testID={`${p.testID}.reset`}
              />
            ) : null}
          </Section>
        </>
      ) : (
        <>
          {p.groups.map((group) => (
            <Section key={group.key} title={group.title}>
              {group.rows.map((row) => (
                <ComposerNativeRow
                  key={row.key}
                  title={row.entry.displayName}
                  subtitle={[
                    mobileAgentLabel(row.config.agent),
                    row.subtitle,
                    row.quotaLabel,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  titleAccessory={
                    <HStack spacing={4}>
                      {row.costMarks ? (
                        <Text
                          modifiers={[
                            font({ textStyle: "caption" }),
                            foregroundStyle(colors.textSecondary),
                          ]}
                        >
                          {row.costMarks}
                        </Text>
                      ) : null}
                      <RNHostView matchContents>
                        <View
                          pointerEvents="none"
                          style={{ width: iconSize.sm, height: iconSize.sm }}
                        >
                          <MobileAgentMark
                            agentKind={row.config.agent}
                            color={colors.textSecondary}
                          />
                        </View>
                      </RNHostView>
                      {row.effortLabel ? (
                        <Text
                          modifiers={[
                            font({ textStyle: "caption" }),
                            foregroundStyle(colors.textSecondary),
                          ]}
                        >
                          {row.effortLabel}
                        </Text>
                      ) : null}
                      {row.config.fast ? mark(Zap, true) : null}
                    </HStack>
                  }
                  subtitleContent={
                    <VStack alignment="leading" spacing={2}>
                      <Text
                        modifiers={[
                          font({ textStyle: "caption" }),
                          foregroundStyle(colors.textSecondary),
                        ]}
                      >
                        {row.subtitle}
                      </Text>
                      {row.quotaLabel ? (
                        <Text
                          modifiers={[
                            font({ textStyle: "caption2" }),
                            foregroundStyle(colors.textTertiary),
                          ]}
                        >
                          {row.quotaLabel}
                        </Text>
                      ) : null}
                    </VStack>
                  }
                  leading={
                    <RNHostView matchContents>
                      <View
                        style={{
                          width: 28,
                          height: 28,
                          justifyContent: "center",
                        }}
                      >
                        <MobileModelIconMark
                          icon={row.entry.icon}
                          {...row.providerMark}
                          color={colors.textSecondary}
                        />
                      </View>
                    </RNHostView>
                  }
                  optionsIcon={mark(SlidersHorizontal)}
                  selectionIcon={mark(Check)}
                  accessory={row.favorite ? mark(Star, true) : undefined}
                  selected={row.selected}
                  disabled={p.busy || row.disabled}
                  onPress={() => p.onSelect(row)}
                  onOptions={() => p.onOptions(row)}
                  optionsLabel={t("models.picker.configureAccessibility", {
                    model: row.entry.displayName,
                  })}
                  testID={`${p.testID}.model.${row.key}`}
                />
              ))}
            </Section>
          ))}
          {!p.groups.length ? (
            <Section>
              <Text modifiers={[foregroundStyle(colors.textSecondary)]}>
                {p.loading ? t("models.picker.loadingDefault") : p.emptyHint}
              </Text>
            </Section>
          ) : null}
        </>
      )}
    </ComposerSheet>
  );
}
