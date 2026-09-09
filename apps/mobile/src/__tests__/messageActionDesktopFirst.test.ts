import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatCompactTokens } from '@cindy/maker-shared/usage-format';
import { describe, expect, it } from 'vitest';

describe('mobile message actions desktop-first surface', () => {
  it('keeps visible message controls compact while preserving touch hit slop', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const sharedSource = readFileSync(resolve(process.cwd(), '../../packages/maker-shared/src/messagePresentation.ts'), 'utf8');

    expect(source).toContain('const MESSAGE_CONTROL_HIT_SLOP = { bottom: 10, left: 10, right: 10, top: 10 };');
    expect(source).toContain('const MESSAGE_CONTROL_TOUCH_SIZE = 44;');
    expect(source).toContain('buildMessageActionBarPresentation');
    expect(sharedSource).toContain("input.canCopy ? 'copy' : null");
    expect(sharedSource).toContain("input.canFork ? 'fork' : null");
    expect(sharedSource).toContain("input.hasMoreActions ? 'more' : null");
    expect(sharedSource).toContain("input.hasTime ? 'time' : null");
    expect(sharedSource).toContain("input.hasTurnCost ? 'cost' : null");
    expect(source).toContain('<MessageActionSheet');
    expect(source).toContain('buildMobileMessageMenu({');
    expect(source).toContain("&& (item.message.kind === 'user' || item.message.kind === 'assistant')");
    expect(source).toContain('&& actions.isSessionStreaming !== true');
    expect(source).toContain('hitSlop={MESSAGE_CONTROL_HIT_SLOP}');
    expect(source).toContain('buttonSize={actionBar.buttonSize}');
    expect(source).toContain('iconSize={actionBar.iconSize}');
    expect(source).toContain("return id === 'copy' || id === 'fork';");
    expect(source).toContain('disabled={disabled && !forkBusy}');
    expect(source).toContain("busy={id === 'fork' && forkBusy}");
    expect(source).toContain("if (id === 'fork' && busy)");
    expect(source).toContain("disabledActions={actionBusy ? ['rewind', 'delete'] : undefined}");
    expect(source).toContain('testID="message.moreButton"');
    expect(source).toContain('{ height: buttonSize, width: buttonSize }');
    expect(source).toContain('minHeight: MESSAGE_CONTROL_TOUCH_SIZE');
    expect(source).toContain('minWidth: MESSAGE_CONTROL_TOUCH_SIZE');
    expect(source).toContain('height: 24');
    expect(source).toContain('width: 24');
    expect(source).toContain('borderRadius: radius.pill');
    expect(sharedSource).toContain('buttonSize: 24');
    expect(sharedSource).toContain('iconSize: 14');
    expect(source).not.toContain('MESSAGE_CONTROL_ICON_SIZE = 16');
    expect(source).not.toContain('messageMetaRow');
    expect(source).not.toContain('messageControlRow');
    expect(source).not.toContain('testID="message.metaRow"');
    expect(source).not.toContain('testID="message.controlRow"');
  });

  it('renders user rows carrying a system card as system presentation (no user affordances)', () => {
    // silent-stop 自动续跑行(kind='user' + systemCardType,turn 边界所需)必须在
    // 渲染层降级为 system 再进 MessageBubble——presentation 的 isUserAligned 是
    // `align==='user' || kind==='user'`,不降级会右对齐成用户气泡并挂 fork / rewind
    // 操作行(对齐桌面 MessageStream 对该形态提前 return SystemCard,review P2)。
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    expect(source).toContain("? { ...item, message: { ...item.message, kind: 'system' as const } }");
    expect(source).toContain(
      '<MessageBubble item={hookSourceUserItem ?? systemCardUserItem ?? item} actions={actions} />',
    );
  });

  it('never hangs the action bar on a system boundary card', () => {
    // 系统卡(agent-switch / auto-resume / goal / slash 命令卡)不是发言:桌面
    // MessageStream 对 systemCardType 提前 return SystemCard,卡片下方没有任何操作
    // 行。手机版曾漏掉这条,跨 Agent 切换的分隔线药丸下多出一行「··· 刚刚」。
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).toContain(
      'const showCompletedActionBar = !shareSelectionActive && mobileMessageShowsActionBar({',
    );
    expect(source).toContain('hasSystemCard: !!item.message.systemCardType,');
    expect(source).toContain('isTurnFinalAssistant: item.message.isTurnFinalAssistant === true,');
    // 时间、花费与 More 都必须由该判据统一 gate,不得绕过它单独计算。
    expect(source).toContain(
      "const relativeTime = showCompletedActionBar ? formatMessageRelativeTime(item.message.createdAt) : '';",
    );
    expect(source).toContain('const turnCost = showCompletedActionBar && ');
    expect(source).not.toContain('const suppressAssistantActions');
  });

  it('only exposes the More menu on a completed turn boundary', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).toContain(
      'const canCopyLink = !!(showCompletedActionBar && clientId && actions.onCopyMessageLink);',
    );
    expect(source).toContain(
      'const canAddToChat = !!(showCompletedActionBar && clientId && actions.onAddMessageToComposer);',
    );
    expect(source).not.toContain(
      'const canCopyLink = !!(canUseCompletedActions && clientId && actions.onCopyMessageLink);',
    );
    expect(source).not.toContain(
      'const canAddToChat = !!(canUseCompletedActions && clientId && actions.onAddMessageToComposer);',
    );
  });

  it('keeps message controls outside the user bubble like the desktop action bar', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const bubbleStart = source.indexOf('const bubble = (');
    const messageNodeStart = source.indexOf('const messageNode = (', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, messageNodeStart);
    const renderSource = source.slice(
      messageNodeStart,
      source.indexOf('function copyActionLabel', messageNodeStart),
    );

    expect(bubbleStart).toBeGreaterThan(-1);
    expect(messageNodeStart).toBeGreaterThan(bubbleStart);
    expect(bubbleSource).toContain('testID={isUser ? \'message.userBubble\' : \'message.agentBubble\'}');
    expect(bubbleSource).not.toContain('testID="message.actionBar"');
    expect(renderSource).toContain('styles.messageItem');
    expect(renderSource).toContain('isUser ? styles.userMessageItem : styles.agentMessageItem');
    // 附件条与气泡都在 action bar 之前(气泡在纯图片消息下可被跳过,但渲染位置不变)
    expect(renderSource).toContain(
      '{hasBubbleContent || (!attachmentStripNode && messageQuotes.length === 0) ? bubble : null}',
    );
    expect(renderSource.indexOf('? bubble : null')).toBeLessThan(renderSource.indexOf('testID="message.actionBar"'));
  });

  it('renders collapsed work groups like the desktop work summary row, not a detail card', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const start = source.indexOf('function WorkGroupCard');
    const end = source.indexOf('function FoldablePanel', start);
    const workGroupSource = source.slice(start, end);
    const expandedBodyStart = workGroupSource.indexOf('{expanded ? (');
    const childrenMapStart = workGroupSource.indexOf('{item.children.map((child) => {');

    // 运行中用状态图标,结束后回到桌面同款 Layers 工作摘要图标。
    expect(source).toContain('Layers,');
    expect(workGroupSource).toContain('const header = presentation.header;');
    expect(workGroupSource).toContain('chevronPosition={header.chevronPosition}');
    expect(workGroupSource).toContain('chevronSize={header.chevronSize}');
    expect(workGroupSource).toContain('title={title}');
    expect(workGroupSource).toContain('subtitle={header.subtitle ?? undefined}');
    // Work group 受控展开；折叠态只保留卡头，不提前构造任何隐藏活动行。
    expect(workGroupSource).not.toContain('defaultExpanded');
    expect(workGroupSource).toContain('controlledExpanded={expanded}');
    expect(workGroupSource).not.toContain('collapsedBody=');
    expect(workGroupSource).toContain('onControlledToggle={onToggle}');
    expect(workGroupSource).not.toContain('live-preview-dismissed');
    expect(workGroupSource).toContain('? <CompactActivityIndicator color={colors.textTertiary}');
    expect(workGroupSource).toContain(': <Layers color={colors.textTertiary}');
    expect(workGroupSource).toContain('variant={header.variant}');
    expect(workGroupSource).toContain('summaryCount: header.summaryCount');
    expect(workGroupSource).toContain('<RenderItemView key={child.key} item={child} actions={actions} />');
    expect(workGroupSource).not.toContain('projectRecentMobileWorkActivities');
    expect(workGroupSource).toContain('() => (expanded');
    expect(workGroupSource).not.toContain('expanded || !isStreaming');
    expect(workGroupSource).toContain('const contentLayout = useMemo(() => (expanded');
    expect(expandedBodyStart).toBeGreaterThan(-1);
    expect(childrenMapStart).toBeGreaterThan(expandedBodyStart);
    expect(workGroupSource).toContain('<ExpandedWorkThinkingRow key={child.key} item={child} />');
    expect(workGroupSource).toContain('activityProjection?.toolActivitiesByChildKey.get(child.key)');
    // thinking / tool 行都固定 28pt，外层不能再给 thinking 子项追加组间距。
    expect(source).toContain('workGroupStack: { gap: 0 }');
    expect(workGroupSource).not.toContain('subtitle={presentation.subtitle}');
    expect(workGroupSource).not.toContain('badges={presentation.badges}');
    expect(workGroupSource).not.toContain('badgeCount: presentation.badges.length');
    expect(source).not.toContain('testID="message.workGroupToggle"\n      variant="card"');
  });

  it('keeps plain foldable headers as desktop summary rows, not mobile cards', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const start = source.indexOf('function FoldablePanel');
    const end = source.indexOf('function Rail', start);
    const foldableSource = source.slice(start, end);

    expect(source).toContain('const FOLDABLE_HEADER_HIT_SLOP = { bottom: 10, left: 4, right: 4, top: 10 };');
    expect(foldableSource).toContain("const headerLayoutStyle = variant === 'plain'");
    expect(foldableSource).toContain('? styles.foldHeaderPlain');
    expect(foldableSource).toContain("hitSlop={variant === 'plain' ? FOLDABLE_HEADER_HIT_SLOP : undefined}");
    expect(source).toContain('foldHeaderPlain: {');
    expect(source).toContain('gap: 6');
    expect(source).toContain('minHeight: 22');
    expect(source).toContain('paddingHorizontal: 0');
    expect(source).toContain('paddingVertical: 2');
    expect(source).toContain("variant === 'plain' && styles.foldTitlePlain");
    const plainTitleStart = source.indexOf('foldTitlePlain: {');
    const plainTitleEnd = source.indexOf('foldSubtitle:', plainTitleStart);
    const plainTitleStyle = source.slice(plainTitleStart, plainTitleEnd);
    expect(plainTitleStyle).toContain('color: colors.textSecondary');
    expect(plainTitleStyle).toContain('fontSize: typeScale.listBody');
    expect(plainTitleStyle).toContain('fontWeight: fontWeight.regular');
    expect(plainTitleStyle).toContain('lineHeight: lineHeight.listBody');
    expect(foldableSource).toContain("variant === 'plain'");
    expect(foldableSource).toContain('? styles.foldBodyPlain');
  });

  it('keeps the load-earlier affordance lighter than message content', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const styleStart = source.indexOf('loadEarlierButton: {');
    const styleEnd = source.indexOf('loadEarlierText:', styleStart);
    const buttonStyle = source.slice(styleStart, styleEnd);

    expect(buttonStyle).toContain('minHeight: 32');
    expect(buttonStyle).toContain('paddingHorizontal: spacing.md');
    expect(buttonStyle).not.toContain('borderWidth');
    expect(buttonStyle).not.toContain('borderColor');
    expect(source).toContain("loadEarlierText: { color: colors.textTertiary");
  });

  it('renders collapsed tool groups like the desktop agent action summary row', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const start = source.indexOf('function ToolGroupCard');
    const end = source.indexOf('function TodoCard', start);
    const toolGroupSource = source.slice(start, end);

    expect(source).toContain('Bot,');
    expect(toolGroupSource).toContain('const header = presentation.header;');
    expect(toolGroupSource).toContain('chevronPosition={header.chevronPosition}');
    expect(toolGroupSource).toContain('chevronSize={header.chevronSize}');
    expect(toolGroupSource).toContain('title={header.title}');
    expect(toolGroupSource).toContain('subtitle={header.subtitle ?? undefined}');
    // 展开态走 blockId 共享记忆,不再传 defaultExpanded(blockId 存在时该值无效)。
    expect(toolGroupSource).not.toContain('defaultExpanded');
    expect(toolGroupSource).toContain('blockId={item.key}');
    // 块头图标:有执行中工具时同槽位换成桌面同款 spinner,否则维持 Bot。
    expect(toolGroupSource).toContain('? <CompactActivityIndicator color={colors.textTertiary} size={header.iconSize} />');
    expect(toolGroupSource).toContain(': <Bot color={colors.textTertiary} size={header.iconSize} strokeWidth={iconStroke.regular} />');
    expect(toolGroupSource).toContain('variant={header.variant}');
    expect(toolGroupSource).toContain('<Rail layout={layout}>');
    expect(toolGroupSource).toContain('summaryCount: header.summaryCount');
    // 工具行对齐桌面 AgentActionRow:一行摘要,点击就地展开详情;展开态走共享记忆(toolrow- 前缀)。
    expect(toolGroupSource).toContain('useFoldableExpandedState(`toolrow-${rowKey ?? tool.key}`, false)');
    expect(toolGroupSource).toContain('testID="message.toolRowToggle"');
    expect(toolGroupSource).toContain('{showDetails ? (');
    // 动作行按 running spinner → failed alert → done check 排序；运行态优先，
    // 已结束的真实失败不能误画成成功勾。行头与 thinking 使用同样的 8px inset。
    const statusIconStart = source.indexOf('function ToolRowStatusIcon');
    const statusIconEnd = source.indexOf('function TodoStatusIcon', statusIconStart);
    const statusIconSource = source.slice(statusIconStart, statusIconEnd);
    expect(statusIconSource).toContain("status === 'running'");
    expect(statusIconSource).toContain('<CompactActivityIndicator');
    expect(statusIconSource).toContain('hasError');
    expect(statusIconSource).toContain('<CircleAlert');
    expect(statusIconSource).toContain('<Check');
    expect(source).toContain('<ToolRowStatusIcon hasError={row.hasError} status={row.status} />');
    const styleStart = source.indexOf('toolRow: {');
    const styleEnd = source.indexOf('toolName:', styleStart);
    const actionRowStyles = source.slice(styleStart, styleEnd);
    expect(actionRowStyles).not.toContain('borderTopWidth');
    expect(actionRowStyles).toContain('paddingHorizontal: spacing.sm');
    expect(actionRowStyles).toContain('gap: 6');
    // 「查看内容」hint 只在文本结果被截断时显示。
    const resultPreviewStart = source.indexOf('function ToolResultPreview');
    const resultPreviewEnd = source.indexOf('function MessageContentOpenButton', resultPreviewStart);
    const resultPreviewSource = source.slice(resultPreviewStart, resultPreviewEnd);
    expect(resultPreviewSource).toContain("payload.kind !== 'text' || clipped");
    expect(resultPreviewSource).toContain('{showHint ? <Text style={styles.toolResultHint}>{preview.actionLabel}</Text> : null}');
    expect(toolGroupSource).not.toContain('row.signals.map');
    expect(toolGroupSource).not.toContain('styles.toolRowSignals');
    expect(toolGroupSource).not.toContain('styles.toolRowSignal');
    expect(toolGroupSource).not.toContain('subtitle={presentation.subtitle}');
    expect(toolGroupSource).not.toContain('badges={presentation.badges}');
    expect(toolGroupSource).not.toContain('badgeCount: presentation.badges.length');
    expect(toolGroupSource).not.toContain('variant="card"');
  });

  it('renders todo cards like the desktop inline checklist, not a separate details sheet', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const start = source.indexOf('function TodoCard');
    const end = source.indexOf('function WorkGroupCard', start);
    const todoSource = source.slice(start, end);

    expect(source).toContain('ListTodo,');
    expect(source).toContain('CircleCheck,');
    expect(source).toContain('CircleDashed,');
    expect(source).toContain('Circle,');
    expect(todoSource).toContain('const header = presentation.header;');
    expect(todoSource).toContain('title={header.title}');
    expect(todoSource).toContain('subtitle={header.subtitle ?? undefined}');
    expect(todoSource).toContain('chevronPosition={header.chevronPosition}');
    expect(todoSource).toContain('chevronSize={header.chevronSize}');
    expect(todoSource).toContain('defaultExpanded={header.defaultExpanded}');
    expect(todoSource).toContain('leadingIcon={<ListTodo color={colors.textPrimary} size={header.iconSize} strokeWidth={iconStroke.regular} />}');
    expect(todoSource).toContain('variant={header.variant}');
    expect(todoSource).toContain('summaryCount: header.summaryCount');
    expect(todoSource).toContain('item.todos.map');
    expect(todoSource).toContain('<TodoStatusIcon animated={animated} status={presentation.status} />');
    expect(source).toContain('animated={item.isStreaming === true}');
    const todoStatusStart = source.indexOf('function TodoStatusIcon');
    const todoStatusEnd = source.indexOf('const AGENT_TASK_STATUS_LABEL', todoStatusStart);
    const todoStatusSource = source.slice(todoStatusStart, todoStatusEnd);
    expect(todoStatusSource).toContain("status === 'in_progress' && animated");
    expect(todoStatusSource).toContain('<CompactActivityIndicator');
    expect(todoSource).not.toContain('summaryTodos');
    expect(todoSource).not.toContain('hiddenCount');
    expect(todoSource).not.toContain('todoOpenButton');
    expect(todoSource).not.toContain('TodoDetailModal');
    expect(todoSource).not.toContain('todoStatusLabel');
    expect(source).not.toContain('testID="message.todoSheet"');
    expect(source).not.toContain('testID="message.todoOpenButton"');
  });

  it('animates only live status icons and freezes them for reduced motion', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const spinnerStart = source.indexOf('function CompactActivityIndicator');
    const spinnerEnd = source.indexOf('function ToolRowStatusIcon', spinnerStart);
    const spinnerSource = source.slice(spinnerStart, spinnerEnd);
    const agentStatusStart = source.indexOf('function AgentTaskStatusIcon');
    const agentStatusEnd = source.indexOf('function buildAgentTaskMeta', agentStatusStart);
    const agentStatusSource = source.slice(agentStatusStart, agentStatusEnd);

    expect(spinnerSource).toContain('AccessibilityInfo.isReduceMotionEnabled()');
    expect(spinnerSource).toContain('AccessibilityInfo.addEventListener(');
    expect(spinnerSource).toContain("'reduceMotionChanged'");
    expect(spinnerSource).toContain('<Animated.View');
    expect(spinnerSource).toContain('duration: 1000');
    expect(spinnerSource).toContain('isInteraction: false');
    expect(spinnerSource).toContain('useNativeDriver: true');
    expect(spinnerSource).toContain("outputRange: ['0deg', '360deg']");
    expect(spinnerSource).toContain('<LoaderCircle');
    expect(spinnerSource).not.toContain('<CircleDashed');
    expect(agentStatusSource).toContain("status === 'running'");
    expect(agentStatusSource).toContain('<CompactActivityIndicator');
  });

  it('compacts sub-agent token usage with the shared desktop/mobile formatter', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const metaStart = source.indexOf('function buildAgentTaskMeta');
    const metaEnd = source.indexOf('\nfunction readAgentTaskToolInput', metaStart);
    const metaSource = source.slice(metaStart, metaEnd);

    expect(source).toContain("import { formatCompactTokens } from '@cindy/maker-shared/usage-format';");
    expect(metaSource).toContain('`${formatCompactTokens(model.totalTokens)} tokens`');
    expect(formatCompactTokens(143_615)).toBe('143.6k');
  });

  it('does not keep a hidden badge rendering path in foldable message hierarchy panels', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const sharedSource = readFileSync(resolve(process.cwd(), '../../packages/maker-shared/src/messagePresentation.ts'), 'utf8');
    const start = source.indexOf('function FoldablePanel');
    const end = source.indexOf('function Rail', start);
    const foldableSource = source.slice(start, end);

    expect(source).not.toContain('function MessageBadges');
    expect(source).not.toContain('MessagePresentationBadge');
    expect(sharedSource).not.toContain('MessagePresentationBadge');
    expect(sharedSource).not.toContain('badges:');
    expect(sharedSource).not.toContain('signals:');
    expect(sharedSource).not.toContain('const badges');
    expect(sharedSource).not.toContain('const signals');
    expect(foldableSource).not.toContain('badges');
    expect(source).not.toContain('messageBadgeRow');
    expect(source).not.toContain('messageBadgeText');
  });

  it('shows direct thinking/tool rows on open while nested groups keep independent expansion memory', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const renderItemStart = source.indexOf('function RenderItemView');
    const renderItemEnd = source.indexOf('function EmptyMessages', renderItemStart);
    const renderItemSource = source.slice(renderItemStart, renderItemEnd);
    const thinkingStart = source.indexOf('function ThinkingCard');
    const thinkingEnd = source.indexOf('function ToolGroupCard', thinkingStart);
    const thinkingSource = source.slice(thinkingStart, thinkingEnd);
    const workGroupStart = source.indexOf('function WorkGroupCard');
    const workGroupEnd = source.indexOf('function FoldablePanel', workGroupStart);
    const workGroupSource = source.slice(workGroupStart, workGroupEnd);
    const foldableStart = source.indexOf('function FoldablePanel');
    const foldableEnd = source.indexOf('function Rail', foldableStart);
    const foldableSource = source.slice(foldableStart, foldableEnd);

    // 当前动作组展开后直接读思考/工具;完成态外层里的嵌套动作组仍通过 RenderItemView 保持第二级折叠。
    expect(source).not.toContain('expandByDefault');
    expect(workGroupSource).toContain("if (child.type === 'thinking')");
    expect(workGroupSource).toContain('<ExpandedWorkThinkingRow key={child.key} item={child} />');
    expect(workGroupSource).toContain("if (child.type === 'tool_group')");
    expect(workGroupSource).toContain('activityProjection?.toolActivitiesByChildKey.get(child.key)');
    expect(workGroupSource).toContain('<RenderItemView key={child.key} item={child} actions={actions} />');
    // 展开态走共享进程内记忆,跨虚拟化重挂/切会话/重分组稳定。
    expect(workGroupSource).toContain('useFoldableExpandedState(item.key, false)');
    expect(foldableSource).toContain('useFoldableExpandedState(blockId, defaultExpanded)');
    expect(thinkingSource).toContain('blockId={item.key}');
    expect(renderItemSource).toContain('<ToolGroupCard item={item} actions={actions} />');
    // 思考卡接收会话流式信号；界面只显示到秒，不需要半秒级刷新。
    expect(renderItemSource).toContain('isSessionStreaming={actions.isSessionStreaming === true}');
    expect(source).toContain('setInterval(() => setNow(Date.now()), 1_000)');
  });

  it('does not render user or assistant role labels inside message bubbles', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const sharedSource = readFileSync(resolve(process.cwd(), '../../packages/maker-shared/src/messagePresentation.ts'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);

    expect(bubbleSource).toContain('summarizeMessageBubblePresentation');
    expect(source).not.toContain('label: item.message.label');
    expect(sharedSource).not.toContain('roleLabel:');
    expect(sharedSource).not.toContain('displayMessageRoleLabel');
    expect(bubbleSource).not.toContain('presentation.roleLabel');
    expect(bubbleSource).not.toContain('message.roleLabel');
    expect(bubbleSource).not.toContain('message.authorLabel');
    expect(bubbleSource).not.toContain('你</Text>');
    expect(bubbleSource).not.toContain('XDMaker</Text>');
  });

  it('renders compact reasoning with shared strong/code parsing and one-line expansion', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    expect(source).toContain("tokenizeThinkingText(content)");
    expect(source).toContain("token.kind === 'strong'");
    expect(source).toContain("token.kind === 'code'");
    expect(source).toContain('numberOfLines={expanded ? undefined : 1}');
    expect(source).toContain('testID="message.workThinkingToggle"');
    expect(source).toContain('onTextLayout={(event) => setMeasuredLineCount(event.nativeEvent.lines.length)}');
  });
});
