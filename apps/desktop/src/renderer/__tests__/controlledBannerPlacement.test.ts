import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const R = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(R, rel), 'utf8').replace(/\r\n?/g, '\n');

const sessionViewSource = read('features/cc-agent/CCAgentSessionView.tsx');
const splitViewSource = read('features/cc-agent/OrcaSplitView.tsx');
const routeSource = read('features/cc-agent/OrcaWorkflowRoute.tsx');
const workerPanelSource = read('features/cc-agent/OrcaWorkerPanel.tsx');
const mainLayoutSource = read('components/layout/MainLayout.tsx');
const controlledBannerSource = read('features/remote-device/ControlledBanner.tsx');

describe('controlled banner placement', () => {
  it('renders the controlled banner in the input status bar for routed chat or explicit opt-in', () => {
    expect(sessionViewSource).toContain('showControlledBanner?: boolean;');
    expect(sessionViewSource).toContain('showControlledBanner = false');
    expect(sessionViewSource).toContain(
      'const showInlineControlledBanner = ownsRoute || showControlledBanner;',
    );
    expect(sessionViewSource).toMatch(
      /centerSlot=\{\s*showInlineControlledBanner\s*\?\s*<ControlledBanner placement="statusbar" \/>\s*:\s*null\s*\}/,
    );
    expect(sessionViewSource).toContain(
      '<ControlledBanner placement="inline" maxWidth={controlledBannerMaxWidth} />',
    );
  });

  it('keeps the statusbar center slot geometrically centered above lower-priority side text', () => {
    expect(sessionViewSource).toContain('const STATUS_BAR_CENTER_SLOT_MAX_WIDTH = 420;');
    expect(sessionViewSource).toContain('const STATUS_BAR_CENTER_SLOT_WIDTH_RATIO = 0.5;');
    expect(sessionViewSource).toContain(
      'function getControlledBannerMaxWidth(inputWidth?: number): number',
    );
    expect(sessionViewSource).toContain('(inputWidth - 16) * STATUS_BAR_CENTER_SLOT_WIDTH_RATIO');
    expect(sessionViewSource).toContain(
      'const centerSlotMaxWidth = getControlledBannerMaxWidth(inputWidth);',
    );
    expect(sessionViewSource).toContain(
      'const controlledBannerMaxWidth = getControlledBannerMaxWidth(inputWidth);',
    );
    expect(sessionViewSource).toContain('grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)]');
    expect(sessionViewSource).toContain(
      'className="z-10 flex min-w-0 max-w-full items-center justify-center px-2"',
    );
    expect(sessionViewSource).toContain('style={{ maxWidth: centerSlotMaxWidth }}');
    expect(sessionViewSource).toContain(
      'className="flex min-w-0 items-center justify-self-end gap-[6px]"',
    );
    expect(controlledBannerSource).toContain(
      'flex min-w-0 max-w-full select-none items-center gap-2 overflow-hidden',
    );
    expect(controlledBannerSource).toContain(
      'className="min-w-0 truncate text-[12px] text-[var(--text-primary)]"',
    );
    expect(controlledBannerSource).toContain(
      'className="flex min-w-0 max-w-[45%] shrink items-center gap-1',
    );
    expect(controlledBannerSource).toContain('<span className="min-w-0 truncate">');
    expect(controlledBannerSource).not.toContain("placement === 'statusbar' && 'my-");
    expect(sessionViewSource).not.toContain('grid-cols-[1fr_auto_1fr]');
    expect(sessionViewSource).not.toContain('absolute left-1/2');
  });

  it('uses the same width cap for the plan-review inline fallback', () => {
    expect(controlledBannerSource).toContain('maxWidth?: number;');
    expect(controlledBannerSource).toContain('style={maxWidth == null ? undefined : { maxWidth }}');
    expect(sessionViewSource).toContain(
      '<ControlledBanner placement="inline" maxWidth={controlledBannerMaxWidth} />',
    );
  });

  it('opts in only route-owned chat views, not Worker panes or embedded doc rails', () => {
    expect(sessionViewSource).toContain(
      'const showInlineControlledBanner = ownsRoute || showControlledBanner;',
    );
    expect(routeSource).not.toContain('<CCAgentSessionView');
    expect(routeSource).not.toContain('showControlledBanner');
    expect(splitViewSource).not.toContain('showLeadControlledBanner');
    expect(splitViewSource).not.toContain('showControlledBanner=');

    expect(workerPanelSource).toContain('<CCAgentSessionView');
    expect(workerPanelSource).not.toContain('showControlledBanner');
  });

  it('suppresses the global floating fallback on legacy Orca redirect pages', () => {
    expect(mainLayoutSource).toContain(
      'function hasInlineControlledBannerPath(pathname: string): boolean',
    );
    expect(mainLayoutSource).toContain(
      "return parts.length === 3 && parts[1] === 'orca' && parts[2] !== 'new';",
    );
    expect(mainLayoutSource).toContain('{!hasInlineControlledBanner && <ControlledBanner />}');
  });
});
