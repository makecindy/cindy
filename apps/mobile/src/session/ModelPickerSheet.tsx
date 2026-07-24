/**
 * ModelPickerSheet —— 模型 + 权限的可拖动底部浮窗(新建会话页与会话页 composer 共用)。
 *
 * 形态对齐「+ 号」Context 面板:SheetModal 外壳(背板淡入淡出 + 面板滑入滑出)+
 * SheetSurface(把手 half/full/下拉 dismiss)。**单 Modal 双 Surface 叠层**:
 * 一级 = 搜索(pinnedTop)+ 模型列表 + 权限行(footer);
 * 点行内配置图标 / 权限行 → 二级 SheetSurface(「模型选项」或「权限」)以 translateY 滑入,
 * 叠在一级之上并自带一层加深 backdrop,返回键 / backdrop / 把手下拉先回一级再关浮窗
 * (settleModelPickerSheetBack)。刻意**不用嵌套 Modal**:iOS 同级双 Modal 第二个不显示、
 * Android 每个 Modal 是独立原生 Dialog(返回键派发不可控),且 Fabric 下 Modal 内手势协商
 * 已有坑(见 useContextSheetDrag);单 Modal 内叠 JS 层全部行为可控、可单测。
 *
 * 数据语义与旧 drop-up 完全同源:选行 = 调用方 onSelectProviderRow/onSelectFlatModel(由其
 * 关浮窗);选中行 effort/Fast 改 live,非选中行写注入记忆(见 ModelOptionsSheetView)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Search } from 'lucide-react-native';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { MobileAgentCapabilities, MobileChoiceOption, MobileModelOption } from '@/session/agentCapabilities';
import type { DeviceApiKeyStatus } from '@/device-link/deviceModelMetaCache';
import type { MobileModelPricingMap } from '@/device-link/mobileMakerTransport';
import type { ProviderView } from '@cindy/model-providers/registry';
import type { AgentKind } from '@cindy/model-providers/types';
import { MobileModelPickerList, type ModelOptionsOpenTarget } from '@/session/MobileModelPickerList';
import { MobileAgentSwitcher } from '@/session/MobileAgentSwitcher';
import { MobilePermissionPickerList } from '@/session/MobilePermissionPickerList';
import { ModelOptionsSheetView } from '@/session/ModelOptionsSheetView';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import type { MobileModelMemoryAccessors } from '@/session/draftModelMemory';
import {
  filterFlatModelOptions,
  findOptionsTarget,
  modelPickerSheetTitle,
  settleModelPickerSheetBack,
  type ModelPickerSheetView,
} from '@/session/modelPickerSheetModel';
import { rowFastEditable } from '@/session/modelPickerRows';
import { permissionAccentColor, permissionPresentation } from '@/session/permissionPresentation';
import {
  buildMobileModelSections,
  flattenProviderSections,
  type ProviderModelRow,
} from '@/session/providerModelSections';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, radius, spacing, typeScale } from '@/theme/tokens';
import {
  mobileAgentLabel,
  type MobileSessionAgentKind,
} from '@/session/sessionAgentSwitch';

/** 二级 Surface 滑入/滑出时长(对齐 useContextSheetDrag 的 SNAP_ANIMATION_DURATION_MS)。 */
const SECONDARY_SLIDE_DURATION_MS = 180;

/** provider-aware 模式下传给列表的空 flat 集(身份稳定,防无谓重渲)。 */
const EMPTY_FLAT_OPTIONS: readonly MobileModelOption[] = [];

