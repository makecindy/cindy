import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  View,
  type GestureResponderHandlers,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { TextInput } from '@/components/AppText';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { TextInputWrapper, type PasteEventPayload } from 'expo-paste-input';
import { Mic } from 'lucide-react-native';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { iconSize, iconStroke, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';
import {
  COMPOSER_SINGLE_LINE_HEIGHT,
  COMPOSER_TEXT_HORIZONTAL_PADDING,
  COMPOSER_TEXT_LINE_HEIGHT,
  COMPOSER_TEXT_STYLE,
  COMPOSER_TEXT_VERTICAL_PADDING,
} from '@/session/composerTextMetrics';
import {
  COMPOSER_TEXT_PADDING_BOTTOM,
  COMPOSER_TEXT_PADDING_TOP,
} from '@/session/composerTextPlatformMetrics';

/**
 * Composer 草稿文本的排版档。正本在 `composerTextMetrics`——原生输入框、WebView 富文本
 * 编辑器与语音听写覆盖层共用同一档,任一处漂移都会让听写文字与真实输入框换行位置错开
 * (详见该文件注释)。此处只做转出,页面按既有名字引用。
 */
export const MOBILE_COMPOSER_DRAFT_TEXT_STYLE = COMPOSER_TEXT_STYLE;

/**
 * 输入区的单行**内容高度**(不含上下内边距) = 单行文字行高:两者同源,保证「单行」
 * 正好装一行文字。含内边距的单行可视高度是 MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT。
 */
export const MOBILE_COMPOSER_INPUT_LINE_HEIGHT = COMPOSER_TEXT_LINE_HEIGHT;
export const MOBILE_COMPOSER_INPUT_VERTICAL_PADDING = COMPOSER_TEXT_VERTICAL_PADDING;
export const MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT = COMPOSER_SINGLE_LINE_HEIGHT;
export const MOBILE_COMPOSER_INPUT_MAX_VISIBLE_LINES = 12;
export const MOBILE_COMPOSER_INPUT_MAX_HEIGHT = (MOBILE_COMPOSER_INPUT_LINE_HEIGHT * MOBILE_COMPOSER_INPUT_MAX_VISIBLE_LINES)
  + (MOBILE_COMPOSER_INPUT_VERTICAL_PADDING * 2);
export const MOBILE_COMPOSER_CONTROL_SIZE = 34;
export const MOBILE_COMPOSER_TOOL_GAP = 6;
/**
 * 触控目标下限(mobile-design-guide「主操作命中区 ≥ 44×44」,iOS HIG 同值)。
 * 语音听写期间「点输入区停止听写」的命中层用它撑起 inputFrame(见 inputFrameMinHeight)。
 */
export const MOBILE_COMPOSER_MIN_TOUCH_TARGET = 44;
const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
/** 语音按钮 absolute 锚点距 composer 内容区右缘的距离(voiceButtonAnchor.right);
 * 消息列表的「跳到底部」浮标按同一常量推导麦克风所在列,保持两者圆心同列。 */
export const MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT = spacing.md;

export interface MobileComposerVoiceButtonPlacement {
  floating: boolean;
  inline: boolean;
}

/**
 * 语音按钮的位置分配：行尾有发送 / 创建 / 停止等 trailing 按钮时向左让位
 * （floating）、否则贴行尾（inline）。判定看「是否有 trailing 按钮」而非
 * 「是否有文字」——附件-only（无文字但发送按钮可见）时同样需要让位。
 * 听写中按钮不隐藏——对齐桌面版设计，同一颗按钮录音中变为「停止录音」形态。
 */
export function resolveMobileComposerVoiceButtonPlacement(input: {
  hasTrailingAction: boolean;
}): MobileComposerVoiceButtonPlacement {
  return {
    floating: input.hasTrailingAction,
    inline: !input.hasTrailingAction,
  };
}

export interface MobileComposerInputRowProps {
  accessibilityHint?: string;
  accessibilityLabel: string;
  /**
   * 卡片内、输入行上方的附加内容(附件缩略图托盘等,对照 Cursor 图片在输入卡内)。
   * 仅 cardActive 形态渲染;简洁态的对应物是 leading 插槽的迷你徽标。
   */
  accessoryAbove?: ReactNode;
  /**
   * 聚焦卡片形态开关。true 时输入区独占整行、底部工具排展开；
   * false 时保持单行简洁态，工具排折叠为 0 高（保持挂载，展开时按钮
   * 像抽屉滑出而非淡入重建，配合 useComposerCardTransition 的布局动画）。
   */
  cardActive?: boolean;
  caretHidden?: boolean;
  compact?: boolean;
  autoFocus?: TextInputProps['autoFocus'];
  cursorColor?: TextInputProps['cursorColor'];
  editable?: boolean;
  /**
   * 语音按钮 render。语音按钮是简洁态与卡片态都存在的常驻控件，
   * 由组件用 absolute 锚点渲染为同一实例：简洁态贴输入行右侧、
   * 卡片态落在底部工具排右二（工具排里放 ComposerToolbarVoiceSlot 占位），
   * 两态切换时 LayoutAnimation 对同一实例的位置做平滑插值，不闪不跳。
   */
  floatingVoiceButton?: (style: StyleProp<ViewStyle>) => ReactNode;
  floatingVoiceButtonStyle?: StyleProp<ViewStyle>;
  /**
   * 输入区（inputFrame）的显式高度：拖拽跟手时传 Animated 值、manual 定高时传数值，
   * null / undefined 走内容自动增长（现状行为）。
   */
  inputFrameHeight?: number | Animated.Value | null;
  /**
   * 输入区（inputFrame）的最小高度。给语音听写用：听写期间「点输入区停止听写」的命中层
   * 盖在 inputFrame 上，而单行听写时 inputFrame 只有 28pt，不满足触控目标 44pt；
   * hitSlop 解决不了——RN 的命中区不会越过父视图边界，必须让父容器本身够高。
   */
  inputFrameMinHeight?: number;
  /** Rich composer replacement for the plain TextInput. */
  inputElement?: ReactNode;
  inputOverlay?: ReactNode;
  inputRef?: unknown;
  inputStyle?: StyleProp<TextStyle>;
  inputTestID: string;
  leading?: ReactNode;
  maxHeight?: number;
  multiline?: boolean;
  multilineShape?: boolean;
  onBlur?: TextInputProps['onBlur'];
  onChangeText: (value: string) => void;
  onContentSizeChange?: TextInputProps['onContentSizeChange'];
  onFocus?: TextInputProps['onFocus'];
  /**
   * 粘贴图片回调(expo-paste-input):长按输入框 Paste 剪贴板图片时收到
   * file:// 临时文件 uri 列表,原生侧已阻止图片以默认方式插入文本;
   * 纯文本粘贴不经此回调、行为不变。有值时 TextInput 外包 TextInputWrapper——
   * 本 prop 必须在页面挂载期恒定(恒有值或恒无值),中途 undefined⇄有值切换
   * 会改变子树形状导致 TextInput remount(丢焦点 / 选区)。
   */
  onPasteImages?: (uris: string[]) => void;
  /**
   * 粘贴占位回调(expo-paste-input 本仓 patch 扩展):原生检测到图片粘贴意图时
   * **立即**上抛 count(只查剪贴板类型元数据,不读数据),此时数据读取 / 转码 /
   * 写盘还在原生后台进行——页面用它先画 N 张转圈占位卡,等 onPasteImages 兑现。
   * 旧原生层(未带 patch 的 OTA 场景)不会发这个事件,占位逻辑必须可缺席。
   */
  onPasteImagesLoading?: (count: number) => void;
  /** 粘贴占位失败回调:原生后台读取 / 写盘失败,页面撤掉占位卡。 */
  onPasteImagesLoadFailed?: () => void;
  onPressIn?: TextInputProps['onPressIn'];
  placeholder: string;
  placeholderTextColor: string;
  /** 顶部居中的拖拽调高 grabber（ComposerResizeGrabber），absolute 定位不占布局空间。 */
  resizeHandle?: ReactNode;
  rowStyle?: StyleProp<ViewStyle>;
  scrollEnabled?: boolean;
  selectionColor?: TextInputProps['selectionColor'];
  testID?: string;
  /**
   * 底部工具排内容（参考 Cursor 移动端聚焦态）。仅 cardActive 时挂载，
   * 配合 useComposerCardTransition 的 create / delete（opacity）段，
   * 按钮在最终位置原地渐显 / 渐隐，没有位移感；常驻的语音按钮不在此排
   * 渲染（走 floatingVoiceButton 的 absolute 锚点保证位置连续）。
   * card 形态下 leading / trailing 不渲染（工具应放本插槽）。
   */
  toolbar?: ReactNode;
  trailing?: ReactNode;
  value: string;
  voicePlacement?: MobileComposerVoiceButtonPlacement;
}

/**
 * Shared mobile chat composer row.
 *
 * Both the active session composer and the new-session composer use this for
 * the one-layer capsule, text input metrics, and inline-vs-floating voice
 * button placement. Page-specific actions stay injected as slots.
 */
export function MobileComposerInputRow({
  accessibilityHint,
  accessibilityLabel,
  accessoryAbove,
  autoFocus,
  cardActive,
  caretHidden,
  compact,
  cursorColor,
  editable = true,
  floatingVoiceButton,
  floatingVoiceButtonStyle,
  inputFrameHeight,
  inputFrameMinHeight,
  inputElement,
  inputOverlay,
  inputRef,
  inputStyle,
  inputTestID,
  leading,
  maxHeight = MOBILE_COMPOSER_INPUT_MAX_HEIGHT,
  multiline = true,
  multilineShape,
  onBlur,
  onChangeText,
  onContentSizeChange,
  onFocus,
  onPasteImages,
  onPasteImagesLoading,
  onPasteImagesLoadFailed,
  onPressIn,
  placeholder,
  placeholderTextColor,
  resizeHandle,
  rowStyle,
  scrollEnabled,
  selectionColor,
  testID,
  toolbar,
  trailing,
  value,
  voicePlacement,
}: MobileComposerInputRowProps) {
  const styles = useThemedStyles(makeMobileComposerInputRowStyles);
  const cardLayout = cardActive === true;
  // RN 里显式 height 压过 minHeight:manual 定高(用户拖过高度)时 frameHeight 可能小于
  // inputFrameMinHeight,直接铺开会把听写停止命中区又压回不足 44pt。数值高度在这里
  // 先 clamp;拖拽中的 Animated 值无法在 JS 侧 clamp(会打断跟手),那一瞬保持动画值,
  // 松手结算成数值后重新受本 clamp 约束。
  const resolvedInputFrameHeight = typeof inputFrameHeight === 'number' && inputFrameMinHeight != null
    ? Math.max(inputFrameHeight, inputFrameMinHeight)
    : inputFrameHeight;
  // useCallback 稳定引用,避免每次 render 都向原生 TextInputWrapper diff 新函数 prop。
  // images-loading:原生刚检测到图片粘贴意图(数据还在后台读),先画占位;
  // images:原生侧已阻止默认粘贴,上抛进附件链路(占位在此兑现);
  // images-load-failed:后台读取失败,撤占位;
  // text:默认插入已发生;unsupported:无可处理内容——都忽略。
  const handleNativePaste = useCallback((payload: PasteEventPayload) => {
    if (payload.type === 'images' && payload.uris.length > 0) {
      onPasteImages?.(payload.uris);
    } else if (payload.type === 'images-loading' && payload.count > 0) {
      onPasteImagesLoading?.(payload.count);
    } else if (payload.type === 'images-load-failed') {
      onPasteImagesLoadFailed?.();
    }
  }, [onPasteImages, onPasteImagesLoading, onPasteImagesLoadFailed]);
  const textInputElement = (
    <TextInput
      ref={inputRef as never}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      autoFocus={autoFocus}
      caretHidden={caretHidden}
      cursorColor={cursorColor}
      editable={editable}
      multiline={multiline}
      onBlur={onBlur}
      onChangeText={onChangeText}
      onContentSizeChange={onContentSizeChange}
      onFocus={onFocus}
      onPressIn={onPressIn}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      scrollEnabled={scrollEnabled}
      selectionColor={selectionColor}
      style={[
        styles.input,
        { maxHeight },
        inputStyle,
      ]}
      testID={inputTestID}
      value={value}
    />
  );
  return (
    <View
      style={[
        styles.row,
        compact && styles.rowCompact,
        multilineShape && styles.rowMultiline,
        cardLayout && styles.rowCard,
        rowStyle,
      ]}
      testID={testID}
    >
      {resizeHandle}
      {cardLayout ? accessoryAbove : null}
      <View
        style={[
          styles.mainRow,
          multilineShape && styles.mainRowMultiline,
          !cardLayout && voicePlacement?.inline && styles.mainRowVoiceInset,
        ]}
      >
        {cardLayout ? null : leading}
        <Animated.View
          style={[
            styles.inputFrame,
            inputFrameMinHeight != null && { minHeight: inputFrameMinHeight },
            resolvedInputFrameHeight != null && { height: resolvedInputFrameHeight },
          ]}
        >
          {inputElement ?? (onPasteImages && !isExpoGo ? (
            <TextInputWrapper onPaste={handleNativePaste} style={styles.pasteWrapper}>
              {textInputElement}
            </TextInputWrapper>
          ) : textInputElement)}
          {inputOverlay}
        </Animated.View>
        {cardLayout ? null : trailing}
      </View>
      {cardLayout && toolbar != null ? (
        <View
          style={styles.toolbarRow}
          testID={testID ? `${testID}.toolbar` : undefined}
        >
          {toolbar}
        </View>
      ) : null}
      {voicePlacement?.inline || voicePlacement?.floating
        ? floatingVoiceButton?.([
          styles.voiceButtonAnchor,
          voicePlacement.floating && styles.voiceButtonAnchorWithTrailing,
          cardLayout && styles.voiceButtonAnchorCard,
          floatingVoiceButtonStyle,
        ])
        : null}
    </View>
  );
}

/** card 工具排中把右侧按钮组推向行尾的弹性占位。 */
export function ComposerToolbarSpacer() {
  const styles = useThemedStyles(makeMobileComposerInputRowStyles);
  return <View style={styles.toolbarSpacer} />;
}

/**
 * 工具排 / 输入行 flex 流中语音按钮的等宽占位。真实语音按钮由
 * MobileComposerInputRow 以 absolute 锚点渲染（保证两态同一实例、位置平滑
 * 过渡），流内用本占位为它留出位置。录音中胶囊(红点+计时)比常态宽,由
 * `width` 传入当前胶囊宽度(useMobileVoiceRecordingTimer.pillWidth),占位随
 * 之变宽把左邻按钮推开——胶囊只向左生长,右缘(与发送键的邻接关系)不动。
 */
export function ComposerToolbarVoiceSlot({ width }: { width?: number }) {
  const styles = useThemedStyles(makeMobileComposerInputRowStyles);
  return <View style={[styles.toolbarVoiceSlot, width != null && { width }]} />;
}

export interface ComposerResizeGrabberProps {
  /** 屏幕阅读器的 increment / decrement 步进调高（useComposerResize.adjustByLine）。 */
  onAdjust?: (direction: 1 | -1) => void;
  /**
   * useComposerResize 输出的 PanResponder handlers + 原生触摸监听
   * （onTouchStart/End/Cancel 驱动 grabberTouchActive，页面据此关闭外壳
   * ScrollView 滚动，防止原生滚动抢走拖拽手势）。
   */
  panHandlers: GestureResponderHandlers & Pick<ViewProps, 'onTouchStart' | 'onTouchEnd' | 'onTouchCancel'>;
  /** 不可见时淡出且不响应触摸，布局位置保持不变（避免出现/消失跳变）。 */
  visible: boolean;
  testID?: string;
}

/**
 * Composer 顶部居中的拖拽调高 grabber。
 *
 * absolute 贴在 capsule 顶部内侧，不参与布局，因此显示 / 隐藏只有透明度变化、
 * 不会引起输入行高度跳变。触摸命中区是顶部居中的一段窄条，比可见的横条大得多，
 * 行两端保持穿透，不与左右按钮抢触摸。
 */
export function ComposerResizeGrabber({ onAdjust, panHandlers, visible, testID }: ComposerResizeGrabberProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeMobileComposerInputRowStyles);
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    const animation = Animated.timing(opacity, {
      duration: 150,
      easing: Easing.out(Easing.ease),
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity, visible]);

  return (
    <Animated.View
      pointerEvents={visible ? 'box-none' : 'none'}
      style={[styles.resizeGrabberTouch, { opacity }]}
    >
      <View
        accessibilityActions={[
          { label: t('composer.input.resize.increaseHeight'), name: 'increment' },
          { label: t('composer.input.resize.decreaseHeight'), name: 'decrement' },
        ]}
        accessibilityHint={t('composer.input.resize.hint')}
        accessibilityLabel={t('composer.input.resize.label')}
        accessibilityRole="adjustable"
        onAccessibilityAction={(event) => {
          onAdjust?.(event.nativeEvent.actionName === 'increment' ? 1 : -1);
        }}
        style={styles.resizeGrabberHit}
        testID={testID}
        {...panHandlers}
      >
        <View style={styles.resizeGrabberBar} />
      </View>
    </Animated.View>
  );
}

