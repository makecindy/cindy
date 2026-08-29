/**
 * ModelOptionsSheetView —— 模型浮窗二级「模型选项」视图的内容(SheetSurface 的 children)。
 *
 * 承接原先行内 accordion 的配置区语义:顶部元信息行(供应商全名 · 上下文 · 单价 · 极速,
 * 对齐桌面 hover tooltip 口径)+ 「快速模式」Switch + 「推理强度」竖排单选。
 * 读写语义与桌面完全一致:目标行是**选中行** → 改 live(onChangeSelectedEffort/FastMode);
 * **非选中行** → 写注入记忆(草稿 = draftModelMemory / 会话 = sessionModelMirror 写穿被控端)。
 * effort 点击后停留(可连续调 Fast),返回/把手下拉由浮窗层负责。
 */
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { Check } from "lucide-react-native";
import { NativeSwitch } from "@/platform/chrome";

import type { MobileAgentCapabilities } from "@/session/agentCapabilities";
import type { MobileModelPricingMap } from "@/device-link/mobileMakerTransport";
import type { ProviderView } from "@cindy/model-providers/registry";
import type { AgentKind } from "@cindy/model-providers/types";
import type { MobileModelMemoryAccessors } from "@/session/draftModelMemory";
import { useDraftModelMemoryVersion } from "@/session/draftModelMemory";
import { useSessionModelMirrorVersion } from "@/session/sessionModelMirror";
import {
  buildRowMetaLine,
  effortLabelFor,
  rowEffortOf,
  rowFastOn,
  type PickerRowModel,
} from "@/session/modelPickerRows";
import {
  iconSize,
  iconStroke,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from "@/theme/tokens";

export interface ModelOptionsSheetViewProps {
  /** 目标行模型(SheetSurface 标题已是 displayName,这里只消费元数据)。 */
  model: PickerRowModel;
  /** 目标行来源(flat 回退为 null → 元信息省略供应商名)。 */
  provider: ProviderView | null;
  providerId: string | null;
  displayName: string;
  /** 上下文窗口(flat 回退无数据传 0,元信息自动省略)。 */
  contextWindow: number;
  /** 目标行是否为当前选中行(live vs 记忆的分界)。 */
  selected: boolean;
  selectedEffort: string;
  selectedFastMode: boolean;
  onChangeSelectedEffort?(effort: string): void;
  onChangeSelectedFastMode?(enabled: boolean): void | Promise<void>;
  modelMemory?: MobileModelMemoryAccessors;
  agentKind: AgentKind;
  capabilities: MobileAgentCapabilities | null;
  /** 调用方用 rowFastEditable 算好传入(agent gate × 该 (来源, 模型) supportsFastMode)。 */
  fastEditable: boolean;
  pricing?: MobileModelPricingMap | null;
  disabled?: boolean;
  testID?: string;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    metaLine: {
      color: c.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingBottom: spacing.sm,
      paddingTop: spacing.xs,
    },
    // 与推理强度选项行同一水平内边距(effortOptionRow 的 pill 内距):
    // label 与选项文字左对齐,Switch 与选项行的 Check 右对齐。
    fastRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 48,
      paddingHorizontal: spacing.sm,
    },
    fastRowLabel: {
      color: c.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    divider: {
      backgroundColor: c.border,
      height: StyleSheet.hairlineWidth,
    },
    sectionLabel: {
      color: c.textTertiary,
      fontSize: typeScale.footnote,
      paddingBottom: spacing.xs,
      paddingTop: spacing.lg,
    },
    effortOptionRow: {
      alignItems: "center",
      borderRadius: radius.pill,
      flexDirection: "row",
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.sm,
    },
    effortOptionRowSelected: {
      backgroundColor: c.surfaceChip,
    },
    effortOptionText: {
      color: c.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      minWidth: 0,
    },
  });

export function ModelOptionsSheetView({
  model,
  provider,
  providerId,
  displayName,
  contextWindow,
  selected,
  selectedEffort,
  selectedFastMode,
  onChangeSelectedEffort,
  onChangeSelectedFastMode,
  modelMemory,
  agentKind,
  capabilities,
  fastEditable,
  pricing = null,
  disabled = false,
  testID = "modelOptions",
}: ModelOptionsSheetViewProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // 非选中行的写入落在记忆 store(不回流 props)—— 订阅版本号即时刷新当前值显示。
  const storeVersion =
    useDraftModelMemoryVersion() + useSessionModelMirrorVersion();
  void storeVersion;

  const metaLine = buildRowMetaLine({
    provider,
    model: {
      id: model.id,
      contextWindow,
      supportsFastMode: model.supportsFastMode,
    },
    pricing,
  });
  const currentEffort = rowEffortOf({
    model,
    providerId,
    selected,
    liveEffort: selectedEffort,
    agentKind,
    memory: modelMemory,
  });
  const fastOn = rowFastOn({
    model,
    providerId,
    selected,
    liveFastMode: selectedFastMode,
    agentKind,
    fastEditable,
    memory: modelMemory,
  });

  const setEffort = (effort: string): void => {
    if (selected) {
      onChangeSelectedEffort?.(effort);
      return;
    }
    if (providerId)
      modelMemory?.setEffort(agentKind, providerId, model.id, effort);
  };
  const setFast = (enabled: boolean): void => {
    if (selected) {
      void onChangeSelectedFastMode?.(enabled);
      return;
    }
    if (providerId)
      modelMemory?.setFast(agentKind, providerId, model.id, enabled);
  };

  const hasEfforts = model.efforts.length > 0;

  return (
    <View testID={testID}>
      {metaLine ? (
        <Text style={styles.metaLine} testID={`${testID}.meta`}>
          {metaLine}
        </Text>
      ) : null}
      {fastEditable ? (
        <View style={styles.fastRow}>
          <Text style={styles.fastRowLabel}>
            {t("models.options.fastMode")}
          </Text>
          <NativeSwitch
            accessibilityLabel={t("models.options.fastMode")}
            disabled={disabled}
            onValueChange={setFast}
            seedColor={colors.cta}
            testID={`${testID}.fastToggle`}
            value={fastOn}
          />
        </View>
      ) : null}
      {fastEditable && hasEfforts ? <View style={styles.divider} /> : null}
      {hasEfforts ? (
        <>
          <Text style={styles.sectionLabel}>
            {t("models.options.reasoningEffort")}
          </Text>
          {model.efforts.map((effortId) => {
            const effortSelected = effortId === currentEffort;
            const label = effortLabelFor(model, effortId, capabilities);
            return (
              <Pressable
                accessibilityLabel={t(
                  "models.options.reasoningEffortAccessibility",
                  { label },
                )}
                accessibilityRole="button"
                accessibilityState={{ selected: effortSelected, disabled }}
                disabled={disabled}
                key={effortId}
                onPress={() => setEffort(effortId)}
                style={({ pressed }) => [
                  styles.effortOptionRow,
                  effortSelected && styles.effortOptionRowSelected,
                  pressed && { opacity: 0.65 },
                ]}
                testID={`${testID}.effortOption`}
              >
                <Text numberOfLines={1} style={styles.effortOptionText}>
                  {label}
                </Text>
                {effortSelected ? (
                  <Check
                    color={colors.textPrimary}
                    size={iconSize.lg}
                    strokeWidth={iconStroke.medium}
                  />
                ) : null}
              </Pressable>
            );
          })}
        </>
      ) : null}
    </View>
  );
}
