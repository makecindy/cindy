/**
 * MobileModelPickerList —— 旧版模型浮窗一级视图的行列表(统一选择器不可用时的回退路径,
 * 由 ModelPickerSheet 装配;iOS 见 MobileModelPickerList.ios.tsx)。
 *
 * 信息结构与 iOS 同构:按来源分组,分组标题「来源 · 账号」;每行 = 来源官方 mark(Cindy 业务
 * 图标,保留)+ 模型名 + 副行「订阅 · 强度 · Fast」(折扣版缺 key 时追加提示)+ 选中勾号 +
 * 行内「配置」入口(打开二级「模型选项」,见 ModelOptionsSheetView)。选中只用勾号表达,不铺整行底色。
 *
 * 三态:① 供应商分组(providerRows 非空,选行 = 选「来源 + 模型」);② 扁平回退(flatOptions,
 * 旧被控端,无来源 mark、无记忆,仅选中行可配置);③ 空 → 加载中 / 暂无文案。
 *
 * 不含 ScrollView —— 由 SheetSurface 的滚动区承载。行显示逻辑在 modelPickerRows.ts
 * (纯逻辑可单测),本组件只做渲染。
 */
import { useRef } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { Check, SlidersHorizontal } from 'lucide-react-native';

import type { MobileAgentCapabilities, MobileModelOption } from '@/session/agentCapabilities';
import type { DeviceApiKeyStatus } from '@/device-link/deviceModelMetaCache';
import type { AgentKind } from '@cindy/model-providers/types';
import { MobileModelIconMark } from '@/session/MobileProviderMark';
import type { MobileModelMemoryAccessors } from '@/session/draftModelMemory';
import { useDraftModelMemoryVersion } from '@/session/draftModelMemory';
import { useSessionModelMirrorVersion } from '@/session/sessionModelMirror';
import {
  budgetDisabledHint,
  budgetRowDisabled,
  effortLabelFor,
  modelRowAccessibilityLabel,
  rowEffortOf,
  rowFastEditable,
  rowFastOn,
} from '@/session/modelPickerRows';
import type { ProviderModelRow } from '@/session/providerModelSections';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';

/** 行内配置入口的目标(providerId null = flat 行)。 */
export interface ModelOptionsOpenTarget {
  providerId: string | null;
  modelId: string;
}