export function VoiceMicWaveCaret({ color, testID }: { color: string; testID?: string }) {
  const styles = useThemedStyles(makeMobileComposerInputRowStyles);
  const bar1 = useRef(new Animated.Value(0)).current;
  const bar2 = useRef(new Animated.Value(0)).current;
  const bar3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const bars = [bar1, bar2, bar3] as const;
    const loops = bars.map((bar, index) => Animated.loop(
      Animated.sequence([
        Animated.delay(index * 180),
        Animated.timing(bar, {
          duration: 550,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(bar, {
          duration: 550,
          easing: Easing.inOut(Easing.ease),
          toValue: 0,
          useNativeDriver: true,
        }),
      ]),
    ));
    loops.forEach((loop) => loop.start());
    return () => {
      loops.forEach((loop) => loop.stop());
    };
  }, [bar1, bar2, bar3]);

  const animatedBarStyle = (bar: Animated.Value) => ({
    opacity: bar.interpolate({
      inputRange: [0, 1],
      outputRange: [0.5, 1],
    }),
    transform: [{
      scaleY: bar.interpolate({
        inputRange: [0, 1],
        outputRange: [0.42, 1],
      }),
    }],
  });

  return (
    <View
      pointerEvents="none"
      style={styles.voiceMicCaret}
      testID={testID}
    >
      <Mic color={color} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      <View style={styles.voiceMicBars}>
        <Animated.View
          style={[
            styles.voiceMicBar,
            styles.voiceMicBarSide,
            { backgroundColor: color },
            animatedBarStyle(bar1),
          ]}
        />
        <Animated.View
          style={[
            styles.voiceMicBar,
            styles.voiceMicBarMiddle,
            { backgroundColor: color },
            animatedBarStyle(bar2),
          ]}
        />
        <Animated.View
          style={[
            styles.voiceMicBar,
            styles.voiceMicBarSide,
            { backgroundColor: color },
            animatedBarStyle(bar3),
          ]}
        />
      </View>
    </View>
  );
}

