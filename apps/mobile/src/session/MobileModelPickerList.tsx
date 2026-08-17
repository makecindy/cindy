/**
 * MobileModelPickerList —— 模型浮窗一级视图的行列表(新建会话页 + 会话内 composer 共用,
 * 由 ModelPickerSheet 装配)。
 *
 * 展现内容对齐桌面 ModelSelector 的 renderModelItem:每行 = 来源官方 mark + 模型名主行 +
 * `订阅`(订阅制来源)+ 当前 effort 标签 + Fast 闪电(点亮时)的紧凑副行 +
 * 选中 Check + 行内「配置」入口。
 * 触屏适配:桌面 hover「Edit」→ 每行右侧常驻配置图标,点击经 `onOpenOptions` 通知浮窗
 * 打开二级「模型选项」SheetSurface(元信息 / 快速开关 / 推理强度,见 ModelOptionsSheetView),
 * 本组件不再承载行内展开。折扣版被控端无 gateway key → 整行置灰 + 行内提示。
 *
 * 三态:① 供应商分段(providerRows 非空,选行 = 选「来源 + 模型」);② 扁平回退(flatOptions,
 * 旧被控端,无来源 mark、无记忆,仅选中行可配置);③ 空 → 加载中 / 暂无文案。
 *
 * 不含 ScrollView —— 由 SheetSurface 的滚动区承载。行显示逻辑在 modelPickerRows.ts
 * (纯逻辑可单测),本组件只做渲染。
 */
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { Check, SlidersHorizontal, Zap } from 'lucide-react-native';

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
  compactEffortLabelFor,
  effortLabelFor,
  modelRowAccessibilityLabel,
  rowEffortOf,
  rowFastEditable,
  rowFastOn,
} from '@/session/modelPickerRows';
import type { ProviderModelRow } from '@/session/providerModelSections';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

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
    optionRow: {
      alignItems: 'center',
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.sm,
    },
    optionRowSelected: {
      backgroundColor: c.surfaceChip,
    },
    optionRowDisabled: {
      opacity: 0.45,
    },
    optionMain: {
      flex: 1,
      minWidth: 0,
    },
    optionTitleRow: {
      alignItems: 'center',
      flexDirection: 'row',
      minWidth: 0,
    },
    optionMetaRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
      minWidth: 0,
    },
    optionText: {
      color: c.textPrimary,
      flexShrink: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
      minWidth: 0,
    },
    effortLabel: {
      color: c.textTertiary,
      flexShrink: 1,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.regular,
      minWidth: 0,
    },
    disabledHint: {
      color: c.textTertiary,
      fontSize: typeScale.micro,
      marginTop: 1,
    },
    subscriptionBadge: {
      backgroundColor: c.surfaceChip,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 1,
    },
    subscriptionBadgeText: {
      color: c.textSecondary,
      fontSize: typeScale.micro,
      fontWeight: fontWeight.semibold,
    },
    optionsButton: {
      alignItems: 'center',
      borderRadius: radius.pill,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
    empty: {
      color: c.textTertiary,
      fontSize: typeScale.footnote,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.md,
      textAlign: 'center',
    },
  });

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

  const hasFastModeCap = capabilities?.hasFastMode === true;
  const configEnabled = !!agentKind; // 新调用点传 agentKind 才启用行内展示(旧调用点行为不变)

  if (providerRows.length > 0) {
    return (
      <>
        {providerRows.map((row) => {
          const selected = row.model.id === activeModelId && row.provider.id === activeSourceId;
          // 对齐桌面 ModelSelector:订阅制来源(Claude.ai / ChatGPT 等)的模型带「订阅」徽标。
          const isSubscription = row.provider.access?.kind === 'subscription';
          const rowDisabled = budgetRowDisabled(row.model.id, apiKeyStatus);
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
            <Pressable
              accessibilityLabel={rowAccessibilityLabel}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: disabled || rowDisabled }}
              disabled={disabled || rowDisabled}
              key={`${row.provider.id}::${row.model.id}`}
              onLayout={
                selected && onSelectedRowLayout
                  ? (e) => onSelectedRowLayout(e.nativeEvent.layout.y)
                  : undefined
              }
              onPress={() => onSelectProviderRow(row)}
              style={({ pressed }) => [
                styles.optionRow,
                rowStyle,
                selected && styles.optionRowSelected,
                rowDisabled && styles.optionRowDisabled,
                pressed && { opacity: 0.65 },
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
                <View style={styles.optionTitleRow}>
                  <Text numberOfLines={1} style={styles.optionText}>{row.model.displayName}</Text>
                </View>
                {isSubscription || rowEffort || fastOn ? (
                  <View style={styles.optionMetaRow}>
                    {isSubscription ? (
                      <View style={styles.subscriptionBadge}>
                        <Text
                          accessibilityLabel={t('models.picker.subscriptionBadge')}
                          numberOfLines={1}
                          style={styles.subscriptionBadgeText}
                        >
                          {t('models.picker.subscriptionBadgeCompact')}
                        </Text>
                      </View>
                    ) : null}
                    {rowEffort ? (
                      <Text
                        accessibilityLabel={fullEffortLabel ?? undefined}
                        numberOfLines={1}
                        style={styles.effortLabel}
                      >
                        {compactEffortLabelFor(row.model, rowEffort, capabilities ?? null)}
                      </Text>
                    ) : null}
                    {fastOn ? (
                      <Zap color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                    ) : null}
                  </View>
                ) : null}
                {rowDisabled ? (
                  <Text numberOfLines={1} style={styles.disabledHint}>{budgetDisabledHint()}</Text>
                ) : null}
              </View>
              {selected ? <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} /> : null}
              {hasOptions ? (
                <Pressable
                  accessibilityLabel={t('models.picker.configureAccessibility', { model: row.model.displayName })}
                  accessibilityRole="button"
                  disabled={disabled}
                  hitSlop={6}
                  onPress={() => onOpenOptions({ providerId: row.provider.id, modelId: row.model.id })}
                  style={({ pressed }) => [styles.optionsButton, pressed && { opacity: 0.65 }]}
                  testID={`${testID}.optionsButton`}
                >
                  <SlidersHorizontal color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}
      </>
    );
  }

  if (flatOptions.length > 0) {
    return (
      <>
        {flatOptions.map((option) => {
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
          const rowAccessibilityLabel = modelRowAccessibilityLabel({
            baseLabel: t('models.picker.selectModelAccessibility', { model: option.label }),
            effortLabel: fullEffortLabel
              ? t('models.options.reasoningEffortAccessibility', { label: fullEffortLabel })
              : null,
            fastLabel:
              fastEditable && selected && selectedFastMode ? t('models.options.fastMode') : null,
          });
          return (
            <Pressable
              accessibilityLabel={rowAccessibilityLabel}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              key={option.id}
              onLayout={
                selected && onSelectedRowLayout
                  ? (e) => onSelectedRowLayout(e.nativeEvent.layout.y)
                  : undefined
              }
              onPress={() => onSelectFlatModel(option)}
              style={({ pressed }) => [
                styles.optionRow,
                rowStyle,
                selected && styles.optionRowSelected,
                pressed && { opacity: 0.65 },
              ]}
              testID={testID}
            >
              <View style={styles.optionMain}>
                <View style={styles.optionTitleRow}>
                  <Text numberOfLines={1} style={styles.optionText}>{option.label}</Text>
                </View>
                {rowEffort || (fastEditable && selected && selectedFastMode) ? (
                  <View style={styles.optionMetaRow}>
                    {rowEffort ? (
                      <Text
                        accessibilityLabel={fullEffortLabel ?? undefined}
                        numberOfLines={1}
                        style={styles.effortLabel}
                      >
                        {compactEffortLabelFor(option, rowEffort, capabilities ?? null)}
                      </Text>
                    ) : null}
                    {fastEditable && selected && selectedFastMode ? (
                      <Zap color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                    ) : null}
                  </View>
                ) : null}
              </View>
              {selected ? <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} /> : null}
              {hasOptions ? (
                <Pressable
                  accessibilityLabel={t('models.picker.configureAccessibility', { model: option.label })}
                  accessibilityRole="button"
                  disabled={disabled}
                  hitSlop={6}
                  onPress={() => onOpenOptions({ providerId: null, modelId: option.id })}
                  style={({ pressed }) => [styles.optionsButton, pressed && { opacity: 0.65 }]}
                  testID={`${testID}.optionsButton`}
                >
                  <SlidersHorizontal color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}
      </>
    );
  }

  return <Text style={styles.empty}>{loading ? resolvedLoadingHint : resolvedEmptyHint}</Text>;
}