export interface ModelPickerSheetProps {
  visible: boolean;
  onClose(): void;
  // —— 模型目录(与旧 drop-up 面板同口径) ——
  providers: readonly ProviderView[];
  /** 被控端「模型显示/隐藏」override 快照(useDeviceProviders 透传);undefined = 不过滤。 */
  modelVisibilityOverrides?: Record<string, boolean>;
  flatOptions: readonly MobileModelOption[];
  agentKind: AgentKind;
  /** 已建会话可选：先浏览 Agent，再选模型登记下一条消息的切换意图。 */
  agentSwitch?: {
    currentAgentKind: MobileSessionAgentKind;
    browsingAgentKind: MobileSessionAgentKind;
    disabled?: boolean;
    onBrowseAgent(next: MobileSessionAgentKind): boolean | void | Promise<boolean | void>;
  };
  capabilities: MobileAgentCapabilities | null;
  activeModelId: string;
  /** 显式选中的来源 id(null = 跟随被控端默认路由;内部据此算高亮来源)。 */
  selectedProviderId: string | null;
  selectedEffort: string;
  selectedFastMode: boolean;
  loading?: boolean;
  disabled?: boolean;
  emptyHint?: string;
  loadingHint?: string;
  /** 选行(调用方负责落草稿/写穿并关浮窗,与旧 drop-up 语义一致)。 */
  onSelectProviderRow(row: ProviderModelRow): void;
  onSelectFlatModel(option: MobileModelOption): void;
  onChangeSelectedEffort?(effort: string): void;
  onChangeSelectedFastMode?(enabled: boolean): void | Promise<void>;
  modelMemory?: MobileModelMemoryAccessors;
  pricing?: MobileModelPricingMap | null;
  apiKeyStatus?: DeviceApiKeyStatus;
  // —— 权限(合并进本浮窗) ——
  permissionOptions: readonly MobileChoiceOption[];
  /** 权限行展示的当前模式(会话页 plan 激活时传底层权限档)。 */
  activePermissionMode: string;
  /** 选权限(调用方落草稿/写穿);浮窗内部自动回一级,不关浮窗。 */
  onSelectPermissionMode(mode: string): void;
  permissionDisabled?: boolean;
  keyboardAvoidingBehavior: 'height' | 'padding' | undefined;
  testID?: string;
}

