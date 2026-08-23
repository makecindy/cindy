import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarDir = resolve(__dirname, '..');
const sessionCardSource = readFileSync(resolve(sidebarDir, 'SessionCard.tsx'), 'utf8');
const sessionEntryListSource = readFileSync(resolve(sidebarDir, 'SessionEntryList.tsx'), 'utf8');
const sessionItemSource = readFileSync(resolve(sidebarDir, 'SessionItem.tsx'), 'utf8');
const railNavSource = readFileSync(resolve(sidebarDir, 'RailNav.tsx'), 'utf8');
const sessionRenameInputSource = readFileSync(
  resolve(sidebarDir, '..', 'SessionRenameInput.tsx'),
  'utf8',
);
const sessionStatusIconSource = readFileSync(resolve(sidebarDir, 'SessionStatusIcon.tsx'), 'utf8');
const automationGroupSource = readFileSync(
  resolve(sidebarDir, 'AutomationSessionGroupItem.tsx'),
  'utf8',
);
const automationTimerIconSource = readFileSync(
  resolve(sidebarDir, 'AutomationTimerIcon.tsx'),
  'utf8',
);
const scheduleBindingBadgeSource = readFileSync(
  resolve(sidebarDir, 'ScheduleBindingBadge.tsx'),
  'utf8',
);
const globalsSource = readFileSync(
  resolve(__dirname, '..', '..', '..', '..', 'styles', 'globals.css'),
  'utf8',
);

