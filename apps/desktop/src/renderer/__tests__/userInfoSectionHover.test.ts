/**
 * userInfoSectionHover.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: user-message-selected-full-row-bg (回路 #2, 方案 D)
 *
 * Current contract: UserInfoSection follows the CREATE AGENT sidebar capsule
 * design. Flame keeps a .flame-btn marker class, but it now sits inside the
 * compact account pill instead of the old 66px full-row footer.
 *
 * 这份测试做静态源码扫描,确保以下契约不被未来的提交悄悄回退:
 * 1. 外层 div keeps the sidebar footer slot, while the visible account card is
 *    the rounded tokenized capsule.
 * 2. 内部主按钮不再有 hover:bg-sidebar-item-hover (避免双层叠色)
 * 3. Flame button className 列表带有 'flame-btn' 标识符 (供 :has() 选择器钩取)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(__dirname, '..', 'components', 'sidebar', 'UserInfoSection.tsx');
const source = readFileSync(sourcePath, 'utf8');
const localePath = resolve(__dirname, '..', 'i18n', 'locales', 'zh-CN', 'common.json');
const locale = JSON.parse(readFileSync(localePath, 'utf8')) as {
  sidebar: {
    user: { settingsLink: string; canaryBadge: string; downloadMobile: string };
    mobileDownload: { title: string };
  };
};

// ── 改动 1: 外层 footer slot + tokenized account capsule ────────────────

describe('UserInfoSection — outer wrapper takes over full-row hover', () => {
  it('outer div keeps the sidebar footer slot', () => {
    expect(source).toContain('mt-auto px-3 pb-3 pt-2');
  });

  it('visible user card uses the rounded tokenized capsule style', () => {
    expect(source).toContain(
      'flex h-10 items-center rounded-full border border-[var(--sidebar-user-card-border)] bg-[var(--sidebar-user-card-bg)] px-[7px]',
    );
  });

  it('visible user card uses the CREATE AGENT sidebar user tokens', () => {
    expect(source).toContain('border-[var(--sidebar-user-card-border)]');
    expect(source).toContain('bg-[var(--sidebar-user-card-bg)]');
    expect(source).toContain('text-[var(--sidebar-user-card-text)]');
  });

  it('capsule owns the hover state via the glass hover token', () => {
    expect(source).toContain("'transition-colors hover:bg-[var(--sidebar-user-card-bg-hover)]'");
  });

  it('capsule hover is suppressed while the flame button is hovered (:has() exclusion)', () => {
    // 悬停火焰按钮时胶囊底色还原,只让火焰自己高亮 —— 方案 D 语义
    expect(source).toContain("'has-[.flame-btn:hover]:bg-[var(--sidebar-user-card-bg)]'");
  });
});

describe('UserInfoSection — version label', () => {
  it('labels only the non-global builds alongside the app version', () => {
    expect(source).toContain("import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';");
    // 「哪些区域要标」必须来自 shared 单点,不得在组件里再写一份映射
    // (issue 反馈链路同源;口径见 DESIGN.md §16.3 / region-and-editions §2.3)。
    expect(source).toContain("import { shouldLabelRegion } from '../../../shared/regionCode';");
    expect(source).not.toMatch(/const REGION_LABEL/);
    // global 故意不贴标签,落到 null 分支只显示版本号。
    expect(source).toMatch(
      /const appRegionLabel = !shouldLabelRegion\(CURRENT_CINDY_REGION\)\s*\n\s*\? null\s*\n\s*: CURRENT_CINDY_REGION === 'cn'/,
    );
    // 展示文案走 i18n,且 key 为字面量分支(check:i18n 静态提取要看得到)。
    expect(source).toContain("t('sidebar.user.regionCodeCn')");
    expect(source).toContain("t('sidebar.user.regionCodeDev')");
    expect(source).not.toContain("'Global'");
    expect(source).not.toMatch(/'CN'|'Dev'/);
    expect(source).toMatch(
      /const appVersionLabel = appRegionLabel\s*\n\s*\? `\$\{appRegionLabel\} · \$\{appDisplayVersion\}`\s*\n\s*: appDisplayVersion;/,
    );
    expect(source).not.toContain('XD.Inc');
    expect(source).toContain('{appVersionLabel}');
    expect(source).toContain('title={appVersionLabelDetail}');
  });
});

describe('UserInfoSection — Canary avatar badge', () => {
  it('shows only the shield decoration when isCanary is true', () => {
    expect(source).toContain(
      "import { Flame, Shield, Smartphone, UserRound } from 'lucide-react';",
    );
    expect(source).toContain('const { user, mode, isCanary } = useAuth();');
    expect(source).toContain('{isCanary && (');
    expect(source).toContain("aria-label={t('sidebar.user.canaryBadge')}");
    expect(source).not.toContain("isCanary && 'ring-[1.5px] ring-foreground'");
    expect(source).not.toContain("user.role === 'admin'");
    expect(locale.sidebar.user.canaryBadge).toBe('灰度用户');
  });
});

describe('UserInfoSection — 未登录态头像兜底', () => {
  it('未登录(跳过登录)态用中性人形图标,不拿状态文案取首字', () => {
    // 状态名四语各不相同(未登录 / Not signed in / 未ログイン / 로그인하지 않음),
    // 取首字会渲染成「未」/「N」这类无意义字符,所以这里必须走图标分支。
    expect(source).toContain('const showNotSignedInGlyph = !user && isLocal;');
    // 折叠 rail(36px 圆)与展开胶囊(27px 圆)两处兜底都要接上
    expect(source).toMatch(
      /showNotSignedInGlyph \? \(\s*\n\s*<UserRound aria-hidden="true" size=\{18\}/,
    );
    expect(source).toMatch(
      /showNotSignedInGlyph \? \(\s*\n\s*<UserRound aria-hidden="true" size=\{15\}/,
    );
  });

  it('已登录用户仍使用姓名首字兜底', () => {
    expect(source).toContain(
      "const displayName = user?.name ?? (isLocal ? t('settings.userProfile.local.name') : '');",
    );
    expect(source).toContain('const initial = displayName.charAt(0).toUpperCase();');
  });
});

describe('UserInfoSection — mobile download entry', () => {
  it('uses the local Lucide Smartphone icon in a matching 22x22 capsule action', () => {
    expect(source).toContain(
      "import { Flame, Shield, Smartphone, UserRound } from 'lucide-react';",
    );
    expect(source).toMatch(/'mobile-download-btn',\s*\n\s*'flex h-\[22px\] w-\[22px\]/);
    expect(source).toContain("!isCollapsed && 'mr-1'");
    expect(source).toContain('<Smartphone className="h-3 w-3" aria-hidden="true" />');
  });

  it('suppresses capsule hover while the mobile button owns the hover state', () => {
    expect(source).toContain("'has-[.mobile-download-btn:hover]:bg-[var(--sidebar-user-card-bg)]'");
  });

  it('opens the mobile download dialog with an accessible label', () => {
    expect(source).toContain('onClick={() => setMobileDownloadOpen(true)}');
    expect(source).toContain("aria-label={t('sidebar.user.downloadMobile')}");
    expect(source).toContain("navigate('/settings?tab=remote-control')");
    expect(source).toContain("const remoteAvailable = mode === 'cloud';");
    expect(source).toContain('remoteAvailable={remoteAvailable}');
    expect(locale.sidebar.user.downloadMobile).toBe('下载 Cindy 移动端');
    expect(locale.sidebar.mobileDownload.title).toBe('远程控制 Cindy');
  });

  it('keeps the same entry and dialog available in the collapsed sidebar', () => {
    expect(source).toContain(
      'className="mt-auto flex h-[66px] flex-col items-center justify-center gap-1 px-3"',
    );
    expect(source).toContain('{mobileDownloadEntry}');
  });
});

// ── 改动 2: 内部主按钮去掉冗余 hover / 圆角 ───────────────────────────

describe('UserInfoSection — inner main button no longer owns hover background', () => {
  it('does not contain a "rounded-full" + "hover:bg-sidebar-item-hover" combo on the same className line', () => {
    // 旧 className 长这样: 'flex w-full items-center gap-[10px] rounded-full',
    // 我们要求这一行(主按钮第一行 cn() 字面量)不再带 rounded-full
    expect(source).not.toMatch(/'flex w-full items-center gap-\[10px\] rounded-full'/);
  });

  it('main button does not own hover:bg-sidebar-item-hover (delegated to outer div)', () => {
    // 旧第二行: 'transition-colors text-left hover:bg-sidebar-item-hover',
    expect(source).not.toMatch(/'transition-colors text-left hover:bg-sidebar-item-hover'/);
  });

  it('main button keeps its layout classes (flex / w-full / gap)', () => {
    // 保留布局,只去掉视觉
    expect(source).toMatch(/'flex min-w-0 flex-1 items-center gap-\[10px\]'/);
  });

  it('main button keeps text-left for left-aligned content', () => {
    expect(source).toMatch(/'text-left'/);
  });

  it('main button preserves onClick / role="link" / aria-label (跳转和无障碍不破)', () => {
    expect(source).toContain('onClick={handleClick}');
    expect(source).toContain('role="link"');
    expect(source).toContain("aria-label={t('sidebar.user.settingsLink', { name: displayName })}");
    expect(locale.sidebar.user.settingsLink).toBe('设置，当前用户：{{name}}');
  });
});

// ── 改动 3: Flame button 加 .flame-btn 标识 class ────────────────────────

describe('UserInfoSection — Flame button carries .flame-btn marker class', () => {
  it("Flame button className list includes 'flame-btn' as the first entry", () => {
    // 关键: 外层 div 的 has-[.flame-btn:hover] 选择器必须能钩到这个 class
    expect(source).toMatch(/'flame-btn',\s*\n\s*'flex h-\[22px\] w-\[22px\]/);
  });

  it('Flame button retains its own hover:bg-sidebar-item-hover (capsule highlight when hovered)', () => {
    // Flame 自己的胶囊 hover 不能丢,这是方案 D 的视觉表达
    expect(source).toMatch(/'transition-colors hover:bg-sidebar-item-hover'/);
  });

  it('Flame button keeps rounded-full + 22x22 size inside the account capsule', () => {
    expect(source).toContain(
      'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full',
    );
    expect(source).toContain(
      'border border-[var(--sidebar-user-card-border)] bg-[var(--sidebar-user-card-bg)]',
    );
  });
});
