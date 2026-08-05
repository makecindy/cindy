import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'), 'utf8');
const brandLockupSource = readFileSync(resolve(__dirname, '..', 'components', 'branding', 'ThemeBrandLockup.tsx'), 'utf8');
const chatInputSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'), 'utf8');
const sendButtonSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'SendButton.tsx'), 'utf8');
const vendorSwitcherSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'VendorSegmentedSwitcher.tsx'), 'utf8');
const permissionSelectorSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'PermissionSelector.tsx'), 'utf8');
const modelSelectorSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'ModelSelector.tsx'), 'utf8');
const worktreeChipsRowSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'WorktreeChipsRow.tsx'), 'utf8');
const userInfoSectionSource = readFileSync(resolve(__dirname, '..', 'components', 'sidebar', 'UserInfoSection.tsx'), 'utf8');
const sidebarTopNavSource = readFileSync(resolve(__dirname, '..', 'components', 'sidebar', 'SidebarTopNav.tsx'), 'utf8');
const vendorIconSource = readFileSync(resolve(__dirname, '..', 'components', 'sidebar', 'VendorIcon.tsx'), 'utf8');
const extraDirsButtonSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'ExtraDirsButton.tsx'), 'utf8');
const colorsSource = readFileSync(resolve(__dirname, '..', 'themes', 'colors.ts'), 'utf8');
const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');