export function ModelPickerSheet({
  visible,
  onClose,
  providers,
  modelVisibilityOverrides,
  flatOptions,
  agentKind,
  agentSwitch,
  capabilities,
  activeModelId,
  selectedProviderId,
  selectedEffort,
  selectedFastMode,
  loading = false,
  disabled = false,
  emptyHint,
  loadingHint,
  onSelectProviderRow,
  onSelectFlatModel,
  onChangeSelectedEffort,
  onChangeSelectedFastMode,
  modelMemory,
  pricing = null,
  apiKeyStatus = 'unknown',
  permissionOptions,
  activePermissionMode,
  onSelectPermissionMode,
  permissionDisabled = false,
  keyboardAvoidingBehavior,
  testID = 'modelSheet',
}: ModelPickerSheetProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [view, setView] = useState<ModelPickerSheetView>({ kind: 'models' });
  const [primarySnap, setPrimarySnap] = useState<ContextSheetSnap>('half');
  const [secondarySnap, setSecondarySnap] = useState<ContextSheetSnap>('half');
  const [query, setQuery] = useState('');
  const scrollRef = useRef<ScrollView | null>(null);
  const didAutoScrollRef = useRef(false);
  // 二级 Surface 滑入/滑出动画(0 = 就位;windowHeight = 屏下)。动画期间锁交互防连点。
  const secondaryTranslate = useRef(new Animated.Value(windowHeight)).current;
  const secondaryAnimatingRef = useRef(false);

  // 每次重新打开重置(view 回一级、snap 回 half、清搜索、允许再次自动滚到选中行)。
  useEffect(() => {
    if (!visible) return;
    setView({ kind: 'models' });
    setPrimarySnap('half');
    setSecondarySnap('half');
    setQuery('');
    didAutoScrollRef.current = false;
    secondaryTranslate.setValue(windowHeight);
    secondaryAnimatingRef.current = false;
  }, [visible, secondaryTranslate, windowHeight]);

  const heights = useMemo(
    () => computeContextSheetSnapHeights({ safeAreaTopInset: insets.top, screenHeight: windowHeight }),
    [insets.top, windowHeight],
  );

  const sections = useMemo(
    () =>
      buildMobileModelSections({
        providers,
        agentKind,
        selectedModelId: activeModelId,
        selectedProviderId,
        query,
        visibilityOverrides: modelVisibilityOverrides,
      }),
    [providers, modelVisibilityOverrides, agentKind, activeModelId, selectedProviderId, query],
  );
  const providerRows = useMemo(() => flattenProviderSections(sections.sections), [sections]);
  // 二级 options 目标行按**未过滤**行集现查(搜索 query 不应让已打开的二级视图失效)。
  const allSections = useMemo(
    () =>
      buildMobileModelSections({
        providers,
        agentKind,
        selectedModelId: activeModelId,
        selectedProviderId,
        visibilityOverrides: modelVisibilityOverrides,
      }),
    [providers, modelVisibilityOverrides, agentKind, activeModelId, selectedProviderId],
  );
  const allRows = useMemo(() => flattenProviderSections(allSections.sections), [allSections]);
  const filteredFlatOptions = useMemo(
    () => filterFlatModelOptions(flatOptions, query),
    [flatOptions, query],
  );
  // flat 回退只在「0 个已连接供应商」时启用;provider-aware 模式下搜索/可见性把 providerRows
  // 清空时必须显示「没有匹配的模型」,不能漏到 capabilities 扁平列表(绕过可见性过滤且选行丢来源)。
  const providerAware = sections.connected.length > 0;
  const browsingOtherAgent = !!agentSwitch
    && agentSwitch.browsingAgentKind !== agentSwitch.currentAgentKind;
  // 跨 Agent 浏览只列已连接来源；不能从 capabilities flat 回退里选到无路由模型。
  const effectiveFlatOptions = providerAware || browsingOtherAgent
    ? EMPTY_FLAT_OPTIONS
    : filteredFlatOptions;

  const hasQuery = query.trim().length > 0;
  const noResults = hasQuery && providerRows.length === 0 && effectiveFlatOptions.length === 0;

  // —— 二级视图开合(translateY 滑入滑出,动画期间锁重复触发) ——
  const openSecondary = useCallback(
    (next: ModelPickerSheetView) => {
      if (secondaryAnimatingRef.current) return;
      secondaryAnimatingRef.current = true;
      setSecondarySnap('half');
      setView(next);
      secondaryTranslate.setValue(windowHeight);
      Animated.timing(secondaryTranslate, {
        duration: SECONDARY_SLIDE_DURATION_MS,
        toValue: 0,
        useNativeDriver: true,
      }).start(() => {
        secondaryAnimatingRef.current = false;
      });
    },
    [secondaryTranslate, windowHeight],
  );
  // 行内配置图标 → 二级「模型选项」:useCallback 稳定引用,避免每次 render 都给
  // MobileModelPickerList 递新函数(破坏其下行组件的 memo 短路)。
  const handleOpenOptions = useCallback(
    (target: ModelOptionsOpenTarget) =>
      openSecondary({ kind: 'options', providerId: target.providerId, modelId: target.modelId }),
    [openSecondary],
  );
  const backToModels = useCallback(() => {
    if (secondaryAnimatingRef.current) return;
    secondaryAnimatingRef.current = true;
    Animated.timing(secondaryTranslate, {
      duration: SECONDARY_SLIDE_DURATION_MS,
      toValue: windowHeight,
      useNativeDriver: true,
    }).start(() => {
      secondaryAnimatingRef.current = false;
      setView({ kind: 'models' });
    });
  }, [secondaryTranslate, windowHeight]);

  // Android 返回键 / iOS 关闭手势:两段式(二级先回一级,一级才关浮窗)。
  const handleRequestClose = useCallback(() => {
    const settled = settleModelPickerSheetBack(view);
    if (settled.close) {
      onClose();
      return;
    }
    backToModels();
  }, [view, onClose, backToModels]);

  // options 目标行现查:providers 目录热更新后目标消失 → 自动回一级,绝不渲染悬空数据。
  const optionsTarget = useMemo(
    () => findOptionsTarget(view, allRows, flatOptions),
    [view, allRows, flatOptions],
  );
  useEffect(() => {
    if (view.kind === 'options' && !optionsTarget) backToModels();
  }, [view, optionsTarget, backToModels]);

  const handleSelectedRowLayout = useCallback(
    (y: number): void => {
      if (didAutoScrollRef.current || hasQuery) return;
      didAutoScrollRef.current = true;
      // 留一行余量,让选中行上方能看到相邻行(对齐桌面「滚动到选中行」的观感)。
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 44), animated: false });
    },
    [hasQuery],
  );

  const secondaryTitle = modelPickerSheetTitle(view, allRows, flatOptions);
  // 权限行文案:已知模式用 permissionPresentation 的中文标签(与二级权限列表一致),
  // 未知模式回退被控端 capabilities 给的 label(presentation 内部兜底)。
  const permission = permissionPresentation(
    activePermissionMode,
    permissionOptions.find((o) => o.id === activePermissionMode)?.label,
  );
  const permissionLabel = permission.label;

  const searchRow = (
    <View style={styles.searchRow}>
      <Search color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      <TextInput
        accessibilityLabel={t('models.picker.searchAccessibility')}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder={t('models.picker.searchPlaceholder')}
        placeholderTextColor={colors.textTertiary}
        style={styles.searchInput}
        testID={`${testID}.search`}
        value={query}
      />
    </View>
  );

  const primaryPinnedTop = (
    <View style={styles.pinnedTop}>
      {agentSwitch ? (
        <>
          <MobileAgentSwitcher
            disabled={disabled || agentSwitch.disabled}
            onChange={async (next) => {
              const changed = await agentSwitch.onBrowseAgent(next);
              if (changed === false) return false;
              setQuery('');
              if (view.kind !== 'models') backToModels();
              return true;
            }}
            value={agentSwitch.browsingAgentKind}
          />
          {browsingOtherAgent ? (
            <Text style={styles.agentSwitchHint} testID={`${testID}.agentSwitchHint`}>
              {t('models.picker.agentSwitchHint', { agent: mobileAgentLabel(agentSwitch.browsingAgentKind) })}
            </Text>
          ) : null}
        </>
      ) : null}
      {searchRow}
    </View>
  );

  // 权限入口:header 右侧「图标 + 文案 + 下拉箭头」,与桌面 composer 的 PermissionSelector
  // trigger 同构——透明底、整体着色(中性 = textSecondary,auto / bypass = 语义色),点开二级
  // 权限选择。按产品反馈刻意轻量化——不占列表整行,浮窗主体只留模型。
  const permissionColor = permissionAccentColor(permission.accent, colors);
  const permissionTrigger = (
    <Pressable
      accessibilityLabel={t('models.picker.permissionModeAccessibility', { mode: permissionLabel })}
      accessibilityRole="button"
      accessibilityState={{ disabled: permissionDisabled || browsingOtherAgent }}
      disabled={permissionDisabled || browsingOtherAgent}
      hitSlop={6}
      onPress={() => openSecondary({ kind: 'permission' })}
      style={({ pressed }) => [
        styles.permissionTrigger,
        (permissionDisabled || browsingOtherAgent) && styles.permissionTriggerDisabled,
        pressed && { opacity: 0.6 },
      ]}
      testID={`${testID}.permissionTrigger`}
    >
      <permission.Icon color={permissionColor} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      <Text
        numberOfLines={1}
        style={[styles.permissionTriggerLabel, { color: permissionColor }]}
      >
        {permissionLabel}
      </Text>
      <ChevronDown color={permissionColor} size={iconSize.sm} strokeWidth={iconStroke.regular} />
    </Pressable>
  );

  return (
    <SheetModal
      backdropTestID={`${testID}.backdrop`}
      keyboardAvoiding
      keyboardAvoidingBehavior={keyboardAvoidingBehavior}
      onBackdropPress={onClose}
      onRequestClose={handleRequestClose}
      visible={visible}
    >
      <SheetSurface
        bottomInset={insets.bottom}
        headerTrailing={permissionTrigger}
        heights={heights}
        onClose={onClose}
        onSnapChange={setPrimarySnap}
        pinnedTop={primaryPinnedTop}
        scrollRef={scrollRef}
        snap={primarySnap}
        testID={testID}
        title={t('models.picker.title')}
      >
        {noResults ? (
          <Text style={styles.noResults} testID={`${testID}.noResults`}>{t('models.picker.noResults')}</Text>
        ) : (
          <MobileModelPickerList
            activeModelId={activeModelId}
            activeSourceId={sections.activeSourceId}
            agentKind={agentKind}
            apiKeyStatus={apiKeyStatus}
            capabilities={capabilities}
            disabled={disabled}
            emptyHint={browsingOtherAgent
              ? t('models.picker.crossAgentEmptyHint', { agent: mobileAgentLabel(agentSwitch!.browsingAgentKind) })
              : emptyHint}
            flatOptions={effectiveFlatOptions}
            loading={loading}
            loadingHint={loadingHint}
            modelMemory={modelMemory}
            providerRows={providerRows}
            onOpenOptions={handleOpenOptions}
            onSelectFlatModel={onSelectFlatModel}
            onSelectProviderRow={onSelectProviderRow}
            onSelectedRowLayout={handleSelectedRowLayout}
            selectedEffort={selectedEffort}
            selectedFastMode={selectedFastMode}
            testID={`${testID}.option`}
          />
        )}
      </SheetSurface>
      {view.kind !== 'models' ? (
        <Animated.View
          style={[styles.secondaryLayer, { transform: [{ translateY: secondaryTranslate }] }]}
          testID={`${testID}.secondaryLayer`}
        >
          <Pressable
            accessibilityLabel={t('models.picker.backToModels')}
            accessibilityRole="button"
            onPress={backToModels}
            style={styles.secondaryBackdrop}
            testID={`${testID}.secondaryBackdrop`}
          />
          <SheetSurface
            backAccessibilityLabel={t('models.picker.backToModels')}
            bottomInset={insets.bottom}
            heights={heights}
            onBack={backToModels}
            onClose={backToModels}
            onSnapChange={setSecondarySnap}
            snap={secondarySnap}
            testID={view.kind === 'permission' ? `${testID}.permissionSheet` : `${testID}.optionsSheet`}
            title={secondaryTitle}
          >
            {view.kind === 'permission' ? (
              <MobilePermissionPickerList
                activeMode={activePermissionMode}
                disabled={permissionDisabled}
                onSelect={(mode) => {
                  onSelectPermissionMode(mode);
                  backToModels();
                }}
                options={permissionOptions}
                testID={`${testID}.permissionOption`}
              />
            ) : view.kind === 'options' && optionsTarget ? (
              <ModelOptionsSheetView
                agentKind={agentKind}
                capabilities={capabilities}
                contextWindow={optionsTarget.contextWindow}
                disabled={disabled}
                displayName={optionsTarget.displayName}
                fastEditable={optionsTarget.provider
                  // provider-aware 行:agent gate × 该 (来源, 模型) 目录条目的 supportsFastMode。
                  ? rowFastEditable({
                      provider: optionsTarget.provider,
                      modelId: optionsTarget.model.id,
                      agentKind,
                      hasFastModeCap: capabilities?.hasFastMode === true,
                    })
                  // flat 回退无供应商结构:退化为模型自述(与列表行口径一致)。不能走
                  // rowFastEditable —— 它对 undefined provider 恒 false,会把开关吞掉。
                  : capabilities?.hasFastMode === true &&
                    optionsTarget.model.supportsFastMode === true}
                model={optionsTarget.model}
                modelMemory={modelMemory}
                onChangeSelectedEffort={onChangeSelectedEffort}
                onChangeSelectedFastMode={onChangeSelectedFastMode}
                pricing={pricing}
                provider={optionsTarget.provider}
                providerId={view.providerId}
                selected={
                  view.modelId === activeModelId &&
                  (view.providerId === null || view.providerId === sections.activeSourceId)
                }
                selectedEffort={selectedEffort}
                selectedFastMode={selectedFastMode}
                testID={`${testID}.options`}
              />
            ) : null}
          </SheetSurface>
        </Animated.View>
      ) : null}
    </SheetModal>
  );
}

