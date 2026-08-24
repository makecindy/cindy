/**
 * SessionMenuSheet —— 会话右上角「…」菜单浮窗(取代旧三 tab 的会话设置面板)。
 *
 * 形态对齐「+ 号」Context 面板 / 模型浮窗:SheetModal 外壳(背板淡入淡出 + 面板滑入
 * 滑出)+ SheetSurface(把手
 * half/full/下拉 dismiss),**单 Modal 双 Surface 叠层**:一级 = 详情头部(状态 chip /
 * 元信息 / 用量摘要)+ 操作列表(重命名 / 复制链接 / 置顶 / 归档 / 删除)+「会话信息」入口;
 * 二级 = 会话信息(用量 / 工作目录 / 附加引用目录),translateY 滑入,返回键 /
 * backdrop 先回一级再关浮窗(settleSessionMenuBack)。刻意不用嵌套 Modal,原因同
 * ModelPickerSheet 头注释(iOS 同级双 Modal 不显示、Android 返回键派发不可控)。
 *
 * 交互取舍(2026-07-06 与产品确认的重设计):重命名 = 一级内原地编辑(输入框替换头部,
 * 编辑期隐藏操作列表);删除 = 系统 Alert 确认(取代旧「点两次」按钮);复制只保留对话深链,
 * 旧面板的 XDT ID / Agent ID 复制按产品决策整体移除(调试向信息不再进手机端 UI);
 * 附加引用目录从 textarea 草稿改为列表 + 移除 + 浏览添加,每次增删立即写穿被控端。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  GitBranch,
  Info,
  Link2,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionGroup } from '@/components/MobilePrimitives';
import type { RemoteDirectoryEntry } from '@/device-link/mobileMakerTransport';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import { writeClipboardText } from '@/session/messageActions';
import { normalizeExtraDirs } from '@/session/newSession';
import {
  nextCodexBucketStaleAtMs,
  resolveCodexBucketTable,
  selectCodexUsageForModel,
} from '@cindy/maker-shared/codex-usage-buckets';
import {
  summarizeAccountRateLimits,
  summarizeCodexRateLimitReset,
  summarizeContextUsage,
  summarizeSessionSpend,
} from '@/session/sessionControls';
import {
  addSessionExtraDir,
  aiRenameFailureText,
  buildSessionInfoWorkspace,
  buildSessionMenuActions,
  buildSessionMenuHeader,
  removeSessionExtraDir,
  sessionInfoShowsExtraDirs,
  sessionMenuCopyLink,
  settleSessionMenuBack,
  type SessionMenuAction,
  type SessionMenuView,
} from '@/session/sessionMenu';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import type { RemoteSession } from '@/session/types';
import { iconSize, iconStroke, monoFont, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** 二级 Surface 滑入/滑出时长(对齐 useContextSheetDrag 的 SNAP_ANIMATION_DURATION_MS)。 */
const SECONDARY_SLIDE_DURATION_MS = 180;
/** 复制反馈(行内文案临时替换)展示时长。 */
const COPY_FEEDBACK_MS = 1500;

export interface SessionExtraDirBrowserState {
  entries: RemoteDirectoryEntry[];
  error: string | null;
  loading: boolean;
  open: boolean;
  parent: string | null;
  path: string;
}

export interface SessionMenuSheetProps {
  visible: boolean;
  /** 打开时落在哪个视图(header 用量入口可直达 info)。 */
  initialView: SessionMenuView;
  session: RemoteSession;
  busy: boolean;
  readOnlyReason?: string | null;
  contextUsage: unknown;
  contextLoading: boolean;
  onRefreshContextUsage(): void;
  /**
   * 账号级限额快照(被控端 `maker:usage:account` 原始返回,unknown 防御解析)。
   * 父级只对 Codex 会话传数据;null = 不显示「账号限额」区(通道不支持 / 拉取失败 /
   * 非订阅形态都静默降级,不占位不显示 loading)。
   */
  accountUsage: unknown;
  /** app-server 权威额度/reset credit 快照;老被控端不支持时为 null。 */
  codexRateLimits: MobileCodexRateLimitsResult | null;
  codexResetBusy: boolean;
  onResetCodexRateLimits(): void;
  onRefreshAccountUsage(): void;
  extraDirBrowser?: SessionExtraDirBrowserState | null;
  onLoadExtraDirPath(path: string): void;
  onToggleExtraDirBrowser(): void;
  onSetExtraDirs(dirs: string[]): void;
  onRename(title: string): void;
  /** 自动起名:被控端按会话素材重新生成标题(不落库);成功后由本组件走 onRename 提交。 */
  onRegenerateTitle(): Promise<{ title: string | null }>;
  /** 打开工作目录(复用文件浏览页);调用方负责关 sheet 并跳转。 */
  onOpenWorkspace(): void;
  /** Pi 原生会话树入口；只有 host runtime 真正返回 Pi 会话时由父级注入。 */
  onOpenSessionTree?: () => void;
  onTogglePinned(): void;
  onArchive(): void;
  onRestore(): void;
  onDelete(): void;
  onClose(): void;
  onClosed?: () => void;
  keyboardAvoidingBehavior: 'height' | 'padding' | undefined;
}