describe('SessionCard review regressions', () => {
  it('only draws the list top divider on the first overall entry', () => {
    // 顶线只认「本列表的整体首行」,不因中间夹了非 session 条目就重画。
    // 2026-08-12 起额外受 showFirstDivider 约束:混排主列表把每条散排对话各渲染成
    // 一个单条列表,若都补顶线会与上一行的底线叠成两根横线,那条路径传 false。
    expect(sessionEntryListSource).toContain('isFirst={showFirstDivider && index === 0}');
    expect(sessionEntryListSource).not.toContain(
      "isFirst={index === 0 || entries[index - 1]?.kind !== 'session'}",
    );
  });

  it('keeps awaiting text in list mode previews', () => {
    expect(sessionCardSource).toContain(
      'const listPreview = awaitingText ?? runningDetail ?? bodyPreview',
    );
    expect(sessionCardSource).toContain('{listPreview}');
  });

  it('keeps status breathing covered by reduced motion', () => {
    expect(globalsSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.session-status-breathing,[\s\S]*animation: none(?: !important)?;/,
    );
  });

  it('plays overflowing sidebar titles only while hovered', () => {
    expect(sessionItemSource).toContain('function SidebarTitleMarquee');
    expect(sessionItemSource).toContain('[data-sidebar-session-row="true"]');
    expect(sessionItemSource).toContain("row.addEventListener('mouseenter', onEnter)");
    expect(sessionItemSource).toContain("row.addEventListener('mouseleave', onLeave)");
    expect(sessionItemSource).toContain("container.dataset.titleOverflowing = 'true'");
    expect(sessionItemSource).toContain('delete container.dataset.titleOverflowing');
    expect(globalsSource).toContain('@keyframes sidebar-title-marquee');
    expect(globalsSource).toContain(
      "sidebar-title-marquee[data-title-overflowing='true'] .sidebar-title-marquee__track",
    );
    expect(globalsSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.sidebar-title-marquee\[data-title-overflowing='true'\][\s\S]*animation: none;/,
    );
    expect(globalsSource).toContain(
      'animation: sidebar-title-marquee var(--sidebar-title-marquee-duration)',
    );
  });

  it('recalculates the marquee when a hovered title changes', () => {
    expect(sessionItemSource).toContain('const isHoveredRef = useRef(false);');
    expect(sessionItemSource).toContain('useLayoutEffect(() => {');
    expect(sessionItemSource).toContain('if (isHoveredRef.current) startMarquee();');
    expect(sessionItemSource).toContain('}, [startMarquee, title]);');
    expect(sessionItemSource).toContain('delete container.dataset.titleOverflowing;');
    expect(sessionItemSource).toContain(
      "container.style.removeProperty('--sidebar-title-marquee-shift');",
    );
    expect(sessionItemSource).toContain(
      "container.style.removeProperty('--sidebar-title-marquee-duration');",
    );
    expect(sessionItemSource).toContain('const viewportCount = Math.max(');
    expect(sessionItemSource).toContain(
      'calc(var(--motion-sidebar-title-marquee-per-viewport) * ${viewportCount})',
    );
    expect(sessionItemSource).not.toContain('var(--motion-base) * ${viewportCount * 12}');
  });

  it('observes layout changes only while the session row is hovered', () => {
    expect(sessionItemSource).toContain(
      'const resizeObserverRef = useRef<ResizeObserver | null>(null);',
    );
    expect(sessionItemSource).toContain("typeof ResizeObserver === 'undefined'");
    expect(sessionItemSource).toContain('observer.observe(container);');
    expect(sessionItemSource).toContain('observer.observe(track);');
    expect(sessionItemSource).toContain('resizeObserverRef.current?.disconnect();');
    expect(sessionItemSource).toContain('startObserving();');
    expect(sessionItemSource).toContain('stopObserving();');
    expect(sessionItemSource).toContain('if (isHoveredRef.current) startMarquee();');
  });

  it('keeps the original accessible title visible when reduced motion is enabled', () => {
    expect(globalsSource).toMatch(
      /\.sidebar-title-marquee\[data-title-overflowing='true'\] \.sidebar-title-marquee__ellipsis \{\r?\n {2}opacity: 0;\r?\n\}/,
    );
    expect(globalsSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.sidebar-title-marquee\[data-title-overflowing='true'\] \.sidebar-title-marquee__ellipsis \{[\s\S]*opacity: 1;/,
    );
  });

  it('keeps card titles to two lines with shared inline prefix alignment', () => {
    expect(sessionCardSource).toContain('[-webkit-line-clamp:2] overflow-hidden');
    expect(sessionCardSource).toContain('style={{ textIndent: 0, paddingLeft: 0 }}');
    expect(sessionCardSource).toContain('const titlePrefixNode = (');
    expect(sessionCardSource).toContain('{titlePrefixNode}');
    expect(sessionCardSource).toContain('CARD_TITLE_STATUS_SLOT_CLASS');
    expect(sessionCardSource).not.toContain('titlePrefixWidth');
  });

  it('projects local and remote activity through the shared session status model', () => {
    // 左侧运行标记和右侧状态槽必须消费同一投影，避免各自组合本地/远程状态源。
    expect(sessionItemSource).toContain('projectSidebarSessionActivity({');
    expect(sessionItemSource).toContain(
      'const leftIconRunning = sessionActivity.currentTurnActive === true',
    );
    expect(sessionItemSource).toContain('resolveSidebarRightStatus(sessionActivity)');
    expect(sessionItemSource).toContain('isRunning={leftIconRunning}');
    expect(sessionCardSource).toContain('projectSidebarSessionActivity({');
    expect(sessionCardSource).toContain(
      'const leftIconRunning = sessionActivity.currentTurnActive === true',
    );
    expect(sessionCardSource).toContain('resolveSidebarRightStatus(sessionActivity)');
    expect(sessionCardSource).toContain('isRunning={leftIconRunning}');
    expect(sessionCardSource).not.toContain('isRemoteSessionActivityActive');
    expect(sessionItemSource).not.toContain('isRemoteSessionActivityActive');
  });

  it('keeps card preview line budgets stable across content sources', () => {
    expect(sessionCardSource).toContain(
      "const usesPinnedCardSummary = variant === 'card' && isPinned && Boolean(session.summary)",
    );
    expect(sessionCardSource).toContain('const cardPreviewLineClamp = usesPinnedCardSummary');
    expect(sessionCardSource).toContain('style={{ WebkitLineClamp: cardPreviewLineClamp }}');
  });

  it('keeps one Timer glyph for scheduled and automation sessions', () => {
    expect(sessionCardSource).toContain(
      'const showScheduleBindingBadge = boundSchedules.length > 0',
    );
    expect(sessionCardSource).toContain(
      'const showAutomationTimer = !showScheduleBindingBadge && isAutomationGenerated',
    );
    // schedule 绑定与普通自动化都复用 AutomationTimerIcon;绑定态优先承载更多状态。
    expect(sessionCardSource).toMatch(
      /const renderAutomationMeta = \(iconSize: number\) =>[\s\S]*?showScheduleBindingBadge \? \([\s\S]*?<ScheduleBindingBadge[\s\S]*?schedules=\{boundSchedules\}[\s\S]*?size=\{iconSize\}[\s\S]*?activeForeground=\{isActive\}[\s\S]*?\) : showAutomationTimer \? \([\s\S]*?<AutomationTimerIcon size=\{iconSize\}/,
    );
    expect(sessionCardSource).toContain('{renderAutomationMeta(10)}');
    expect(sessionCardSource).toContain('{renderAutomationMeta(11)}');
  });

  it('keeps running cards free of the removed progress bar', () => {
    // 评审:Running 卡片不再渲染扫动进度条(w-[52px] 一并移除)。
    expect(sessionCardSource).not.toContain('w-[52px]');
    expect(sessionCardSource).not.toContain('session-card-progress');
  });

  it('lets text-mode info slots shrink to their visible content', () => {
    expect(sessionItemSource).not.toMatch(
      /group\/slot relative ml-auto flex h-6 shrink-0 items-center justify-end min-w-14/,
    );
    expect(automationGroupSource).not.toContain('min-w-14 max-w-[96px]');
    expect(automationGroupSource).toContain(
      'group/slot relative ml-auto flex h-6 max-w-[96px] shrink-0 items-center justify-end',
    );
    expect(sessionItemSource).toContain(
      'grid h-6 grid-cols-[max-content] items-center justify-items-end',
    );
    expect(sessionItemSource).toContain("'hidden group-hover:flex group-focus-within/slot:flex'");
    expect(automationGroupSource).toContain(
      'grid h-6 max-w-[96px] grid-cols-[max-content] items-center justify-items-end',
    );
    expect(automationGroupSource).toContain(
      "!menuOpen && 'hidden group-hover:block group-focus-within/slot:block'",
    );
    expect(sessionCardSource).toContain(
      'grid h-[22px] grid-cols-[max-content] items-center justify-items-end',
    );
    expect(sessionCardSource).toContain(
      "'hidden group-hover/card:flex group-focus-within/slot:flex'",
    );
    expect(sessionItemSource).toContain('invisible col-start-1 row-start-1 inline-flex');
    expect(sessionItemSource).toContain('<SessionOrdinalBadgeKbd label={ordinalBadgeLabel} />');
    expect(sessionCardSource).toContain('invisible col-start-1 row-start-1 inline-flex');
    expect(sessionCardSource).toContain('<SessionOrdinalBadgeKbd label={ordinalBadgeLabel} />');
    expect(sessionItemSource).not.toContain(
      'invisible col-start-1 row-start-1 inline-flex h-6 items-center px-1.5 py-[2px] text-11 leading-none',
    );
    expect(sessionCardSource).not.toContain(
      'invisible col-start-1 row-start-1 inline-flex h-5 items-center px-1.5 py-[2px] text-11 leading-none',
    );
  });

  it('keeps card info anchored to the bottom meta row instead of the overlay layout', () => {
    // 时间/信息槽固定在底部 meta 行右端(ml-auto),不再依赖 overlay/block 双态测量。
    // C 期起时间渲染并入 SessionInfoMeta(任务信息复选),锚点与让位语义不变。
    expect(sessionCardSource).not.toContain('cardTimeLayout');
    expect(sessionCardSource).toContain('pieces={cardInfoPieces}');
    expect(sessionCardSource).toContain('ml-auto shrink-0'); // E1D 侧栏层级:info 槽 ml-auto shrink-0 保留
  });

  it('keeps archive confirmation pills clear of time and ordinal overlays', () => {
    expect(sessionCardSource).toContain('w-max min-w-14');
    expect(sessionCardSource).toContain('whitespace-nowrap text-11 font-semibold');
    expect(sessionCardSource).toContain(
      'invisible col-start-1 row-start-1 inline-flex h-[22px] w-max min-w-14 items-center justify-center whitespace-nowrap rounded-full px-[9px] text-11 font-semibold',
    );
    expect(sessionCardSource).not.toContain(
      'invisible col-start-1 row-start-1 inline-block h-[22px] w-14',
    );
    expect(sessionItemSource).toContain('invisible col-start-1 row-start-1 inline-block h-6 w-14');
    expect(sessionItemSource).toContain(
      'absolute right-0 top-0 flex h-6 w-14 items-center justify-center rounded-md text-xs font-medium',
    );
    expect(sessionCardSource).toContain(
      '!isEditing && !archivePending && ordinalBadgeLabel != null',
    );
    expect(sessionCardSource).toContain("archivePending && 'invisible opacity-0'");
  });

  it('keeps running card previews stable instead of streaming compact activity text', () => {
    expect(sessionCardSource).toContain(
      'const listPreview = awaitingText ?? runningDetail ?? bodyPreview',
    );
    expect(sessionCardSource).toContain('const cardPreview = awaitingText ?? bodyPreview');
    expect(sessionCardSource).not.toContain(
      'const cardPreview = awaitingText ?? runningDetail ?? bodyPreview',
    );
  });

  it('lets single-line card content keep its natural compact height', () => {
    expect(sessionCardSource).toContain("'rounded-xl bg-[var(--surface-elevated)] border'");
    expect(sessionCardSource).not.toContain(
      "'h-full rounded-xl bg-[var(--surface-elevated)] border'",
    );
  });

  it('E1D 任务C: SessionCard active 反白链完整且运行态不降级文字颜色', () => {
    const re = /isActive \? 'text-sidebar-item-active-foreground'/g;
    const count = (sessionCardSource.match(re) || []).length;
    // C 期起两个时间槽的 isActive 分支并入 SessionInfoMeta(经 isActive prop 传递,
    // 组件内应用 active-foreground),SessionCard 本体剩 title×2 + RemoteProjectIcon 等。
    expect(
      count,
      'isActive conditional active-foreground ≥5(title×2+RemoteProjectIcon 等;时间槽已并入 SessionInfoMeta)',
    ).toBeGreaterThanOrEqual(5);
    // 信息槽的反白链由 SessionInfoMeta 承担:isActive 必须透传。
    expect(sessionCardSource).toMatch(/<SessionInfoMeta[\s\S]{0,200}isActive=\{isActive\}/);

    // Running is already expressed by the status indicator, so its text keeps
    // the same semantic colors as other non-active tasks.
    expect(sessionCardSource).not.toContain('const isMuted = isRunning && !isActive');
    expect(sessionCardSource).not.toContain("isMuted ? 'text-[var(--text-disabled)]'");
    expect(sessionCardSource).not.toContain('transition-[color] duration-500');
    expect(sessionCardSource).toContain(
      "isActive ? 'text-sidebar-item-active-foreground' : 'text-[var(--text-tertiary)]'",
    );
  });

  it('keeps selected sidebar text bound to the active foreground token', () => {
    expect(globalsSource).toContain('.text-sidebar-item-active-foreground');
    expect(globalsSource).toContain('color: var(--sidebar-item-active-foreground);');
    expect(sessionItemSource).toContain('text-[var(--sidebar-item-active-foreground)]');
    expect(sessionCardSource).toContain('text-[var(--sidebar-item-active-foreground)]');
  });

  it('keeps active session rows aligned by painting the border without changing layout', () => {
    expect(sessionItemSource).toContain(
      'shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)]',
    );
    expect(sessionItemSource).not.toContain(
      'text-sidebar-item-active-foreground border border-[var(--sidebar-item-active-border)]',
    );
  });

  it('keeps every sidebar Agent-to-Timer gap as compact as the former Clock', () => {
    expect(sessionItemSource).toContain(
      'const hasAutomationMeta = boundSchedules.length > 0 || isAutomationGenerated;',
    );
    expect(sessionItemSource).toContain("!isEditing && hasAutomationMeta ? 'gap-1.5' : 'gap-2.5'");
    expect(automationGroupSource).toContain('className="flex min-w-0 items-center gap-1.5"');
  });

  it('keeps active sidebar rename controls inside the active foreground color system', () => {
    expect(sessionItemSource).toContain('activeForeground={isActive}');
    expect(
      (sessionCardSource.match(/activeForeground=\{isActive\}/g) || []).length,
    ).toBeGreaterThanOrEqual(2);
    expect(sessionRenameInputSource).toContain(
      "activeForeground && 'text-sidebar-item-active-foreground'",
    );
    expect(sessionRenameInputSource).toContain(
      "'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'",
    );
  });

  it('keeps selected running-session icons and spinner on the active foreground color', () => {
    expect(sessionStatusIconSource).toContain(
      "colorClassName={isActive ? 'text-[var(--sidebar-item-active-foreground)]' : undefined}" /* colorClassName 覆盖口:选中态前景优先于 running 强调态 */,
    );
    // 用户拍板 2026-07-20:running 橙(status-bar-accent)优先于选中态反相前景。
    expect(sessionStatusIconSource).toMatch(
      /isRunning\s*\? 'text-\[var\(--status-bar-accent\)\]'\s*:\s*isActive/,
    );
    expect(sessionItemSource).toContain(
      "isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon'",
    );
  });

  it('keeps rail hover backgrounds in the sidebar token family', () => {
    expect(railNavSource).toContain('group-hover/pin:bg-sidebar-item-hover');
    expect(railNavSource).toContain('hover:bg-sidebar-item-hover');
    expect(railNavSource).not.toContain('update-btn-hover');
  });

  it('keeps selected sidebar hover actions inside the active color system', () => {
    expect(sessionItemSource).toContain('isActive={isActive}');
    expect(sessionItemSource).toContain(
      "'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'",
    );
    expect(sessionItemSource).toContain(
      "'text-sidebar-action-icon hover:bg-sidebar-item-hover hover:text-foreground'",
    );
  });

  it('lets the title truncate with an in-flow spacer while actions stay focusable', () => {
    expect(sessionItemSource).toContain(
      "'invisible col-start-1 row-start-1 h-6 items-center gap-0.5'",
    );
    expect(sessionItemSource).toContain("'hidden group-hover:flex group-focus-within/slot:flex'");
    expect(sessionItemSource).toContain('absolute right-0 top-0 flex h-6 items-center gap-0.5');
    expect(sessionItemSource).toContain(
      'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
    );
    expect(sessionItemSource).not.toContain('SESSION_ACTION_HOVER_SCRIM_CLASS');
    expect(sessionCardSource).toContain(
      "'invisible col-start-1 row-start-1 h-[22px] items-center gap-0.5'",
    );
    expect(sessionCardSource).toContain(
      "'hidden group-hover/card:flex group-focus-within/slot:flex'",
    );
    expect(sessionCardSource).toContain(
      'absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-0.5',
    );
    expect(sessionCardSource).not.toContain('SESSION_ACTION_HOVER_SCRIM_CLASS');
  });

  it('aligns the session row cursor with the actual split drag source state', () => {
    expect(sessionItemSource).toContain("!isEditing && 'cursor-pointer'");
    expect(sessionItemSource).toContain(
      'draggable={splitDragEnabled && (dragContainerState.nativeSortable || !needsSplitDragHandle)}',
    );
    expect(sessionItemSource).toContain('inSortableContainer: true');
    expect(sessionItemSource).toContain('nativeSortable: false');
    expect(sessionItemSource).toContain(
      "sortableDragBlocked: Boolean(row?.closest('[data-no-drag]'))",
    );
    expect(sessionItemSource).toContain(
      "nativeSortable: Boolean(row?.closest('[data-sortable-native-dnd]'))",
    );
    expect(sessionItemSource).toContain('data-split-group-drag-handle');
    expect(sessionItemSource).toContain('data-no-drag={splitDragHandleActive');
  });

  it('wires pinned card and list titles into split drag without disabling item sorting', () => {
    expect(sessionCardSource).toContain('data-split-group-drag-source');
    expect(sessionCardSource).toContain(
      'draggable={splitDragEnabled && (dragContainerState.nativeSortable || !needsSplitDragHandle)}',
    );
    expect(sessionCardSource).toContain('nativeSortable: false');
    expect(sessionCardSource).toContain(
      "nativeSortable: Boolean(card?.closest('[data-sortable-native-dnd]'))",
    );
    expect(sessionCardSource).toContain('data-split-group-drag-handle');
    expect(sessionCardSource).toContain('data-no-drag={splitDragHandleActive');
    expect(sessionCardSource).toContain('startSessionDrag');
  });

  it('PR-123 greptile: card 路径的绑定徽章与 Timer 进反白体系', () => {
    // P1:renderAutomationMeta 卡片/列表两路都要把选中态透传给 ScheduleBindingBadge,
    // 否则红胶囊上 Timer 仍是 meta 灰;普通自动化分支也必须透传 activeForeground。
    expect(sessionCardSource).toContain('activeForeground={isActive}');
    expect(sessionCardSource).toMatch(
      /showAutomationTimer \? \([\s\S]*?<AutomationTimerIcon[\s\S]*?activeForeground=\{isActive\}/,
    );
  });

  it('PR-123 greptile: 暂停角标随反白态切换红胶囊配色', () => {
    // P2:allPaused mini-badge 在 activeForeground 下改用选中态三 token,
    // 不再把页面级 chip 灰底灰字嵌进红胶囊。
    expect(scheduleBindingBadgeSource).toContain('paused={allPaused}');
    expect(automationTimerIconSource).toMatch(
      /activeForeground[\s\S]*?\? 'border border-\[var\(--sidebar-item-active-border\)\] bg-sidebar-item-active text-\[var\(--sidebar-item-active-foreground\)\]'[\s\S]*?: 'border border-\[var\(--cmd-palette-border\)\] bg-\[var\(--chat-input-chip-bg\)\] text-\[var\(--cmd-palette-item-meta\)\]'/,
    );
  });

  it('keeps selected automation group icons, spinner, and actions in the active color system', () => {
    // 用正则容忍 prettier 折行(三元在一行还是拆成多行都算通过)。
    expect(automationGroupSource).toMatch(
      /colorClassName=\{\s*hasActiveHidden \? 'text-\[var\(--sidebar-item-active-foreground\)\]' : undefined\s*\}/,
    );
    // running 语义下沉到统一 Timer；组头必须透传，图标组件保持橙色优先级。
    expect(automationGroupSource).toContain('running={isRunning}');
    expect(automationTimerIconSource).toMatch(
      /isActivelyRunning[\s\S]*?\? 'text-\[var\(--status-bar-accent\)\]'/,
    );
    // 用正则容忍 prettier 折行(三元在一行还是拆成多行都算通过)。
    expect(automationGroupSource).toMatch(
      /hasActiveHidden\s*\?\s*'text-sidebar-item-active-foreground'\s*:\s*'text-sidebar-action-icon'/,
    );
    expect(automationGroupSource).toContain('actionButtonToneClassName');
    expect(automationGroupSource).toContain(
      "? 'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'",
    );
    expect(automationGroupSource).toContain(": 'text-foreground hover:bg-sidebar-item-hover'");
  });

  it('matches list-mode title type to the text-mode session row', () => {
    expect(sessionCardSource).toContain('<SidebarTitleMarquee');
    expect(sessionCardSource).toContain("'text-sm font-medium leading-[1.3]'");
    expect(sessionCardSource).toContain(
      'inputClassName="absolute inset-x-0 top-1/2 h-6 -translate-y-1/2 text-sm font-medium text-foreground"',
    );
    expect(sessionCardSource).toContain("'mt-1 overflow-hidden text-xs leading-[1.45]'");
    expect(sessionCardSource).toContain('className="leading-none"');
    expect(sessionCardSource).not.toContain(
      "'text-13 font-semibold leading-[1.3] tracking-[-0.005em]'",
    );
    expect(sessionItemSource).toContain("'text-left text-sm font-medium'");
  });

  it('keeps list-mode time and remote marks on the text-mode color and size', () => {
    expect(sessionCardSource).toContain('size={12}');
    expect(sessionCardSource).toContain(": 'text-sidebar-action-icon'");
    expect(sessionCardSource).not.toContain('size={11}\n                      strokeWidth={1.8}');
    expect(sessionItemSource).toContain('size={12}');
    expect(sessionItemSource).toContain(": 'text-sidebar-action-icon'");
  });

  it('shows the project source label inline in both list and text modes', () => {
    expect(sessionCardSource).toContain('{sourceLabel ? (');
    expect(sessionItemSource).toContain('{sourceLabel ? (');
    expect(sessionItemSource).toContain('title={sourceLabel}');
    expect(sessionCardSource).toContain('title={sourceLabel}');
    expect(sessionItemSource).toContain("'min-w-0 truncate text-xs font-normal'");
    expect(sessionItemSource).not.toContain('sourceLabel={sourceLabel}');
  });

  it('aligns list automation headers with regular tasks and indents only expanded children', () => {
    expect(automationGroupSource).toMatch(
      /sessionVariant === 'list'\s*\? 'px-2\.5'\s*: indented\s*\? 'pl-\[22px\] pr-2'\s*: 'pl-3 pr-2'/,
    );
    expect(automationGroupSource).toContain('<div className="flex flex-col gap-0.5 pl-3">');
    expect(automationGroupSource).toContain("sessionVariant === 'list' ? 'w-3' : 'w-[15px]'");
    expect(automationGroupSource).toContain("sessionVariant === 'list' && 'order-2'");
  });
});
