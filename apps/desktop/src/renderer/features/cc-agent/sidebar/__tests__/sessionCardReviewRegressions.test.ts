import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarDir = resolve(__dirname, '..');
const sessionCardSource = readFileSync(resolve(sidebarDir, 'SessionCard.tsx'), 'utf8');
const sessionEntryListSource = readFileSync(resolve(sidebarDir, 'SessionEntryList.tsx'), 'utf8');
const sessionItemSource = readFileSync(resolve(sidebarDir, 'SessionItem.tsx'), 'utf8');
const sessionRenameInputSource = readFileSync(resolve(sidebarDir, '..', 'SessionRenameInput.tsx'), 'utf8');
const sessionStatusIconSource = readFileSync(resolve(sidebarDir, 'SessionStatusIcon.tsx'), 'utf8');
const automationGroupSource = readFileSync(resolve(sidebarDir, 'AutomationSessionGroupItem.tsx'), 'utf8');
const automationTimerIconSource = readFileSync(resolve(sidebarDir, 'AutomationTimerIcon.tsx'), 'utf8');
const scheduleBindingBadgeSource = readFileSync(resolve(sidebarDir, 'ScheduleBindingBadge.tsx'), 'utf8');
const globalsSource = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'styles', 'globals.css'), 'utf8');

describe('SessionCard review regressions', () => {
  it('only draws the list top divider on the first overall entry', () => {
    expect(sessionEntryListSource).toContain('isFirst={index === 0}');
    expect(sessionEntryListSource).not.toContain(
      "isFirst={index === 0 || entries[index - 1]?.kind !== 'session'}",
    );
  });

  it('keeps awaiting text in list mode previews', () => {
    expect(sessionCardSource).toContain('const listPreview = awaitingText ?? runningDetail ?? summaryPreview');
    expect(sessionCardSource).toContain('{listPreview}');
  });

  it('keeps status breathing covered by reduced motion', () => {
    expect(globalsSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.session-status-breathing,[\s\S]*animation: none(?: !important)?;/,
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

  it('keeps card preview line budgets stable across content sources', () => {
    expect(sessionCardSource).toContain(
      'const cardPreviewLineClamp = session.summary ? 3 : isRunning ? 2 : isAutomationGenerated ? 1 : 2',
    );
    expect(sessionCardSource).toContain('style={{ WebkitLineClamp: cardPreviewLineClamp }}');
  });

  it('keeps one Timer glyph for scheduled and automation sessions', () => {
    expect(sessionCardSource).toContain('const showScheduleBindingBadge = boundSchedules.length > 0');
    expect(sessionCardSource).toContain('const showAutomationTimer = !showScheduleBindingBadge && isAutomationGenerated');
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

  it('keeps card time anchored to the bottom meta row instead of the overlay layout', () => {
    // 时间固定在底部 meta 行右端(ml-auto),不再依赖 overlay/block 双态测量。
    expect(sessionCardSource).not.toContain('cardTimeLayout');
    expect(sessionCardSource).toContain('{cardTimeText}');
    expect(sessionCardSource).toContain('ml-auto shrink-0'); // E1D 侧栏层级:time 色 conditional via cn,ml-auto shrink-0 保留
  });

  it('keeps running card previews stable instead of streaming compact activity text', () => {
    expect(sessionCardSource).toContain('const listPreview = awaitingText ?? runningDetail ?? summaryPreview');
    expect(sessionCardSource).toContain('const cardPreview = awaitingText ?? summaryPreview');
    expect(sessionCardSource).not.toContain('const cardPreview = awaitingText ?? runningDetail ?? summaryPreview');
  });

  it('lets single-line card content keep its natural compact height', () => {
    expect(sessionCardSource).toContain("'rounded-xl bg-[var(--surface-elevated)] border'");
    expect(sessionCardSource).not.toContain("'h-full rounded-xl bg-[var(--surface-elevated)] border'");
  });

  it('E1D 任务C: SessionCard active 反白链收全(title/time/RemoteProjectIcon 全切 sidebar-item-active-foreground)', () => {
    // 阿梅 SIDEBAR-R 打回:SessionCard 漏网(title 700 + RemoteProjectIcon 556/735/753/941)未切反白,现收全
    const re = /isActive \? 'text-sidebar-item-active-foreground'/g;
    const count = (sessionCardSource.match(re) || []).length;
    expect(count, 'isActive conditional active-foreground ≥7(title×2+time+RemoteProjectIcon×4)').toBeGreaterThanOrEqual(7);
    expect(sessionCardSource).toContain("isActive ? 'text-sidebar-item-active-foreground' : isMuted ? 'text-[var(--text-disabled)]' : 'text-[var(--text-tertiary)]'");
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
    expect(sessionItemSource).toContain(
      "!isEditing && hasAutomationMeta ? 'gap-1.5' : 'gap-2.5'",
    );
    expect(automationGroupSource).toContain(
      'className="flex min-w-0 items-center gap-1.5 text-left disabled:cursor-default"',
    );
    expect(automationGroupSource).toContain(
      'className="flex min-w-0 items-center gap-1.5"',
    );
  });

  it('keeps active sidebar rename controls inside the active foreground color system', () => {
    expect(sessionItemSource).toContain('activeForeground={isActive}');
    expect((sessionCardSource.match(/activeForeground=\{isActive\}/g) || []).length).toBeGreaterThanOrEqual(2);
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

  it('keeps selected sidebar hover actions inside the active color system', () => {
    expect(sessionItemSource).toContain('isActive={isActive}');
    expect(sessionItemSource).toContain(
      "'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'",
    );
    expect(sessionItemSource).toContain(
      "'text-sidebar-action-icon hover:bg-sidebar-item-hover hover:text-foreground'",
    );
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
    expect(automationGroupSource).toContain(
      "colorClassName={hasActiveHidden ? 'text-[var(--sidebar-item-active-foreground)]' : undefined}",
    );
    // running 语义下沉到统一 Timer；组头必须透传，图标组件保持橙色优先级。
    expect(automationGroupSource).toContain('running={isRunning}');
    expect(automationTimerIconSource).toMatch(
      /isActivelyRunning[\s\S]*?\? 'text-\[var\(--status-bar-accent\)\]'/,
    );
    expect(automationGroupSource).toContain(
      "hasActiveHidden ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon'",
    );
    expect(automationGroupSource).toContain('actionButtonToneClassName');
    expect(automationGroupSource).toContain(
      "? 'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'",
    );
    expect(automationGroupSource).toContain(
      ": 'text-foreground hover:bg-sidebar-item-hover'",
    );
  });
});