const makeMobileComposerInputRowStyles = (colors: ThemeColors) => ({
  // 外壳是纵向容器：mainRow（输入行）在上、toolbarRow（工具排）在下；
  // 简洁态工具排折叠为 0 高，外壳看起来就是单行 capsule。
  row: {
    alignItems: 'stretch',
    backgroundColor: colors.chatCodeSurface,
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'column',
    minHeight: 50,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    position: 'relative',
  },
  rowMultiline: {
    borderRadius: 30, // 组件几何:composer 聚焦形态专用,非通用圆角档
  },
  rowCompact: {
    gap: MOBILE_COMPOSER_TOOL_GAP,
  },
  // 聚焦卡片形态：大圆角，paddingTop 给常驻的 grabber 留出呼吸空间
  // （grabber 横条距顶约 8pt、距输入内容约 14pt，参考 Cursor 移动端）。
  rowCard: {
    borderRadius: radius.control,
    paddingBottom: 8,
    paddingTop: 26,
  },
  // 水平输入行：简洁态装 [输入][发送]，card 态只剩全宽输入区；
  // 语音按钮不在流内（absolute 锚点），简洁态无发送时给它留出右侧空间。
  mainRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexGrow: 1,
    gap: MOBILE_COMPOSER_TOOL_GAP,
    minWidth: 0,
  },
  mainRowMultiline: {
    alignItems: 'flex-end',
  },
  mainRowVoiceInset: {
    paddingRight: MOBILE_COMPOSER_CONTROL_SIZE + MOBILE_COMPOSER_TOOL_GAP,
  },
  inputFrame: {
    alignItems: 'stretch',
    flex: 1,
    flexDirection: 'row',
    minWidth: 0,
    position: 'relative',
  },
  // TextInputWrapper(expo-paste-input)接管 TextInput 在 inputFrame row 里的
  // flex:1 位置;内部保持 row + stretch,TextInput 自身 flex:1 继续填满,
  // 内容自动增长与显式 inputFrameHeight(拖高)两条高度链都不经它中断。
  pasteWrapper: {
    flex: 1,
    flexDirection: 'row',
    minWidth: 0,
  },
  toolbarRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: MOBILE_COMPOSER_TOOL_GAP,
    marginTop: 8,
  },
  toolbarSpacer: {
    flex: 1,
  },
  toolbarVoiceSlot: {
    height: MOBILE_COMPOSER_CONTROL_SIZE,
    width: MOBILE_COMPOSER_CONTROL_SIZE,
  },
  // 字号 / 行高 / 水平内边距全部走 composerTextMetrics:WebView 富文本编辑器与语音
  // 听写覆盖层用同一份度量,三边换行位置必须逐字一致(见该文件注释)。
  input: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    color: colors.textPrimary,
    flex: 1,
    ...COMPOSER_TEXT_STYLE,
    maxHeight: MOBILE_COMPOSER_INPUT_MAX_HEIGHT,
    minHeight: MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
    paddingBottom: COMPOSER_TEXT_PADDING_BOTTOM,
    paddingHorizontal: COMPOSER_TEXT_HORIZONTAL_PADDING,
    paddingTop: COMPOSER_TEXT_PADDING_TOP,
    textAlignVertical: 'top',
  },
  // 语音按钮的 absolute 锚点：简洁态贴输入行右侧垂直居中；
  // 有发送按钮时向左让位；卡片态下沉到底部工具排的占位上。
  voiceButtonAnchor: {
    // iOS 的文字 padding 是 6/0,按钮随文字下移 3pt；Android 保持 3/3,
    // 不应继承 iOS 的补偿。
    bottom: Platform.OS === 'ios' ? 8 : 11,
    position: 'absolute',
    right: MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT,
    zIndex: 2,
  },
  voiceButtonAnchorWithTrailing: {
    right: spacing.md + MOBILE_COMPOSER_CONTROL_SIZE + MOBILE_COMPOSER_TOOL_GAP,
  },
  voiceButtonAnchorCard: {
    bottom: 8,
  },
  // 外层横跨全行但 box-none 穿透触摸，只有中间的窄命中条接手势，
  // 避免与左右两侧按钮的 hitSlop 抢触摸。
  // 命中区拉满卡片顶部整行(与 Context 面板拖动区同手感):高度对齐 rowCard 的
  // paddingTop(26),不侵入输入区首行;grabber 仅卡片态渲染,顶部两端无可点内容。
  resizeGrabberTouch: {
    alignItems: 'center',
    height: 26,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 3,
  },
  resizeGrabberHit: {
    alignItems: 'center',
    alignSelf: 'stretch' as const,
    height: 26,
  },
  resizeGrabberBar: {
    backgroundColor: colors.borderTranslucent,
    borderRadius: radius.pill,
    height: 4.5,
    marginTop: 8,
    width: 40,
  },
  voiceMicCaret: {
    alignItems: 'center',
    height: MOBILE_COMPOSER_INPUT_LINE_HEIGHT,
    justifyContent: 'center',
    marginLeft: 2,
    marginRight: 5,
    width: 18,
  },
  voiceMicBars: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 1.1,
    height: 8,
    justifyContent: 'center',
    left: 5.9,
    overflow: 'hidden',
    position: 'absolute',
    top: 6.8,
    width: 6.2,
  },
  voiceMicBar: {
    borderRadius: radius.pill,
    width: 1.15,
  },
  voiceMicBarSide: {
    height: 3.4,
  },
  voiceMicBarMiddle: {
    height: 6.4,
  },
} satisfies Record<string, ViewStyle | TextStyle>);