function makeStyles(colors: ThemeColors) {
  return {
    // Modal 外壳(背板/内容层/键盘规避)样式已随 SheetModal 抽出。
    // 二级层铺满内容层区域,底部吸附;自带一层 overlay 色 backdrop = 视觉加深一档。
    secondaryLayer: {
      bottom: 0,
      justifyContent: 'flex-end' as const,
      left: 0,
      position: 'absolute' as const,
      right: 0,
      top: 0,
    },
    secondaryBackdrop: {
      backgroundColor: colors.overlay,
      flex: 1,
    },
    searchRow: {
      alignItems: 'center' as const,
      borderColor: colors.borderStrong,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      marginBottom: spacing.xs,
      minHeight: 36,
      paddingHorizontal: spacing.md,
    },
    searchInput: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.footnote,
      minWidth: 0,
      paddingVertical: 0,
    },
    noResults: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.md,
      textAlign: 'center' as const,
    },
    pinnedTop: {
      gap: spacing.sm,
    },
    agentSwitchHint: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      paddingHorizontal: spacing.xs,
    },
    // 对齐桌面 PermissionSelector trigger:透明底 + gap 4 + 13px 文案,整体随权限档着色。
    permissionTrigger: {
      alignItems: 'center' as const,
      borderRadius: radius.pill,
      flexDirection: 'row' as const,
      gap: 4,
      height: 36,
      justifyContent: 'flex-end' as const,
      paddingHorizontal: 2,
    },
    permissionTriggerLabel: {
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.regular,
      maxWidth: 120,
    },
    permissionTriggerDisabled: {
      opacity: 0.5,
    },
  };
}
