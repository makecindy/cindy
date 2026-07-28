import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const backdropSource = fs.readFileSync(
  fileURLToPath(new URL('../SkinBackdrop.tsx', import.meta.url)),
  'utf8',
);
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
const brandLockupSource = fs.readFileSync(
  fileURLToPath(new URL('../../components/branding/ThemeBrandLockup.tsx', import.meta.url)),
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

  it('skins the settings card and derived surface token family', () => {
    expect(backdropSource).toContain("'surface-card-ivory'");
    expect(backdropSource).toContain("'surface-chip-alt'");
    expect(backdropSource).toContain("'surface-elevated-soft'");
    expect(backdropSource).toContain("'surface-hover-soft'");
    expect(backdropSource).toContain("'surface-hover-hsl'");
    expect(backdropSource).toContain("'surface-translucent-sidebar'");
    expect(backdropSource).toContain("'sidebar-item-active'");
    expect(backdropSource).toContain("'sidebar-item-active-foreground'");
    expect(backdropSource).toContain("'sidebar-user-card-bg'");
    expect(backdropSource).toContain("'settings-profile-card-bg'");
    expect(backdropSource).toContain("'settings-theme-card-bg'");
    expect(backdropSource).toContain("'settings-input-bg'");
    expect(backdropSource).toContain("'create-agent-quick-card-bg'");
    expect(backdropSource).toContain("'create-agent-quick-card-icon-bg'");
    expect(newMakerSource).toContain('data-cindy-skin-glass-card="true"');
    expect(brandLockupSource).toContain('useSkinAppearance()');
    expect(brandLockupSource).toContain('skinAppearance?.brand?.icon?.url');
    expect(brandLockupSource).toContain('skinAppearance?.brand?.logo?.url');
  });

  it('keeps scrollback from showing through the local composer glass', () => {
    expect(backdropSource).toContain('const composerAlpha = Math.max(0.94, alpha)');
    expect(backdropSource).toContain(
      "'chat-input-bg': `hsl(${elevated} / ${composerAlpha})`",
    );
    expect(chatInputSource.match(/data-cindy-skin-glass-card=/g)?.length).toBe(2);
    expect(globalsSource).toContain(
      "html[data-skin-active] [data-cindy-skin-glass-card='true']",
    );
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
