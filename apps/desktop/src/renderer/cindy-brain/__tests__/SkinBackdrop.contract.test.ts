import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const backdropSource = fs.readFileSync(
  fileURLToPath(new URL('../SkinBackdrop.tsx', import.meta.url)),
  'utf8',
);
const skinThemeSource = fs.readFileSync(
  fileURLToPath(new URL('../../themes/skin-theme.ts', import.meta.url)),
  'utf8',
);
const themeHookSource = fs.readFileSync(
  fileURLToPath(new URL('../../hooks/useTheme.ts', import.meta.url)),
  'utf8',
);
const appSource = fs.readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8');
const mainLayoutSource = fs.readFileSync(
  fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url)),
  'utf8',
);
const sessionViewSource = fs.readFileSync(
  fileURLToPath(new URL('../../features/cc-agent/CCAgentSessionView.tsx', import.meta.url)),
  'utf8',
);
const newMakerSource = fs.readFileSync(
  fileURLToPath(new URL('../../features/cc-agent/NewMakerDraftRoute.tsx', import.meta.url)),
  'utf8',
);
const settingsViewSource = fs.readFileSync(
  fileURLToPath(new URL('../../components/settings/SettingsView.tsx', import.meta.url)),
  'utf8',
);
const chatInputSource = fs.readFileSync(
  fileURLToPath(new URL('../../components/new-chat/ChatInput.tsx', import.meta.url)),
  'utf8',
);
const messageStreamSource = fs.readFileSync(
  fileURLToPath(new URL('../../components/chat/MessageStream.tsx', import.meta.url)),
  'utf8',
);
const globalsSource = fs.readFileSync(
  fileURLToPath(new URL('../../styles/globals.css', import.meta.url)),
  'utf8',
);

describe('SkinBackdrop stacking contract', () => {
  it('keeps wallpaper behind the whole Cindy workspace', () => {
    expect(mainLayoutSource).toContain("'relative isolate h-screen overflow-hidden");
    expect(mainLayoutSource).toContain('data-cindy-skin-foreground="true"');
    expect(mainLayoutSource).toContain('className="relative z-10 flex h-full"');
    expect(backdropSource).toContain('absolute inset-0 z-0');
    expect(backdropSource).not.toContain('absolute inset-0 -z-10');
  });

  it('does not stack a second opaque canvas over chat and generation views', () => {
    expect(
      sessionViewSource.match(/data-cindy-skin-transparent-layer="true"/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(newMakerSource).toContain('data-cindy-skin-transparent-layer="true"');
    expect(settingsViewSource).toContain('data-cindy-skin-transparent-layer="true"');
    expect(globalsSource).toContain(
      "html[data-skin-active] [data-cindy-skin-transparent-layer='true']",
    );
  });

  it('resolves skin as a complete Cindy-based theme instead of a DOM token overlay', () => {
    expect(skinThemeSource).toContain("type === 'dark' ? cindyDark : cindyLight");
    expect(skinThemeSource).toContain('...foundation.colors');
    expect(themeHookSource).toContain('resolveSkinTheme(skin, requestedType)');
    expect(themeHookSource).not.toContain(
      'resolveSkinTheme(skin, requestedType),\n      ...resolveFamilyVariant',
    );
    expect(themeHookSource).toContain("skinAppearance ? 'plugin-skin' : familyId");
    expect(backdropSource).not.toContain('style.setProperty');
    expect(backdropSource).not.toContain('appearanceTokenValues');
    expect(appSource).toContain('<SkinAppearanceRuntime />');
  });

  it('skins the settings card and derived surface token family', () => {
    expect(skinThemeSource).toContain("'surface-card-ivory'");
    expect(skinThemeSource).toContain("'surface-chip-alt'");
    expect(skinThemeSource).toContain("'surface-elevated-soft'");
    expect(skinThemeSource).toContain("'surface-hover-soft'");
    expect(skinThemeSource).toContain("'surface-hover-hsl'");
    expect(skinThemeSource).toContain("'surface-translucent-sidebar'");
    expect(skinThemeSource).toContain("'sidebar-item-active'");
    expect(skinThemeSource).toContain("'sidebar-item-active-foreground'");
    expect(skinThemeSource).toContain("'sidebar-user-card-bg'");
    expect(skinThemeSource).toContain("'settings-profile-card-bg'");
    expect(skinThemeSource).toContain("'settings-theme-card-bg'");
    expect(skinThemeSource).toContain("'settings-input-bg'");
    expect(skinThemeSource).toContain("'create-agent-quick-card-bg'");
    expect(skinThemeSource).toContain("'create-agent-quick-card-icon-bg'");
    expect(newMakerSource).toContain('data-cindy-skin-glass-card="true"');
    expect(skinThemeSource).toContain('icon: { src: icon }');
    expect(skinThemeSource).toContain('logo: { src: logo }');
  });

  it('keeps scrollback from showing through the local composer glass', () => {
    expect(skinThemeSource).toContain('const composerAlpha = Math.max(0.94, alpha)');
    expect(skinThemeSource).toContain("'chat-input-bg': `hsl(${elevated} / ${composerAlpha})`");
    expect(chatInputSource.match(/data-cindy-skin-glass-card=/g)?.length).toBe(2);
    expect(globalsSource).toContain("html[data-skin-active] [data-cindy-skin-glass-card='true']");
    expect(sessionViewSource).toContain('data-cindy-skin-message-viewport="true"');
    expect(sessionViewSource).toContain("'--cindy-composer-overlay-height'");
    expect(messageStreamSource).toContain('data-cindy-skin-scroll-content="true"');
    expect(globalsSource).toContain(
      "[data-cindy-skin-message-viewport='true']\n  [data-cindy-skin-scroll-content='true']",
    );
    expect(globalsSource).toContain(
      'transparent calc(100% - var(--cindy-composer-overlay-height) + 32px)',
    );
  });
});