describe('NewMakerDraftRoute CREATE AGENT visual contract', () => {
  it('keeps the approved CREATE AGENT shell while preserving the functional composer', () => {
    expect(source).toContain('data-testid="create-agent-shell"');
    expect(source).toContain('data-testid="create-agent-main"');
    expect(source).toContain('data-testid="create-agent-mode-pill"');
    expect(source).toContain('testId="create-agent-brand-lockup"');
    expect(source).toContain('data-testid="create-agent-quick-starts"');
    expect(source).toContain('createAgentQuickStarts.map');
    expect(source).toContain('<ChatInput');
    expect(source).toContain('<VendorSegmentedSwitcher');
    expect(source).toContain('middleToolbarSlot={');
    expect(source).not.toContain('<HomeUsageDashboard');
    expect(source).not.toContain('newChat.createAgent.more');
    expect(source).not.toContain('data-testid="create-agent-sidebar"');
    expect(source).not.toContain('<aside');
    expect(source).not.toContain('createAgentSidebarNav');
    expect(source).not.toContain('createAgentSidebarProjects');
    // 2026-07-19 用户裁决:488cb33 对齐 Figma 时误删 branch/worktree 高级入口
    // (功能回归,wt* 状态与 send 管线一直健在)。恢复为 advancedOnly 变体挂在
    // mode pill 右侧——只出齿轮,不回退到旧 folder chip 布局。
    expect(source).toContain('variant="advancedOnly"');
    expect(source).toMatch(/<WorktreeChipsRow[\s\S]*?variant="advancedOnly"/);
    expect(source).not.toContain('h-2.5 w-2.5 rounded-full');
    expect(source).not.toContain('surface-translucent-sidebar');
    expect(source).not.toContain('agent-island-annie');
    expect(source).toContain('<ThemeBrandLockup');
    expect(brandLockupSource).toContain('head-image-dark.png');
  });

  it('centers the CREATE AGENT content group without reintroducing route chrome', () => {
    expect(source).toContain('items-center justify-start');
    const shellBlock = source.slice(
      source.indexOf('data-testid="create-agent-shell"'),
      source.indexOf('data-testid="create-agent-main"'),
    );
    expect(shellBlock).toContain('overflow-x-hidden overflow-y-auto');
    expect(shellBlock).not.toContain('overflow-hidden');
    // 用户改稿 2026-07-21:摘掉 268px 封顶(Figma 定稿画框高度的遗留),大窗口下顶距随 28vh
    // 等比增长,内容组不再"偏高";96px 下限保留,小窗口行为不变。比例为可调参数。
    // 用户改稿 2026-07-21 二连:①摘 268px 封顶(顶距随 28vh 等比);②叠加 --content-header-h
    // 占位补偿——内容组距窗口顶恒为 max(96px,28vh)+46px(="有顶栏时"位置),顶栏显隐零跳动。
    // 比例调参:25.5%→28%(用户实机拍板 2026-07-21)。
    expect(source).toContain('pt-[calc(max(96px,28vh)_+_46px_-_var(--content-header-h,46px))]');
    expect(source).not.toContain('pt-[clamp(96px,25.5vh,268px)]');
    // 内容列宽度从死锁 800px 改为跟随 useProportionalWidth 的 inputWidth(与进行中
    // 对话页同源,封顶 914+20=934px):大屏留出左右呼吸空间、发送后同一 ChatInput 无宽度跳变。
    expect(source).toContain('relative flex w-full flex-col items-start');
    expect(source).toContain('style={{ maxWidth: inputWidth || 800 }}');
    expect(source).not.toContain('max-w-[800px]');
    expect(source).toContain('absolute right-0 top-[22px]');
    // 快捷入口与输入框同宽(w-full 跟随父列 inputWidth),左右两缘对齐 ChatInput;
    // 旧 800px 封顶在宽窗口下右缘短一截,2026-07-24 用户反馈后摘除。
    const quickStartsBlock = source.slice(
      source.indexOf('data-testid="create-agent-quick-starts"'),
      source.indexOf('data-testid="create-agent-quick-starts"') + 200,
    );
    expect(quickStartsBlock).toContain('w-full');
    expect(quickStartsBlock).toContain('mt-[42px]');
    expect(quickStartsBlock).not.toMatch(/maxWidth:\s*800/);
  });

  it('preserves New Maker behavior-critical props on ChatInput', () => {
    const chatInputIndex = source.indexOf('<ChatInput');
    expect(chatInputIndex).toBeGreaterThan(-1);
    const chatInputBlock = source.slice(chatInputIndex, source.indexOf('<NewGoalDialog', chatInputIndex));

    for (const invariant of [
      'onSend={handleSend}',
      'onBeforeVoiceInputStart={handleBeforeVoiceInputStart}',
      'externalDragOver={pageDragOver}',
      'sessionId={undefined}',
      'initialWorkingDir={effectiveWorkingDir}',
      'remoteHostId={draft.remoteHostId ?? null}',
      'deviceLinkDeviceId={effectiveDeviceLinkDeviceId}',
      'modelMemoryOverride={deviceLinkDraftMemory}',
      'initialModel={draftInitialModel}',
      'initialEffort={draftInitialEffort}',
      'initialPermissionMode={chatInitialPermissionMode}',
      'initialProviderId={chatInitialProviderId}',
      'planModeEnabled={effectivePlanMode}',
      'fastMode={effectiveFastMode}',
      'onWorkingDirChange={handleWorkingDirChange}',
      'onModelDidChange={handleModelDidChange}',
      'onEffortDidChange={handleEffortDidChange}',
      'onPermissionModeDidChange={handlePermissionModeDidChange}',
      'onProviderDidChange={handleProviderDidChange}',
      'vendorKey={draft.vendor ===',
      // #807 第二十二轮:仍然由调用方显式持有(ChatInput 不 fallback 内部一份),但远程草稿下
      // 包了一层闸门 —— 拒绝路径型附件,因为那是控制端绝对路径,发到对端读不到或读到无关文件。
      'attachmentState={guardedAttachmentState}',
      'draftKey={NEW_MAKER_DRAFT_KEY}',
      'extraDirs={effectiveExtraDirs}',
      // #807 第二十二轮**刻意收窄**原来「+ 始终能加引用目录」这条:远程草稿不下传 onChange,
      // ExtraDirsButton 据此不渲染引用目录段。原因是它开的是控制端原生目录对话框,选出的本机
      // 路径发到对端会被 validateExtraDirs 静默丢掉、或撞上对端同名的无关目录 —— chip 显示的
      // 并非真实授予的上下文。本机草稿行为不变;把 picker 路由到对端后恢复,见 issue #1012。
      'onExtraDirsChange={isDeviceLinkDraft ? undefined : handleExtraDirsChange}',
      'onNewGoal={(text) =>',
      'rememberedEffortByModel={isDeviceLinkDraft ? undefined : draft.effortByModel}',
      'onRememberedEffortChange={',
      'isDeviceLinkDraft ? undefined : handleRememberedEffortChange',
      'placeholder="Hi Cindy!"',
      'middleToolbarSlot={',
    ]) {
      expect(chatInputBlock).toContain(invariant);
    }
  });

  it('uses the R2 quick-start icon mapping and avoids page-level shadows', () => {
    expect(source).toContain('SearchCode');
    expect(source).toContain('Code2');
    expect(source).toContain('MessageSquareCode');
    expect(source).toContain('Hammer');
    expect(source).not.toContain('shadow-[');
    expect(source).not.toContain('boxShadow');
  });

  it('lays out quick-start cards icon-top/label-bottom with a 4px minimum gap (2026-07-25 redesign)', () => {
    // 用户改稿 2026-07-25:两档(narrow/常态)统一竖排——icon 固定左上,文字挪到卡片
    // 中下方与 icon 左对齐(flex-col + justify-between,gap-1 兜底最小间距),取代原
    // 窄态横排 / 常态竖排自适应(#562)。卡片高度不变(narrow 84 / 常态 112)。
    expect(source).toContain(
      "'group flex flex-col items-start justify-between gap-1 rounded-xl border",
    );
    expect(source).toContain("isDraftNarrow ? 'min-h-[84px] p-3' : 'min-h-[112px] p-4'");
    expect(source).toContain('className="w-full min-w-0 text-13 font-semibold leading-[16px]"');
    // 旧的窄态横排(items-center)/常态竖排(gap-3)特判已被统一竖排取代。
    expect(source).not.toContain("'flex min-h-[84px] items-center gap-3 p-3'");
    expect(source).not.toContain("'flex min-h-[112px] flex-col items-start gap-3 p-4'");
  });

  it('uses exact CREATE AGENT quick-start and avatar tokens from the Figma slices', () => {
    // head_image 切图方案(用户裁决 2026-07-17):边框烧入图,仅投影走 CSS
    expect(brandLockupSource).toContain('head-image-dark.png');
    expect(brandLockupSource).toContain('head-image-light.png');
    expect(brandLockupSource).toContain("drop-shadow(0 2px 3.65px rgba(0, 0, 0, 0.15))");
    expect(brandLockupSource).toContain('BRAND_ICON_SIZE = 50');
    expect(brandLockupSource).toContain('BRAND_LOGO_WIDTH = 110');
    expect(brandLockupSource).toContain('BRAND_LOGO_HEIGHT = 37.5');
    expect(brandLockupSource).not.toMatch(/logoScale\s*[=:]/);
    expect(source).not.toContain('create-agent-avatar-glass-bg');
    expect(source).toContain('bg-[var(--create-agent-quick-card-bg)]');
    expect(source).toContain('border-[var(--create-agent-quick-card-border)]');
    expect(source).toContain('text-[var(--create-agent-quick-card-text)]');
    expect(source).toContain('bg-[var(--create-agent-quick-card-icon-bg)]');
    expect(source).toContain('text-[var(--create-agent-quick-card-icon)]');

    expect(colorsSource).toContain("'create-agent-quick-card-icon-bg'");
    expect(colorsSource).toContain("light: '#EDEDED'");
    expect(colorsSource).toContain("dark: '#2A2828'");
  });

  it('keeps the decorative head image unselectable', () => {
    expect(brandLockupSource).toContain('pointer-events-none');
    expect(brandLockupSource).toContain('select-none');
    expect(brandLockupSource).toContain('draggable={false}');
  });

  it('keeps global sidebar chrome out of the route body', () => {
    expect(source).not.toContain('TODO-E4D');
    expect(source).not.toContain('cindy-avatar-account.png');
  });

  it('uses CREATE AGENT private tokens for composer controls', () => {
    expect(source).toContain('border-[var(--create-agent-control-border)]');
    expect(source).toContain('bg-[var(--create-agent-control-bg)]');
    expect(source).toContain('text-[var(--create-agent-control-text)]');
    expect(source).toContain('text-[var(--create-agent-control-icon)]');
    expect(source).toContain('visualVariant="create-agent"');

    expect(chatInputSource).toContain("visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}");
    // 聚焦描边已拆分:输入框容器走 chat-input-border-focus(CINDY 30% 弱化),
    // create-agent-focus-ring 专供键盘 focus-visible ring(PR#174 review 2026-07-20)。
    expect(chatInputSource).toContain('focus-within:border-[var(--chat-input-border-focus)]');
    expect(chatInputSource).not.toContain('focus-within:border-[var(--create-agent-focus-ring)]');
    expect(chatInputSource).toContain("'min-w-0 flex-nowrap justify-between gap-2 overflow-hidden'");
    const permissionSelectorIndex = chatInputSource.indexOf('<PermissionSelector');
    const middleToolbarSlotIndex = chatInputSource.indexOf('{middleToolbarSlot}');
    const modelSelectorIndex = chatInputSource.indexOf('<ModelSelector');
    expect(middleToolbarSlotIndex).toBeGreaterThan(permissionSelectorIndex);
    expect(middleToolbarSlotIndex).toBeLessThan(modelSelectorIndex);

    // 发送按钮已统一到 send-btn-*(create-agent 与会话内共用,2026-07-22),SendButton 不再消费
    // create-agent-send-* 私有 token;send-btn-* 的正向断言见下方「keeps default composer send buttons」。
    expect(sendButtonSource).not.toContain('create-agent-send-bg');
    expect(sendButtonSource).not.toContain('create-agent-send-icon');
    expect(sendButtonSource).not.toContain('create-agent-focus-ring');
    expect(sendButtonSource).toContain('function CreateAgentSendIcon');
    expect(sendButtonSource).toContain('fill="currentColor"');

    // Claude|Codex 分段切换是新建对话框独有控件,不在统一范围,仍用 create-agent 分段 token
    expect(vendorSwitcherSource).toContain('bg-[var(--create-agent-segment-track-bg)]');
    expect(vendorSwitcherSource).toContain('text-[var(--create-agent-segment-inactive-text)]');
    expect(vendorSwitcherSource).toContain('border-[var(--create-agent-control-border)]');

    // 权限/模型 trigger 已统一为裸态无框(create-agent 与会话内共用同一套),不再用 create-agent-control 边框
    expect(permissionSelectorSource).not.toContain('border-[var(--create-agent-control-border)]');
    expect(permissionSelectorSource).toContain('border border-transparent bg-transparent');
    expect(permissionSelectorSource).toContain('hover:border-[var(--border-default)]');
    expect(permissionSelectorSource).toContain('min-w-[72px] max-w-full shrink');
    expect(permissionSelectorSource).toContain("'truncate'");
    expect(modelSelectorSource).not.toContain('border-[var(--create-agent-control-border)]');
    expect(modelSelectorSource).toContain('border border-transparent bg-transparent');
    expect(modelSelectorSource).toContain("'h-[30px] max-w-full shrink overflow-hidden px-2.5'");
    expect(modelSelectorSource).toContain("? 'w-[64px] min-w-[64px]'");
    expect(modelSelectorSource).toContain("? 'w-[148px] min-w-[72px]'");
    expect(modelSelectorSource).not.toContain('w-[206px] min-w-[160px] max-w-[206px] shrink');
    expect(modelSelectorSource).not.toContain('max-w-[180px] truncate');

    expect(colorsSource).toContain("'create-agent-send-bg'");
    expect(colorsSource).toContain("light: '#3C3F43'");
    expect(colorsSource).toContain("dark: '#EEEEEE'");
    expect(colorsSource).toContain("'create-agent-send-icon'");
    expect(colorsSource).toContain("light: '#FCFCFC'");
    expect(colorsSource).not.toContain("'create-agent-send-border'");
    expect(colorsSource).toContain("'create-agent-send-bg-hover'");
    expect(colorsSource).toContain("light: '#2E3237'");
    expect(colorsSource).toContain("dark: '#E2E2E2'");
    expect(colorsSource).toContain("'create-agent-send-bg-pressed'");
    expect(colorsSource).toContain("light: '#25282C'");
    expect(colorsSource).toContain("dark: '#D4D4D4'");
    expect(colorsSource).toContain("'create-agent-send-disabled-bg'");
    expect(colorsSource).toContain("dark: '#444242'");
    expect(colorsSource).toContain("'create-agent-send-disabled-icon'");
    expect(colorsSource).toContain("dark: '#585555'");
    expect(colorsSource).toContain("'create-agent-segment-inactive-text'");
    expect(colorsSource).toContain("light: '#9A9DA3'");
    expect(colorsSource).toContain("dark: '#6F6F6F'");
    expect(colorsSource).toContain("'create-agent-control-border'");
    expect(colorsSource).toContain("light: '#DCDFE3'");
    expect(colorsSource).toContain("dark: '#434343'");
    expect(colorsSource).toContain("'create-agent-control-icon'");
    expect(colorsSource).toContain("light: '#3C3F43'");

    expect(chatInputSource).toContain("'min-w-0 flex-nowrap justify-between gap-2 overflow-hidden'");
    expect(chatInputSource).toContain("'min-w-0 flex-nowrap justify-between gap-1 overflow-hidden'");
    expect(chatInputSource).toContain("'flex min-w-0 shrink items-center gap-2'");
    expect(chatInputSource).toContain("'flex min-w-0 shrink items-center justify-end gap-2'");
    expect(chatInputSource).toContain("'flex min-w-0 shrink items-center gap-1'");
    expect(chatInputSource).toContain("'flex min-w-0 shrink items-center justify-end gap-1'");
    expect(chatInputSource).not.toContain("'contents'");
    expect(chatInputSource).not.toContain("grid-cols-[minmax(0,max-content)_minmax(0,1fr)]");
    expect(chatInputSource).not.toContain("isCreateAgentVariant ? 'flex-wrap gap-2' : 'min-w-0 gap-1'");
    expect(chatInputSource).not.toContain("'flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2'");
    expect(source).toContain('className="shrink-0"');
    expect(extraDirsButtonSource).toContain("'flex shrink-0 items-center rounded-full transition-colors'");
    expect(permissionSelectorSource).toContain("'h-[30px] min-w-[72px] max-w-full shrink px-2.5'");
    expect(permissionSelectorSource).not.toContain("'h-[30px] min-w-[90px] max-w-none shrink-0");
    expect(permissionSelectorSource).not.toContain("'h-[30px] min-w-[72px] max-w-full shrink border border-[var(--create-agent-control-border)]");
    expect(permissionSelectorSource).not.toContain("'h-[30px] min-w-max shrink-0 px-2.5");
    // 2026-07 动效统一:过渡集扩为 color/background-color/transform,承载
    // active 按压缩放(DESIGN.md §14.4 按压原型);rounded-full 收进骨架(统一 send-btn-* 后壳形恒定)。
    expect(sendButtonSource).toContain(
      "'flex shrink-0 items-center justify-center rounded-full transition-[color,background-color,transform]'",
    );
    expect(modelSelectorSource).toContain("'h-[30px] max-w-full shrink overflow-hidden px-2.5'");
    expect(modelSelectorSource).not.toContain("'h-[30px] min-w-max shrink-0");
    expect(modelSelectorSource).not.toContain("'h-[30px] w-[206px] min-w-[160px] max-w-[206px]");
    expect(modelSelectorSource).toContain("? 'truncate'");
    expect(modelSelectorSource).toContain("? 'truncate'");
    expect(modelSelectorSource).toContain('<ChevronDown');
    expect(modelSelectorSource).toContain("'shrink-0'");
    expect(chatInputSource).toContain(
      "className={isCreateAgentVariant && !useNarrowToolbar ? 'ml-[7px]' : undefined}",
    );
    expect(chatInputSource).toContain(
      '(extraDirs !== undefined && onExtraDirsChange)',
    );
    expect(chatInputSource).not.toContain(
      "vendorKey === 'cc' && extraDirs !== undefined && onExtraDirsChange",
    );
    expect(extraDirsButtonSource).toContain(
      'const hasReferenceDirs = onChange !== undefined',
    );
    expect(extraDirsButtonSource).not.toContain("const isCc = agentKind === 'cc'");
    // ×N 角标在 create-agent(新建草稿)也要外显(2026-07-25 用户定稿):引用目录
    // 扩大 agent 可见范围,收起态不允许静默。不得回退到 icon-only 紧凑态。
    expect(extraDirsButtonSource).toContain('count > 0 && hasReferenceDirs');
    expect(extraDirsButtonSource).not.toContain(
      'count > 0 && hasReferenceDirs && !isCreateAgentVariant',
    );
  });

  it('keeps the worktree checkmark readable in both themes', () => {
    expect(worktreeChipsRowSource).toContain(
      'border-[var(--create-agent-send-bg)] bg-[var(--create-agent-send-bg)] text-[var(--create-agent-send-icon)]',
    );
    expect(worktreeChipsRowSource).not.toContain(
      'border-primary bg-primary text-primary-foreground',
    );
  });

  it('aligns the real sidebar colors and user capsule with the CREATE AGENT Figma frame', () => {
    expect(sidebarTopNavSource).toContain('text-[var(--sidebar-nav-text)]');
    expect(vendorIconSource).toContain('text-[hsl(var(--sidebar-muted))]');

    expect(userInfoSectionSource).toContain(
      'rounded-full border border-[var(--sidebar-user-card-border)]',
    );
    expect(userInfoSectionSource).toContain('bg-[var(--sidebar-user-card-bg)]');
    expect(userInfoSectionSource).toContain('text-[var(--sidebar-user-card-text)]');

    expect(colorsSource).toContain("'sidebar-nav-text'");
    expect(colorsSource).toContain("'sidebar-list-muted'");
    expect(colorsSource).toContain("'sidebar-user-card-bg'");
    expect(colorsSource).toContain('rgba(255, 255, 255, 0.20)');
    expect(colorsSource).toContain('rgba(255, 255, 255, 0.05)');
  });

  it('uses the focus-blue caret accent for editable carets', () => {
    expect(globalsSource).toContain('caret-color: var(--caret-accent);');
    expect(globalsSource).toContain('.cm-editor .cm-cursor');
    expect(globalsSource).toContain('border-left-color: var(--caret-accent) !important;');
    expect(colorsSource).toContain("'caret-accent'");
    expect(colorsSource).toContain('CINDY overrides to focus blue #417CDD per user decision 2026-07-18');
  });

  it('keeps default composer send buttons aligned with the neutral inverse rule', () => {
    expect(sendButtonSource).toContain('bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)]');
    expect(sendButtonSource).toContain('hover:bg-[var(--send-btn-hover-bg)]');
    expect(sendButtonSource).toContain('active:bg-[var(--send-btn-pressed-bg)]');
    expect(sendButtonSource).toContain('bg-[var(--send-btn-icon)]');
    // bg/text 已无条件设 send-btn-*(create-agent 与会话内共用),disabled 仅叠 opacity-40(见上方 267 行)
    expect(sendButtonSource).toContain("'cursor-not-allowed opacity-40'");
    expect(sendButtonSource).not.toContain('stop-btn-bg');
    expect(sendButtonSource).not.toContain('stop-btn-icon');
    expect(sendButtonSource).not.toContain('hover:opacity-85');
    expect(sendButtonSource).not.toContain('rounded-[8px]');
    expect(sendButtonSource).not.toContain('bg-[var(--send-btn-disabled-bg)] text-[var(--send-btn-disabled-icon)]');

    expect(colorsSource).toContain("'send-btn-bg'");
    expect(colorsSource).toContain("light: '#3C3F43'");
    expect(colorsSource).toContain("dark: '#EEEEEE'");
    expect(colorsSource).toContain("'send-btn-icon'");
    expect(colorsSource).toContain("light: '#FCFCFC'");
    expect(colorsSource).toContain("dark: '#252222'");
    expect(colorsSource).not.toContain("'stop-btn-bg'");
    expect(colorsSource).not.toContain("'stop-btn-icon'");
  });

  it('does not own global sidebar glass or selected-state tokens', () => {
    expect(colorsSource).not.toContain("'sidebar-glass-bg'");
    expect(colorsSource).not.toContain("'sidebar-glass-overlay-linear'");
    expect(colorsSource).not.toContain("'sidebar-glass-overlay-radial'");
    // sidebar-item-active-border 已由主题层按补编 §3 合法注册,不再列入禁项
    expect(colorsSource).not.toContain("'sidebar-item-active-text'");
  });
});