export interface MobileModelPickerListProps {
  /** 被控端供应商分段平铺出来的行(非空 = provider-aware 模式)。 */
  providerRows: readonly ProviderModelRow[];
  /** 0 供应商时的扁平回退列表(capabilities.availableModels)。 */
  flatOptions: readonly MobileModelOption[];
  /** 当前会话/草稿的模型 id。 */
  activeModelId: string;
  /** 当前高亮的来源 id(provider-aware 模式下与 activeModelId 一起决定选中行)。 */
  activeSourceId: string | null;
  loading?: boolean;
  disabled?: boolean;
  emptyHint?: string;
  loadingHint?: string;
  onSelectProviderRow(row: ProviderModelRow): void;
  onSelectFlatModel(option: MobileModelOption): void;
  rowStyle?: StyleProp<ViewStyle>;
  testID?: string;
  /** ── 以下全部可选:传齐才启用行内 effort/Fast 展示与配置入口 ── */
  /** 当前列表的 agent(effort 标签 / fast 门控 / 记忆读取都按它取)。 */
  agentKind?: AgentKind;
  /** 该 agent 的被控端 capabilities(effortLevels 标签 + hasFastMode 粗粒度 gate)。 */
  capabilities?: MobileAgentCapabilities | null;
  /** 选中行 live effort(草稿 = draft.effort / 会话 = session.effort)。 */
  selectedEffort?: string;
  /** 选中行 live fast(草稿 = draft.fastMode / 会话 = session.fastMode)。 */
  selectedFastMode?: boolean;
  /** 非选中行 effort/fast 记忆读取器(草稿 = draftModelMemory / 会话 = sessionModelMirror)。 */
  modelMemory?: MobileModelMemoryAccessors;
  /** 被控端网关 key presence('absent' 才置灰折扣版,缺省 'unknown' 不置灰)。 */
  apiKeyStatus?: DeviceApiKeyStatus;
  /** 行内配置图标点击(打开二级「模型选项」浮窗);不传则不显示配置入口。 */
  onOpenOptions?(target: ModelOptionsOpenTarget): void;
  /** 选中行 onLayout 的 y 上报(浮窗打开时滚动到选中行)。 */
  onSelectedRowLayout?(y: number): void;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // 分组节奏与 ContextSheetGroup 一致:小标题 + 行间 hairline;选中只用勾号表达(对齐 iOS)。
    group: {
      paddingTop: spacing.lg,
    },
    groupLabel: {
      color: c.textTertiary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.caption,
      paddingBottom: spacing.xs,
    },
    separator: {
      backgroundColor: c.border,
      height: StyleSheet.hairlineWidth,
    },
    rowWrap: {
      alignItems: 'center',
      flexDirection: 'row',
    },
    optionRow: {
      alignItems: 'center',
      flex: 1,
      flexDirection: 'row',
      gap: spacing.md,
      minHeight: 52,
      minWidth: 0,
      paddingVertical: spacing.xs,
    },
    optionRowDisabled: {
      opacity: 0.45,
    },
    pressed: mobileInteractionStyles.pressed,
    optionMain: {
      flex: 1,
      minWidth: 0,
    },
    optionText: {
      color: c.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    metaLine: {
      color: c.textSecondary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    optionsButton: {
      alignItems: 'center',
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    empty: {
      color: c.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.md,
      textAlign: 'center',
    },
  });

const FLAT_GROUP_ID = '__flat__';

export function MobileModelPickerList({
  providerRows,
  flatOptions,
  activeModelId,
  activeSourceId,
  loading = false,
  disabled = false,
  emptyHint,
  loadingHint,
  onSelectProviderRow,
  onSelectFlatModel,
  rowStyle,
  testID = 'modelPicker.option',
  agentKind,
  capabilities,
  selectedEffort = '',
  selectedFastMode = false,
  modelMemory,
  apiKeyStatus = 'unknown',
  onOpenOptions,
  onSelectedRowLayout,
}: MobileModelPickerListProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const resolvedEmptyHint = emptyHint ?? t('models.picker.emptyDefault');
  const resolvedLoadingHint = loadingHint ?? t('models.picker.loadingDefault');
  // 非选中行的记忆写入(二级浮窗里改)不经 props 回流 —— 订阅两个记忆 store 的版本号,
  // 任一变化即重渲染行 effort/Fast 标签(对齐桌面 ModelSelector 的 storeVersion)。
  const storeVersion = useDraftModelMemoryVersion() + useSessionModelMirrorVersion();
  void storeVersion;

  // 分组后选中行的 onLayout y 相对分组容器;加上分组在滚动内容里的 y 才是滚动定位值。
  // 扁平回退同样包在一个分组容器里,用 FLAT_GROUP_ID 走同一条换算。
  const groupOffsets = useRef(new Map<string, number>());
  const selectedRowRef = useRef<{ groupId: string; y: number } | null>(null);
  const reportSelectedRow = (): void => {
    const selectedRow = selectedRowRef.current;
    if (!selectedRow || !onSelectedRowLayout) return;
    const groupY = groupOffsets.current.get(selectedRow.groupId);
    if (groupY === undefined) return;
    onSelectedRowLayout(groupY + selectedRow.y);
  };

  const hasFastModeCap = capabilities?.hasFastMode === true;
  const configEnabled = !!agentKind; // 新调用点传 agentKind 才启用行内展示(旧调用点行为不变)

  if (providerRows.length > 0) {
    // 与 iOS 同构:按来源分组,分组标题「来源 · 账号」(账号已写进来源名时不重复)。
    const groups = new Map<string, ProviderModelRow[]>();
    for (const row of providerRows) {
      const rows = groups.get(row.provider.id) ?? [];
      rows.push(row);
      groups.set(row.provider.id, rows);
    }
    return (
      <>
        {[...groups].map(([groupId, rows]) => {
          const provider = rows[0].provider;
          const identity =
            provider.openAiAccount?.identity?.trim() ||
            provider.subscriptionAccount?.identity?.trim();
          const groupTitle = [
            provider.name,
            identity && !provider.name.includes(identity) ? identity : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <View
              key={groupId}
              onLayout={(e) => {
                groupOffsets.current.set(groupId, e.nativeEvent.layout.y);
                reportSelectedRow();
              }}
              style={styles.group}
              testID={`${testID}.group.${groupId}`}
            >
              <Text numberOfLines={1} style={styles.groupLabel}>{groupTitle}</Text>
              {rows.map((row, index) => {
          const selected = row.model.id === activeModelId && row.provider.id === activeSourceId;
          // 对齐桌面 ModelSelector:订阅制来源(Claude.ai / ChatGPT 等)的模型带「订阅」。
          const isSubscription = row.provider.access?.kind === 'subscription';
          const rowDisabled = budgetRowDisabled(row.model.id, apiKeyStatus, row.provider);
          const fastEditable =
            configEnabled &&
            rowFastEditable({
              provider: row.provider,
              modelId: row.model.id,
              agentKind: agentKind ?? null,
              hasFastModeCap,
            });
          const rowEffort = configEnabled
            ? rowEffortOf({
                model: row.model,
                providerId: row.provider.id,
                selected,
                liveEffort: selectedEffort,
                agentKind: agentKind ?? null,
                memory: modelMemory,
              })
            : null;
          const fastOn =
            configEnabled &&
            rowFastOn({
              model: row.model,
              providerId: row.provider.id,
              selected,
              liveFastMode: selectedFastMode,
              agentKind: agentKind ?? null,
              fastEditable,
              memory: modelMemory,
            });
          const fullEffortLabel = rowEffort
            ? effortLabelFor(row.model, rowEffort, capabilities ?? null)
            : null;
          // 副行与 iOS 同口径:「订阅 · 强度 · Fast」。折扣版缺 key 的提示是整句恢复指引,
          // 单独成行且不限行数,不挤在单行元信息里被截掉。
          const metaLine = [
            isSubscription ? t('models.picker.subscriptionBadge') : null,
            fullEffortLabel,
            fastOn ? t('models.options.fastMode') : null,
          ]
            .filter(Boolean)
            .join(' · ');
          const rowAccessibilityLabel = modelRowAccessibilityLabel({
            baseLabel: t('models.picker.selectProviderModelAccessibility', {
              provider: row.provider.name,
              model: row.model.displayName,
            }),
            subscriptionLabel: isSubscription ? t('models.picker.subscriptionBadge') : null,
            effortLabel: fullEffortLabel
              ? t('models.options.reasoningEffortAccessibility', { label: fullEffortLabel })
              : null,
            fastLabel: fastOn ? t('models.options.fastMode') : null,
          });
          // 行内配置入口:置灰行不给;有 effort 档或 fast 可编辑才有意义;非选中行还要有记忆可写
          // (无记忆场景写不进任何地方 → 不显示,避免假开关)。
          const hasOptions =
            configEnabled &&
            !!onOpenOptions &&
            !rowDisabled &&
            (row.model.efforts.length > 0 || fastEditable) &&
            (selected || !!modelMemory);
          return (
            <View
              key={`${row.provider.id}::${row.model.id}`}
              // 行外层是分组 View 的直接子节点,y 才是相对分组的偏移。
              testID={selected ? `${testID}.selectedRow` : undefined}
              onLayout={
                selected && onSelectedRowLayout
                  ? (e) => {
                      selectedRowRef.current = { groupId, y: e.nativeEvent.layout.y };
                      reportSelectedRow();
                    }
                  : undefined
              }
            >
              {index > 0 ? <View style={styles.separator} /> : null}
              <View style={styles.rowWrap}>
                <Pressable
                  accessibilityLabel={rowAccessibilityLabel}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: disabled || rowDisabled }}
                  disabled={disabled || rowDisabled}
                  onPress={() => onSelectProviderRow(row)}
                  style={({ pressed }) => [
                    styles.optionRow,
                    rowStyle,
                    rowDisabled && styles.optionRowDisabled,
                    pressed && styles.pressed,
                  ]}
                  testID={testID}
                >
                  <MobileModelIconMark
                    icon={row.model.icon}
                    name={row.provider.name}
                    providerId={row.provider.id}
                    routing={row.provider.routing}
                    logoKind={row.provider.logoKind}
                  />
                  <View style={styles.optionMain}>
                    <Text numberOfLines={1} style={styles.optionText}>{row.model.displayName}</Text>
                    {metaLine ? (
                      <Text numberOfLines={1} style={styles.metaLine}>{metaLine}</Text>
                    ) : null}
                    {rowDisabled ? (
                      <Text style={styles.metaLine} testID={`${testID}.disabledHint`}>{budgetDisabledHint()}</Text>
                    ) : null}
                  </View>
                  {selected ? <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} /> : null}
                </Pressable>
                {hasOptions ? (
                  <Pressable
                    accessibilityLabel={t('models.picker.configureAccessibility', { model: row.model.displayName })}
                    accessibilityRole="button"
                    disabled={disabled}
                    onPress={() => onOpenOptions({ providerId: row.provider.id, modelId: row.model.id })}
                    style={({ pressed }) => [styles.optionsButton, pressed && styles.pressed]}
                    testID={`${testID}.optionsButton`}
                  >
                    <SlidersHorizontal color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
              })}
            </View>
          );
        })}
      </>
    );
  }

  if (flatOptions.length > 0) {
    return (
      <View
        onLayout={(e) => {
          groupOffsets.current.set(FLAT_GROUP_ID, e.nativeEvent.layout.y);
          reportSelectedRow();
        }}
        style={styles.group}
        testID={`${testID}.group.${FLAT_GROUP_ID}`}
      >
        {flatOptions.map((option, index) => {
          const selected = option.id === activeModelId;
          // 扁平回退(旧被控端):无供应商结构 → 无来源 mark、无 per-provider fast 判定,
          // fast 支持退化为 capabilities gate × 模型自述;非选中行无记忆可写 → 仅选中行可配置。
          const fastEditable = configEnabled && hasFastModeCap && option.supportsFastMode === true;
          const hasOptions =
            configEnabled &&
            !!onOpenOptions &&
            selected &&
            (option.efforts.length > 0 || fastEditable);
          // 桌面 flat 模式非选中行也显示默认 effort 标签(无记忆可读 → rowEffortOf 落模型默认)。
          const rowEffort = configEnabled
            ? rowEffortOf({
                model: option,
                providerId: null,
                selected,
                liveEffort: selectedEffort,
                agentKind: agentKind ?? null,
              })
            : null;
          const fullEffortLabel = rowEffort
            ? effortLabelFor(option, rowEffort, capabilities ?? null)
            : null;
          const fastOn = fastEditable && selected && selectedFastMode;
          const metaLine = [fullEffortLabel, fastOn ? t('models.options.fastMode') : null]
            .filter(Boolean)
            .join(' · ');
          const rowAccessibilityLabel = modelRowAccessibilityLabel({
            baseLabel: t('models.picker.selectModelAccessibility', { model: option.label }),
            effortLabel: fullEffortLabel
              ? t('models.options.reasoningEffortAccessibility', { label: fullEffortLabel })
              : null,
            fastLabel: fastOn ? t('models.options.fastMode') : null,
          });
          return (
            <View
              key={option.id}
              testID={selected ? `${testID}.selectedRow` : undefined}
              onLayout={
                selected && onSelectedRowLayout
                  ? (e) => {
                      selectedRowRef.current = { groupId: FLAT_GROUP_ID, y: e.nativeEvent.layout.y };
                      reportSelectedRow();
                    }
                  : undefined
              }
            >
              {index > 0 ? <View style={styles.separator} /> : null}
              <View style={styles.rowWrap}>
                <Pressable
                  accessibilityLabel={rowAccessibilityLabel}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled }}
                  disabled={disabled}
                  onPress={() => onSelectFlatModel(option)}
                  style={({ pressed }) => [styles.optionRow, rowStyle, pressed && styles.pressed]}
                  testID={testID}
                >
                  <View style={styles.optionMain}>
                    <Text numberOfLines={1} style={styles.optionText}>{option.label}</Text>
                    {metaLine ? (
                      <Text numberOfLines={1} style={styles.metaLine}>{metaLine}</Text>
                    ) : null}
                  </View>
                  {selected ? <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} /> : null}
                </Pressable>
                {hasOptions ? (
                  <Pressable
                    accessibilityLabel={t('models.picker.configureAccessibility', { model: option.label })}
                    accessibilityRole="button"
                    disabled={disabled}
                    onPress={() => onOpenOptions({ providerId: null, modelId: option.id })}
                    style={({ pressed }) => [styles.optionsButton, pressed && styles.pressed]}
                    testID={`${testID}.optionsButton`}
                  >
                    <SlidersHorizontal color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    );
  }

  return <Text style={styles.empty}>{loading ? resolvedLoadingHint : resolvedEmptyHint}</Text>;
}