export function SessionMenuSheet({
  visible,
  initialView,
  session,
  busy,
  readOnlyReason,
  contextUsage,
  contextLoading,
  onRefreshContextUsage,
  accountUsage,
  codexRateLimits,
  codexResetBusy,
  onResetCodexRateLimits,
  onRefreshAccountUsage,
  extraDirBrowser,
  onLoadExtraDirPath,
  onToggleExtraDirBrowser,
  onSetExtraDirs,
  onRename,
  onRegenerateTitle,
  onOpenWorkspace,
  onOpenSessionTree,
  onTogglePinned,
  onArchive,
  onRestore,
  onDelete,
  onClose,
  onClosed,
  keyboardAvoidingBehavior,
}: SessionMenuSheetProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n: i18nInstance } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [view, setView] = useState<SessionMenuView>('menu');
  const [primarySnap, setPrimarySnap] = useState<ContextSheetSnap>('half');
  const [secondarySnap, setSecondarySnap] = useState<ContextSheetSnap>('half');
  const [renaming, setRenaming] = useState(false);
  const [renameGenerating, setRenameGenerating] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  // 重命名输入框的预填值:哨兵先过投影,输入框里不能出现内部哨兵 "New Maker"
  // (与桌面 SessionContentHeader 的预填同款)。用户不改直接确定时由 submitRename
  // 的「没改就不落库」判据挡住,详见那里的注释。
  const renamePrefill = projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle'));
  const [titleDraft, setTitleDraft] = useState(renamePrefill);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [extraDirsNotice, setExtraDirsNotice] = useState<string | null>(null);
  // 编辑轮次号:提交 / 取消 / 关闭都会 +1,自动起名的迟到结果据此丢弃(手动操作优先,
  // 与桌面 SessionRenameInput 的 mountedRef 守卫同语义)。
  const renameSeqRef = useRef(0);
  // 二级 Surface 滑入/滑出动画(0 = 就位;windowHeight = 屏下)。动画期间锁交互防连点。
  const secondaryTranslate = useRef(new Animated.Value(windowHeight)).current;
  const secondaryAnimatingRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const heights = useMemo(
    () => computeContextSheetSnapHeights({ safeAreaTopInset: insets.top, screenHeight: windowHeight }),
    [insets.top, windowHeight],
  );

  // 最新窗口高度走 ref:下面的重置 effect 刻意不依赖 windowHeight——设备旋转或
  // Android adjustResize 软键盘弹起都会改变 useWindowDimensions().height,若进依赖
  // 会在浮窗开着时整段重跑 reset(info 被瞬时拉回 menu、重命名编辑态被踢掉,违反
  // 规则 7 的无跳变要求;重命名 autoFocus 弹键盘 → 高度变化 → 立即退出编辑,主路径
  // 在 Android 上直接不可用)。
  const windowHeightRef = useRef(windowHeight);
  useEffect(() => {
    windowHeightRef.current = windowHeight;
  }, [windowHeight]);

  // 每次重新打开重置(视图落 initialView、snap 回 half、退出编辑、清反馈)。
  // 依赖只挂 visible/initialView(secondaryTranslate 是稳定 ref 值):窗口尺寸变化
  // 不触发重置,见上方 windowHeightRef 注释。
  useEffect(() => {
    if (!visible) return;
    setView(initialView);
    setPrimarySnap('half');
    setSecondarySnap('half');
    renameSeqRef.current += 1;
    setRenaming(false);
    setRenameGenerating(false);
    setRenameError(null);
    setCopiedKey(null);
    setExtraDirsNotice(null);
    secondaryAnimatingRef.current = false;
    secondaryTranslate.setValue(initialView === 'info' ? 0 : windowHeightRef.current);
  }, [visible, initialView, secondaryTranslate]);

  // 会话切换 / 远端改名后同步标题草稿,并退出编辑态。
  useEffect(() => {
    renameSeqRef.current += 1;
    setTitleDraft(renamePrefill);
    setRenaming(false);
    setRenameGenerating(false);
    setRenameError(null);
  }, [session.id, renamePrefill]);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  // 进入 info 视图且还没有上下文数据时自动拉一次(免去手点「刷新」的空态)。
  // 依赖刻意只挂 visible/view:contextUsage 到货或 loading 翻转不应重复触发拉取。
  useEffect(() => {
    if (!visible || view !== 'info') return;
    if (contextUsage || contextLoading) return;
    onRefreshContextUsage();
  }, [visible, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // 账号限额拉取:每次进入 info 视图都拉(被控端通道 cached-first,重复拉便宜且
  // 能带回后台刷新的新快照,不做「有数据就短路」——否则打开期间数据永不更新);
  // session.id 进依赖:面板开着原地切会话时父组件会清空快照,必须跟着重新拉取
  // (review #938 P1/P2)。失败静默,区块不渲染。
  useEffect(() => {
    if (!visible || view !== 'info') return;
    onRefreshAccountUsage();
  }, [visible, view, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openInfo = useCallback(() => {
    if (secondaryAnimatingRef.current || view === 'info') return;
    secondaryAnimatingRef.current = true;
    setSecondarySnap('half');
    setView('info');
    secondaryTranslate.setValue(windowHeight);
    Animated.timing(secondaryTranslate, {
      duration: SECONDARY_SLIDE_DURATION_MS,
      toValue: 0,
      useNativeDriver: true,
    }).start(() => {
      secondaryAnimatingRef.current = false;
    });
  }, [secondaryTranslate, view, windowHeight]);

  const backToMenu = useCallback(() => {
    if (secondaryAnimatingRef.current) return;
    secondaryAnimatingRef.current = true;
    Animated.timing(secondaryTranslate, {
      duration: SECONDARY_SLIDE_DURATION_MS,
      toValue: windowHeight,
      useNativeDriver: true,
    }).start(() => {
      secondaryAnimatingRef.current = false;
      setView('menu');
    });
  }, [secondaryTranslate, windowHeight]);

  // Android 返回键 / iOS 关闭手势:两段式(info 先回 menu,menu 才关浮窗)。
  const handleRequestClose = useCallback(() => {
    if (settleSessionMenuBack(view).close) {
      onClose();
      return;
    }
    backToMenu();
  }, [view, onClose, backToMenu]);

  const markCopied = useCallback((key: string) => {
    setCopiedKey(key);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedKey(null), COPY_FEEDBACK_MS);
  }, []);

  const copyValue = useCallback((key: string, value: string) => {
    void writeClipboardText(value)
      .then(() => markCopied(key))
      .catch(() => markCopied(`${key}:error`));
  }, [markCopied]);

  /** 复制按钮 / 行的反馈文案:成功「已复制」、失败「复制失败」,1.5s 后还原。 */
  const copyLabel = useCallback((base: string, key: string, copiedText = t('session.menu.copied')) => {
    if (copiedKey === key) return copiedText;
    if (copiedKey === `${key}:error`) return t('session.menu.copyFailed');
    return base;
  }, [copiedKey, t]);

  const writeDisabled = busy || !!readOnlyReason;
  const header = buildSessionMenuHeader(session, { readOnlyReason });
  const actions = buildSessionMenuActions({
    archived: session.status === 'archived',
    pinned: !!session.pinnedAt,
    busy,
    writeDisabled,
  });

  const submitRename = useCallback(() => {
    renameSeqRef.current += 1;
    const next = titleDraft.trim();
    setRenaming(false);
    setRenameGenerating(false);
    setRenameError(null);
    // 「没改就不落库」要同时比原始标题**和**预填的投影值:未起名会话预填的是本地化
    // 兜底文案,只比原始标题会把这个文案写进 DB,哨兵被毁 → 自动起名永久跳过该会话。
    if (!next || next === session.title || next === renamePrefill) {
      setTitleDraft(renamePrefill);
      return;
    }
    onRename(next);
  }, [onRename, renamePrefill, session.title, titleDraft]);

  const cancelRename = useCallback(() => {
    renameSeqRef.current += 1;
    setRenaming(false);
    setRenameGenerating(false);
    setRenameError(null);
    setTitleDraft(renamePrefill);
  }, [renamePrefill]);

  // 自动起名:生成结果只回填输入框,停留在编辑态等用户按「确定」提交(2026-07-06
  // 产品确认,与桌面「生成即提交」刻意不同);生成期间用户手动提交 / 取消 →
  // 轮次号变化,迟到结果丢弃。
  const handleAiRename = useCallback(async () => {
    if (renameGenerating) return;
    const seq = renameSeqRef.current;
    setRenameGenerating(true);
    setRenameError(null);
    try {
      const { title } = await onRegenerateTitle();
      if (renameSeqRef.current !== seq) return;
      const trimmed = title?.trim();
      if (trimmed) {
        setTitleDraft(trimmed);
      } else {
        setRenameError(t('session.menu.aiRenameFailed'));
      }
    } catch (err) {
      if (renameSeqRef.current !== seq) return;
      setRenameError(aiRenameFailureText(err));
    }
    setRenameGenerating(false);
  }, [onRegenerateTitle, renameGenerating, t]);

  // 删除确认后先关 sheet 再发删除(会话删除后本页会整体退出,不留悬空 overlay)。
  const confirmDelete = useCallback(() => {
    Alert.alert(t('session.menu.deleteConfirmTitle'), t('session.menu.deleteConfirmBody'), [
      { style: 'cancel', text: t('session.common.cancel') },
      {
        onPress: () => {
          onClose();
          onDelete();
        },
        style: 'destructive',
        text: t('session.common.delete'),
      },
    ]);
  }, [onClose, onDelete, t]);

  // 置顶 / 归档执行即收起菜单(手机菜单惯例);复制链接留在菜单展示「已复制」反馈,
  // 重命名进入原地编辑态。
  const handleAction = useCallback((action: SessionMenuAction) => {
    if (action.disabled) return;
    switch (action.id) {
      case 'rename':
        setTitleDraft(renamePrefill);
        setRenameError(null);
        setRenaming(true);
        return;
      case 'copyLink':
        copyValue('copyLink', sessionMenuCopyLink(session));
        return;
      case 'pin':
        onTogglePinned();
        onClose();
        return;
      case 'archive':
        if (session.status === 'archived') onRestore();
        else onArchive();
        onClose();
        return;
      case 'delete':
        confirmDelete();
        return;
      default:
        return;
    }
  }, [confirmDelete, copyValue, onArchive, onClose, onRestore, onTogglePinned, renamePrefill, session]);

  const currentExtraDirs = normalizeExtraDirs(session.extraDirs ?? undefined);
  const addExtraDir = useCallback((path: string) => {
    const next = addSessionExtraDir(session.extraDirs, path);
    if (!next.changed) {
      setExtraDirsNotice(t('session.menu.dirAlreadyAdded'));
      return;
    }
    setExtraDirsNotice(null);
    onSetExtraDirs(next.dirs);
  }, [onSetExtraDirs, session.extraDirs, t]);
  const removeExtraDir = useCallback((path: string) => {
    setExtraDirsNotice(null);
    onSetExtraDirs(removeSessionExtraDir(session.extraDirs, path));
  }, [onSetExtraDirs, session.extraDirs]);

  const spend = summarizeSessionSpend(session, mobilePresentationLocalizer);
  const usage = summarizeContextUsage(contextUsage, mobilePresentationLocalizer);
  // 账号限额行:窗口构成完全跟随被控端上游接口返回(不假设 5h/周),解析不出内容 → null 不渲染。
  // 陈旧判定依赖当前时间: 重开面板要重算, 面板长开跨过失效时刻也要重算
  // (与 desktop 的定时重选同口径; review 反馈)。
  const [quotaStaleTick, setQuotaStaleTick] = useState(0);
  const quotaBucketTables = useMemo(() => ({
    byLimitId: codexRateLimits?.rateLimitsByLimitId,
    appServerBuckets: (accountUsage as { appServerBuckets?: unknown } | null)?.appServerBuckets,
  }), [accountUsage, codexRateLimits]);
  useEffect(() => {
    if (!visible) return undefined;
    const now = Date.now();
    // 与选桶共用同一套桶表解析(空表也要回退, 不能用 ?? —— review 反馈)。
    const staleAt = nextCodexBucketStaleAtMs(resolveCodexBucketTable(quotaBucketTables), now);
    if (staleAt === null) return undefined;
    const timer = setTimeout(
      () => setQuotaStaleTick((tick) => tick + 1),
      Math.min(Math.max(staleAt - now, 0) + 1_000, 6 * 60 * 60 * 1000),
    );
    return () => clearTimeout(timer);
  }, [visible, quotaBucketTables, quotaStaleTick]);

  const accountLimits = useMemo(() => {
    const now = Date.now();
    // 账号可能同时有主配额桶与模型专属促销桶(如 GPT-5.3-Codex-Spark), 上游每次
    // 只报一个桶 —— 必须按**本会话模型**选桶, 否则会显示别的模型的额度
    // (desktop 同源问题见 useAccountUsage.matchCodexBucketForModel)。
    const scoped = selectCodexUsageForModel({
      fallback: accountUsage,
      byLimitId: quotaBucketTables.byLimitId,
      appServerBuckets: quotaBucketTables.appServerBuckets,
      modelId: session.model,
      nowMs: now,
    });
    return summarizeAccountRateLimits(scoped, now, mobilePresentationLocalizer);
    // visible / quotaStaleTick 进依赖: 重开与到点失效都要按当前时间重选。
  }, [accountUsage, i18nInstance.language, quotaBucketTables, session.model, visible, quotaStaleTick]);
  const resetSummary = useMemo(
    () => summarizeCodexRateLimitReset(codexRateLimits, Date.now(), mobilePresentationLocalizer),
    [codexRateLimits, i18nInstance.language],
  );
  const workspace = buildSessionInfoWorkspace(session);
  const showExtraDirs = sessionInfoShowsExtraDirs(session);

  const mainActions = actions.filter((action) => action.id !== 'delete');
  const deleteAction = actions.find((action) => action.id === 'delete');

  const confirmCodexReset = useCallback(() => {
    if (!resetSummary?.canReset || codexResetBusy) return;
    const account = [
      codexRateLimits?.account.email,
      codexRateLimits?.account.accountId,
      codexRateLimits?.account.planType,
    ].filter(Boolean).join(' · ');
    Alert.alert(
      t('session.menu.resetCodexTitle'),
      t('session.menu.resetCodexBody', { account: account || t('session.menu.currentCodexAccount') }),
      [
        { text: t('session.common.cancel'), style: 'cancel' },
        { text: t('session.menu.resetConsumeOnce'), onPress: onResetCodexRateLimits },
      ],
    );
  }, [codexRateLimits, codexResetBusy, onResetCodexRateLimits, resetSummary, t]);

  const menuContent = (
    <View style={styles.menuBody} testID="session.menuSheetBody">
      {renaming ? (
        <View style={styles.renameBlock} testID="session.renameBlock">
          <View style={styles.renameInputWrap}>
            <TextInput
              autoFocus
              onChangeText={(value) => {
                // 生成期间用户开始手动输入 → 视为更新的编辑轮次:作废在途 AI 结果并停掉
                // spinner,手动输入优先,迟到结果不得覆盖用户正在敲的标题(review P2)。
                if (renameGenerating) {
                  renameSeqRef.current += 1;
                  setRenameGenerating(false);
                }
                setTitleDraft(value);
                setRenameError(null);
              }}
              onSubmitEditing={submitRename}
              placeholder={t('session.menu.titlePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              returnKeyType="done"
              selectTextOnFocus
              style={styles.renameInput}
              testID="session.renameInput"
              value={titleDraft}
            />
            <Pressable
              accessibilityLabel={t('session.menu.aiRenameLabel')}
              accessibilityRole="button"
              accessibilityState={{ busy: renameGenerating }}
              hitSlop={6}
              onPress={() => void handleAiRename()}
              style={({ pressed }) => [styles.renameAiButton, pressed && styles.pressed]}
              testID="session.renameAiButton"
            >
              {renameGenerating ? (
                <ActivityIndicator color={colors.textSecondary} size="small" />
              ) : (
                <Sparkles color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              )}
            </Pressable>
          </View>
          {renameError ? (
            <Text style={styles.renameErrorText} testID="session.renameError">{renameError}</Text>
          ) : null}
        </View>
      ) : (
        <>
          <View style={styles.headerBlock} testID="session.menuHeader">
            {header.chips.length > 0 ? (
              <View style={styles.chipRow}>
                {header.chips.map((chip) => (
                  <View key={chip.id} style={styles.chip} testID={`session.menuChip.${chip.id}`}>
                    <Text style={styles.chipText}>{chip.label}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Text numberOfLines={1} style={styles.metaLine} testID="session.menuMetaLine">
              {header.metaLine}
            </Text>
            {readOnlyReason ? (
              <Text style={styles.readOnlyText} testID="session.menuReadOnlyNotice">
                {readOnlyReason}
              </Text>
            ) : null}
            {header.usageSummary ? (
              <Pressable
                accessibilityLabel={t('session.menu.viewUsageDetail')}
                accessibilityRole="button"
                onPress={openInfo}
                style={({ pressed }) => [styles.usageRow, pressed && styles.pressed]}
                testID="session.menuUsageRow"
              >
                <Text numberOfLines={1} style={styles.usageText}>{header.usageSummary}</Text>
                <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              </Pressable>
            ) : null}
          </View>

          <View style={styles.actionGroup}>
            {mainActions.map((action) => (
              <MenuActionRow
                key={action.id}
                disabled={action.disabled}
                icon={menuActionIcon(action, session)}
                label={action.id === 'copyLink'
                  ? copyLabel(action.label, 'copyLink', t('session.menu.linkCopied'))
                  : action.label}
                onPress={() => handleAction(action)}
                testID={action.testID}
              />
            ))}
          </View>

          <View style={styles.actionGroup}>
            {session.agentKind === 'pi' && onOpenSessionTree ? (
              <MenuActionRow
                icon={GitBranch}
                label={t('session.menu.branches')}
                onPress={onOpenSessionTree}
                testID="session.branchesButton"
                trailing={<ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />}
              />
            ) : null}
            <MenuActionRow
              icon={Info}
              label={t('session.menu.sessionInfo')}
              onPress={openInfo}
              testID="session.infoButton"
              trailing={<ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />}
            />
          </View>

          {deleteAction ? (
            <View style={styles.actionGroup}>
              <MenuActionRow
                danger
                disabled={deleteAction.disabled}
                icon={Trash2}
                label={deleteAction.label}
                onPress={() => handleAction(deleteAction)}
                testID={deleteAction.testID}
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );

  const infoContent = (
    <View style={styles.infoBody} testID="session.infoSheetBody">
      <View style={styles.infoSection}>
        <View style={styles.infoSectionHeader}>
          <Text style={styles.infoSectionTitle}>{t('session.menu.usageSection')}</Text>
          <Pressable
            accessibilityLabel={t('session.menu.refreshContextUsage')}
            accessibilityRole="button"
            disabled={contextLoading}
            onPress={onRefreshContextUsage}
            style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
            testID="session.contextRefreshButton"
          >
            {contextLoading ? (
              <ActivityIndicator color={colors.textSecondary} size="small" />
            ) : (
              <RefreshCw color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            )}
          </Pressable>
        </View>
        <InfoRow label={t('session.menu.currentSessionSpend')} value={spend.available ? spend.detail : t('session.menu.noSessionSpend')} />
        <InfoRow label={t('session.menu.contextLabel')} value={usage.detail} />
        {usage.rows.length > 0 ? (
          <View style={styles.usageRows} testID="session.contextRows">
            {usage.rows.map((row) => (
              <InfoRow key={`${row.label}:${row.value}`} label={row.label} value={row.value} />
            ))}
          </View>
        ) : null}
      </View>

      {accountLimits || resetSummary ? (
        <View style={styles.infoSection} testID="session.accountLimitsSection">
          <Text style={styles.infoSectionTitle}>{t('session.menu.accountLimits')}</Text>
          {accountLimits?.rows.map((row, index) => (
            // 两个窗口都缺时长数据时 label 会同为「限额」,key 需带 index 去重。
            <InfoRow key={`${row.label}:${index}`} label={row.label} value={row.value} />
          ))}
          {resetSummary?.rows.map((row, index) => (
            <InfoRow key={`reset:${row.label}:${index}`} label={row.label} value={row.value} />
          ))}
          {resetSummary?.canReset ? (
            <>
              <Text style={styles.infoCaption}>
                {t('session.menu.quotaExhaustedResettable')}
              </Text>
              <View style={styles.infoActionRow}>
                <MenuPillButton
                  disabled={codexResetBusy}
                  label={codexResetBusy ? t('session.menu.resetting') : t('session.menu.resetCodexUsage')}
                  onPress={confirmCodexReset}
                  testID="session.codexRateLimitResetButton"
                  tone="primary"
                />
              </View>
            </>
          ) : resetSummary?.shouldPrompt && resetSummary.availableCount === 0 ? (
            <Text style={styles.infoCaption}>{t('session.menu.quotaExhaustedNoCredit')}</Text>
          ) : null}
        </View>
      ) : null}

      {workspace ? (
        <View style={styles.infoSection} testID="session.worktreeStatus">
          <Text style={styles.infoSectionTitle}>{workspace.label}</Text>
          <InfoRow label={workspace.name} mono value={workspace.path} />
          <View style={styles.infoActionRow}>
            <MenuPillButton
              label={t('session.menu.openDir')}
              onPress={onOpenWorkspace}
              testID="session.openWorkspaceButton"
            />
            <MenuPillButton
              label={copyLabel(t('session.menu.copyPath'), 'workspacePath')}
              onPress={() => copyValue('workspacePath', workspace.path)}
              testID="session.copyWorkspacePath"
            />
          </View>
        </View>
      ) : null}

      {showExtraDirs ? (
        <View style={styles.infoSection} testID="session.extraDirsSection">
          <Text style={styles.infoSectionTitle}>{t('session.menu.extraDirsSection')}</Text>
          {currentExtraDirs.length === 0 ? (
            <Text style={styles.infoCaption} testID="session.extraDirsStatus">
              {t('session.menu.noExtraDirs')}
            </Text>
          ) : (
            <View style={styles.extraDirList}>
              {currentExtraDirs.map((dir) => (
                <View key={dir} style={styles.extraDirRow} testID="session.extraDirRow">
                  <Text numberOfLines={1} style={styles.extraDirPath}>{dir}</Text>
                  <MenuPillButton
                    disabled={writeDisabled}
                    label={t('session.menu.remove')}
                    onPress={() => removeExtraDir(dir)}
                    testID="session.extraDirRemoveButton"
                  />
                </View>
              ))}
            </View>
          )}
          {extraDirsNotice ? (
            <Text style={styles.infoCaption} testID="session.extraDirsDraftStatus">{extraDirsNotice}</Text>
          ) : null}
          <View style={styles.infoActionRow}>
            <MenuPillButton
              disabled={writeDisabled || !!extraDirBrowser?.loading}
              label={extraDirBrowser?.open ? t('session.menu.collapseRemoteDir') : t('session.menu.browseRemoteDir')}
              onPress={onToggleExtraDirBrowser}
              testID="session.extraDirsBrowseToggle"
            />
          </View>
          {extraDirBrowser?.open ? (
            <View style={styles.browsePanel} testID="session.extraDirsBrowsePanel">
              <Text
                numberOfLines={2}
                selectable
                style={styles.browsePath}
                testID="session.extraDirsBrowseCurrentPath"
              >
                {extraDirBrowser.path || t('session.menu.reading')}
              </Text>
              <View style={styles.infoActionRow}>
                <MenuPillButton
                  disabled={writeDisabled || extraDirBrowser.loading || !extraDirBrowser.parent}
                  label={t('session.menu.parentDir')}
                  onPress={() => extraDirBrowser.parent && onLoadExtraDirPath(extraDirBrowser.parent)}
                  testID="session.extraDirsBrowseParentButton"
                />
                <MenuPillButton
                  disabled={writeDisabled || extraDirBrowser.loading || !extraDirBrowser.path}
                  label={t('session.menu.addCurrentDir')}
                  onPress={() => addExtraDir(extraDirBrowser.path)}
                  testID="session.extraDirsBrowseAddCurrent"
                />
              </View>
              {extraDirBrowser.error ? (
                <Text style={styles.infoCaption}>{extraDirBrowser.error}</Text>
              ) : null}
              <View style={styles.browseList}>
                {extraDirBrowser.entries.slice(0, 30).map((entry) => (
                  <View key={entry.path} style={styles.browseRow} testID="session.extraDirsBrowseEntry">
                    <Pressable
                      accessibilityLabel={t('session.menu.enterRemoteDir', { name: entry.name })}
                      accessibilityRole="button"
                      disabled={writeDisabled || extraDirBrowser.loading}
                      onPress={() => onLoadExtraDirPath(entry.path)}
                      style={({ pressed }) => [styles.browseEntryButton, pressed && styles.pressed]}
                    >
                      <Text numberOfLines={1} style={styles.browseEntryName}>{entry.name}</Text>
                      <Text numberOfLines={1} style={styles.browseEntryPath}>
                        {entry.kind === 'symlink' ? 'symlink · ' : ''}{entry.path}
                      </Text>
                    </Pressable>
                    <MenuPillButton
                      disabled={writeDisabled || extraDirBrowser.loading}
                      label={t('session.menu.add')}
                      onPress={() => addExtraDir(entry.path)}
                      testID="session.extraDirsBrowseAddEntry"
                    />
                  </View>
                ))}
                {!extraDirBrowser.loading && extraDirBrowser.entries.length === 0 && !extraDirBrowser.error ? (
                  <Text style={styles.infoCaption}>{t('session.menu.noSubDirs')}</Text>
                ) : null}
                {extraDirBrowser.entries.length > 30 ? (
                  <Text style={styles.infoCaption}>{t('session.menu.dirLimitNotice')}</Text>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

    </View>
  );

  return (
    <SheetModal
      backdropTestID="session.settingsBackdrop"
      keyboardAvoiding
      keyboardAvoidingBehavior={keyboardAvoidingBehavior}
      onBackdropPress={onClose}
      onClosed={onClosed}
      onRequestClose={handleRequestClose}
      visible={visible}
    >
      <SheetSurface
        bottomInset={insets.bottom}
        // 确认对统一规则:重命名编辑态的确定/取消走 footer 插槽置底(满宽纵排,确定在上取消居底)。
        footer={renaming ? (
          <MainWindowActionGroup
            primaryActions={[{
              accessibilityLabel: t('session.menu.confirmRename'),
              label: t('session.menu.confirm'),
              onPress: submitRename,
              testID: 'session.renameButton',
              tone: 'primary',
            }]}
            cancelAction={{
              accessibilityLabel: t('session.menu.cancelRename'),
              label: t('session.common.cancel'),
              onPress: cancelRename,
              testID: 'session.renameCancelButton',
            }}
            testID="session.renameActions"
          />
        ) : undefined}
        heights={heights}
        onClose={onClose}
        onSnapChange={setPrimarySnap}
        snap={primarySnap}
        testID="session.menuSheet"
        title={header.title}
        variant="tasksheet"
      >
        {menuContent}
      </SheetSurface>
      {view === 'info' ? (
        <Animated.View
          style={[styles.secondaryLayer, { transform: [{ translateY: secondaryTranslate }] }]}
          testID="session.infoLayer"
        >
          <Pressable
            accessibilityLabel={t('session.menu.backToMenu')}
            accessibilityRole="button"
            onPress={backToMenu}
            style={styles.secondaryBackdrop}
            testID="session.infoBackdrop"
          />
          <SheetSurface
            backAccessibilityLabel={t('session.menu.backToMenu')}
            bottomInset={insets.bottom}
            heights={heights}
            onBack={backToMenu}
            onClose={backToMenu}
            onSnapChange={setSecondarySnap}
            snap={secondarySnap}
            testID="session.infoSheet"
            title={t('session.menu.sessionInfo')}
          >
            {infoContent}
          </SheetSurface>
        </Animated.View>
      ) : null}
    </SheetModal>
  );
}

type MenuIcon = typeof Pencil;

function menuActionIcon(action: SessionMenuAction, session: Pick<RemoteSession, 'pinnedAt' | 'status'>): MenuIcon {
  switch (action.id) {
    case 'rename': return Pencil;
    case 'copyLink': return Link2;
    case 'pin': return session.pinnedAt ? PinOff : Pin;
    case 'archive': return session.status === 'archived' ? ArchiveRestore : Archive;
    case 'delete': return Trash2;
    default: return Copy;
  }
}

function MenuActionRow({
  danger = false,
  disabled = false,
  icon: IconComponent,
  label,
  onPress,
  testID,
  trailing,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: MenuIcon;
  label: string;
  onPress: () => void;
  testID?: string;
  trailing?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const color = danger ? colors.destructive : colors.sheetActionText;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.actionRow,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <IconComponent color={color} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      <Text numberOfLines={1} style={[styles.actionLabel, danger && styles.actionLabelDanger]}>
        {label}
      </Text>
      {trailing ? <View style={styles.actionTrailing}>{trailing}</View> : null}
    </Pressable>
  );
}

function MenuPillButton({
  disabled = false,
  label,
  onPress,
  testID,
  tone = 'default',
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
  tone?: 'default' | 'primary';
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.pillButton,
        tone === 'primary' && styles.pillButtonPrimary,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text
        numberOfLines={1}
        style={[styles.pillButtonText, tone === 'primary' && styles.pillButtonTextPrimary]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function InfoRow({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.infoRow}>
      <Text numberOfLines={1} style={styles.infoLabel}>{label}</Text>
      <Text selectable style={[styles.infoValue, mono && styles.infoValueMono]}>{value}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // Modal 外壳(背板/内容层/键盘规避)样式已随 SheetModal 抽出。
  secondaryLayer: {
    bottom: 0,
    justifyContent: 'flex-end',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  secondaryBackdrop: {
    backgroundColor: colors.overlay,
    flex: 1,
  },
  menuBody: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  headerBlock: {
    alignSelf: 'stretch',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  chipRow: {
    alignSelf: 'stretch',
    justifyContent: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  metaLine: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  readOnlyText: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  usageRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'space-between',
    minHeight: 32,
  },
  usageText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.caption,
    minWidth: 0,
  },
  actionGroup: {
    backgroundColor: colors.sheetActionSurface,
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 45,
    paddingHorizontal: spacing.lg,
  },
  actionLabel: {
    color: colors.sheetActionText,
    flexShrink: 1,
    fontSize: typeScale.listBody,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listBody,
  },
  actionLabelDanger: {
    color: colors.destructive,
  },
  actionTrailing: {
    marginLeft: 'auto',
  },
  renameBlock: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  renameInputWrap: {
    justifyContent: 'center',
  },
  renameInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    minHeight: 44,
    paddingLeft: spacing.md,
    paddingRight: 44,
  },
  renameAiButton: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    top: 0,
    width: 44,
  },
  renameErrorText: {
    color: colors.errorText,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  infoBody: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  infoSection: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  infoSectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  infoSectionTitle: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  refreshButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    minWidth: 32,
  },
  infoRow: {
    gap: 2,
  },
  infoLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  infoValue: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  infoValueMono: {
    color: colors.textSecondary,
    fontFamily: monoFont,
  },
  infoCaption: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  infoActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  usageRows: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  extraDirList: {
    gap: spacing.sm,
  },
  extraDirRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  extraDirPath: {
    color: colors.textPrimary,
    flex: 1,
    fontFamily: monoFont,
    fontSize: typeScale.caption,
    minWidth: 0,
  },
  browsePanel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  browsePath: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  browseList: {
    gap: spacing.sm,
  },
  browseRow: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    padding: spacing.sm,
  },
  browseEntryButton: {
    flex: 1,
    minWidth: 0,
  },
  browseEntryName: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  browseEntryPath: {
    color: colors.textTertiary,
    fontSize: typeScale.micro,
    marginTop: 2,
  },
  pillButton: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 36,
    minWidth: 72,
    paddingHorizontal: spacing.md,
  },
  pillButtonPrimary: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  pillButtonText: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  pillButtonTextPrimary: {
    color: colors.ctaText,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.45,
  },
});
