import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 动效时长与曲线门禁（DESIGN.md §14.4「Motion tokens (the only tier source)」，
 * 2026-11-11 维护者裁决 D-04 方案 A）。
 *
 * §14.4 规定新的过渡与动画必须引用 motion token，不得在组件里写死毫秒数或 cubic-bezier。
 * 审核发现侧栏、右栏、标题栏与文件浏览的宽度动画都写死 250ms，比面板开合的 base 档
 * （200ms）慢一截；Toast 列表重排写死 300ms + 浏览器默认 ease-out。写死的值不随
 * 减弱动效的 token 归零，也让规范、开发规范与代码三方口径不一。
 *
 * 规则：renderer 的 .ts / .tsx（不含测试）里不得出现
 *   - Tailwind 数字时长 `duration-150`（`duration-0` 除外，那是「无动画」不是档位）；
 *   - 任意值时长 `duration-[250ms]` / `duration-[0.3s]`；
 *   - 任何写死的曲线 `cubic-bezier(...)`：Tailwind `ease-[…]`、行内 transition、Web Animations 的
 *     `easing` 都算；只有 `var(--motion-ease-*, cubic-bezier(...))` 这种 token 回退值不算；
 *   - Tailwind 任意值动画里的字面量时长，如 `animate-[x_200ms_ease-out]`；
 *   - 行内 transition 字符串里的字面量时长，如 `'transform 300ms ease-out'`；
 *   - 只有时长的字符串，如 `transitionDuration: '300ms'`。
 * 改用 `duration-[var(--motion-*)]`、`ease-[var(--motion-ease-*)]` 或 `var(--motion-*)`。
 * 盲区：数字形式的时长（Web Animations 的 `duration: 300`、计时器毫秒）与普通计时常量无法
 * 区分，不在扫描范围；`themes/` 是 token 定义源，不扫。
 *
 * 存量命中按「文件 → 次数」登记在 MOTION_LITERAL_DEBT，只减不增：新增一处（哪怕在已登记
 * 文件里）即红；迁移掉一处后次数变少也会红，提示同步下调或删除登记。不扫 globals.css：
 * 那里的循环动画在 §14.4 逐条登记。tier：guard（跨文件静态设计契约）。
 */

const RENDERER_ROOT = join(__dirname, '..');

const PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: 'tailwind-duration', re: /(?<![\w-])duration-(?!0(?![\d.]))\d+(?![\w-])/g },
  { rule: 'arbitrary-duration', re: /(?<![\w-])duration-\[\d+(?:\.\d+)?m?s\]/g },
  { rule: 'cubic-bezier', re: /(?<!--motion-[\w-]+,\s*)cubic-bezier\(/g },
  { rule: 'arbitrary-animation', re: /(?<![\w-])animate-\[[^\]\s'"`]*?_\d+(?:\.\d+)?m?s/g },
  { rule: 'bare-duration', re: /['"`]\d+(?:\.\d+)?m?s['"`]/g },
  {
    rule: 'inline-transition',
    re: /['"`][^'"`\n]*\b[a-z-]+ \d+(?:\.\d+)?m?s(?: |,|['"`])[^'"`\n]*['"`]/g,
  },
];

/** 存量写死时长（2026-11-11 基线，只减不增）。key 为相对 renderer 的路径。 */
const MOTION_LITERAL_DEBT: Record<string, number> = {
  'cindy-brain/ghostCardLive.ts': 1,
  'components/chat/CopyAsImageBlock.tsx': 1,
  'components/chat/GhostToolCard.tsx': 3,
  'components/chat/ImageLightbox.tsx': 2,
  'components/chat/JumpToBottomChip.tsx': 2,
  'components/chat/MarkdownMermaidBlock.tsx': 1,
  'components/chat/MermaidLightbox.tsx': 2,
  'components/chat/ModelLightbox.tsx': 1,
  'components/chat/NewMessageIndicator.tsx': 2,
  'components/chat/SessionHandoffCard.tsx': 4,
  'components/chat/TextLightbox.tsx': 1,
  'components/chat/ToolPayloadLightbox.tsx': 1,
  'components/chat/VideoLightbox.tsx': 1,
  'components/diff-panel/DiffPanelShell.tsx': 3,
  'components/layout/FadeSwitcher.tsx': 2,
  'components/login/LoginCaptchaOverlay.tsx': 1,
  'components/markdown/codemirrorGithubTheme.ts': 2,
  'components/new-chat/ChatInput.tsx': 3,
  'components/new-chat/FastModeToggle.tsx': 2,
  'components/new-chat/HomeUsageDashboard.tsx': 1,
  'components/new-chat/ModelSelector.tsx': 2,
  'components/new-chat/ThinkingToggle.tsx': 2,
  'components/new-chat/UnifiedFlyoutHost.tsx': 1,
  'components/settings/ComputerPermissionGuideWindow.tsx': 2,
  'components/settings/ComputerUseSection.tsx': 2,
  'components/settings/DownloadMeter.tsx': 1,
  'components/settings/RelayServicePanel.tsx': 1,
  'components/settings/SettingsView.tsx': 1,
  'components/settings/UnifiedModelList.tsx': 2,
  'components/settings/VoiceSpeakerEnrollmentDialog.tsx': 1,
  'components/sidebar/GhostMainViewNavEntries.tsx': 1,
  'components/sidebar/Sidebar.tsx': 6,
  'components/sidebar/SidebarTopNav.tsx': 1,
  'components/sidebar/UserInfoSection.tsx': 2,
  'components/splash/SplashScreen.tsx': 2,
  'components/ui/effort-slider.tsx': 2,
  'components/ui/morph-popover.tsx': 2,
  'components/ui/toast/ToastContainer.tsx': 1,
  'contexts/LoginHandoffContext.tsx': 3,
  'features/billing/BillingPage.tsx': 1,
  'features/bots/BotGlancePopover.tsx': 1,
  'features/bots/TeammatesSection.tsx': 1,
  'features/cc-agent/CCAgentSidebarUpper.tsx': 2,
  'features/cc-agent/sidebar/DeviceSectionHeader.tsx': 1,
  'features/cc-agent/sidebar/MainListScopeHeader.tsx': 1,
  'features/cc-agent/sidebar/RailNav.tsx': 2,
  'features/cc-agent/sidebar/SectionCollapse.tsx': 4,
  'features/cc-agent/sidebar/SessionCard.tsx': 1,
  'features/cc-agent/sidebar/SessionItem.tsx': 1,
  'features/cc-agent/sidebar/sections/DialogueSection.tsx': 1,
  'features/cc-agent/sidebar/sections/PinnedSection.tsx': 1,
  'features/cc-agent/sidebar/sections/ProjectNode.tsx': 2,
  'features/cc-agent/sidebar/sections/ProjectsSection.tsx': 1,
  'features/cc-agent/workdir-browse/FileTabsBar.tsx': 1,
  'features/cc-agent/workdir-browse/SessionTabsBar.tsx': 1,
  'features/plugin/GhostPagePanelHost.tsx': 1,
  'features/plugin/GhostPluginActions.tsx': 1,
  'features/plugin/GhostPluginDetailView.tsx': 7,
  'features/plugin/GhostPluginPage.tsx': 6,
  'features/plugin/PluginBackgroundTasksSection.tsx': 1,
  'features/plugin/PluginManagementLayout.tsx': 1,
  'features/plugin/PluginReadmeSection.tsx': 1,
  'features/scheduler/components/TaskListCell.tsx': 1,
  'features/scheduler/components/TemplateCard.tsx': 1,
  'features/skillhub/SkillhubHomeView.tsx': 2,
  'features/skillhub/components/HomeMarketCard.tsx': 1,
  'features/skillhub/components/SkillDetailLayout.tsx': 1,
};

/** 去掉注释，只扫代码：注释里描述旧值不算违规。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

function collectFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '__tests__' || name === 'node_modules' || name === 'generated') continue;
      if (dir === RENDERER_ROOT && name === 'themes') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(RENDERER_ROOT);
  return files;
}

export function findMotionLiterals(source: string): Array<{ rule: string; match: string; index: number }> {
  const code = stripComments(source);
  const hits: Array<{ rule: string; match: string; index: number }> = [];
  for (const { rule, re } of PATTERNS) {
    for (const m of code.matchAll(re)) hits.push({ rule, match: m[0], index: m.index ?? 0 });
  }
  return hits;
}

describe('motion discipline (DESIGN.md §14.4 motion tokens, D-04)', () => {
  it('flags hardcoded durations and curves, and accepts motion tokens', () => {
    const bad = [
      "'transition-[width] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]'",
      "el.style.transition = 'transform 300ms ease-out';",
      "'transition-opacity duration-150'",
      "{ transition: 'left 250ms cubic-bezier(0.4, 0, 0.2, 1)' }",
      "{ transition: 'transform var(--motion-base) cubic-bezier(0.4,0,0.2,1)' }",
      "{ transitionDuration: '300ms' }",
      "el.animate(frames, { duration: PULSE_MS, easing: 'cubic-bezier(0, 0, 0.2, 1)' })",
      "'animate-[sidebar-peek-in_200ms_ease-out]'",
    ];
    for (const line of bad) expect(findMotionLiterals(line), line).not.toHaveLength(0);
    const good = [
      "'transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-move)] motion-reduce:duration-0'",
      "el.style.transition = 'transform var(--motion-base) var(--motion-ease-move)';",
      "{ transition: 'left var(--motion-base) var(--motion-ease-move)' }",
      '// 旧值 duration-[250ms] 只出现在注释里',
      'const timeoutMs = 250;',
      "'transition-transform duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))]'",
      "'animate-[spin_var(--motion-spinner-cycle)_linear_infinite]'",
    ];
    for (const line of good) expect(findMotionLiterals(line), line).toHaveLength(0);
  });

  it('keeps hardcoded motion literals at or below the registered baseline (shrink-only)', () => {
    const actual = new Map<string, number>();
    const details: string[] = [];
    for (const file of collectFiles()) {
      const hits = findMotionLiterals(readFileSync(file, 'utf8'));
      if (hits.length === 0) continue;
      const key = relative(RENDERER_ROOT, file).split(sep).join('/');
      actual.set(key, hits.length);
      details.push(...hits.map((h) => `${key} [${h.rule}] ${h.match}`));
    }
    const problems: string[] = [];
    for (const [file, count] of actual) {
      const allowed = MOTION_LITERAL_DEBT[file] ?? 0;
      if (count > allowed) {
        problems.push(
          `${file}: ${count} 处写死时长/曲线（登记 ${allowed}）。改用 duration-[var(--motion-*)] / ease-[var(--motion-ease-*)]，见 DESIGN.md §14.4。`,
        );
      }
    }
    for (const [file, allowed] of Object.entries(MOTION_LITERAL_DEBT)) {
      const count = actual.get(file) ?? 0;
      if (count < allowed) problems.push(`${file}: 实际 ${count} 处，少于登记的 ${allowed}，请同步下调或删除 MOTION_LITERAL_DEBT 登记。`);
    }
    expect(problems, details.join('\n')).toEqual([]);
  });
});
